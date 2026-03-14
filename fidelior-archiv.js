/* ==========================================================================
   Fidelior Archiv  v3.1  —  Dokument-Browser (vollständig überarbeitet)
   ==========================================================================
   FIXES v3.1:
   - Dokumentliste gruppiert nach Ordnertyp (Rechnungen / Dokumente) + Jahr
   - PDF-Vorschau füllt gesamtes rechtes Panel (flex layout, volle Höhe)
   - Sortierung verwendet geparste Dokumentdatum aus Dateiname (primär)
   - Filter-Pipeline: Text → Ordnertyp → Jahr → Sortierung
   - Kein Emoji — ausschließlich SVG-Icons (Lucide)
   - Einzelne Source-of-Truth für Filterstate (S.query, S.typeFilter, S.yearFilter, S.sortOrder)
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   KONFIGURATION
   ══════════════════════════════════════════════════════════════════════════ */

let objectsMap = {};

async function loadObjectsConfig() {
  try {
    const cfgDir = window.configDirHandle;
    if (!cfgDir) return;
    const fh  = await cfgDir.getFileHandle('objects.json', { create: false });
    const file = await fh.getFile();
    const json = JSON.parse(await file.text());
    for (const obj of (json.objects || [])) objectsMap[obj.code] = obj;
  } catch (e) { console.warn('[FideliorArchiv] objects.json:', e); }
}

function getScopeName(code) { return objectsMap[code]?.scopevisioName || code; }

/* ══════════════════════════════════════════════════════════════════════════
   PFAD-MAPPING  (exakt wie preflightTargets in app.js — NICHT ÄNDERN)
   ══════════════════════════════════════════════════════════════════════════ */

function buildScanRoots(code) {
  const sn = getScopeName(code);
  if (code === 'FIDELIOR') return [
    { segs: ['FIDELIOR', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' },
    { segs: ['FIDELIOR', 'Dokumente'],          label: 'Dokumente' },
  ];
  if (code === 'PRIVAT') return [
    { segs: ['PRIVAT', 'Rechnungsbelege'], label: 'Rechnungsbelege' },
    { segs: ['PRIVAT', 'Dokumente'],       label: 'Dokumente' },
  ];
  if (code === 'ARNDTCIE' || sn === 'ARNDT & CIE') return [
    { segs: ['ARNDT & CIE', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' },
    { segs: ['ARNDT & CIE', 'Dokumente'],           label: 'Dokumente' },
  ];
  return [
    { segs: ['OBJEKTE', sn, 'Rechnungsbelege'],   label: 'Rechnungsbelege' },
    { segs: ['OBJEKTE', sn, 'Objektdokumente'],   label: 'Objektdokumente' },
    { segs: ['OBJEKTE', sn, 'Abrechnungsbelege'], label: 'Abrechnungsbelege' },
  ];
}

async function navigateTo(root, segs) {
  let cur = root;
  for (const s of segs) {
    try { cur = await cur.getDirectoryHandle(s, { create: false }); }
    catch { return null; }
  }
  return cur;
}

async function scanPDFs(dir, basePath, depth, out, seen) {
  if (!dir || depth < 0) return;
  try {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {
        const key = basePath.join('/') + '/' + entry.name;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const f = await entry.getFile();
          out.push({ handle: entry, name: entry.name, size: f.size, modified: f.lastModified, pathSegs: [...basePath] });
        } catch {}
      } else if (entry.kind === 'directory' && depth > 0) {
        await scanPDFs(entry, [...basePath, entry.name], depth - 1, out, seen);
      }
    }
  } catch {}
}

async function loadFiles(code) {
  const root  = window.scopeRootHandle || null;
  if (!root) return [];
  const roots = buildScanRoots(code);
  const all = [], seen = new Set();

  for (const { segs, label } of roots) {
    const dir   = await navigateTo(root, segs);
    if (!dir) continue;
    const batch = [];
    await scanPDFs(dir, segs, 2, batch, seen);

    for (const f of batch) {
      f.folderType = label;
      f.meta       = parseName(f.name);
      f.year       = extractYear(f.pathSegs, f.modified);
      f.subfolder  = extractSub(f.pathSegs, segs, f.year);
      f.objectCode = code;
      f.objectName = getScopeName(code);
    }
    all.push(...batch);
  }

  all.sort((a, b) => docDateMs(b) - docDateMs(a));
  return all;
}

/* ══════════════════════════════════════════════════════════════════════════
   METADATEN
   ══════════════════════════════════════════════════════════════════════════ */

function extractYear(segs, modified) {
  for (let i = segs.length - 1; i >= 0; i--)
    if (/^20\d{2}$/.test(segs[i])) return segs[i];
  return modified ? String(new Date(modified).getFullYear()) : '';
}

function extractSub(segs, baseSegs, year) {
  const after = segs.slice(baseSegs.length).filter(s => !/^20\d{2}$/.test(s));
  return after.join(' › ') || null;
}

function parseName(name) {
  const stem  = name.replace(/\.pdf$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) return { raw: name };
  let rest = [...parts], datum = null, betrag = null;
  const last = rest[rest.length - 1];
  if (/^(\d{4})[.\-](\d{2})[.\-](\d{2})$/.test(last)) { datum = last.replace(/[.\-]/g, '.'); rest.pop(); }
  if (rest[0] && /^\d/.test(rest[0])) { betrag = rest.shift() + ' €'; }
  if (rest[0] && /^[A-ZÄÖÜ0-9]{2,10}$/.test(rest[0])) { rest.shift(); } // object code — skip
  return { betrag, absender: rest.join(' ').replace(/-/g, ' ').trim() || null, datum };
}

/* ══════════════════════════════════════════════════════════════════════════
   SORTIERUNG — DATUM AUS DATEINAME (primär), Datei-Timestamp (Fallback)
   ══════════════════════════════════════════════════════════════════════════ */

function docDateMs(f) {
  // Priority 1: datum aus Dateiname (z.B. "2026.03.12")
  if (f.meta?.datum) {
    const parts = f.meta.datum.split('.');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      if (!isNaN(d.getTime())) return d.getTime();
    }
  }
  // Priority 2: Jahresordner → Ende des Jahres
  if (f.year && /^20\d{2}$/.test(f.year)) {
    return new Date(parseInt(f.year), 11, 31).getTime();
  }
  // Fallback: Datei-Modification-Timestamp
  return f.modified || 0;
}

function sortFiles(arr, order) {
  const s = [...arr];
  switch (order || 'date-desc') {
    case 'date-desc': return s.sort((a, b) => docDateMs(b) - docDateMs(a));
    case 'date-asc':  return s.sort((a, b) => docDateMs(a) - docDateMs(b));
    case 'name-asc':  return s.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    case 'amount':    return s.sort((a, b) => {
      const n = f => parseFloat((f.meta.betrag || '0').replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
      return n(b) - n(a);
    });
    default: return s;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ORDNERTYP NORMALISIERUNG
   Rechnungsbelege / Eingangsrechnungen  → "Rechnungen"
   Objektdokumente / Dokumente           → "Dokumente"
   ══════════════════════════════════════════════════════════════════════════ */

const TYPE_ORDER = ['Rechnungen', 'Abrechnungsbelege', 'Dokumente'];

function fmtFolderType(ft) {
  if (!ft) return 'Dokumente';
  if (ft === 'Rechnungsbelege' || ft === 'Eingangsrechnungen') return 'Rechnungen';
  if (ft === 'Objektdokumente') return 'Dokumente';
  return ft;
}

/* ══════════════════════════════════════════════════════════════════════════
   FORMATIERUNG
   ══════════════════════════════════════════════════════════════════════════ */

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtSize(b) {
  if (!b) return '';
  return b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

/* ══════════════════════════════════════════════════════════════════════════
   TASKS
   ══════════════════════════════════════════════════════════════════════════ */

async function loadTasks(fileName) {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fidelior_addon_v1', 1);
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e);
    });
    return await new Promise(res => {
      const req  = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
      const stem = fileName.replace(/\.pdf$/i, '');
      req.onsuccess = e => res((e.target.result || []).filter(t =>
        (t.note || '').includes(stem) || (t.title || '').includes(stem)));
      req.onerror = () => res([]);
    });
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   SVG ICONS  (Lucide, kein Emoji)
   ══════════════════════════════════════════════════════════════════════════ */

const SVG = {
  download:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  externalLink: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  inbox:        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  copy:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  link:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  task:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  search:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  close:        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  folder:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  file:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  check:        `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  warn:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  disconnect:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="1" y1="1" x2="23" y2="23" stroke-width="1.5" stroke-dasharray="4 2"/></svg>`,
  receipt:      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/></svg>`,
  cursor:       `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>`,
};

/* ══════════════════════════════════════════════════════════════════════════
   CSS
   ══════════════════════════════════════════════════════════════════════════ */

function injectCSS() {
  if (document.getElementById('fdl-av3-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-av3-css';
  s.textContent = `
@keyframes av3spin { to { transform: rotate(360deg); } }
@keyframes av3fade { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }

#fdl-av3-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-ui,'Inter',system-ui); font-size: 11.5px; font-weight: 600;
  padding: 6px 13px; border-radius: 8px; cursor: pointer;
  border: 1px solid #D9DDE3; background: #FFFFFF; color: #5B1B70;
  transition: background .15s, border-color .15s; white-space: nowrap;
}
#fdl-av3-btn:hover { background: #F7F2FA; border-color: #C8B3D3; }

/* ── OVERLAY ── */
#fdl-av3 {
  position: fixed; inset: 0; z-index: 9200;
  background: #F4F5F7; display: flex; flex-direction: column;
  opacity: 0; pointer-events: none; transition: opacity .18s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
#fdl-av3.open { opacity: 1; pointer-events: all; }

/* ── TOPBAR ── */
.av3-topbar {
  display: flex; align-items: center; gap: 10px;
  height: 52px; padding: 0 16px;
  background: #fff; border-bottom: 1px solid #E5E7EB;
  flex-shrink: 0; z-index: 10; overflow: hidden;
}
.av3-logo {
  display: flex; align-items: center; gap: 7px;
  font-size: 13px; font-weight: 700; color: #111827; flex-shrink: 0;
}
.av3-logo-dot { width: 8px; height: 8px; border-radius: 50%; background: #5B1B70; }
.av3-breadcrumb {
  display: flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: #6B7280; min-width: 0; flex: 0 1 200px;
}
.av3-bc-current { color: #111827; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.av3-bc-sep { color: #D1D5DB; }

.av3-search-wrap {
  flex: 1; max-width: 340px; position: relative; display: flex; align-items: center;
}
.av3-search-icon { position: absolute; left: 10px; color: #9CA3AF; pointer-events: none; display: flex; }
.av3-search-wrap input {
  width: 100%; padding: 6px 10px 6px 30px;
  font-family: inherit; font-size: 12.5px; color: #111827;
  background: #F9FAFB; border: 1.5px solid #E5E7EB; border-radius: 7px; outline: none;
  transition: border-color .15s, background .15s;
}
.av3-search-wrap input:focus { border-color: #5B1B70; background: #fff; box-shadow: 0 0 0 3px rgba(91,27,112,.08); }
.av3-search-wrap input::placeholder { color: #9CA3AF; }

.av3-filter-sel {
  font-family: inherit; font-size: 12px; padding: 5px 8px;
  border: 1.5px solid #E5E7EB; border-radius: 7px;
  background: #F9FAFB; color: #374151; outline: none; cursor: pointer;
  transition: border-color .15s; flex-shrink: 0;
}
.av3-filter-sel:focus { border-color: #5B1B70; }

.av3-topbar-close {
  width: 30px; height: 30px; border-radius: 7px; border: none; flex-shrink: 0;
  background: #F3F4F6; color: #6B7280; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s; margin-left: auto;
}
.av3-topbar-close:hover { background: #E5E7EB; color: #111827; }

/* ── 3-SPALTEN BODY ── */
.av3-body {
  flex: 1; display: grid; grid-template-columns: 200px 1fr 380px;
  min-height: 0; overflow: hidden;
}

/* ── SIDEBAR ── */
.av3-sidebar { background: #fff; border-right: 1px solid #E5E7EB; overflow-y: auto; }
.av3-sb-head {
  padding: 14px 16px 6px; font-size: 10px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase; color: #9CA3AF;
}
.av3-obj {
  display: flex; align-items: center; gap: 7px; padding: 7px 12px 7px 16px;
  cursor: pointer; font-size: 12.5px; color: #374151;
  border-left: 3px solid transparent; transition: background .1s;
}
.av3-obj:hover { background: #F9FAFB; }
.av3-obj.active { background: #FAF5FB; color: #5B1B70; font-weight: 600; border-left-color: #5B1B70; }
.av3-obj-code {
  font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
  background: #F3F0F6; color: #5B1B70; padding: 2px 5px; border-radius: 4px; flex-shrink: 0;
}
.av3-obj.active .av3-obj-code { background: #EDE9F5; }
.av3-obj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.av3-obj-cnt {
  font-size: 11px; color: #9CA3AF; background: #F3F4F6;
  border-radius: 20px; padding: 1px 7px; font-weight: 500; flex-shrink: 0;
}
.av3-obj.active .av3-obj-cnt { background: #EDE9F5; color: #5B1B70; }

/* ── DATEILISTE ── */
.av3-list { background: #F4F5F7; border-right: 1px solid #E5E7EB; overflow-y: auto; display: flex; flex-direction: column; }
.av3-list-head {
  padding: 9px 16px; background: #fff; border-bottom: 1px solid #E5E7EB;
  display: flex; align-items: center; justify-content: space-between;
  position: sticky; top: 0; z-index: 2; flex-shrink: 0;
}
.av3-list-count { font-size: 11.5px; color: #6B7280; font-weight: 500; }

/* Folder type group header (NEW) */
.av3-type-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px 5px;
  font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;
  color: #5B1B70; background: #F4F5F7;
  position: sticky; top: 40px; z-index: 2;
  border-bottom: 1px solid #E9EAEE;
  margin-top: 2px;
}
.av3-type-hdr:first-child { margin-top: 0; }
.av3-type-cnt {
  font-size: 10px; font-weight: 600; color: #9CA3AF;
  background: #ECEEF1; border-radius: 20px; padding: 1px 7px;
}

/* Year separator */
.av3-year-sep {
  padding: 5px 16px; font-size: 11px; font-weight: 700; letter-spacing: .05em;
  color: #9CA3AF; background: #ECEEF1; border-bottom: 1px solid #E5E7EB;
  position: sticky; top: 68px; z-index: 1;
}

/* File row */
.av3-file {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 14px 10px 16px; cursor: pointer;
  background: #fff; border-bottom: 1px solid #F3F4F6;
  border-left: 3px solid transparent; transition: background .1s;
}
.av3-file:hover { background: #FAFAFA; }
.av3-file.active { background: #FAF5FB; border-left-color: #5B1B70; }
.av3-thumb {
  width: 34px; height: 44px; border-radius: 5px; flex-shrink: 0;
  background: #FEF2F2; border: 1px solid #FECACA;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-size: 8px; font-weight: 800; color: #DC2626; gap: 1px;
}
.av3-thumb-line { width: 16px; height: 2px; background: #FECACA; border-radius: 1px; margin-top: 3px; }
.av3-file-body { flex: 1; min-width: 0; }
.av3-file-name {
  font-size: 11.5px; font-weight: 600; color: #111827; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;
}
.av3-file.active .av3-file-name { color: #5B1B70; }
.av3-chips { display: flex; gap: 3px; flex-wrap: wrap; margin-bottom: 3px; }
.av3-chip { font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
.av3-chip.amt  { background: #D1FAE5; color: #065F46; }
.av3-chip.dt   { background: #F3F4F6; color: #6B7280; font-weight: 500; }
.av3-chip.sub  { background: #FEF3C7; color: #92400E; }
.av3-file-sender { font-size: 10.5px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.av3-file-info   { font-size: 10px; color: #9CA3AF; margin-top: 2px; }

/* ── RECHTES PANEL (neue Struktur: meta oben, Vorschau füllt Rest) ── */
.av3-panel {
  background: #fff; display: flex; overflow: hidden; position: relative;
}
.av3-panel-rail {
  width: 42px; flex-shrink: 0; display: flex; flex-direction: column;
  align-items: center; padding: 10px 0; gap: 2px;
  border-right: 1px solid #F3F4F6; background: #FAFAFA;
}
.av3-rail-btn {
  width: 32px; height: 32px; border-radius: 7px; border: none;
  background: transparent; color: #6B7280; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background .12s, color .12s;
}
.av3-rail-btn:hover { background: #F3F4F6; color: #111827; }
.av3-rail-btn.highlighted { color: #5B1B70; background: #F0E8F5; }
.av3-rail-sep { height: 1px; width: 24px; background: #E5E7EB; margin: 4px 0; }

/* Panel content — flex column, fills height */
.av3-panel-content {
  flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}

/* Metadata section — compact, fixed */
.av3-panel-meta {
  flex-shrink: 0; overflow-y: auto; max-height: 260px;
  border-bottom: 1px solid #E5E7EB; padding: 14px 16px;
  background: #fff;
}
.av3-ph-name {
  font-size: 12.5px; font-weight: 700; color: #111827; line-height: 1.4;
  word-break: break-all; margin-bottom: 10px;
}
.av3-ph-date { font-size: 11px; color: #9CA3AF; margin-bottom: 4px; }
.av3-cat-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.av3-cat-pill {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px;
  background: #F3F4F6; color: #374151;
}
.av3-cat-pill.green { background: #D1FAE5; color: #065F46; }
.av3-cat-pill.blue  { background: #DBEAFE; color: #1E40AF; }
.av3-cat-pill.amber { background: #FEF3C7; color: #92400E; }

.av3-meta { display: flex; flex-direction: column; gap: 0; }
.av3-meta-row {
  display: flex; justify-content: space-between; align-items: flex-start;
  padding: 4px 0; border-bottom: 1px solid #F9FAFB;
  font-size: 11.5px;
}
.av3-meta-row:last-child { border-bottom: none; }
.av3-meta-label { color: #9CA3AF; flex-shrink: 0; width: 90px; }
.av3-meta-val { color: #111827; font-weight: 500; text-align: right; }
.av3-meta-val.mono { font-family: 'Menlo','Consolas',monospace; font-size: 10.5px; color: #6B7280; }

/* Tasks mini section */
.av3-tasks-mini { padding: 10px 16px 0; border-top: 1px solid #E5E7EB; flex-shrink: 0; }
.av3-tasks-mini-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.av3-tasks-mini-title { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #9CA3AF; }
.av3-task-add { font-size: 11px; font-weight: 600; color: #5B1B70; border: none; background: none; cursor: pointer; font-family: inherit; }
.av3-task-row { display: flex; align-items: flex-start; gap: 7px; padding: 4px 0; font-size: 12px; color: #374151; }
.av3-check-box {
  width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid #D1D5DB;
  flex-shrink: 0; margin-top: 1px; display: flex; align-items: center; justify-content: center;
}
.av3-check-box.done { background: #5B1B70; border-color: #5B1B70; }
.av3-check-box.high { border-color: #DC2626; }
.av3-no-tasks { font-size: 11.5px; color: #9CA3AF; padding: 4px 0; }

/* PDF Preview section — fills remaining height (KEY FIX) */
.av3-panel-preview {
  flex: 1; overflow-y: auto; background: #F4F5F7;
  display: flex; flex-direction: column; min-height: 0;
  padding: 16px;
}
.av3-prev-label {
  font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #9CA3AF; margin-bottom: 10px; flex-shrink: 0;
}
.av3-prev-canvas-wrap { display: flex; flex-direction: column; gap: 8px; }
.av3-prev-canvas-wrap canvas {
  width: 100%; height: auto; display: block;
  border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.12);
}
.av3-prev-more { font-size: 11.5px; color: #9CA3AF; text-align: center; padding: 8px 0; }

/* Empty / Loading */
.av3-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; min-height: 120px; gap: 8px; color: #9CA3AF; padding: 24px;
}
.av3-empty-icon { color: #D1D5DB; }
.av3-empty-title { font-size: 13px; font-weight: 600; color: #6B7280; }
.av3-empty-sub   { font-size: 12px; color: #9CA3AF; text-align: center; }
.av3-loading { display: flex; align-items: center; gap: 10px; padding: 24px; color: #9CA3AF; font-size: 13px; }
.av3-spinner { width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0; border: 2px solid #E5E7EB; border-top-color: #5B1B70; animation: av3spin .65s linear infinite; }

/* Responsive */
@media (max-width: 1100px) { .av3-body { grid-template-columns: 180px 1fr 320px; } }
@media (max-width: 900px)  { .av3-body { grid-template-columns: 160px 1fr; } .av3-panel { display: none; } }
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE  — Single source of truth
   ══════════════════════════════════════════════════════════════════════════ */

const S = {
  obj:        null,
  files:      [],     // all loaded files for current object
  filtered:   [],     // after applying all filters
  selected:   null,
  query:      '',
  typeFilter: 'all',  // 'all' | 'Rechnungen' | 'Dokumente' | 'Abrechnungsbelege'
  yearFilter: 'all',  // 'all' | '2026' | '2025' | ...
  sortOrder:  'date-desc',
  blobUrl:    null,
  counts:     {},
  subFilter:  'all',
  scopeCategory: null,
};

/* ══════════════════════════════════════════════════════════════════════════
   FILTER PIPELINE  — korrekte Reihenfolge
   1) Freitext  2) Ordnertyp  3) Jahr  4) Sortierung
   ══════════════════════════════════════════════════════════════════════════ */

function applyFilters() {
  let result = [...S.files];

  // 1. Freitext
  if (S.query) {
    const q = S.query.toLowerCase();
    result = result.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.meta.absender || '').toLowerCase().includes(q) ||
      (f.meta.betrag   || '').toLowerCase().includes(q) ||
      (f.meta.datum    || '').toLowerCase().includes(q) ||
      (f.subfolder     || '').toLowerCase().includes(q) ||
      (f.year          || '').includes(q)
    );
  }

  // 2. Ordnertyp
  if (S.typeFilter && S.typeFilter !== 'all') {
    result = result.filter(f => fmtFolderType(f.folderType) === S.typeFilter);
  }

  // 3. Sonder-Unterordner
  if (S.subFilter && S.subFilter !== 'all') {
    result = result.filter(f => (f.subfolder || '') === S.subFilter);
  }

  // 4. Jahr
  if (S.yearFilter && S.yearFilter !== 'all') {
    result = result.filter(f => f.year === S.yearFilter);
  }

  // 5. Sortierung
  result = sortFiles(result, S.sortOrder);

  S.filtered = result;
  renderList(result);
}

/* ══════════════════════════════════════════════════════════════════════════
   YEAR-FILTER OPTIONEN  — dynamisch aus geladenen Dateien
   ══════════════════════════════════════════════════════════════════════════ */

function populateYearFilter(files) {
  const sel = document.getElementById('fdl-av3-year');
  if (!sel) return;
  const years = [...new Set(files.map(f => f.year).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  sel.innerHTML = `<option value="all">Alle Jahre</option>` +
    years.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = S.yearFilter;
}

/* ══════════════════════════════════════════════════════════════════════════
   OBJEKTE-LISTE
   ══════════════════════════════════════════════════════════════════════════ */

function getObjList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options).filter(o => o.value).map(o => ({ code: o.value, name: o.textContent }));
}
function getObjectsByCategory(category) {
  let objs = getObjList();

  if (!category) return objs;

  return objs.filter(o => {
    const cat = window.fdlDeriveCategory ? window.fdlDeriveCategory(o.code) : o.code;
    return cat === category;
  });
}

async function loadFilesForCategory(category) {
  const objs = getObjectsByCategory(category);
  let all = [];

  for (const o of objs) {
    const files = await loadFiles(o.code);
    all.push(...files);
  }

  all = sortFiles(all, S.sortOrder || 'date-desc');
  return all;
}
function getShortName(o) {
  const obj = objectsMap[o.code];
  if (obj?.displayName) return obj.displayName.replace(o.code + ' · ', '').trim();
  return o.name.replace(o.code + ' · ', '').trim() || o.code;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: SIDEBAR
   ══════════════════════════════════════════════════════════════════════════ */

function renderSidebar() {
  const el = document.getElementById('fdl-av3-sb');
  if (!el) return;
  let objs = getObjList();
  if (S.scopeCategory) {
    objs = objs.filter(o => {
      const cat = (window.fdlDeriveCategory ? window.fdlDeriveCategory(o.code) : o.code);
      return cat === S.scopeCategory;
    });
  }
  const headLabel = S.scopeCategory || 'Liegenschaften';
  let h = `<div class="av3-sb-head">${headLabel}</div>`;
  for (const o of objs) {
    const active = S.obj?.code === o.code ? 'active' : '';
    const cnt    = S.counts[o.code] !== undefined ? S.counts[o.code] : '…';
    h += `<div class="av3-obj ${active}" onclick="window.__av3.obj('${o.code}')">
      <span class="av3-obj-code">${o.code}</span>
      <span class="av3-obj-name">${getShortName(o)}</span>
      <span class="av3-obj-cnt" id="av3c-${o.code}">${cnt}</span>
    </div>`;
  }
  el.innerHTML = h;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: LISTE  — gruppiert nach Ordnertyp → Jahr
   ══════════════════════════════════════════════════════════════════════════ */

function renderList(files) {
  const el  = document.getElementById('fdl-av3-li');
  const cnt = document.getElementById('fdl-av3-cnt');
  if (!el) return;
  if (cnt) cnt.textContent = `${files.length} Dokument${files.length !== 1 ? 'e' : ''}`;

  if (!files.length) {
    el.innerHTML = `<div class="av3-empty">
      <div class="av3-empty-icon">${SVG.folder}</div>
      <div class="av3-empty-title">${S.query || S.typeFilter !== 'all' || S.yearFilter !== 'all' ? 'Keine Treffer' : 'Keine Dokumente'}</div>
      <div class="av3-empty-sub">${S.query ? 'Suche anpassen' : 'Ordner leer oder nicht verbunden'}</div>
    </div>`;
    return;
  }

  // Gruppe nach normalisiertem Ordnertyp → Jahr
  const byType = {};
  for (const f of files) {
    const typeKey = fmtFolderType(f.folderType);
    if (!byType[typeKey]) byType[typeKey] = {};
    const yr = f.year || '—';
    if (!byType[typeKey][yr]) byType[typeKey][yr] = [];
    byType[typeKey][yr].push(f);
  }

  const types = TYPE_ORDER.filter(t => byType[t]);
  // Add any types not in TYPE_ORDER
  for (const t of Object.keys(byType)) if (!types.includes(t)) types.push(t);

  let html = '';
  for (const typeName of types) {
    const byYear   = byType[typeName];
    const typeTotal = Object.values(byYear).reduce((s, a) => s + a.length, 0);

    html += `<div class="av3-type-hdr">
      <span>${typeName}</span>
      <span class="av3-type-cnt">${typeTotal}</span>
    </div>`;

    const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
    for (const yr of years) {
      html += `<div class="av3-year-sep">${yr}</div>`;
      for (const f of byYear[yr]) {
        const m   = f.meta;
        const act = isSel(f) ? 'active' : '';
        const key = encodeURIComponent(f.name + '||' + f.modified);
        html += `<div class="av3-file ${act}" onclick="window.__av3.file('${key}')">
          <div class="av3-thumb">PDF<div class="av3-thumb-line"></div></div>
          <div class="av3-file-body">
            <div class="av3-file-name" title="${f.name}">${f.name}</div>
            <div class="av3-chips">
          ${f.objectCode ? `<span class="av3-chip dt">${f.objectCode}</span>` : ''}
${m.betrag    ? `<span class="av3-chip amt">${m.betrag}</span>` : ''}
${m.datum     ? `<span class="av3-chip dt">${m.datum}</span>` : ''}
${f.subfolder ? `<span class="av3-chip sub">${f.subfolder}</span>` : ''}
            </div>
            ${m.absender ? `<div class="av3-file-sender">${m.absender}</div>` : ''}
            <div class="av3-file-info">${fmtDate(f.modified)} · ${fmtSize(f.size)}</div>
          </div>
        </div>`;
      }
    }
  }
  el.innerHTML = html;
}

function isSel(f) { return S.selected && S.selected.name === f.name && S.selected.modified === f.modified; }

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: RECHTES PANEL
   Neue Struktur: Metadaten (compact, oben) + PDF-Vorschau (füllt Rest)
   ══════════════════════════════════════════════════════════════════════════ */

async function renderPanel(file) {
  const el = document.getElementById('fdl-av3-panel');
  if (!el) return;

  if (!file) {
    el.innerHTML = `
      <div class="av3-panel-rail">${railButtons()}</div>
      <div class="av3-panel-content">
        <div class="av3-empty" style="height:100%">
          <div class="av3-empty-icon">${SVG.cursor}</div>
          <div class="av3-empty-title">Dokument auswählen</div>
          <div class="av3-empty-sub">Klicke auf ein Dokument in der Liste</div>
        </div>
      </div>`;
    return;
  }

  const m     = file.meta;
  const tasks = await loadTasks(file.name);
  const open  = tasks.filter(t => t.status !== 'done');

  const catPills = [
    S.obj ? `<span class="av3-cat-pill">${S.obj.code}</span>` : '',
    file.folderType ? `<span class="av3-cat-pill green">${fmtFolderType(file.folderType)}</span>` : '',
    file.year ? `<span class="av3-cat-pill blue">${file.year}</span>` : '',
    file.subfolder ? `<span class="av3-cat-pill amber">${file.subfolder}</span>` : '',
  ].filter(Boolean).join('');

  const taskHTML = tasks.length
    ? tasks.slice(0, 5).map(t => {
        const done = t.status === 'done', high = t.priority === 'high';
        return `<div class="av3-task-row">
          <div class="av3-check-box ${done ? 'done' : high ? 'high' : ''}">${done ? SVG.check : ''}</div>
          <span style="${done ? 'text-decoration:line-through;opacity:.5' : ''}">${t.title}</span>
        </div>`;
      }).join('')
    : '<div class="av3-no-tasks">Noch keine Aufgaben</div>';

  el.innerHTML = `
    <div class="av3-panel-rail">
      ${railButtons(open.length)}
    </div>
    <div class="av3-panel-content">
      <div class="av3-panel-meta">
        <div class="av3-ph-date">${fmtDate(file.modified)}</div>
        <div class="av3-ph-name">${file.name}</div>
        <div class="av3-cat-pills">${catPills || '<span style="color:#9CA3AF;font-size:11px">—</span>'}</div>
        <div class="av3-meta">
          ${m.betrag    ? `<div class="av3-meta-row"><span class="av3-meta-label">Betrag</span><span class="av3-meta-val">${m.betrag}</span></div>` : ''}
          ${m.datum     ? `<div class="av3-meta-row"><span class="av3-meta-label">Belegdatum</span><span class="av3-meta-val">${m.datum}</span></div>` : ''}
          ${m.absender  ? `<div class="av3-meta-row"><span class="av3-meta-label">Absender</span><span class="av3-meta-val">${m.absender}</span></div>` : ''}
          <div class="av3-meta-row"><span class="av3-meta-label">Dateigröße</span><span class="av3-meta-val">${fmtSize(file.size)}</span></div>
          <div class="av3-meta-row"><span class="av3-meta-label">Geändert</span><span class="av3-meta-val">${fmtDate(file.modified)}</span></div>
          ${file.subfolder ? `<div class="av3-meta-row"><span class="av3-meta-label">Unterordner</span><span class="av3-meta-val">${file.subfolder}</span></div>` : ''}
          <div class="av3-meta-row"><span class="av3-meta-label">Pfad</span><span class="av3-meta-val mono">${(file.pathSegs || []).join(' › ')}</span></div>
        </div>
        <div class="av3-tasks-mini">
          <div class="av3-tasks-mini-hdr">
            <span class="av3-tasks-mini-title">Aufgaben${open.length ? ' (' + open.length + ')' : ''}</span>
            <button class="av3-task-add" onclick="window.__av3.task()">+ Erstellen</button>
          </div>
          ${taskHTML}
        </div>
      </div>
      <div class="av3-panel-preview" id="fdl-av3-prev">
        <div class="av3-prev-label">Vorschau</div>
        <div class="av3-loading"><div class="av3-spinner"></div> PDF wird gerendert…</div>
      </div>
    </div>`;

  renderPDF(file);
}

function railButtons(taskCount) {
  return `
    <button class="av3-rail-btn" title="Herunterladen"    onclick="window.__av3.dl()">${SVG.download}</button>
    <button class="av3-rail-btn" title="In neuem Tab"     onclick="window.__av3.tab()">${SVG.externalLink}</button>
    <button class="av3-rail-btn" title="In App laden"     onclick="window.__av3.load()">${SVG.inbox}</button>
    <div class="av3-rail-sep"></div>
    <button class="av3-rail-btn" title="Name kopieren"    onclick="window.__av3.cpName()">${SVG.copy}</button>
    <button class="av3-rail-btn" title="Pfad kopieren"    onclick="window.__av3.cpPath()">${SVG.link}</button>
    <div style="flex:1"></div>
    <button class="av3-rail-btn${taskCount ? ' highlighted' : ''}" title="Aufgabe erstellen" onclick="window.__av3.task()">${SVG.task}</button>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   PDF RENDERING  — scale 2.2 für bessere Lesbarkeit, 100% Breite
   ══════════════════════════════════════════════════════════════════════════ */

async function renderPDF(file) {
  const wrap = document.getElementById('fdl-av3-prev');
  if (!wrap) return;
  if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch {} S.blobUrl = null; }
  try {
    const raw  = await file.handle.getFile();
    const buf  = await raw.arrayBuffer();
    const blob = new Blob([buf], { type: 'application/pdf' });
    S.blobUrl  = URL.createObjectURL(blob);

    const pjs = window.pdfjsLib;
    if (!pjs) {
      wrap.innerHTML = `<div class="av3-prev-label">Vorschau</div><embed src="${S.blobUrl}" type="application/pdf" style="width:100%;flex:1;border:none;border-radius:4px">`;
      return;
    }
    if (!pjs.GlobalWorkerOptions?.workerSrc)
      pjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const doc   = await pjs.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 8);

    wrap.innerHTML = '<div class="av3-prev-label">Vorschau</div><div class="av3-prev-canvas-wrap" id="av3-cv-wrap"></div>';
    const cvWrap = document.getElementById('av3-cv-wrap');

    // Scale: use container width for proper sizing
    const containerWidth = wrap.clientWidth - 32; // subtract padding

    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      // Compute scale to fill container width
      const baseVp = page.getViewport({ scale: 1 });
      const scale  = Math.max(2.0, containerWidth / baseVp.width);
      const vp     = page.getViewport({ scale });
      const cv     = document.createElement('canvas');
      cv.width  = vp.width;
      cv.height = vp.height;
      cvWrap.appendChild(cv);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    if (doc.numPages > 8) {
      const note = document.createElement('div');
      note.className = 'av3-prev-more';
      note.textContent = `+ ${doc.numPages - 8} weitere Seiten`;
      cvWrap.appendChild(note);
    }
  } catch {
    const wrap2 = document.getElementById('fdl-av3-prev');
    if (wrap2) wrap2.innerHTML = `<div class="av3-prev-label">Vorschau</div><div class="av3-empty" style="flex:1"><div class="av3-empty-icon">${SVG.warn}</div><div class="av3-empty-sub">Vorschau nicht verfügbar</div></div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AKTIONEN
   ══════════════════════════════════════════════════════════════════════════ */

window.__av3 = {
  async obj(code, opts = {}) {
    const o = getObjList().find(x => x.code === code);
    if (!o) return;
    S.obj = { ...o, ...(objectsMap[code] || {}) };
    S.scopeCategory = opts.scopeCategory || (window.fdlDeriveCategory ? window.fdlDeriveCategory(code) : null);
    S.selected = null; S.files = []; S.filtered = [];
    S.query = (opts.query || '').trim().toLowerCase();
    S.typeFilter = opts.typeFilter || 'all';
    S.subFilter = opts.subFilter || 'all';
    S.yearFilter = opts.yearFilter || 'all';

    const sf = document.getElementById('fdl-av3-search'); if (sf) sf.value = opts.query || '';
    const tf = document.getElementById('fdl-av3-type');   if (tf) tf.value = S.typeFilter;
    const yf = document.getElementById('fdl-av3-year');   if (yf) yf.value = S.yearFilter;
    const so = document.getElementById('fdl-av3-sort');   if (so) so.value = opts.sortOrder || 'date-desc';
    S.sortOrder = opts.sortOrder || 'date-desc';

    const bc = document.getElementById('fdl-av3-bc');
    if (bc) {
      const scope = S.scopeCategory ? `<span class="av3-bc-current">${S.scopeCategory}</span><span class="av3-bc-sep">/</span>` : '';
      bc.innerHTML = `<span style="color:#9CA3AF">Archiv</span><span class="av3-bc-sep">/</span>${scope}<span class="av3-bc-current">${o.name}</span>`;
    }

    renderSidebar();
    const li = document.getElementById('fdl-av3-li');
    if (li) li.innerHTML = `<div class="av3-loading"><div class="av3-spinner"></div> Lade Dokumente…</div>`;
    await renderPanel(null);

    if (!window.scopeRootHandle) {
      if (li) li.innerHTML = `<div class="av3-empty"><div class="av3-empty-icon">${SVG.disconnect}</div><div class="av3-empty-title">Scopevisio nicht verbunden</div></div>`;
      return;
    }

    const files = await loadFiles(code);
    S.files   = files;
    S.filtered = files;
    S.counts[code] = files.length;
    const ce = document.getElementById(`av3c-${code}`); if (ce) ce.textContent = files.length;

    populateYearFilter(files);
    applyFilters();

    if (opts.selectName) {
      const match = S.filtered.find(f => f.name === opts.selectName) || S.files.find(f => f.name === opts.selectName);
      if (match) await window.__av3.file(encodeURIComponent(match.name + '||' + match.modified));
    }
  },
  render() {
    applyFilters();
  },

  refresh() {
    applyFilters();
  },
  async setCategory(category, opts = {}) {
    S.scopeCategory = category || null;
    S.obj = null;
    S.selected = null;
    S.files = [];
    S.filtered = [];

    S.query      = (opts.query || '').trim().toLowerCase();
    S.typeFilter = opts.typeFilter || 'all';
    S.subFilter  = opts.subFilter || 'all';
    S.yearFilter = opts.yearFilter || 'all';
    S.sortOrder  = opts.sortOrder || 'date-desc';

    const sf = document.getElementById('fdl-av3-search');
    const tf = document.getElementById('fdl-av3-type');
    const yf = document.getElementById('fdl-av3-year');
    const so = document.getElementById('fdl-av3-sort');

    if (sf) sf.value = opts.query || '';
    if (tf) tf.value = S.typeFilter;
    if (so) so.value = S.sortOrder;

    if (yf) {
      yf.innerHTML = `<option value="all">Alle Jahre</option>`;
      yf.value = 'all';
    }

    const bc = document.getElementById('fdl-av3-bc');
    if (bc) {
      bc.innerHTML = `<span style="color:#9CA3AF">Archiv</span><span class="av3-bc-sep">/</span><span class="av3-bc-current">${category || 'Alle Liegenschaften'}</span>`;
    }

    renderSidebar();
    renderPanel(null);

    const li = document.getElementById('fdl-av3-li');
    if (li) {
      li.innerHTML = `<div class="av3-loading"><div class="av3-spinner"></div> Lade Dokumente…</div>`;
    }

    if (!window.scopeRootHandle) {
      if (li) {
        li.innerHTML = `<div class="av3-empty">
          <div class="av3-empty-icon">${SVG.disconnect}</div>
          <div class="av3-empty-title">Scopevisio nicht verbunden</div>
        </div>`;
      }
      return;
    }

    const files = await loadFilesForCategory(category);
    S.files = files;
    S.filtered = files;

    populateYearFilter(files);

    if (opts.yearFilter) {
      S.yearFilter = opts.yearFilter;
      if (yf) yf.value = opts.yearFilter;
    }

    applyFilters();

    // optional: erstes Dokument automatisch auswählen
    if (opts.autoSelectFirst && S.filtered.length) {
      S.selected = S.filtered[0];
      renderList(S.filtered);
      await renderPanel(S.selected);
    }
  },

  dl()     { if (S.blobUrl && S.selected) { const a = Object.assign(document.createElement('a'), { href: S.blobUrl, download: S.selected.name }); a.click(); } },
  tab()    { if (S.blobUrl) window.open(S.blobUrl, '_blank'); },
  cpName() { if (S.selected) navigator.clipboard?.writeText(S.selected.name).then(() => toast('Dateiname kopiert', 1500)); },
  cpPath() { if (S.selected) { const p = (S.selected.pathSegs || []).join(' › ') + ' › ' + S.selected.name; navigator.clipboard?.writeText(p).then(() => toast('Pfad kopiert', 1500)); } },

  async load() {
    if (!S.selected) return;
    try {
      if (typeof window.openPdfFromHandle === 'function') { await window.openPdfFromHandle(S.selected.handle); close(); return; }
      const f  = await S.selected.handle.getFile();
      const dt = new DataTransfer(); dt.items.add(f);
      const fi = document.querySelector('input[type="file"]');
      if (fi) { Object.defineProperty(fi, 'files', { value: dt.files, configurable: true }); fi.dispatchEvent(new Event('change', { bubbles: true })); close(); toast(`${f.name} geladen`, 2000); }
      else toast('Direktladen nicht verfügbar', 3000);
    } catch (e) { toast('Fehler: ' + (e?.message || e), 3000); }
  },

  task() {
    if (!S.selected) return;
    close();
    setTimeout(() => {
      const ov = document.getElementById('fdl-tasks-overlay');
      if (ov) { ov.classList.add('open'); setTimeout(() => { const n = document.getElementById('fdl-f-note'), ob = document.getElementById('fdl-f-obj'); if (n) n.value = 'Dokument: ' + S.selected.name; if (ob && S.obj) ob.value = S.obj.code; }, 80); }
    }, 160);
  },
};

function toast(h, ms) { try { if (typeof window.toast === 'function') window.toast(h, ms || 2500); } catch {} }

/* ══════════════════════════════════════════════════════════════════════════
   EVENT HANDLER  für Filter-Controls
   ══════════════════════════════════════════════════════════════════════════ */

function onSearch(val)  { S.query = (val || '').trim().toLowerCase(); applyFilters(); }
function onType(val)    { S.typeFilter = val || 'all'; applyFilters(); }
function onYear(val)    { S.yearFilter = val || 'all'; applyFilters(); }
function onSort(val)    { S.sortOrder  = val || 'date-desc'; applyFilters(); }

/* ══════════════════════════════════════════════════════════════════════════
   OVERLAY
   ══════════════════════════════════════════════════════════════════════════ */

function buildOverlay() {
  if (document.getElementById('fdl-av3')) return;
  const ov = document.createElement('div');
  ov.id = 'fdl-av3';
  ov.innerHTML = `
    <div class="av3-topbar">
      <div class="av3-logo"><div class="av3-logo-dot"></div> Archiv</div>
      <div class="av3-breadcrumb" id="fdl-av3-bc"><span style="color:#9CA3AF">Alle Liegenschaften</span></div>
      <div class="av3-search-wrap">
        <span class="av3-search-icon">${SVG.search}</span>
        <input id="fdl-av3-search" type="search" placeholder="Suche in Dokumenten…" autocomplete="off">
      </div>
      <select class="av3-filter-sel" id="fdl-av3-type">
        <option value="all">Alle Typen</option>
        <option value="Rechnungen">Rechnungen</option>
        <option value="Abrechnungsbelege">Abrechnungsbelege</option>
        <option value="Dokumente">Dokumente</option>
      </select>
      <select class="av3-filter-sel" id="fdl-av3-year">
        <option value="all">Alle Jahre</option>
      </select>
      <select class="av3-filter-sel" id="fdl-av3-sort">
        <option value="date-desc">Neueste zuerst</option>
        <option value="date-asc">Älteste zuerst</option>
        <option value="name-asc">Name A–Z</option>
        <option value="amount">Betrag hoch–niedrig</option>
      </select>
      <button class="av3-topbar-close" id="fdl-av3-close">${SVG.close}</button>
    </div>
    <div class="av3-body">
      <div class="av3-sidebar" id="fdl-av3-sb"></div>
      <div class="av3-list">
        <div class="av3-list-head">
          <span class="av3-list-count" id="fdl-av3-cnt">—</span>
        </div>
        <div id="fdl-av3-li">
          <div class="av3-empty">
            <div class="av3-empty-icon">${SVG.folder}</div>
            <div class="av3-empty-title">Liegenschaft wählen</div>
          </div>
        </div>
      </div>
      <div class="av3-panel" id="fdl-av3-panel">
        <div class="av3-panel-rail"></div>
        <div class="av3-panel-content">
          <div class="av3-empty" style="height:100%">
            <div class="av3-empty-icon">${SVG.cursor}</div>
            <div class="av3-empty-title">Dokument auswählen</div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('fdl-av3-close').onclick  = close;
  document.getElementById('fdl-av3-search').addEventListener('input',  e => onSearch(e.target.value));
  document.getElementById('fdl-av3-type').addEventListener('change',   e => onType(e.target.value));
  document.getElementById('fdl-av3-year').addEventListener('change',   e => onYear(e.target.value));
  document.getElementById('fdl-av3-sort').addEventListener('change',   e => onSort(e.target.value));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
}

async function open(opts = {}) {
  buildOverlay();
  await loadObjectsConfig();
  renderSidebar();
  document.getElementById('fdl-av3').classList.add('open');

  if (opts.scopeCategory) S.scopeCategory = opts.scopeCategory;
  renderSidebar();

  const root = window.scopeRootHandle;
  if (opts.obj) {
    setTimeout(() => { window.__av3.obj(opts.obj, opts); }, 0);
  } else if (opts.scopeCategory) {
    setTimeout(() => {
      window.__av3.setCategory(opts.scopeCategory, {
        typeFilter: opts.typeFilter || 'all',
        subFilter: opts.subFilter || 'all',
        query: opts.query || '',
        yearFilter: opts.yearFilter || 'all',
        sortOrder: opts.sortOrder || 'date-desc',
        autoSelectFirst: false
      });
    }, 0);
  }

  if (root) {
    for (const o of getObjList()) {
      loadFiles(o.code).then(files => {
        S.counts[o.code] = files.length;
        const el = document.getElementById(`av3c-${o.code}`); if (el) el.textContent = files.length;
      }).catch(() => {});
    }
  }
}

function close() {
  document.getElementById('fdl-av3')?.classList.remove('open');
  if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch {} S.blobUrl = null; }
  if (document.body.classList.contains('view-archive') && window.__fdlPro?.goDash) {
    setTimeout(() => window.__fdlPro.goDash(), 0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

function injectButton() {
  if (document.getElementById('fdl-av3-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'fdl-av3-btn';
  btn.innerHTML = `${SVG.folder} Archiv`;
  btn.title = 'Archiv öffnen (A)';
  btn.onclick = open;

  const addon = document.getElementById('fdl-addon-btns');
  const hdr   = document.querySelector('.header-inner, header');
  if (addon)  addon.insertBefore(btn, addon.firstChild);
  else if (hdr) { const s = document.getElementById('settingsBtn'); if (s) hdr.insertBefore(btn, s); else hdr.appendChild(btn); }
}

function init() {
  injectCSS(); injectButton();
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) open();
  });
  console.info('[FideliorArchiv v3.1] bereit — Gruppierung: Ordnertyp + Jahr, Sortierung: Dokumentdatum');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
window.fdlArchivOpen = open;

})();
