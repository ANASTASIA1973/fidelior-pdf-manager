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
  } catch (e) {
    console.warn('[FideliorArchiv] objects.json:', e);
  }
}

function getScopeName(code) {
  return objectsMap[code]?.scopevisioName || code;
}

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
    { segs: ['ARNDT & CIE', 'Dokumente'],          label: 'Dokumente' },
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
    try {
      cur = await cur.getDirectoryHandle(s, { create: false });
    } catch {
      return null;
    }
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
          out.push({
            handle: entry,
            name: entry.name,
            size: f.size,
            modified: f.lastModified,
            pathSegs: [...basePath]
          });
        } catch {}
      } else if (entry.kind === 'directory' && depth > 0) {
        await scanPDFs(entry, [...basePath, entry.name], depth - 1, out, seen);
      }
    }
  } catch {}
}

async function loadFiles(code) {
  const core = window.FideliorCore;
  if (!core?.getDocuments) return [];

  const docs = await core.getDocuments();

  return docs
    .filter(d => d.objectCode === code)
    .map(d => {
      const pathSegs = String(d.id || "")
        .split("/")
        .slice(0, -1);

      const modifiedMs = d.savedAt ? new Date(d.savedAt).getTime() : 0;
      const folderType =
        d.type === "Rechnung"
          ? "Rechnungsbelege"
          : "Dokumente";

      return {
        handle: d.handle || null,
        name: d.fileName,
        size: 0,
        modified: Number.isFinite(modifiedMs) ? modifiedMs : 0,
        pathSegs,
        folderType,
        year: d.year || "",
        subfolder: extractSub(pathSegs, pathSegs.slice(0, pathSegs.length - ((d.year && /^20\d{2}$/.test(d.year)) ? 1 : 0))),
        objectCode: d.objectCode,
        objectName: d.objectName,
        meta: {
          betrag: d.amount || null,
          absender: d.sender || null,
          datum: d.date || null
        },
        __core: d
      };
    })
    .sort((a, b) => docDateMs(b) - docDateMs(a));
}

/* ══════════════════════════════════════════════════════════════════════════
   METADATEN
   ══════════════════════════════════════════════════════════════════════════ */

function extractYear(segs, modified) {
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^20\d{2}$/.test(segs[i])) return segs[i];
  }
  return modified ? String(new Date(modified).getFullYear()) : '';
}

function extractSub(segs, baseSegs) {
  const after = segs.slice(baseSegs.length).filter(s => !/^20\d{2}$/.test(s));
  return after.join(' › ') || null;
}

function parseName(name) {
  const stem  = name.replace(/\.pdf$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) return { raw: name };

  let rest = [...parts];
  let datum = null;
  let betrag = null;

  const last = rest[rest.length - 1];
  if (/^(\d{4})[.\-](\d{2})[.\-](\d{2})$/.test(last)) {
    datum = last.replace(/[.\-]/g, '.');
    rest.pop();
  }
  if (rest[0] && /^\d/.test(rest[0])) {
    betrag = rest.shift() + ' €';
  }
  if (rest[0] && /^[A-ZÄÖÜ0-9]{2,10}$/.test(rest[0])) {
    rest.shift(); // object code — skip
  }

  return {
    betrag,
    absender: rest.join(' ').replace(/-/g, ' ').trim() || null,
    datum
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   SORTIERUNG — DATUM AUS DATEINAME (primär), Datei-Timestamp (Fallback)
   ══════════════════════════════════════════════════════════════════════════ */

function docDateMs(f) {
  if (f.meta?.datum) {
    const parts = f.meta.datum.split('.');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      if (!isNaN(d.getTime())) return d.getTime();
    }
  }

  if (f.year && /^20\d{2}$/.test(f.year)) {
    return new Date(parseInt(f.year, 10), 11, 31).getTime();
  }

  return f.modified || 0;
}

function sortFiles(arr, order) {
  const s = [...arr];
  switch (order || 'date-desc') {
    case 'date-desc':
      return s.sort((a, b) => docDateMs(b) - docDateMs(a));
    case 'date-asc':
      return s.sort((a, b) => docDateMs(a) - docDateMs(b));
    case 'name-asc':
      return s.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    case 'amount':
      return s.sort((a, b) => {
        const n = f => parseFloat((f.meta?.betrag || '0').replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
        return n(b) - n(a);
      });
    default:
      return s;
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
  return new Date(ts).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function formatFilterDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
        (t.note || '').includes(stem) || (t.title || '').includes(stem)
      ));
      req.onerror = () => res([]);
    });
  } catch {
    return [];
  }
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
  flex: 1;
  display: grid;
  grid-template-columns: 200px 1fr minmax(520px, 560px);
  min-height: 0;
  overflow: hidden;
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

/* ── RECHTES PANEL ── */
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

.av3-panel-content {
  flex: 1;
  display: grid;
  grid-template-rows: minmax(260px, 42%) 1fr;
  min-height: 0;
  overflow: hidden;
}

.av3-panel-meta {
  overflow-y: auto;
  min-height: 0;
  border-bottom: 1px solid #E5E7EB;
  padding: 16px 18px;
  background: #fff;
}
  .av3-doc-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.av3-doc-hero {
  padding-bottom: 14px;
  border-bottom: 1px solid #EEF0F3;
}

.av3-doc-file {
  font-size: 11px;
  color: #9CA3AF;
  margin-bottom: 6px;
  word-break: break-all;
}

.av3-doc-title {
  font-size: 20px;
  line-height: 1.25;
  font-weight: 700;
  color: #111827;
  margin-bottom: 10px;
}

.av3-doc-summary {
  font-size: 13.5px;
  line-height: 1.55;
  color: #374151;
  margin-bottom: 10px;
}

.av3-doc-date-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.av3-doc-date-main {
  font-size: 12px;
  font-weight: 600;
  color: #6B7280;
}

.av3-doc-section {
  padding-bottom: 12px;
  border-bottom: 1px solid #F3F4F6;
}

.av3-doc-section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.av3-doc-section-title {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #9CA3AF;
  margin-bottom: 8px;
}

.av3-doc-section-tasks {
  padding-top: 2px;
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

.av3-panel-preview {
  overflow: auto;
  background: #F3F4F6;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 18px;
}
.av3-prev-label {
  font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #9CA3AF; margin-bottom: 10px; flex-shrink: 0;
}
.av3-prev-canvas-wrap { display: flex; flex-direction: column; gap: 8px; }
.av3-prev-canvas-wrap canvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12);
  background: #fff;
}
.av3-prev-more { font-size: 11.5px; color: #9CA3AF; text-align: center; padding: 8px 0; }

.av3-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; min-height: 120px; gap: 8px; color: #9CA3AF; padding: 24px;
}
.av3-empty-icon { color: #D1D5DB; }
.av3-empty-title { font-size: 13px; font-weight: 600; color: #6B7280; }
.av3-empty-sub   { font-size: 12px; color: #9CA3AF; text-align: center; }
.av3-loading { display: flex; align-items: center; gap: 10px; padding: 24px; color: #9CA3AF; font-size: 13px; }
.av3-spinner { width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0; border: 2px solid #E5E7EB; border-top-color: #5B1B70; animation: av3spin .65s linear infinite; }

@media (max-width: 1280px) {
  .av3-body { grid-template-columns: 180px 1fr minmax(420px, 480px); }
}

@media (max-width: 980px)  {
  .av3-body { grid-template-columns: 160px 1fr; }
  .av3-panel { display: none; }
}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE  — Single source of truth
   ══════════════════════════════════════════════════════════════════════════ */

const S = {
  obj:        null,
  files:      [],
  filtered:   [],
  selected:   null,
  query:      '',
  typeFilter: 'all',
  yearFilter: 'all',
  sortOrder:  'date-desc',
  blobUrl:    null,
  counts:     {},
  subFilter:  'all',
  scopeCategory: null,
  collectionId: '',
  dateFrom:   '',
  dateTo:     '',
};


/* ══════════════════════════════════════════════════════════════════════════
   FILTER PIPELINE
   ══════════════════════════════════════════════════════════════════════════ */

function applyFilters() {
  let result = [...S.files];

  if (S.query) {
    const q = S.query.toLowerCase();
    result = result.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.meta?.absender || '').toLowerCase().includes(q) ||
      (f.meta?.betrag   || '').toLowerCase().includes(q) ||
      (f.meta?.datum    || '').toLowerCase().includes(q) ||
      (f.subfolder      || '').toLowerCase().includes(q) ||
      (f.year           || '').includes(q)
    );
  }

  if (S.typeFilter && S.typeFilter !== 'all') {
    result = result.filter(f => fmtFolderType(f.folderType) === S.typeFilter);
  }

  if (S.subFilter && S.subFilter !== 'all') {
    result = result.filter(f => (f.subfolder || '') === S.subFilter);
  }

  if (S.yearFilter && S.yearFilter !== 'all') {
    result = result.filter(f => f.year === S.yearFilter);
  }

   // collectionId wurde bereits beim Laden über filterFilesByCollection(...) angewendet.
  // Hier nicht erneut mit Default-Regeln filtern, sonst würden keyword/objectCode-Treffer verloren gehen.


  if (S.dateFrom || S.dateTo) {

    result = result.filter(f => {
      const ms = docDateMs(f);
      if (!ms) return false;

      const iso = formatFilterDate(ms);
      if (S.dateFrom && iso < S.dateFrom) return false;
      if (S.dateTo && iso > S.dateTo) return false;
      return true;
    });
  }

  result = sortFiles(result, S.sortOrder);
  S.filtered = result;
  renderList(result);
}

/* ══════════════════════════════════════════════════════════════════════════
   YEAR-FILTER OPTIONEN
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
  return Array.from(sel.options)
    .filter(o => o.value)
    .map(o => ({ code: o.value, name: o.textContent }));
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
async function getCollectionById(collectionId) {
  if (!collectionId) return null;

  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fidelior_index_v1');
      r.onsuccess = e => res(e.target.result);
      r.onerror = e => rej(e);
    });

    if (!db.objectStoreNames.contains('collections')) return null;

    return await new Promise(res => {
      const req = db.transaction('collections', 'readonly').objectStore('collections').get(collectionId);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

function normalizeCollectionText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[ä]/g, 'ae')
    .replace(/[ö]/g, 'oe')
    .replace(/[ü]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCollectionHaystack(f) {
  return normalizeCollectionText([
    f.name || '',
    f.objectCode || '',
    f.objectName || '',
    f.folderType || '',
    fmtFolderType(f.folderType || ''),
    f.subfolder || '',
    f.year || '',
    f.meta?.absender || '',
    f.meta?.betrag || '',
    f.meta?.datum || ''
  ].join(' '));
}

function matchesCollectionByDefaultRules(file, collectionId) {
  const hay = buildCollectionHaystack(file);

  if (collectionId === 'steuererklarung') {
    return [
      'steuer',
      'steuererklaerung',
      'steuerberatung',
      'finanzamt',
      'lohnbuchfuehrung',
      'lohnbuchhaltung',
      'zinnikus',
      'sevdesk',
      'datev'
    ].some(token => hay.includes(token));
  }

  if (collectionId === 'betriebskosten') {
    return [
      'betriebskosten',
      'nebenkosten',
      'hausgeld',
      'abrechnung',
      'abrechnungsbeleg',
      'heizung',
      'wasser',
      'strom',
      'muell',
      'mull',
      'reinigung',
      'wartung'
    ].some(token => hay.includes(token));
  }

  return false;
}

async function filterFilesByCollection(files, collectionId) {
  if (!collectionId) return files;

  const collection = await getCollectionById(collectionId);

  if (!collection) {
    return files.filter(f => matchesCollectionByDefaultRules(f, collectionId));
  }

  const keywords = Array.isArray(collection.keywords)
    ? collection.keywords.map(normalizeCollectionText).filter(Boolean)
    : [];

  const objectCodes = Array.isArray(collection.objectCodes)
    ? collection.objectCodes.map(v => String(v).toUpperCase())
    : [];

  return files.filter(f => {
    const hay = buildCollectionHaystack(f);

    if (objectCodes.length && objectCodes.includes(String(f.objectCode || '').toUpperCase())) {
      return true;
    }

    if (keywords.length && keywords.some(k => hay.includes(k))) {
      return true;
    }

    return matchesCollectionByDefaultRules(f, collectionId);
  });
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
      const cat = window.fdlDeriveCategory ? window.fdlDeriveCategory(o.code) : o.code;
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
   RENDER: LISTE
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

  const byType = {};
  for (const f of files) {
    const typeKey = fmtFolderType(f.folderType);
    if (!byType[typeKey]) byType[typeKey] = {};
    const yr = f.year || '—';
    if (!byType[typeKey][yr]) byType[typeKey][yr] = [];
    byType[typeKey][yr].push(f);
  }

  const types = TYPE_ORDER.filter(t => byType[t]);
  for (const t of Object.keys(byType)) {
    if (!types.includes(t)) types.push(t);
  }

  let html = '';
  for (const typeName of types) {
    const byYear = byType[typeName];
    const typeTotal = Object.values(byYear).reduce((sum, arr) => sum + arr.length, 0);

    html += `<div class="av3-type-hdr">
      <span>${typeName}</span>
      <span class="av3-type-cnt">${typeTotal}</span>
    </div>`;

    const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
    for (const yr of years) {
      html += `<div class="av3-year-sep">${yr}</div>`;
      for (const f of byYear[yr]) {
        const m   = f.meta || {};
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

function isSel(f) {
  return S.selected && S.selected.name === f.name && S.selected.modified === f.modified;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: RECHTES PANEL
   ══════════════════════════════════════════════════════════════════════════ */
const __av3DocRecordCache = new Map();
const __av3InsightCache = new Map();
const __av3PdfInsightCache = new Map();

async function loadIndexedDocumentRecord(file) {
  try {
    if (!file?.name) return null;
    if (__av3DocRecordCache.has(file.name)) return __av3DocRecordCache.get(file.name);

    const req = indexedDB.open('fidelior_index_v1', 1);

    const record = await new Promise((resolve) => {
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('documents')) return resolve(null);

          const tx = db.transaction('documents', 'readonly');
          const store = tx.objectStore('documents');
          const idx = store.index('fileName');
          const q = idx.getAll(file.name);

          q.onerror = () => resolve(null);
          q.onsuccess = () => {
            const all = Array.isArray(q.result) ? q.result : [];
            if (!all.length) return resolve(null);

            const best = all
              .slice()
              .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))[0] || null;

            resolve(best);
          };
        } catch {
          resolve(null);
        }
      };
    });

    __av3DocRecordCache.set(file.name, record || null);
    return record || null;
  } catch {
    return null;
  }
}

function uniqClean(list) {
  return Array.from(new Set([].concat(list || []).map(x => String(x || '').trim()).filter(Boolean)));
}

function fallbackInsightsFromArchive(file) {
  const m = file?.meta || {};
  const c = file?.__core || {};

  const docType = c.type || fmtFolderType(file?.folderType) || '';
  const sender = c.sender || m.absender || '';
  const amount = c.amount || m.betrag || '';
  const docDate = c.date || m.datum || '';
  const objectCode = c.objectCode || file?.objectCode || '';
  const objectName = c.objectName || file?.objectName || '';
  const subfolder = file?.subfolder || '';

  const title = buildArchivTitle({
    file,
    core: c,
    docType,
    amount,
    sender,
    objectCode,
    objectName
  });

  const summary = buildArchivSummary({
    file,
    core: c,
    docType,
    amount,
    docDate,
    sender,
    objectCode,
    objectName
  });

   return {
    title,
    summary,
    documentKind: normalizeDisplayType(docType, ''),
    keywords: uniqClean([docType, objectCode, subfolder]),
    emails: [],
    dueDate: '',
    invoiceNo: '',
    iban: '',
    ustId: '',
    importantFacts: uniqClean([
      sender ? `Absender: ${sender}` : '',
      amount ? `Betrag: ${amount}` : '',
      docDate ? `Datum: ${docDate}` : '',
      objectCode ? `Objekt: ${objectCode}${objectName ? ` (${objectName})` : ''}` : ''
    ]),
    source: 'fallback'
  };
}

async function buildDocumentInsights(file) {
  if (!file?.name) return fallbackInsightsFromArchive(file);

  const cacheKey = `${file.name}__${file.modified || ''}__${file.size || ''}`;
  if (__av3InsightCache.has(cacheKey)) return __av3InsightCache.get(cacheKey);

  const archiveFallback = fallbackInsightsFromArchive(file);
  const rec = await loadIndexedDocumentRecord(file);
  const pdf = await extractPdfTextInsights(file);

  // ── Sanitize helpers ──
  // Prevent raw label words from leaking into the company field
  function sanitizeCompany(val) {
    if (!val) return '';
    const v = String(val).trim();
    if (/^(?:firma|lieferant|absender|rechnungsaussteller|kreditor|auftragnehmer|vendor|supplier|from)$/i.test(v)) return '';
    if (v.length < 3) return '';
    return v;
  }

  // Combine and resolve a field from multiple candidate sources
  function resolve(...candidateSets) {
    const merged = [].concat(...candidateSets.filter(Array.isArray));
    return resolveField(merged);
  }

  // For fields where we want any non-empty value (no strict confidence gate)
  function firstValue(...vals) {
    for (const v of vals) {
      const s = String(v || '').trim();
      if (s) return s;
    }
    return '';
  }

  let out;

  // ══════════════════════════════════════════
  // PATH A: Indexed document record available
  // ══════════════════════════════════════════
  if (rec) {
    out = {
      title: firstValue(
        rec.title,
        rec.dashboard?.title,
        archiveFallback.title
      ),

      summary: (() => {
        const _m = inferDisplayModel({
          ai:    pdf?.ai || null,
          rawText: pdf?.text || '',
          lines:   pdf?.lines || [],
          fallbackTitle: file?.name || '',
          amountHint:  firstValue(pdf?.grossAmount, rec.amountRaw),
          dateHint:    firstValue(pdf?.invoiceDate, rec.invoiceDate),
          issuerHint:  firstValue(pdf?.company, rec.sender)
        });
        return buildConservativeSummary(_m);
      })(),

      keywords: uniqLower([
        ...(rec.keywords  || []),
        ...(pdf?.keywords || []),
        ...(archiveFallback.keywords || [])
      ]),

      emails: uniqLower([
        ...(Array.isArray(rec.emailsFound) ? rec.emailsFound : []),
        ...(rec.email      ? [rec.email]      : []),
        ...(pdf?.emails    || [])
      ]),

      documentKind: firstValue(
        pdf ? normalizeDisplayType(pdf.text || '', pdf?.ai?.semanticType || pdf?.ai?.type || '') : '',
        normalizeDisplayType('', rec.title || ''),
        archiveFallback.documentKind
      ),

      dueDate: firstValue(rec.dueDate, pdf?.dueDate, archiveFallback.dueDate),

      // FIX: use AI-finalized pdf values directly — no score-scale mismatch via resolveField
      invoiceNo:   firstValue(pdf?.invoiceNo,   rec.invoiceNo,  archiveFallback.invoiceNo),
      invoiceDate: firstValue(pdf?.invoiceDate, rec.invoiceDate),
      grossAmount: firstValue(pdf?.grossAmount, rec.amountRaw),
      company: normalizeIssuer(
        sanitizeCompany(firstValue(pdf?.company, rec.sender)),
        pdf?.text || '',
        pdf?.lines || []
      ),

      customerNo:    firstValue(pdf?.customerNo),
      orderNo:       firstValue(pdf?.orderNo),
      propertyNo:    firstValue(pdf?.propertyNo),
      servicePeriod: firstValue(pdf?.servicePeriod),

      netAmount:   firstValue(pdf?.netAmount),
      taxAmount:   firstValue(pdf?.taxAmount),

      iban:  firstValue(rec.iban, pdf?.iban, archiveFallback.iban),
      bic:   firstValue(pdf?.bic),
      ustId: firstValue(rec.ustId, pdf?.ustId, archiveFallback.ustId),

      recipient:   firstValue(pdf?.recipient),
      subjectLine: firstValue(pdf?.subjectLine),
      services:    pdf?.services || [],

      importantFacts: buildImportantFactsFromPdf(pdf || {}, {
        importantFacts: uniqLower([
          rec.sender      ? `Absender: ${rec.sender}` : '',
          rec.amountRaw   ? `Betrag: ${rec.amountRaw}` : '',
          rec.invoiceDate ? `Belegdatum: ${fmtDate(rec.invoiceDate)}` : '',
          rec.invoiceNo   ? `Referenz: ${rec.invoiceNo}` : '',
          rec.objectCode  ? `Objekt: ${rec.objectCode}` : '',
          ...(archiveFallback.importantFacts || [])
        ])
      }),

      invoiceCandidates: [],
      amountCandidates:  [],
      companyCandidates: [],
      dateCandidates:    [],

      invoiceConfidence: pdf?.invoiceConfidence || 'low',
      amountConfidence:  pdf?.amountConfidence  || 'low',
      companyConfidence: pdf?.companyConfidence || 'low',
      dateConfidence:    pdf?.dateConfidence    || 'low',

      source: pdf ? 'document-index+pdf' : 'document-index'
    };

  // ══════════════════════════════════════════
  // PATH B: PDF only (no indexed record)
  // ══════════════════════════════════════════
  } else if (pdf) {
    out = {
      title: archiveFallback.title,

      summary: (() => {
        const _m = inferDisplayModel({
          ai:    pdf.ai || null,
          rawText: pdf.text || '',
          lines:   pdf.lines || [],
          fallbackTitle: file?.name || '',
          amountHint:  pdf.grossAmount || '',
          dateHint:    pdf.invoiceDate || '',
          issuerHint:  pdf.company    || ''
        });
        return buildConservativeSummary(_m);
      })(),

      keywords: uniqLower([
        ...(pdf.keywords || []),
        ...(archiveFallback.keywords || [])
      ]),

      emails: uniqLower([
        ...(pdf.emails || []),
        ...(archiveFallback.emails || [])
      ]),

      documentKind: normalizeDisplayType(
        pdf.text || '',
        pdf?.ai?.semanticType || pdf?.ai?.type || ''
      ),

      dueDate: firstValue(pdf.dueDate, archiveFallback.dueDate),

      invoiceNo:   firstValue(pdf.invoiceNo,   archiveFallback.invoiceNo),
      invoiceDate: firstValue(pdf.invoiceDate),
      grossAmount: firstValue(pdf.grossAmount),
      company:     normalizeIssuer(
        sanitizeCompany(firstValue(pdf.company)),
        pdf.text || '',
        pdf.lines || []
      ),

      customerNo:    firstValue(pdf.customerNo),
      orderNo:       firstValue(pdf.orderNo),
      propertyNo:    firstValue(pdf.propertyNo),
      servicePeriod: firstValue(pdf.servicePeriod),

      netAmount:   firstValue(pdf.netAmount),
      taxAmount:   firstValue(pdf.taxAmount),

      iban:  firstValue(pdf.iban, archiveFallback.iban),
      bic:   firstValue(pdf.bic),
      ustId: firstValue(pdf.ustId, archiveFallback.ustId),

      recipient:   firstValue(pdf.recipient),
      subjectLine: firstValue(pdf.subjectLine),
      services:    pdf.services || [],

      importantFacts: buildImportantFactsFromPdf(pdf, archiveFallback),

      invoiceCandidates: [],
      amountCandidates:  [],
      companyCandidates: [],
      dateCandidates:    [],

      invoiceConfidence: pdf?.invoiceConfidence || 'low',
      amountConfidence:  pdf?.amountConfidence  || 'low',
      companyConfidence: pdf?.companyConfidence || 'low',
      dateConfidence:    pdf?.dateConfidence    || 'low',

      source: 'pdf'
    };

  // ══════════════════════════════════════════
  // PATH C: No PDF, no index → archive fallback
  // ══════════════════════════════════════════
  } else {
    out = archiveFallback;
  }

  __av3InsightCache.set(cacheKey, out);
  return out;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function normalizeInsightText(v) {
  return String(v || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitInsightLines(text) {
  return normalizeInsightText(text)
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function uniqLower(list) {
  const seen = new Set();
  const out = [];
  for (const item of (list || [])) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function extractEmailsFromText(text) {
  const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniqLower(matches);
}

function extractIbansFromText(text) {
  const matches = String(text || '').match(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,34}\b/g) || [];
  return uniqLower(matches.map(v => v.replace(/\s+/g, ' ').trim()));
}

function extractUstIdFromText(text) {
  const rxList = [
    /\b(?:USt-IdNr\.?|USt-ID\.?|Umsatzsteuer-ID\.?|VAT ID\.?)[:\s]*([A-Z]{2}[A-Z0-9\- ]{6,20})/i,
    /\b(DE[0-9]{9})\b/i
  ];
  for (const rx of rxList) {
    const m = String(text || '').match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractInvoiceNoFromText(text, lines) {
  const t = String(text || '');

  const patterns = [
    /\bRechnungsnr\.?\s*[:#]?\s*([A-Z0-9\/\-]+)/i,
    /\bRechnung\s*(?:No\.?|Nr\.?)\s*[:#]?\s*([A-Z0-9\/\-]+)/i,
    /\bInvoice\s*(?:No\.?|Number)\s*[:#]?\s*([A-Z0-9\/\-]+)/i,
    /\bBelegnummer\s*[:#]?\s*([A-Z0-9\/\-]+)/i,
    /\bReferenz\s*[:#]?\s*([A-Z0-9\/\-]+)/i
  ];

  for (const rx of patterns) {
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim();
  }

  for (const line of (lines || []).slice(0, 30)) {
    if (/rechnungsnr|rechnung|invoice|referenz|beleg/i.test(line) && /[A-Z0-9\/\-]{5,}/.test(line)) {
      const mm = line.match(/([A-Z0-9\/\-]{5,})/);
      if (mm && mm[1]) return mm[1].trim();
    }
  }

  return '';
}
function extractInvoiceNoCandidates(text, lines) {
  const t = String(text || '');
  const cleanLines = (lines || []).map(l => String(l || '').trim()).filter(Boolean);
  const candidates = [];

  // ── Contexts that disqualify a value from being a Rechnungsnummer ──
  const NON_INVOICE_CTX = /\b(?:kundennr?\.?|kundennummer|customer[\s\-]*(?:no\.?|number|id)|auftragsnr?\.?|auftragsnummer|bestellnr?\.?|bestellnummer|objektnr?\.?|objektnummer|projektnr?\.?|projektnummer|vertragsnr?\.?|vertragsnummer|angebotsnr?\.?|angebotsnummer|liegenschaftsnr?\.?|debitorennr?\.?|lieferantennr?\.?|sachkonto|kostenstelle)\b/i;

  // ── Strong invoice-number label context ──
  const INVOICE_LABEL = /\b(?:rechnungsnr?\.?|rechnungsnummer|rechnung(?:\s*nr\.?|\s*no\.?|\s*#)?|invoice[\s\-]*(?:no\.?|number|#)|belegnr?\.?|belegnummer)\b/i;

  // ── Weak / secondary label context ──
  const INVOICE_WEAK_LABEL = /\b(?:referenz(?:nr?\.?|nummer)?|re\.?\s*nr\.?|dokument(?:en)?nr?\.?|vorgangsnr?\.?|our\s*ref\.?|your\s*ref\.?)\b/i;

  // ── Value-level bad-value guard ──
  function isBadValue(val) {
    if (!val) return true;
    const v = String(val).trim();

    if (v.length < 3 || v.length > 32) return true;

    // Date pattern
    if (/\d{2}[.\-\/]\d{2}[.\-\/]\d{2,4}/.test(v)) return true;

    // Amount: comma-decimal
    if (/\d+,\d{2}$/.test(v)) return true;

    // IBAN prefix
    if (/^[A-Z]{2}\d{2}/.test(v)) return true;

    // Bank/account keywords
    if (/iban|bic|konto|bank/i.test(v)) return true;

    // Pure 4-digit year
    if (/^\d{4}$/.test(v) && +v >= 1990 && +v <= 2099) return true;

    // Postal code (5 digits)
    if (/^\d{5}$/.test(v)) return true;

    // Very short pure-digit (extension numbers, page numbers, etc.)
    if (/^\d{1,4}$/.test(v)) return true;

    // Looks like a phone number (many digits, no letters)
    if (/^[\d\s\-\+\(\)\/]{9,}$/.test(v) && !/[A-Za-z]/.test(v)) return true;

    // All zeros
    if (/^0+$/.test(v)) return true;

    return false;
  }

  function getCtx(t, val) {
    const idx = t.indexOf(val);
    if (idx === -1) return '';
    return t.slice(Math.max(0, idx - 100), idx + val.length + 100);
  }

  function lineIndex(val) {
    for (let i = 0; i < cleanLines.length; i++) {
      if (cleanLines[i].includes(val)) return i;
    }
    return -1;
  }

  // ── PASS 1: Label + value on SAME line (strongest signal) ──
  // Match label followed (on same line) by an alphanumeric token
  const SAME_LINE_RX = /\b(?:rechnungsnr?\.?|rechnungsnummer|rechnung\s*(?:nr\.?|no\.?|#)|invoice[\s\-]*(?:no\.?|number|#)|belegnr?\.?|belegnummer)\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\.\-\/]{2,28})/gi;
  let slm;
  while ((slm = SAME_LINE_RX.exec(t)) !== null) {
    const val = slm[1].replace(/[.\-\/]$/, '').trim(); // strip trailing separators
    if (isBadValue(val)) continue;
    if (NON_INVOICE_CTX.test(val)) continue;
    candidates.push({ value: val, score: 1.0, reason: 'label-sameline' });
  }

  // ── PASS 2: Label on its own line → value on NEXT line ──
  const LABEL_ONLY_RX = /^(?:rechnungsnr?\.?|rechnungsnummer|rechnung\s*(?:nr\.?|no\.?|#)|invoice[\s\-]*(?:no\.?|number|#)|belegnr?\.?|belegnummer)\s*[:\-#]?\s*$/i;
  for (let i = 0; i < cleanLines.length - 1; i++) {
    if (!LABEL_ONLY_RX.test(cleanLines[i])) continue;
    const next = cleanLines[i + 1];
    // Value on next line: take the first alphanumeric token
    const nm = next.match(/^([A-Z0-9][A-Z0-9\.\-\/]{2,28})(?:\s|$)/i);
    if (!nm) continue;
    const val = nm[1].replace(/[.\-\/]$/, '').trim();
    if (isBadValue(val)) continue;
    if (NON_INVOICE_CTX.test(next)) continue;
    candidates.push({ value: val, score: 0.97, reason: 'label-nextline' });
  }

  // ── PASS 3: Weak label (Referenz etc.) same-line ──
  const WEAK_SAME_RX = /\b(?:referenz(?:nr?\.?|nummer)?|re\.?\s*nr\.?|dokument(?:en)?nr?\.?\s*(?:nr\.?)?|vorgangsnr?\.?)\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\.\-\/]{2,28})/gi;
  let wsm;
  while ((wsm = WEAK_SAME_RX.exec(t)) !== null) {
    const val = wsm[1].replace(/[.\-\/]$/, '').trim();
    if (isBadValue(val)) continue;
    if (NON_INVOICE_CTX.test(getCtx(t, val))) continue;
    candidates.push({ value: val, score: 0.74, reason: 'weak-label-sameline' });
  }

  // ── PASS 4: Pattern scan across the full text (context-scored) ──
  // Typical invoice number patterns: letter prefix + digits, or long digit strings
  const PATTERN_RX = /\b([A-Z]{1,5}[-\/]?(?:20\d{2}[-\/])?\d{4,}(?:[-\/][A-Z0-9]{1,6})?|\d{4,}[-\/][A-Z]{1,5}|\d{7,})\b/g;
  let pm;
  while ((pm = PATTERN_RX.exec(t)) !== null) {
    const val = pm[1];
    if (isBadValue(val)) continue;

    const ctx = getCtx(t, val);

    // Hard skip: clearly in non-invoice context
    if (NON_INVOICE_CTX.test(ctx)) continue;

    let score = 0.38;
    let reason = 'pattern-generic';

    if (INVOICE_LABEL.test(ctx)) {
      score = 0.88;
      reason = 'pattern-invoice-ctx';
    } else if (INVOICE_WEAK_LABEL.test(ctx)) {
      score = 0.66;
      reason = 'pattern-weak-ctx';
    }

    // Position bonus: header zone (first 20 lines)
    const li = lineIndex(val);
    if (li >= 0 && li < 20) score = Math.min(1.0, score + 0.06);

    // Only emit if worth considering
    if (score < 0.40) continue;

    candidates.push({ value: val.trim(), score, reason });
  }

  return dedupeCandidates(candidates);
}


// ═══════════════════════════════════════════════════════════════════════════════
// 2. extractAmountCandidates
// ═══════════════════════════════════════════════════════════════════════════════

function extractAmountCandidates(text) {
  const t = String(text || '');
  const candidates = [];

  // ── Helpers ──
  function fmt(raw) {
    // Store original German format with € appended if missing
    const s = String(raw || '').trim().replace(/\s+(?=€|EUR)/i, '');
    if (!/€|EUR/i.test(s)) return s + ' €';
    return s;
  }

  function leftCtx(t, idx) {
    return t.slice(Math.max(0, idx - 120), idx);
  }

  function rightCtx(t, idx, len) {
    return t.slice(idx + len, idx + len + 60);
  }

  // ── Negative contexts: these amounts are NOT the gross total ──
  const NEGATIVE_LEFT = /\b(?:netto(?:betrag)?|zzgl\.?|zuzügl\.|mehrwertsteuer|mwst\.?|ust\.?|umsatzsteuer|vat\b|tax\b|einzeln|stückpreis|preis\s*je|preis\/(?:stk|stück|m[²³]?|km)|à\b|einzel(?:preis|betrag)|anzahl|menge|pos(?:ition)?\.?\s*\d|rabatt|skonto|abzug|anzahlung|teilbetrag|vorauszahlung|bereits\s*(?:bezahlt|gezahlt)|abschlag)\b/i;
  const MEDIUM_LEFT   = /\b(?:netto|zwischensumme|sub\s*total)\b/i;

  // ── Priority-1 patterns: named-label exact matches (highest confidence) ──
  // These run on the full text and extract amounts directly from labelled contexts.
  const NAMED_PATTERNS = [
    { rx: /\b(?:rechnungsbetrag|zahlbetrag|zu\s+zahlen(?:\s+sind)?|endbetrag|abschlussbetrag|totalbetrag)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 1.0, reason: 'invoice-total' },
    { rx: /\b(?:gesamtbetrag\s+(?:inkl\.?\s*(?:mwst|ust|steuer)|brutto)|summe\s+(?:inkl\.?\s*(?:mwst|ust|steuer)|brutto)|bruttobetrag|bruttosumme)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.97, reason: 'gross-brutto' },
    { rx: /\b(?:summe\s+brutto|gesamtbetrag\s+brutto|gesamt(?:betrag)?(?:\s+brutto)?|endsumme)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.95, reason: 'gross-total' },
    { rx: /\b(?:grand\s+total|total\s+amount|amount\s+due|total\s+due)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.94, reason: 'grand-total-en' },
    { rx: /\b(?:gesamtbetrag|gesamtsumme)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.93, reason: 'gesamt' },
    { rx: /\b(?:gesamt|summe|total|amount)\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.82, reason: 'total-generic' },
    { rx: /\bbrutto\b[^\n\d]{0,60}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR)?/gi, score: 0.78, reason: 'brutto-label' },
  ];

  for (const { rx, score, reason } of NAMED_PATTERNS) {
    const rxCopy = new RegExp(rx.source, rx.flags);
    let m;
    while ((m = rxCopy.exec(t)) !== null) {
      const raw = m[1];
      if (!raw) continue;

      // Reject if the label context itself indicates netto/tax
      const lc = leftCtx(t, m.index);
      if (NEGATIVE_LEFT.test(lc.slice(-80))) continue;

      candidates.push({ value: fmt(raw), score, reason });
    }
  }

  // ── Priority-2: Generic scan with context scoring ──
  const AMOUNT_RX = /\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d{4,},\d{2})\s*(?:€|EUR)?\b/g;
  let am;
  while ((am = AMOUNT_RX.exec(t)) !== null) {
    const raw = am[1];
    const idx = am.index;
    const lc = leftCtx(t, idx);
    const rc = rightCtx(t, idx, am[0].length);

    // Reject if clearly in a negative (netto/tax/unit-price) context
    if (NEGATIVE_LEFT.test(lc.slice(-100))) continue;

    let score = 0.42;
    let reason = 'generic';

    if (/rechnungsbetrag|zahlbetrag|zu\s+zahlen|endbetrag|abschlussbetrag/i.test(lc)) {
      score = 0.98; reason = 'invoice-total-ctx';
    } else if (/gesamtbetrag\s+(?:brutto|inkl)|summe\s+(?:brutto|inkl)|bruttobetrag|bruttosumme/i.test(lc)) {
      score = 0.95; reason = 'gross-ctx';
    } else if (/grand\s+total|total\s+amount|amount\s+due/i.test(lc)) {
      score = 0.93; reason = 'grand-total-en-ctx';
    } else if (/gesamtbetrag|gesamtsumme/i.test(lc)) {
      score = 0.91; reason = 'gesamt-ctx';
    } else if (/\bgesamt\b|\bsumme\b|\btotal\b|\bbetrag\b/i.test(lc)) {
      score = 0.78; reason = 'total-generic-ctx';
    } else if (/\bbrutto\b/i.test(lc)) {
      score = 0.72; reason = 'brutto-ctx';
    } else if (MEDIUM_LEFT.test(lc)) {
      score = 0.50; reason = 'medium-ctx';
    } else if (/\bnetto\b/i.test(lc)) {
      score = 0.40; reason = 'netto-ctx';
    } else if (/\bmwst|ust|umsatzsteuer|tax|vat\b/i.test(lc)) {
      score = 0.28; reason = 'tax-ctx';
    }

    // Bonus: € or EUR immediately follows the number
    if (/^\s*(?:€|EUR)\b/i.test(rc)) score = Math.min(1.0, score + 0.04);

    // Parse and sanity-check the numeric value
    const numeric = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(numeric) || numeric < 0.01) continue;
    // Very small amounts (< 1 €) are almost never the invoice total
    if (numeric < 1.0) continue;

    score = Math.max(0.10, Math.min(1.0, score));
    candidates.push({ value: fmt(raw), score, reason });
  }

  const deduped = dedupeCandidates(candidates);

  // ── Post-process: if there's a clear gross winner (>= 0.90),
  //    suppress all others to prevent netto/tax from accidentally being chosen ──
  const topScore = deduped.reduce((mx, c) => Math.max(mx, c.score || 0), 0);
  if (topScore >= 0.90) {
    return deduped.map(c => ({
      ...c,
      score: (c.score || 0) >= 0.88 ? c.score : Math.min(c.score || 0, 0.50)
    }));
  }

  return deduped;
}

// ═════════════════════════════════════════════════════════════
// COMPANY CANDIDATE ENGINE
// ═════════════════════════════════════════════════════════════
function extractCompanyCandidates(text, lines) {
  const t = String(text || '');
  const cleanLines = (lines || []).map(l => String(l || '').trim()).filter(Boolean);
  const candidates = [];

  // ── Label words that signal "next line = company name" ──
  const COMPANY_LABEL_ONLY_RX = /^(?:firma|lieferant|rechnungsaussteller|kreditor|absender|auftragnehmer|leistungserbringer|dienstleister|von|from|supplier|vendor)\s*[:\.\-]?\s*$/i;

  // ── Inline label: "Firma: XY GmbH" ──
  const COMPANY_LABEL_INLINE_RX = /\b(?:firma|lieferant|rechnungsaussteller|kreditor|absender|auftragnehmer|leistungserbringer)\s*[:\-]\s*(.{3,120})/i;

  // ── Lines that can NEVER be a company name ──
  const DISQUALIFY_RX = /\b(?:rechnung|invoice|angebot|gutschrift|mahnung|abrechnung|lieferung|bestellung|beleg|quittung|storno|seite\s*\d|page\s*\d|mwst|ust|steuer(?:nr|nummer|id)?|bank(?:verbindung)?|iban|bic|tel\.?|telefon|fax|mobil|www\.|\.(?:de|com|eu|net|org)|gericht|handelsregister|vorstand|aufsichtsrat|prokura|amtsgericht)\b/i;

  // ── Address line signals ──
  const ADDRESS_RX = /\b(?:str(?:aße|asse)?\.?|straße|strasse|weg|allee|platz|ring|gasse|damm|ufer|chaussee)\b|\b\d{5}\s+[A-ZÄÖÜ]|\bpostfach\b/i;

  // ── Legal form (strong signal) ──
  const LEGAL_RX = /\b(?:GmbH|AG\b|KG\b|UG\b|OHG\b|GbR\b|e\.K\.|SE\b|mbH|Co\.\s*KG|Ltd\.?|S\.A\.|S\.r\.l\.)\b/;

  // ── 1. Inline label match ──
  const inlineM = t.match(COMPANY_LABEL_INLINE_RX);
  if (inlineM && inlineM[1]) {
    const val = inlineM[1]
      .replace(/\s*[,;:]\s*$/, '')           // strip trailing punctuation
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (val.length > 2 && !DISQUALIFY_RX.test(val) && !ADDRESS_RX.test(val)) {
      candidates.push({ value: val, score: 1.0, reason: 'label-inline' });
    }
  }

  // ── 2. Label line → next line is company name ──
  for (let i = 0; i < cleanLines.length - 1; i++) {
    const line = cleanLines[i];
    const next = cleanLines[i + 1];

    if (!COMPANY_LABEL_ONLY_RX.test(line)) continue;
    if (!next || next.length < 3) continue;
    if (DISQUALIFY_RX.test(next)) continue;
    if (ADDRESS_RX.test(next)) continue;
    if (/^\d/.test(next)) continue;             // starts with digit → not a name
    if (/^[A-Z0-9]{1,6}$/.test(next)) continue; // short all-caps code

    candidates.push({ value: next.trim(), score: 0.99, reason: 'label-nextline' });
  }

  // ── 3. Legal-form pattern in full text ──
  // Match: "Word Word ... GmbH" — require start with uppercase
  const LEGAL_MATCH_RX = /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9&,.\s\-]{1,80}?)\s+(GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|UG(?:\s*\(haftungsbeschränkt\))?|OHG|GbR|e\.K\.|SE|mbH|Co\.\s*KG|Ltd\.?)/g;
  let lm;
  while ((lm = LEGAL_MATCH_RX.exec(t)) !== null) {
    const full = (lm[1] + ' ' + lm[2]).replace(/\s{2,}/g, ' ').trim();

    if (full.length > 120 || full.length < 4) continue;
    if (DISQUALIFY_RX.test(full)) continue;
    if (ADDRESS_RX.test(full)) continue;

    // Find position
    const li = cleanLines.findIndex(l => l.includes(lm[1].trim()) || l.includes(full));
    let score = 0.86;
    if (li >= 0 && li < 4)  score = 0.95;
    else if (li >= 0 && li < 8)  score = 0.90;
    else if (li >= 0 && li < 14) score = 0.87;

    candidates.push({ value: full, score, reason: 'legal-form' });
  }

  // ── 4. Header zone scan (first 10 lines, no legal form needed) ──
  for (let i = 0; i < Math.min(cleanLines.length, 10); i++) {
    const line = cleanLines[i];

    if (!line || line.length < 4 || line.length > 100) continue;
    if (DISQUALIFY_RX.test(line)) continue;
    if (ADDRESS_RX.test(line)) continue;
    if (COMPANY_LABEL_ONLY_RX.test(line)) continue;  // skip pure label lines
    if (/^\d/.test(line)) continue;
    if (/^[A-Z0-9\/\-\.]{2,20}$/.test(line)) continue; // short code
    if (/@/.test(line)) continue;                         // email address in line
    if (/\b\d{5}\b/.test(line)) continue;                 // postal code in line

    // Reject high digit-ratio lines (reference numbers, amounts)
    const digitCount = (line.match(/\d/g) || []).length;
    if (digitCount / line.length > 0.30) continue;

    let score = 0.58;
    let reason = 'header-zone';

    if (LEGAL_RX.test(line)) {
      score = 0.88; reason = 'header-legal';
    } else if (/\b(?:&|verwaltung|immobilien|holding|service(?:s)?|beratung|logistik|handel|bau|gebäude|facilit|consulting|engineering|group|GmbH|AG)\b/i.test(line)) {
      score = 0.72; reason = 'header-company-like';
    } else if (/[a-zäöüß]{4,}/.test(line) && line.split(/\s+/).length >= 2) {
      // Multi-word line with genuine lowercase letters: plausible company name
      score = 0.62; reason = 'header-multiword';
    } else {
      // Single word, all-uppercase or mixed short → only keep for very early lines
      if (i >= 3) continue;
      score = 0.56; reason = 'header-early';
    }

    candidates.push({ value: line.trim(), score, reason });
  }

  return dedupeCandidates(candidates);
}

function getContext(text, value) {
  const idx = text.indexOf(value);
  if (idx === -1) return '';

  return text.slice(Math.max(0, idx - 50), idx + 50);
}

function normalizeAmount(val) {
  return val
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
}
function isBadInvoiceCandidate(val) {
  if (!val) return true;

  const v = val.toLowerCase();

  // ❌ Datum
  if (/\d{2}[.\-\/]\d{2}[.\-\/]\d{2,4}/.test(v)) return true;

  // ❌ Betrag
  if (/\d+,\d{2}/.test(v)) return true;

  // ❌ IBAN / Bank
  if (/iban|bic|konto|bank/.test(v)) return true;

  // ❌ zu lang (IBAN etc.)
  if (val.length > 25) return true;

  // ❌ zu kurz
  if (val.length < 4) return true;

  // ❌ nur Zahlen (meist falsch)
  if (/^\d+$/.test(val)) return true;

  return false;
}
function extractDueDateFromText(text) {
  const rxList = [
    /\b(?:fällig am|faellig am|zahlbar bis|due date|due on)[:\s]*([0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4})/i,
    /\b(?:Zahlungsziel|Fälligkeit|Faelligkeit)[:\s]*([0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4})/i
  ];
  for (const rx of rxList) {
    const m = String(text || '').match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function detectDocumentKindFromText(text) {
  return normalizeDisplayType(String(text || ''), '');
}

function extractKeywordsFromText(text, lines) {
  const hay = String(text || '').toLowerCase();
  const found = [];

  const keywordMap = [
    ['Versicherung', /\bversicherung\b|\bpolice\b|\bschaden\b/],
    ['Steuer', /\bsteuer\b|\bfinanzamt\b|\bust\b|\bvat\b/],
    ['Energie', /\bstrom\b|\bgas\b|\benergie\b|\bversorger\b/],
    ['Wasser', /\bwasser\b|\babwasser\b/],
    ['Telekommunikation', /\btelekom\b|\bvodafone\b|\bo2\b|\binternet\b|\bdsl\b|\bmobilfunk\b/],
    ['Handwerker', /\breparatur\b|\bwartung\b|\bmontage\b|\belektriker\b|\bheizung\b|\bsanit/i],
    ['Nebenkosten', /\bnebenkosten\b|\bbetriebskosten\b|\bhausgeld\b/],
    ['Zahlung', /\bfällig\b|\bfaellig\b|\bzahlbar\b|\büberweisung\b|\bueberweisung\b/],
    ['IBAN', /\biban\b/],
    ['Rechnungsnummer', /\brechnungsnummer\b|\binvoice number\b|\bbelegnummer\b/]
  ];

  for (const [label, rx] of keywordMap) {
    if (rx.test(hay)) found.push(label);
  }

  for (const line of (lines || []).slice(0, 20)) {
    if (/objekt|liegenschaft/i.test(line)) found.push('Objektbezug');
    if (/fällig|faellig|zahlbar/i.test(line)) found.push('Frist');
  }

  return uniqLower(found);
}
function extractBestAmountFromText(text) {
  const t = String(text || '');

  const preferredPatterns = [
    /(?:Summe\s*Brutto(?:\s*EUR)?|Gesamtbetrag(?:\s*brutto)?|Rechnungsbetrag|Endbetrag)[^0-9]{0,30}([0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})/i,
    /(?:Total\s*Amount|Grand\s*Total)[^0-9]{0,30}([0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})/i
  ];

  for (const rx of preferredPatterns) {
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim() + ' €';
  }

  const fallbackPatterns = [
    /(?:Gesamtbetrag|Summe|Total)[^0-9]{0,30}([0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})/i
  ];

  for (const rx of fallbackPatterns) {
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim() + ' €';
  }

  return '';
}
function extractFieldByLabel(text, labels) {
  const t = String(text || '');
  for (const label of (labels || [])) {
    const rx = new RegExp(`\\b${label}\\s*[:]?\\s*([^\\n]{1,120})`, 'i');
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractInvoiceDateFromText(text) {
  const m = String(text || '').match(
    /(datum|rechnungsdatum)\s*[:\-]?\s*(\d{2}\.\d{2}\.\d{4})/i
  );
  return m ? m[2] : '';
}
// ═════════════════════════════════════════════════════════════
// DATE CANDIDATE ENGINE
// ═════════════════════════════════════════════════════════════

function extractDateCandidates(text, lines) {
  const t = String(text || '');
  const cleanLines = (lines || []).map(l => String(l || '').trim()).filter(Boolean);
  const candidates = [];

  // ── Validation ──
  function validDate(d, mo, y) {
    return d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 1990 && y <= 2050;
  }

  function parseDE(val) {
    const m = String(val).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    const [, ds, ms, ys] = m;
    const d = +ds, mo = +ms, y = +ys;
    if (!validDate(d, mo, y)) return null;
    return `${String(d).padStart(2,'0')}.${String(mo).padStart(2,'0')}.${y}`;
  }

  function parseISO(val) {
    const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [, ys, ms, ds] = m;
    const d = +ds, mo = +ms, y = +ys;
    if (!validDate(d, mo, y)) return null;
    return `${String(d).padStart(2,'0')}.${String(mo).padStart(2,'0')}.${y}`;
  }

  const MONTH_NAMES = {
    januar:'01', januar:'01', february:'02', februar:'02',
    'märz':'03', maerz:'03', march:'03', april:'04',
    mai:'05', may:'05', juni:'06', june:'06',
    juli:'07', july:'07', august:'08', september:'09',
    oktober:'10', october:'10', november:'11', dezember:'12', december:'12'
  };

  function parseWritten(val) {
    const m = String(val).match(/^(\d{1,2})\s*\.?\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|January|February|March|June|July|August|September|October|November|December)\s+(\d{4})$/i);
    if (!m) return null;
    const d = +m[1];
    const mo = MONTH_NAMES[m[2].toLowerCase()];
    const y = +m[3];
    if (!mo || !validDate(d, +mo, y)) return null;
    return `${String(d).padStart(2,'0')}.${mo}.${y}`;
  }

  function leftCtx(t, idx, n) {
    return t.slice(Math.max(0, idx - n), idx);
  }

  function isDueDateCtx(lc) {
    return /\b(?:fällig(?:\s*am)?|faellig(?:\s*am)?|zahlbar\s*bis|zahlungsziel|due\s*(?:date|on|by)?|frist)\b/i.test(lc);
  }

  function isServiceDateCtx(lc) {
    return /\b(?:leistungsdatum|leistungszeitraum|abrechnungszeitraum|berechnet\s*(?:am|vom))\b/i.test(lc);
  }

  function isInvoiceDateCtx(lc) {
    return /\b(?:rechnungsdatum|belegdatum|invoice\s*date|datum\s*der\s*rechnung)\b/i.test(lc);
  }

  function isDatumCtx(lc) {
    return /(?:^|\s)datum\s*[:\-]?\s*$/i.test(lc.trimEnd());
  }

  // ── PASS 1: Strong label + date on SAME line ──
  const INVOICE_DATE_SAME = /\b(?:rechnungsdatum|belegdatum|invoice\s*date|datum\s*der\s*rechnung)\s*[:\-]?\s*(\d{1,2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})/gi;
  let idm;
  while ((idm = INVOICE_DATE_SAME.exec(t)) !== null) {
    const parsed = parseDE(idm[1]) || parseISO(idm[1]);
    if (parsed) candidates.push({ value: parsed, score: 1.0, reason: 'invoice-date-sameline' });
  }

  // ── PASS 2: "Datum:" label + date on same line ──
  const DATUM_SAME = /(?:^|\s)datum\s*[:\-]?\s*(\d{1,2}\.\d{2}\.\d{4})/gi;
  let dsm;
  while ((dsm = DATUM_SAME.exec(t)) !== null) {
    const parsed = parseDE(dsm[1]);
    if (parsed) candidates.push({ value: parsed, score: 0.88, reason: 'datum-sameline' });
  }

  // ── PASS 3: Label on its own line → date on next line ──
  const DATE_LABEL_ONLY = /^(?:rechnungsdatum|belegdatum|invoice\s*date|datum)\s*[:\-.]?\s*$/i;
  for (let i = 0; i < cleanLines.length - 1; i++) {
    if (!DATE_LABEL_ONLY.test(cleanLines[i])) continue;
    const next = cleanLines[i + 1];
    const parsed = parseDE(next) || parseISO(next);
    if (parsed) candidates.push({ value: parsed, score: 0.97, reason: 'date-label-nextline' });
  }

  // ── PASS 4: Written dates (e.g. "15. Januar 2025") ──
  const WRITTEN_RX = /\b(\d{1,2})\s*\.?\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|January|February|March|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;
  let wm;
  while ((wm = WRITTEN_RX.exec(t)) !== null) {
    const parsed = parseWritten(wm[0].trim());
    if (!parsed) continue;
    const lc = leftCtx(t, wm.index, 100);
    let score = 0.70;
    if (isInvoiceDateCtx(lc)) score = 0.95;
    else if (isDatumCtx(lc)) score = 0.86;
    else if (isServiceDateCtx(lc)) score = 0.62;
    else if (isDueDateCtx(lc)) score = 0.32;
    candidates.push({ value: parsed, score, reason: 'written-date' });
  }

  // ── PASS 5: Service date labels (lower priority) ──
  const SERVICE_DATE_RX = /\b(?:leistungsdatum|berechnet\s*am)\s*[:\-]?\s*(\d{1,2}\.\d{2}\.\d{4})/gi;
  let sm;
  while ((sm = SERVICE_DATE_RX.exec(t)) !== null) {
    const parsed = parseDE(sm[1]);
    if (parsed) candidates.push({ value: parsed, score: 0.58, reason: 'service-date' });
  }

  // ── PASS 6: Due-date labels (do NOT use as invoice date, keep separate context for dueDate extraction) ──
  // We include these at low score so they are not chosen as the invoice date.
  const DUE_DATE_RX = /\b(?:fällig(?:\s*am)?|faellig(?:\s*am)?|zahlbar\s*bis|zahlungsziel\s*(?:bis)?|due\s*(?:date|on|by)?)\s*[:\-]?\s*(\d{1,2}\.\d{2}\.\d{4})/gi;
  let udm;
  while ((udm = DUE_DATE_RX.exec(t)) !== null) {
    const parsed = parseDE(udm[1]);
    if (parsed) candidates.push({ value: parsed, score: 0.28, reason: 'due-date' });
  }

  // ── PASS 7: Generic German dates across all text (context-scored) ──
  const GEN_DE_RX = /\b(\d{1,2}\.\d{2}\.\d{4})\b/g;
  let gm;
  while ((gm = GEN_DE_RX.exec(t)) !== null) {
    const raw = gm[1];
    const parsed = parseDE(raw);
    if (!parsed) continue;

    const lc = leftCtx(t, gm.index, 110);

    // Skip if this is a due-date context (already captured above with lower score)
    if (isDueDateCtx(lc)) continue;

    let score = 0.44;
    let reason = 'generic-de';

    if (isInvoiceDateCtx(lc)) {
      score = 0.95; reason = 'generic-invoice-ctx';
    } else if (isDatumCtx(lc)) {
      score = 0.84; reason = 'generic-datum-ctx';
    } else if (isServiceDateCtx(lc)) {
      score = 0.58; reason = 'generic-service-ctx';
    } else {
      // Header-zone bonus for generic dates
      const li = cleanLines.findIndex(l => l.includes(raw));
      if (li >= 0 && li < 12) score = Math.min(0.65, score + 0.14);
    }

    candidates.push({ value: parsed, score: Math.max(0.20, Math.min(1.0, score)), reason });
  }

  // ── PASS 8: ISO dates ──
  const ISO_RX = /\b(\d{4}-\d{2}-\d{2})\b/g;
  let im;
  while ((im = ISO_RX.exec(t)) !== null) {
    const parsed = parseISO(im[1]);
    if (!parsed) continue;
    const lc = leftCtx(t, im.index, 110);
    let score = 0.50;
    if (isInvoiceDateCtx(lc)) score = 0.92;
    else if (isDatumCtx(lc)) score = 0.80;
    candidates.push({ value: parsed, score, reason: 'iso-date' });
  }

  return dedupeCandidates(candidates);
}


function isBadDateCandidate(val) {
  if (!val) return true;

  const m = String(val).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return true;

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);

  if (day < 1 || day > 31) return true;
  if (month < 1 || month > 12) return true;
  if (year < 2000 || year > 2100) return true;

  return false;
}
function extractCustomerNoFromText(text) {
  return extractFieldByLabel(text, [
    'Kundennr\\.?', 'Kundennummer', 'Customer No\\.?', 'Customer Number'
  ]);
}

function extractOrderNoFromText(text) {
  const m = String(text || '').match(
    /(auftragsnummer|bestellnummer)\s*[:\-]?\s*([A-Z0-9\-]+)/i
  );
  return m ? m[2] : '';
}

function extractPropertyNoFromText(text) {
  return extractFieldByLabel(text, [
    'Liegenschaftsnummer', 'Objektnummer', 'Property No\\.?'
  ]);
}

function extractServicePeriodFromText(text) {
  const t = String(text || '');
  const patterns = [
    /\bAbrechnungszeitraum\s*[:]?[\s]*([0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4}\s*[-–]\s*[0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4})/i,
    /\bLeistungszeitraum\s*[:]?[\s]*([0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4}\s*[-–]\s*[0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4})/i,
    /\bberechnet vom\s*([0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4}\s*[-–]\s*[0-3]?\d[.\-/][0-1]?\d[.\-/](?:20)?\d{2,4})/i
  ];
  for (const rx of patterns) {
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractMoneyByLabel(text, labels) {
  const t = String(text || '');
  for (const label of (labels || [])) {
    const rx = new RegExp(`\\b${label}\\b[^0-9]{0,30}([0-9]{1,3}(?:[.\\s][0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})`, 'i');
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim() + ' €';
  }
  return '';
}

function extractNetAmountFromText(text) {
  return extractMoneyByLabel(text, ['Nettobetrag', 'Summe Netto', 'Netto']);
}

function extractTaxAmountFromText(text) {
  return extractMoneyByLabel(text, ['MwSt\\.?-?Betrag', 'Umsatzsteuer', 'Tax']);
}

function extractGrossAmountFromText(text) {
  return (
    extractMoneyByLabel(text, ['Rechnungsbetrag', 'Summe Brutto(?: EUR)?', 'Gesamtbetrag(?: brutto)?', 'Endbetrag', 'Total Amount', 'Grand Total']) ||
    extractBestAmountFromText(text)
  );
}

function extractBicFromText(text) {
  const m = String(text || '').match(/\bBIC\s*[:]?[\s]*([A-Z0-9]{8,11})\b/i);
  return m && m[1] ? m[1].trim() : '';
}

function extractCompanyFromText(text, lines) {
  const lns = lines || [];

  // 1. erste Zeilen scannen (typisch Kopfbereich)
  for (let i = 0; i < Math.min(8, lns.length); i++) {
    const line = lns[i];

    if (
      /(gmbh|ag|kg|ug|ltd|inc)/i.test(line) &&
      !/rechnung|invoice|angebot|gutschrift/i.test(line)
    ) {
      return line.trim();
    }
  }

  return '';
}
function extractRecipientFromText(text) {
  const t = String(text || '');
  const patterns = [
    /\bEmpfänger\s*[:]?[\s]*([^\n]{3,120})/i,
    /\bKäufer\s*[:]?[\s]*([^\n]{3,120})/i
  ];
  for (const rx of patterns) {
    const m = t.match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractSubjectLineFromText(text, lines) {
  const t = String(text || '');
  const direct = t.match(/\b(Mietrechnung\/Wartungsrechnung|Rechnung|Gutschrift|Mahnung|Angebot|Abrechnung)\b/i);
  if (direct && direct[1]) return direct[1].trim();

  const line = (lines || []).find(l =>
    /mietrechnung|wartungsrechnung|rechnung|gutschrift|mahnung|angebot|abrechnung/i.test(l)
  );
  return line || '';
}

function extractServiceLines(lines) {
  const out = [];

  for (const l of lines) {
    if (
      /^\d+\.\s/.test(l) &&
      /\d+,\d{2}\s*€/.test(l)
    ) {
      out.push(l.trim());
    }
  }

  return out.slice(0, 5);
}
function isBadSummaryLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (s.length < 6) return true;

  if (/^seite\s*\d+/i.test(s)) return true;
  if (/^(rechnung|invoice)\s*$/i.test(s)) return true;
  if (/^(rechnungsnr|auftragsnr|kundennr|warenausgangsnr|belegdatum|rechnungsdatum)\.?:?\s*$/i.test(s)) return true;

  if (/^[A-Z0-9\/\-.]{3,20}$/.test(s)) return true;
  if (/^[\d\s.,€%-]+$/.test(s)) return true;

  if (/^(telefon|fax|web|homepage|ust-id|iban|bic|tel\.?|e-mail|kontakt)\b/i.test(s)) return true;
  if (/\b(bankverbindung|kontonummer|handelsregister|vorstand|aufsichtsrat|sitz der gesellschaft)\b/i.test(s)) return true;
  if (/\b(iban|bic|ust-id|ust id|steuer-nr|steuernummer)\b/i.test(s)) return true;

  return false;
}

function scoreSummaryLine(line) {
  const s = String(line || '').trim();
  if (!s) return -999;
  if (isBadSummaryLine(s)) return -999;

  let score = 0;

  if (s.length >= 18) score += 2;
  if (s.length >= 30) score += 2;
  if (s.length <= 140) score += 1;

  if (/[a-zäöüß]{3,}/i.test(s)) score += 2;
  if (/\b(gmbh|ag|kg|ug|ohg|gbr)\b/i.test(s)) score += 3;

  if (/\b(rechnung|invoice|mietrechnung|wartungsrechnung|abrechnung|lieferung|bestellung|leistung)\b/i.test(s)) score += 4;
  if (/\b(abrechnungszeitraum|leistungszeitraum)\b/i.test(s)) score += 4;
  if (/\b(wandleuchte|leuchte|heizkostenverteiler|gateway|versandkosten|miete|wartung)\b/i.test(s)) score += 4;
  if (/\b(€|eur)\b/i.test(s)) score += 2;
  if (/\d+,\d{2}/.test(s)) score += 2;

  if (/\b(bank|iban|bic|konto|überweisung|ueberweisung)\b/i.test(s)) score -= 6;
  if (/\b(zahlbar|zahlung|frist|fällig|faellig)\b/i.test(s)) score -= 3;
  if (/\bschlussrechnung\b/i.test(s)) score -= 2;

  if (/^b75\s*[–-]/i.test(s)) score -= 2;

  return score;
}
/* ══════════════════════════════════════════════════════════════════════════
   DISPLAY MODEL PIPELINE  v5
   ══════════════════════════════════════════════════════════════════════════
   Architecture:
     STEP 1  normalizeDisplayType   – conservative type from text signals
     STEP 2  isForbiddenIssuerCandidate / normalizeIssuer  – role separation
     STEP 3  inferDisplayModel      – builds validated internal model
     STEP 4  buildConservativeTitle / buildConservativeSummary  – render only
   ══════════════════════════════════════════════════════════════════════════ */

/* ── helpers ── */

function _fmtAmountStr(v) {
  if (!v && v !== 0) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return '';
    return v.toFixed(2).replace('.', ',') + '\u00A0\u20AC';
  }
  const s = String(v).trim();
  if (!s) return '';
  if (/,\d{2}/.test(s) || /€/.test(s)) return s;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  if (Number.isFinite(n) && n > 0) return n.toFixed(2).replace('.', ',') + '\u00A0\u20AC';
  return s;
}

function _lcFirst(s) {
  const str = String(s || '').trim();
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}

/* ── STEP 1: conservative type detection ── */

function normalizeDisplayType(rawText, hintType) {
  const t = String(rawText || '').toLowerCase();
  const h = String(hintType || '').toLowerCase();

  // Bescheid signals are unambiguous — never degrade to Rechnung
  if (/\b(grundbesitzabgabenbescheid|abgabenbescheid|steuerbescheid|gebührenbescheid|gebuehrenbescheid|festsetzungsbescheid|feststellungsbescheid|bescheid)\b/.test(t)) return 'Bescheid';

  // Stornorechnung — detect before Rechnung to avoid wrong classification
  if (/\b(stornorechnung|storno-?rechnung)\b/.test(t)) return 'Stornorechnung';

  // Unambiguous negative/payment signals
  if (/\bzahlungserinnerung\b/.test(t)) return 'Zahlungserinnerung';
  if (/\bmahnung\b/.test(t)) return 'Mahnung';

  // Gutschrift: only when it appears as a standalone heading or label, not buried in body text
  if (/(?:^|[\n\r])\s*gutschrift\b/m.test(t) || /\bgutschrift\s*(?:nr\.?|nummer|#)\b/i.test(t)) return 'Gutschrift';

  if (/\bangebot\b|\boffer\b|\bofferte\b/.test(t)) return 'Angebot';

  // Versicherung: only if clearly dominant (not just a single casual mention in a utility bill)
  if (/\b(versicherungsschein|versicherungspolice|police\s*nr|police\s*nummer|versicherungsbeitrag|jahresbeitrag)\b/.test(t)) return 'Versicherung';
  if (/\bversicherung\b/.test(t) && !/\brechnung\b|\binvoice\b/.test(t)) return 'Versicherung';

  if (/\bvertrag\b|\bmietvertrag\b|\bdienstleistungsvertrag\b/.test(t)) return 'Vertrag';
  if (/\babrechnung\b/.test(t)) return 'Abrechnung';
  if (/\brechnung\b|\binvoice\b/.test(t)) return 'Rechnung';

  // Fallback: try AI hint if it maps to something known
  const hintMap = {
    rechnung: 'Rechnung', gutschrift: 'Gutschrift', mahnung: 'Mahnung',
    zahlungserinnerung: 'Zahlungserinnerung', angebot: 'Angebot',
    vertrag: 'Vertrag', abrechnung: 'Abrechnung', versicherung: 'Versicherung',
    bescheid: 'Bescheid', storno: 'Stornorechnung', stornorechnung: 'Stornorechnung'
  };
  if (h && hintMap[h]) return hintMap[h];

  return 'Dokument';
}

function _displayTypeLabel(type) {
  const map = {
    'Rechnung':           'Rechnung',
    'Gutschrift':         'Gutschrift',
    'Mahnung':            'Mahnung',
    'Zahlungserinnerung': 'Zahlungserinnerung',
    'Angebot':            'Angebot',
    'Vertrag':            'Vertrag',
    'Abrechnung':         'Abrechnung',
    'Versicherung':       'Versicherungsdokument',
    'Bescheid':           'Bescheid',
    'Stornorechnung':     'Stornorechnung',
    'Storno':             'Stornorechnung',
    'Dokument':           'Dokument'
  };
  return map[type] || type || 'Dokument';
}

/* ── STEP 2: issuer role separation ── */

function isForbiddenIssuerCandidate(name, rawText, lines) {
  if (!name) return true;
  const s = String(name).trim();
  if (s.length < 2) return true;

  // Hard block: postal/logistics services
  if (/\b(deutsche\s*post|dhl\b|hermes\b|dpd\b|ups\b|fedex\b|gls\b)\b/i.test(s)) return true;

  // Hard block: typical bank/payment context names
  const sl = s.toLowerCase();
  if (/\b(volksbank|sparkasse|commerzbank|deutsche\s*bank|postbank|comdirect|ing\b|dkb\b|targobank|hypovereinsbank)\b/i.test(s)) {
    // Only block if the name appears exclusively in a bank/payment line, not as letterhead
    const linesArr = Array.isArray(lines) ? lines : [];
    const inBankCtx = linesArr.some(l => {
      const ll = String(l || '').toLowerCase();
      return ll.includes(sl.slice(0, 10)) && /\b(iban|bic|kontonr|konto|blz|lastschrift|einzug|bankverbindung)\b/.test(ll);
    });
    if (inBankCtx) return true;
  }

  // Hard block: if name is only found in address-window zone (lines 2–8) and NOT in letterhead (lines 0–1)
  const linesArr = Array.isArray(lines) ? lines : [];
  if (linesArr.length >= 5) {
    const shortSl = sl.slice(0, 12);
    const inHeader  = linesArr.slice(0, 2).some(l => String(l || '').toLowerCase().includes(shortSl));
    const inAddrWin = linesArr.slice(2, 9).some(l => String(l || '').toLowerCase().includes(shortSl));
    if (inAddrWin && !inHeader) return true;
  }

  return false;
}

function isLikelyRecipientContext(lines, name) {
  if (!name) return false;
  const sl = String(name).toLowerCase().slice(0, 14);
  const RECIP_CTX = /\b(rechnung\s*an|lieferadresse|rechnungsadresse|empf.nger|an\s*:|zu\s*h.nden|kunde\s*:|kundennummer|auftraggeber|leistungsempf.nger)\b/i;
  const linesArr = Array.isArray(lines) ? lines : [];

  for (let i = 0; i < linesArr.length; i++) {
    if (!RECIP_CTX.test(String(linesArr[i] || ''))) continue;
    for (let j = i + 1; j <= Math.min(i + 5, linesArr.length - 1); j++) {
      if (String(linesArr[j] || '').toLowerCase().includes(sl)) return true;
    }
  }
  return false;
}

function normalizeIssuer(candidateName, rawText, lines) {
  if (!candidateName) return '';
  const s = String(candidateName).trim();
  if (!s || s.length < 2) return '';
  if (isForbiddenIssuerCandidate(s, rawText, lines)) return '';
  if (isLikelyRecipientContext(lines, s)) return '';
  return s;
}

/* ── helpers for display model ── */

function _extractDueDateFromLines(lines) {
  const joined = (lines || []).join('\n');
  const rxList = [
    /\b(?:fällig am|faellig am|zahlbar bis|due date|due on|zahlungsfrist bis)\s*[:\-]?\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
    /\b(?:Zahlungsziel|Fälligkeit|Faelligkeit)\s*[:\-]?\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
    /\b(?:bitte\s+(?:überweisen|zahlen)\s+bis)\s*[:\-]?\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i
  ];
  for (const rx of rxList) {
    const m = joined.match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function _extractServiceHint(lines, excludes) {
  const TABLE_HEADER_RX = /\b(menge|einheit|einzelpreis|pos\b|position|anz\b|art\.?-?nr|artikelnr|stk\.?|stück\.?|netto\s*eur|gesamt\s*eur|betrag\s*eur|preis\s*eur|netto\s*€|gesamt\s*€|qty|unit\s*price)\b/i;
  const BAD_LINE_RX     = /\b(iban|bic|swift|telefon|fax|www\.|e-?mail|ust-?id|steuer-?nr|handelsregister|bank|konto|überweisung|ueberweisung|fällig|faellig|zahlbar|sepa|mandats|einzug|lastschrift)\b/i;
  const ADDRESS_RX      = /\b\d{5}\s+[A-ZÄÖÜa-zäöüß]|\b(straße|strasse|postfach|str\.\s*\d)\b/i;
  const ONLY_CAPS_SHORT = /^[A-ZÄÖÜ0-9\s\-\/\.]{1,12}$/;

  const excl = new Set(
    [excludes.issuer, excludes.date, excludes.amountStr, excludes.ref, excludes.dueDate]
      .filter(Boolean)
      .map(v => v.toLowerCase().replace(/\s+/g, ' ').slice(0, 18))
  );

  const SERVICE_RX = /\b(wartung|reparatur|lieferung|installation|sanierung|montage|inspektion|service|reinigung|beratung|prüfung|überwachung|betriebskosten|nebenkosten|heizkosten|strom|gas|wasser|internet|software|lizenz|pflege|entsorgung|hausverwaltung|instandhaltung|spülkasten|fracht|versand|material|ersatz|pumpe|ventil|zähler|heizung|sanitär|miete|pacht|nutzung|verwaltung|reparaturen|umbau|ausbau|einbau|demontage|revision|verbrauch|abschlag|yachthafen|hafen|marina|moor)\b/i;

  const scored = [];
  for (const raw of (lines || [])) {
    const line = String(raw || '').trim();
    if (!line || line.length < 8 || line.length > 110) continue;
    if (TABLE_HEADER_RX.test(line)) continue;
    if (BAD_LINE_RX.test(line)) continue;
    if (ADDRESS_RX.test(line)) continue;
    if (isBadSummaryLine(line)) continue;
    if (ONLY_CAPS_SHORT.test(line)) continue;

    const ll = line.toLowerCase();
    if ([...excl].some(e => e.length >= 6 && ll.includes(e))) continue;
    if (!/[a-zäöüß]{4,}/.test(line)) continue;
    if (/^[\d\s.,€%\-\/]+$/.test(line)) continue;
    if (/^\d+[\.,\s]/.test(line) && /\d{1,3},\d{2}/.test(line)) continue;

    let score = 0;
    if (SERVICE_RX.test(line)) score += 8;
    if (/betreff|betr\.|re:/i.test(line)) score += 6;
    if (line.split(/\s+/).length >= 2 && line.split(/\s+/).length <= 10) score += 2;
    if (line.length >= 12 && line.length <= 65) score += 2;
    if (/[a-zäöüß]{4,}/.test(line)) score += 1;
    if (/^[A-Z]{2,}\d/.test(line)) score -= 3;
    if (score >= 5) scored.push({ text: line.replace(/^betreff\s*[:\-]?\s*/i, '').trim(), score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return '';
  const top = scored.slice(0, 2).map(c => c.text);
  const raw = top.length === 2 && top[0].length + top[1].length <= 70 ? top.join(' und ') : top[0];
  return raw.length > 72 ? raw.slice(0, 69).trim() + '…' : raw;
}

/* ── STEP 3: infer the display model ── */

function inferDisplayModel({ ai, rawText, lines, fallbackTitle, amountHint, dateHint, issuerHint }) {
  const t = String(rawText || '');
  const linesArr = Array.isArray(lines) ? lines : [];

  // --- DISPLAY TYPE ---
  const aiTypeHint = String(ai?.semanticType || ai?.type || '').toLowerCase();
  const displayType = normalizeDisplayType(t, aiTypeHint);

  // --- AMOUNT ---
  const aiAmount = ai?.fields?.amount?.value;
  const rawAmount = amountHint || '';
  let amount = '';
  if (Number.isFinite(aiAmount) && aiAmount > 0) {
    amount = _fmtAmountStr(aiAmount);
  } else if (rawAmount) {
    amount = _fmtAmountStr(rawAmount);
  }

  // --- DATE ---
  const aiDate = String(ai?.fields?.date?.value || '').trim();
  const date   = aiDate || String(dateHint || '').trim();

  // --- REFERENCE ---
  const reference = String(ai?.fields?.reference?.value || '').trim();

  // --- DUE DATE ---
  const dueDate = _extractDueDateFromLines(linesArr);

  // --- ISSUER ---
  const aiSender  = String(ai?.fields?.sender?.value || '').trim();
  const rawIssuer = issuerHint || '';
  // Try AI sender first; if blocked, try raw hint; if also blocked, leave empty
  const issuerCandidate = aiSender || rawIssuer;
  const issuer = normalizeIssuer(issuerCandidate, t, linesArr);
  const issuerConfidence = issuer
    ? (ai?.fields?.sender?.confidence === 'high' ? 'high' : 'medium')
    : 'low';

  // --- SERVICE HINT --- (only for types that benefit from it)
  const typeKey = displayType.toLowerCase();
  let serviceHint = '';
  if (['rechnung', 'abrechnung', 'versicherung', 'vertrag', 'bescheid', 'dokument'].includes(typeKey)) {
    serviceHint = _extractServiceHint(linesArr, {
      issuer, ref: reference, amountStr: amount, date, dueDate
    });
  }

  return {
    displayType,
    typeLabel: _displayTypeLabel(displayType),
    typeKey,
    issuer,
    issuerConfidence,
    amount,
    date,
    reference,
    dueDate,
    serviceHint,
    fallbackTitle: String(fallbackTitle || '').replace(/\.pdf$/i, '').trim()
  };
}

/* ── STEP 4a: conservative title ── */

function buildConservativeTitle(model) {
  const { typeLabel, issuer, amount } = model;
  const parts = [typeLabel];
  if (issuer)  parts.push(issuer);
  if (amount)  parts.push(amount);
  return parts.join(' \u2013 ');  // en-dash
}

/* ── STEP 4b: conservative summary ── */

function buildConservativeSummary(model) {
  const { typeLabel, typeKey, issuer, amount, date, dueDate, serviceHint, fallbackTitle } = model;
  let s = typeLabel;

  // Issuer: only add "von X" when we have reasonable confidence
  if (issuer) s += ` von ${issuer}`;

  if (typeKey === 'mahnung' || typeKey === 'zahlungserinnerung') {
    if (amount)  s += ` über ${amount}`;
    if (dueDate) s += ` mit Zahlungsfrist bis ${dueDate}`;
    else if (date) s += ` vom ${date}`;
  } else if (typeKey === 'versicherung' || typeKey === 'versicherungsdokument') {
    if (serviceHint) s += ` für ${_lcFirst(serviceHint)}`;
    if (amount)      s += ` mit Jahresbeitrag von ${amount}`;
    // Skip date for insurance — not meaningful as invoice date
  } else if (typeKey === 'gutschrift' || typeKey === 'storno' || typeKey === 'stornorechnung') {
    if (date)   s += ` vom ${date}`;
    if (amount) s += ` über ${amount}`;
  } else if (typeKey === 'bescheid') {
    if (date)         s += ` vom ${date}`;
    if (amount)       s += ` über ${amount}`;
    if (serviceHint)  s += ` für ${_lcFirst(serviceHint)}`;
  } else {
    // Rechnung, Angebot, Vertrag, Abrechnung, Dokument
    if (date)        s += ` vom ${date}`;
    if (amount)      s += ` über ${amount}`;
    if (serviceHint) s += ` für ${_lcFirst(serviceHint)}`;
  }

  if (!s.endsWith('.')) s += '.';

  // If nothing meaningful was added at all, use fallback file name
  if (s === `${typeLabel}.` && fallbackTitle) return fallbackTitle;
  return s;
}

/* ── Legacy shim: _naturalDocTypeLabel still used by a few fallback paths ── */
function _naturalDocTypeLabel(type) {
  return _displayTypeLabel(normalizeDisplayType('', String(type || '')));
}

/* ── buildSummaryFromPdfText (no-AI path) ── */
function buildSummaryFromPdfText(text, lines, fallbackTitle) {
  const t = String(text || '');
  const cleanLines = (lines || []).map(x => String(x || '').trim()).filter(Boolean);

  const amountCands  = extractAmountCandidates(t);
  const companyCands = extractCompanyCandidates(t, cleanLines);
  const dateCands    = extractDateCandidates(t, cleanLines);

  const amount  = resolveField(amountCands);
  const company = resolveField(companyCands);
  const date    = resolveField(dateCands);

  const model = inferDisplayModel({
    ai: null,
    rawText: t,
    lines: cleanLines,
    fallbackTitle,
    amountHint:  amount.value,
    dateHint:    date.value,
    issuerHint:  company.value
  });

  console.log('[FDL DISPLAY MODEL v5 no-ai]', model);
  return buildConservativeSummary(model);
}

function resolveBestCandidate(list) {
  if (!list || !list.length) {
    return { value: '', confidence: 'low' };
  }

  // nach Score sortieren
  const sorted = list.sort((a, b) => b.score - a.score);

  const best = sorted[0];

  // 🔥 zusätzlicher Check:
  // wenn 2 Kandidaten ähnlich gut → unsicher!
  if (sorted.length > 1 && (best.score - sorted[1].score) < 0.15) {
    return { value: '', confidence: 'low' };
  }

  let confidence = 'low';
  if (best.score >= 0.9) confidence = 'high';
  else if (best.score >= 0.7) confidence = 'medium';

  return {
    value: best.value,
    confidence,
    reason: best.reason
  };
}
function resolveField(candidates) {
  if (!candidates || !candidates.length) {
    return { value: '', confidence: 'none' };
  }

  // Remove empties and sort descending by score
  const sorted = [...candidates]
    .filter(c => c && String(c.value || '').trim().length > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  if (!sorted.length) return { value: '', confidence: 'none' };

  const best   = sorted[0];
  const second = sorted[1];
  const bestScore = best.score || 0;

  // ── Hard floor: below this threshold we never return a value ──
  if (bestScore < 0.52) {
    return { value: '', confidence: 'none' };
  }

  // ── Ambiguity guard: two close candidates with different values = uncertain ──
  if (second) {
    const sameValue = String(best.value).trim().toLowerCase() ===
                      String(second.value).trim().toLowerCase();
    const gap = bestScore - (second.score || 0);
    if (!sameValue && gap < 0.20) {
      return { value: '', confidence: 'low' };
    }
  }

  // ── Confidence tier ──
  let confidence;
  if (bestScore >= 0.90)      confidence = 'high';
  else if (bestScore >= 0.72) confidence = 'medium';
  else                        confidence = 'low';

  // "Lieber leer als falsch": suppress low-confidence results
  if (confidence === 'low') {
    return { value: '', confidence: 'low' };
  }

  return {
    value:      String(best.value).trim(),
    confidence,
    reason:     best.reason || '',
    score:      bestScore
  };
}


function dedupeCandidates(list) {
  const map = new Map();

  for (const c of (list || [])) {
    const value = String(c?.value || '').trim();
    if (!value) continue;

    const key = value.toLowerCase();

    if (!map.has(key) || (map.get(key).score || 0) < (c.score || 0)) {
      map.set(key, { ...c, value });
    }
  }

  return Array.from(map.values());
}
function buildImportantFactsFromPdf(parsed, archiveFallback) {
  const facts = [];

  if (parsed.documentKind) facts.push(`Dokumenttyp erkannt: ${parsed.documentKind}`);
  if (parsed.invoiceNo) facts.push(`Referenz: ${parsed.invoiceNo}`);
  if (parsed.invoiceDate) facts.push(`Rechnungsdatum: ${parsed.invoiceDate}`);
  if (parsed.orderNo) facts.push(`Auftragsnr.: ${parsed.orderNo}`);
  if (parsed.customerNo) facts.push(`Kundennr.: ${parsed.customerNo}`);
  if (parsed.propertyNo) facts.push(`Objektnr.: ${parsed.propertyNo}`);
  if (parsed.servicePeriod) facts.push(`Zeitraum: ${parsed.servicePeriod}`);
  if (parsed.grossAmount) facts.push(`Brutto: ${parsed.grossAmount}`);
  if (parsed.netAmount) facts.push(`Netto: ${parsed.netAmount}`);
  if (parsed.taxAmount) facts.push(`MwSt.: ${parsed.taxAmount}`);
  if (parsed.dueDate) facts.push(`Frist: ${parsed.dueDate}`);
  if (parsed.iban) facts.push(`IBAN erkannt: ${parsed.iban}`);
  if (parsed.bic) facts.push(`BIC erkannt: ${parsed.bic}`);
  if (parsed.ustId) facts.push(`USt-Id erkannt: ${parsed.ustId}`);
  if ((parsed.emails || []).length) facts.push(`E-Mail-Kontakte: ${parsed.emails.slice(0, 3).join(', ')}`);
  for (const item of (archiveFallback?.importantFacts || [])) {
    facts.push(item);
  }

  return uniqLower(facts).slice(0, 8);
}

async function extractPdfTextInsights(file) {
  if (!file?.handle || typeof file.handle.getFile !== 'function') return null;

  const cacheKey = `${file.name}__${file.modified || ''}__${file.size || ''}`;
  if (__av3PdfInsightCache.has(cacheKey)) return __av3PdfInsightCache.get(cacheKey);

  try {
    const raw = await file.handle.getFile();
    const buf = await raw.arrayBuffer();
    const pjs = window.pdfjsLib;
    if (!pjs) return null;

    if (!pjs.GlobalWorkerOptions?.workerSrc) {
      pjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const doc = await pjs.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 3);

    let textChunks = [];

    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
    const items = (tc.items || []).filter(it => String(it.str || '').trim());
let pageLines = [];
let currentLine = [];
let lastY = null;

for (const it of items) {
  const str = String(it.str || '').trim();
  const y = Array.isArray(it.transform) ? Math.round(it.transform[5]) : null;

  if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
    if (currentLine.length) pageLines.push(currentLine.join(' ').replace(/\s{2,}/g, ' ').trim());
    currentLine = [];
  }

  currentLine.push(str);
  lastY = y;
}

if (currentLine.length) {
  pageLines.push(currentLine.join(' ').replace(/\s{2,}/g, ' ').trim());
}

const pageText = pageLines.join('\n');
      if (pageText) textChunks.push(pageText);
    }

    const text = normalizeInsightText(textChunks.join('\n'));
    const lines = splitInsightLines(text);

    if (!text) {
      __av3PdfInsightCache.set(cacheKey, null);
      return null;
    }
const ai = window.FideliorAI?.analyzeDocument
  ? window.FideliorAI.analyzeDocument(text, lines)
  : null;

// FIX: use correct field names matching AI engine output (fields.reference / fields.date)
const invoiceField = ai?.fields?.reference || null;
const amountField  = ai?.fields?.amount    || null;
const senderField  = ai?.fields?.sender    || null;
const dateField    = ai?.fields?.date      || null;

// FIX: format AI numeric amount to display string; never fall back to old extractors when AI ran
function _fmtAiAmount(v) {
  if (!Number.isFinite(v) || v <= 0) return '';
  return v.toFixed(2).replace('.', ',') + '\u00A0\u20AC';
}

const out = {
  text,
  lines,

  // zentrale Engine zuerst
  ai,

  documentKind: normalizeDisplayType(text, ai?.semanticType || ai?.type || ''),

  // FIX: when AI ran, trust it fully — no fallback to old extractors
  invoiceNo:   ai ? (invoiceField?.value  || '') : extractInvoiceNoFromText(text, lines),
  invoiceDate: ai ? (dateField?.value     || '') : extractInvoiceDateFromText(text),
  grossAmount: ai ? _fmtAiAmount(amountField?.value) : extractGrossAmountFromText(text),
  company:     ai ? (senderField?.value   || '') : extractCompanyFromText(text, lines),

  dueDate:       extractDueDateFromText(text),
  customerNo:    extractCustomerNoFromText(text),
  orderNo:       extractOrderNoFromText(text),
  propertyNo:    extractPropertyNoFromText(text),
  servicePeriod: extractServicePeriodFromText(text),

  netAmount: extractNetAmountFromText(text),
  taxAmount: extractTaxAmountFromText(text),

  iban:  (extractIbansFromText(text)[0] || ''),
  bic:   extractBicFromText(text),
  ustId: extractUstIdFromText(text),

  recipient:   extractRecipientFromText(text),
  subjectLine: extractSubjectLineFromText(text, lines),
  services:    extractServiceLines(lines),
  emails:      extractEmailsFromText(text),
  keywords:    extractKeywordsFromText(text, lines),

  // FIX: do NOT pass raw AI integer-scored candidates to float-threshold resolveField —
  // that mismatch causes score=2 to be treated as "high confidence" (2 > 0.9).
  // buildDocumentInsights uses the finalized field values above directly.
  invoiceCandidates: [],
  amountCandidates:  [],
  companyCandidates: [],
  dateCandidates:    [],

  invoiceConfidence: invoiceField?.confidence || 'low',
  amountConfidence:  amountField?.confidence  || 'low',
  companyConfidence: senderField?.confidence  || 'low',
  dateConfidence:    dateField?.confidence    || 'low',

  // Build summary via display model pipeline
  summary: (() => {
    const model = inferDisplayModel({
      ai,
      rawText: text,
      lines,
      fallbackTitle: file?.name || '',
      amountHint:  ai ? _fmtAiAmount(amountField?.value) : '',
      dateHint:    ai ? (dateField?.value || '') : '',
      issuerHint:  ai ? (senderField?.value || '') : ''
    });
    console.log('[FDL DISPLAY MODEL v5]', model);
    return buildConservativeSummary(model);
  })()
};
    __av3PdfInsightCache.set(cacheKey, out);
    return out;
  } catch (e) {
    console.warn('[FideliorArchiv] PDF insight extraction failed:', e);
    __av3PdfInsightCache.set(cacheKey, null);
    return null;
  }
}
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

  const m = file.meta || {};
  const core = file.__core || null;
  const tasks = await loadTasks(file.name);
  const open = tasks.filter(t => t.status !== 'done');
  const insights = await buildDocumentInsights(file);

  // Build display model from insights for correct type, issuer, title and summary
  const _panelModel = inferDisplayModel({
    ai:          insights?.ai || null,
    rawText:     insights?.text || '',
    lines:       insights?.lines || [],
    fallbackTitle: file.name || '',
    amountHint:  insights?.grossAmount || core?.amount || m.betrag || '',
    dateHint:    insights?.invoiceDate  || core?.date  || m.datum  || '',
    issuerHint:  insights?.company     || core?.sender || m.absender || ''
  });

  const docType   = _panelModel.typeLabel;
  const amount    = _panelModel.amount  || insights?.grossAmount || core?.amount || m.betrag || '';
  const docDate   = _panelModel.date    || insights?.invoiceDate  || core?.date  || m.datum  || '';
  const sender    = _panelModel.issuer  || '';
  const objectCode = core?.objectCode || file.objectCode || '';
  const objectName = core?.objectName || file.objectName || '';
  const modifiedLabel = fmtDate(file.modified);
let fileSizeLabel = fmtSize(file.size);

if ((!file.size || !fileSizeLabel) && file?.handle && typeof file.handle.getFile === 'function') {
  try {
    const realFile = await file.handle.getFile();
    fileSizeLabel = fmtSize(realFile.size) || '—';
  } catch {
    fileSizeLabel = fileSizeLabel || '—';
  }
}
  const filePath = (file.pathSegs || []).join(' › ');

  const smallFileName = file.name || '';
const largeTitle = insights?.title || buildConservativeTitle(_panelModel);
const summary    = insights?.summary || buildConservativeSummary(_panelModel);

const catPills = [
  objectCode ? `<span class="av3-cat-pill">${esc(objectCode)}</span>` : '',
  docType ? `<span class="av3-cat-pill green">${esc(docType)}</span>` : '',
  file.year ? `<span class="av3-cat-pill blue">${esc(file.year)}</span>` : '',
  file.subfolder ? `<span class="av3-cat-pill amber">${esc(file.subfolder)}</span>` : '',
].filter(Boolean).join('');

  const taskHTML = tasks.length
    ? tasks.slice(0, 5).map(t => {
        const done = t.status === 'done';
        const high = t.priority === 'high';
        return `<div class="av3-task-row">
          <div class="av3-check-box ${done ? 'done' : high ? 'high' : ''}">${done ? SVG.check : ''}</div>
          <span style="${done ? 'text-decoration:line-through;opacity:.5' : ''}">${t.title}</span>
        </div>`;
      }).join('')
    : '<div class="av3-no-tasks">Noch keine Aufgaben vorhanden.</div>';
const keywordsHtml = (insights?.keywords || []).length
  ? `<div class="av3-cat-pills">${insights.keywords.slice(0, 10).map(k => `<span class="av3-cat-pill">${esc(k)}</span>`).join('')}</div>`
  : '<div class="av3-no-tasks">Keine Schlagwörter erkannt.</div>';

const emailsHtml = (insights?.emails || []).length
  ? insights.emails.slice(0, 8).map(mail => `
      <div class="av3-meta-row">
        <span class="av3-meta-label">E-Mail</span>
        <span class="av3-meta-val">${esc(mail)}</span>
      </div>
    `).join('')
  : '<div class="av3-no-tasks">Keine E-Mail-Adressen erkannt.</div>';

const factsHtml = (insights?.importantFacts || []).length
  ? insights.importantFacts.slice(0, 8).map(f => `
      <div class="av3-task-row">
        <span style="color:#9CA3AF">•</span>
        <span>${esc(f)}</span>
      </div>
    `).join('')
  : '<div class="av3-no-tasks">Keine zusätzlichen Inhalte erkannt.</div>';

const structuredDocRows = [
  insights?.subjectLine ? `<div class="av3-meta-row"><span class="av3-meta-label">Betreff</span><span class="av3-meta-val">${esc(insights.subjectLine)}</span></div>` : '',
  insights?.invoiceNo ? `<div class="av3-meta-row"><span class="av3-meta-label">Rechnungsnr.</span><span class="av3-meta-val">${esc(insights.invoiceNo)}</span></div>` : '',
  insights?.invoiceDate ? `<div class="av3-meta-row"><span class="av3-meta-label">Rechnungsdatum</span><span class="av3-meta-val">${esc(insights.invoiceDate)}</span></div>` : '',
  insights?.orderNo ? `<div class="av3-meta-row"><span class="av3-meta-label">Auftragsnr.</span><span class="av3-meta-val">${esc(insights.orderNo)}</span></div>` : '',
  insights?.customerNo ? `<div class="av3-meta-row"><span class="av3-meta-label">Kundennr.</span><span class="av3-meta-val">${esc(insights.customerNo)}</span></div>` : '',
  insights?.propertyNo ? `<div class="av3-meta-row"><span class="av3-meta-label">Objektnr.</span><span class="av3-meta-val">${esc(insights.propertyNo)}</span></div>` : '',
  insights?.servicePeriod ? `<div class="av3-meta-row"><span class="av3-meta-label">Zeitraum</span><span class="av3-meta-val">${esc(insights.servicePeriod)}</span></div>` : '',
  insights?.dueDate ? `<div class="av3-meta-row"><span class="av3-meta-label">Fällig</span><span class="av3-meta-val">${esc(insights.dueDate)}</span></div>` : ''
].filter(Boolean).join('');

const structuredAmountRows = [
  insights?.grossAmount ? `<div class="av3-meta-row"><span class="av3-meta-label">Brutto</span><span class="av3-meta-val">${esc(insights.grossAmount)}</span></div>` : '',
  insights?.netAmount ? `<div class="av3-meta-row"><span class="av3-meta-label">Netto</span><span class="av3-meta-val">${esc(insights.netAmount)}</span></div>` : '',
  insights?.taxAmount ? `<div class="av3-meta-row"><span class="av3-meta-label">MwSt.</span><span class="av3-meta-val">${esc(insights.taxAmount)}</span></div>` : ''
].filter(Boolean).join('');

const structuredPartyRows = [
  _panelModel.issuer ? `<div class="av3-meta-row"><span class="av3-meta-label">Firma</span><span class="av3-meta-val">${esc(_panelModel.issuer)}</span></div>` : '',
  insights?.recipient ? `<div class="av3-meta-row"><span class="av3-meta-label">Empfänger</span><span class="av3-meta-val">${esc(insights.recipient)}</span></div>` : '',
  insights?.iban ? `<div class="av3-meta-row"><span class="av3-meta-label">IBAN</span><span class="av3-meta-val mono">${esc(insights.iban)}</span></div>` : '',
  insights?.bic ? `<div class="av3-meta-row"><span class="av3-meta-label">BIC</span><span class="av3-meta-val mono">${esc(insights.bic)}</span></div>` : '',
  insights?.ustId ? `<div class="av3-meta-row"><span class="av3-meta-label">USt-Id</span><span class="av3-meta-val mono">${esc(insights.ustId)}</span></div>` : ''
].filter(Boolean).join('');

const servicesHtml = (insights?.services || []).length
  ? insights.services.slice(0, 5).map(s => `
      <div class="av3-task-row">
        <span style="color:#9CA3AF">•</span>
        <span>${esc(s)}</span>
      </div>
    `).join('')
  : '<div class="av3-no-tasks">Keine Positionen erkannt.</div>';

el.innerHTML = `
  <div class="av3-panel-rail">
    ${railButtons(open.length)}
  </div>

  <div class="av3-panel-content">
    <div class="av3-panel-meta av3-doc-shell">

      <div class="av3-doc-hero">
        <div class="av3-doc-file">${esc(smallFileName || '—')}</div>
        <div class="av3-doc-title">${esc(largeTitle || smallFileName || 'Dokument')}</div>
        <div class="av3-doc-date-row">
          ${docDate
            ? `<span class="av3-doc-date-main">${esc(docDate)}</span>`
            : `<span class="av3-doc-date-main">${esc(modifiedLabel)}</span>`}
        </div>
        <div class="av3-cat-pills">${catPills || '<span style="color:#9CA3AF;font-size:11px">—</span>'}</div>
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Zusammenfassung</div>
        <div class="av3-doc-summary" style="margin:0">
          ${summary ? esc(summary) : 'Keine inhaltliche Zusammenfassung verfügbar.'}
        </div>
      </div>

      ${structuredDocRows ? `
      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Strukturierte Felder</div>
        <div class="av3-meta">
          ${structuredDocRows}
        </div>
      </div>` : ''}

      ${structuredAmountRows ? `
      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Beträge</div>
        <div class="av3-meta">
          ${structuredAmountRows}
        </div>
      </div>` : ''}

      ${structuredPartyRows ? `
      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Parteien & Zahlung</div>
        <div class="av3-meta">
          ${structuredPartyRows}
        </div>
      </div>` : ''}

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Leistungszeilen / Positionen</div>
        <div class="av3-meta" style="display:block">
          ${servicesHtml}
        </div>
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Schlagwörter</div>
        ${keywordsHtml}
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Erkannte Kontakte / E-Mails</div>
        <div class="av3-meta">
          ${emailsHtml}
        </div>
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Wichtige Inhalte</div>
        <div class="av3-meta" style="display:block">
          ${factsHtml}
        </div>
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Dokumentdaten</div>
        <div class="av3-meta">
          ${docType ? `<div class="av3-meta-row"><span class="av3-meta-label">Typ</span><span class="av3-meta-val">${esc(docType)}</span></div>` : ''}
          ${amount ? `<div class="av3-meta-row"><span class="av3-meta-label">Betrag</span><span class="av3-meta-val">${esc(amount)}</span></div>` : ''}
          ${docDate ? `<div class="av3-meta-row"><span class="av3-meta-label">Belegdatum</span><span class="av3-meta-val">${esc(docDate)}</span></div>` : ''}
          ${sender ? `<div class="av3-meta-row"><span class="av3-meta-label">Absender</span><span class="av3-meta-val">${esc(sender)}</span></div>` : ''}
          ${objectCode ? `<div class="av3-meta-row"><span class="av3-meta-label">Objekt</span><span class="av3-meta-val">${esc(objectCode)}${objectName ? ` · ${esc(objectName)}` : ''}</span></div>` : ''}
          ${file.subfolder ? `<div class="av3-meta-row"><span class="av3-meta-label">Unterordner</span><span class="av3-meta-val">${esc(file.subfolder)}</span></div>` : ''}
          ${filePath ? `<div class="av3-meta-row"><span class="av3-meta-label">Pfad</span><span class="av3-meta-val mono">${esc(filePath)}</span></div>` : ''}
        </div>
      </div>

      <div class="av3-doc-section">
        <div class="av3-doc-section-title">Dateiinformationen</div>
        <div class="av3-meta">
          <div class="av3-meta-row">
            <span class="av3-meta-label">Dateiname</span>
            <span class="av3-meta-val mono">${esc(smallFileName || '—')}</span>
          </div>
          <div class="av3-meta-row">
            <span class="av3-meta-label">Größe</span>
            <span class="av3-meta-val">${esc(fileSizeLabel || '—')}</span>
          </div>
          <div class="av3-meta-row">
            <span class="av3-meta-label">Geändert</span>
            <span class="av3-meta-val">${esc(modifiedLabel || '—')}</span>
          </div>
                <div class="av3-meta-row">
            <span class="av3-meta-label">Quelle</span>
            <span class="av3-meta-val">${esc(
              insights?.source === 'document-index+pdf' ? 'Dokumentenindex + PDF' :
              insights?.source === 'document-index' ? 'Dokumentenindex' :
              insights?.source === 'pdf' ? 'PDF-Analyse' :
              'Archiv'
            )}</span>
          </div>
        </div>
      </div>

      <div class="av3-doc-section av3-doc-section-tasks">
        <div class="av3-tasks-mini">
          <div class="av3-tasks-mini-hdr">
            <span class="av3-tasks-mini-title">Aufgaben${open.length ? ' (' + open.length + ')' : ''}</span>
            <button class="av3-task-add" onclick="window.__av3.task()">+ Erstellen</button>
          </div>
          ${taskHTML}
        </div>
      </div>

    </div>

    <div class="av3-panel-preview" id="fdl-av3-prev">
      <div class="av3-prev-label">Vorschau</div>
      <div class="av3-loading"><div class="av3-spinner"></div> PDF wird gerendert…</div>
    </div>
  </div>`;

renderPDF(file);
}

function buildArchivTitle(ctx) {
  const { docType, sender, amount, file } = ctx || {};
  const model = inferDisplayModel({
    ai: null, rawText: '', lines: [],
    fallbackTitle: file?.name || '',
    amountHint: amount || '', dateHint: '', issuerHint: sender || ''
  });
  // Override displayType with what was passed in (already resolved upstream)
  const typeLabel = _displayTypeLabel(normalizeDisplayType('', String(docType || '')));
  return buildConservativeTitle({ ...model, typeLabel, issuer: model.issuer || sender || '' });
}

function buildArchivSummary(ctx) {
  const { docType, sender, amount, docDate, file } = ctx || {};
  const model = inferDisplayModel({
    ai: null, rawText: '', lines: [],
    fallbackTitle: file?.name || '',
    amountHint: amount || '', dateHint: docDate || '', issuerHint: sender || ''
  });
  const typeLabel = _displayTypeLabel(normalizeDisplayType('', String(docType || '')));
  return buildConservativeSummary({ ...model, typeLabel, typeKey: typeLabel.toLowerCase(), issuer: model.issuer || sender || '' });
}
function railButtons(taskCount) {
  return `
    <button class="av3-rail-btn" title="Herunterladen" onclick="window.__av3.dl()">${SVG.download}</button>
    <button class="av3-rail-btn" title="In neuem Tab" onclick="window.__av3.tab()">${SVG.externalLink}</button>
    <button class="av3-rail-btn" title="In App laden" onclick="window.__av3.load()">${SVG.inbox}</button>
    <div class="av3-rail-sep"></div>
    <button class="av3-rail-btn" title="Name kopieren" onclick="window.__av3.cpName()">${SVG.copy}</button>
    <button class="av3-rail-btn" title="Pfad kopieren" onclick="window.__av3.cpPath()">${SVG.link}</button>
    <div style="flex:1"></div>
    <button class="av3-rail-btn${taskCount ? ' highlighted' : ''}" title="Aufgabe erstellen" onclick="window.__av3.task()">${SVG.task}</button>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   PDF RENDERING
   ══════════════════════════════════════════════════════════════════════════ */

async function renderPDF(file) {
  const wrap = document.getElementById('fdl-av3-prev');
  if (!wrap) return;

if (!file?.handle || typeof file.handle.getFile !== 'function') {
  wrap.innerHTML = `<div class="av3-prev-label">Vorschau</div><div class="av3-empty" style="flex:1"><div class="av3-empty-icon">${SVG.warn}</div><div class="av3-empty-sub">Keine Datei-Verbindung vorhanden</div></div>`;
  return;
}
  if (S.blobUrl) {
    try { URL.revokeObjectURL(S.blobUrl); } catch {}
    S.blobUrl = null;
  }

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

    if (!pjs.GlobalWorkerOptions?.workerSrc) {
      pjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const doc   = await pjs.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 8);

    wrap.innerHTML = '<div class="av3-prev-label">Vorschau</div><div class="av3-prev-canvas-wrap" id="av3-cv-wrap"></div>';
    const cvWrap = document.getElementById('av3-cv-wrap');
    const containerWidth = wrap.clientWidth - 32;

    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
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
    if (wrap2) {
      wrap2.innerHTML = `<div class="av3-prev-label">Vorschau</div><div class="av3-empty" style="flex:1"><div class="av3-empty-icon">${SVG.warn}</div><div class="av3-empty-sub">Vorschau nicht verfügbar</div></div>`;
    }
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
    S.selected = null;
    S.files = [];
    S.filtered = [];
      S.query        = (opts.query || '').trim().toLowerCase();
    S.typeFilter   = opts.typeFilter || 'all';
    S.subFilter    = opts.subFilter || 'all';
    S.yearFilter   = opts.yearFilter || 'all';
    S.collectionId = opts.collectionId || '';
    S.dateFrom     = opts.dateFrom || '';
    S.dateTo       = opts.dateTo || '';


    const sf = document.getElementById('fdl-av3-search'); if (sf) sf.value = opts.query || '';
    const tf = document.getElementById('fdl-av3-type');   if (tf) tf.value = S.typeFilter;
    const yf = document.getElementById('fdl-av3-year');   if (yf) yf.value = S.yearFilter;
    const so = document.getElementById('fdl-av3-sort');   if (so) so.value = opts.sortOrder || 'date-desc';
    S.sortOrder = opts.sortOrder || 'date-desc';

     const bc = document.getElementById('fdl-av3-bc');
    if (bc) {
      const scope = S.scopeCategory ? `<span class="av3-bc-current">${S.scopeCategory}</span><span class="av3-bc-sep">/</span>` : '';
      const collectionLabel =
        S.collectionId === 'steuererklarung' ? 'Steuererklärung' :
        S.collectionId === 'betriebskosten' ? 'Betriebskosten' :
        '';

      bc.innerHTML = `<span style="color:#9CA3AF">Archiv</span><span class="av3-bc-sep">/</span>${scope}<span class="av3-bc-current">${o.name}</span>${collectionLabel ? `<span class="av3-bc-sep">/</span><span class="av3-bc-current">${collectionLabel}</span>` : ''}`;
    }

    renderSidebar();
    const li = document.getElementById('fdl-av3-li');
    if (li) li.innerHTML = `<div class="av3-loading"><div class="av3-spinner"></div> Lade Dokumente…</div>`;
    await renderPanel(null);

    if (!window.scopeRootHandle) {
      if (li) li.innerHTML = `<div class="av3-empty"><div class="av3-empty-icon">${SVG.disconnect}</div><div class="av3-empty-title">Scopevisio nicht verbunden</div></div>`;
      return;
    }

     let files = await loadFiles(code);
    files = await filterFilesByCollection(files, S.collectionId);

    S.files   = files;
    S.filtered = files;
    S.counts[code] = files.length;

    const ce = document.getElementById(`av3c-${code}`);
    if (ce) ce.textContent = files.length;

    populateYearFilter(files);
    applyFilters();

    if (opts.selectName) {
      const match = S.filtered.find(f => f.name === opts.selectName) || S.files.find(f => f.name === opts.selectName);
      if (match) await window.__av3.file(encodeURIComponent(match.name + '||' + match.modified));
    }
  },

  async file(key) {
    const decoded = decodeURIComponent(key);
    const sep     = decoded.lastIndexOf('||');
    if (sep === -1) {
      console.warn('[FideliorArchiv] file(): bad key', key);
      return;
    }

    const name        = decoded.slice(0, sep);
    const modifiedStr = decoded.slice(sep + 2);

    const file =
      S.filtered.find(f => f.name === name && String(f.modified) === modifiedStr) ||
      S.files.find(f => f.name === name && String(f.modified) === modifiedStr);

    if (!file) {
      console.warn('[FideliorArchiv] file(): not found', name);
      return;
    }

    S.selected = file;
    renderList(S.filtered);

    setTimeout(() => {
      const li = document.getElementById('fdl-av3-li');
      if (li) {
        const active = li.querySelector('.av3-file.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 0);

    await renderPanel(file);
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

       S.query        = (opts.query || '').trim().toLowerCase();
    S.typeFilter   = opts.typeFilter || 'all';
    S.subFilter    = opts.subFilter || 'all';
    S.yearFilter   = opts.yearFilter || 'all';
    S.sortOrder    = opts.sortOrder || 'date-desc';
    S.collectionId = opts.collectionId || '';
    S.dateFrom     = opts.dateFrom || '';
    S.dateTo       = opts.dateTo || '';


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
      const collectionLabel =
        S.collectionId === 'steuererklarung' ? 'Steuererklärung' :
        S.collectionId === 'betriebskosten' ? 'Betriebskosten' :
        '';

      bc.innerHTML = `<span style="color:#9CA3AF">Archiv</span><span class="av3-bc-sep">/</span><span class="av3-bc-current">${category || 'Alle Liegenschaften'}</span>${collectionLabel ? `<span class="av3-bc-sep">/</span><span class="av3-bc-current">${collectionLabel}</span>` : ''}`;
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
    let files = await loadFilesForCategory(category);
    files = await filterFilesByCollection(files, S.collectionId);

    S.files = files;
    S.filtered = files;

    populateYearFilter(files);

    if (opts.yearFilter) {
      S.yearFilter = opts.yearFilter;
      if (yf) yf.value = opts.yearFilter;
    }

    applyFilters();

    if (opts.autoSelectFirst && S.filtered.length) {
      S.selected = S.filtered[0];
      renderList(S.filtered);
      await renderPanel(S.selected);
    }
  },

  dl() {
    if (S.blobUrl && S.selected) {
      const a = Object.assign(document.createElement('a'), {
        href: S.blobUrl,
        download: S.selected.name
      });
      a.click();
    }
  },

  tab() {
    if (S.blobUrl) window.open(S.blobUrl, '_blank');
  },

  cpName() {
    if (S.selected) {
      navigator.clipboard?.writeText(S.selected.name).then(() => toast('Dateiname kopiert', 1500));
    }
  },

  cpPath() {
    if (S.selected) {
      const p = (S.selected.pathSegs || []).join(' › ') + ' › ' + S.selected.name;
      navigator.clipboard?.writeText(p).then(() => toast('Pfad kopiert', 1500));
    }
  },

  async load() {
    if (!S.selected) return;
    try {
      if (typeof window.openPdfFromHandle === 'function') {
        await window.openPdfFromHandle(S.selected.handle);
        close();
        return;
      }

      const f  = await S.selected.handle.getFile();
      const dt = new DataTransfer();
      dt.items.add(f);

      const fi = document.querySelector('input[type="file"]');
      if (fi) {
        Object.defineProperty(fi, 'files', { value: dt.files, configurable: true });
        fi.dispatchEvent(new Event('change', { bubbles: true }));
        close();
        toast(`${f.name} geladen`, 2000);
      } else {
        toast('Direktladen nicht verfügbar', 3000);
      }
    } catch (e) {
      toast('Fehler: ' + (e?.message || e), 3000);
    }
  },

  task() {
    if (!S.selected) return;
    close();
    setTimeout(() => {
      const ov = document.getElementById('fdl-tasks-overlay');
      if (ov) {
        ov.classList.add('open');
        setTimeout(() => {
          const n = document.getElementById('fdl-f-note');
          const ob = document.getElementById('fdl-f-obj');
          if (n) n.value = 'Dokument: ' + S.selected.name;
          if (ob && S.obj) ob.value = S.obj.code;
        }, 80);
      }
    }, 160);
  },
};

function toast(h, ms) {
  try {
    if (typeof window.toast === 'function') window.toast(h, ms || 2500);
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   EVENT HANDLER
   ══════════════════════════════════════════════════════════════════════════ */

function onSearch(val) { S.query = (val || '').trim().toLowerCase(); applyFilters(); }
function onType(val)   { S.typeFilter = val || 'all'; applyFilters(); }
function onYear(val)   { S.yearFilter = val || 'all'; applyFilters(); }
function onSort(val)   { S.sortOrder  = val || 'date-desc'; applyFilters(); }

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

  document.getElementById('fdl-av3-close').onclick = close;
  document.getElementById('fdl-av3-search').addEventListener('input',  e => onSearch(e.target.value));
  document.getElementById('fdl-av3-type').addEventListener('change',   e => onType(e.target.value));
  document.getElementById('fdl-av3-year').addEventListener('change',   e => onYear(e.target.value));
  document.getElementById('fdl-av3-sort').addEventListener('change',   e => onSort(e.target.value));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ov.classList.contains('open')) close();
  });
}

async function open(opts = {}) {
  if (opts && typeof opts.preventDefault === 'function') {
    opts.preventDefault();
    opts = {};
  } else if (typeof opts === 'string') {
    opts = { scopeCategory: opts };
  } else if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    opts = {};
  }

  buildOverlay();

  
  await loadObjectsConfig();
  renderSidebar();
  document.getElementById('fdl-av3').classList.add('open');

  if (opts.scopeCategory) S.scopeCategory = opts.scopeCategory;
  renderSidebar();

  const root = window.scopeRootHandle;
  if (opts.obj) {
    setTimeout(() => { window.__av3.obj(opts.obj, opts); }, 0);
  } else if (opts.scopeCategory || opts.collectionId) {
    setTimeout(() => {
      window.__av3.setCategory(opts.scopeCategory || null, {
        typeFilter: opts.typeFilter || 'all',
        subFilter: opts.subFilter || 'all',
        query: opts.query || '',
        yearFilter: opts.yearFilter || 'all',
        sortOrder: opts.sortOrder || 'date-desc',
        collectionId: opts.collectionId || '',
        dateFrom: opts.dateFrom || '',
        dateTo: opts.dateTo || '',
        autoSelectFirst: false
      });
    }, 0);
  }


  if (root) {
    for (const o of getObjList()) {
      loadFiles(o.code).then(files => {
        S.counts[o.code] = files.length;
        const el = document.getElementById(`av3c-${o.code}`);
        if (el) el.textContent = files.length;
      }).catch(() => {});
    }
  }
}

function close() {
  document.getElementById('fdl-av3')?.classList.remove('open');
  if (S.blobUrl) {
    try { URL.revokeObjectURL(S.blobUrl); } catch {}
    S.blobUrl = null;
  }
  if (document.body.classList.contains('view-archive') && window.__fdlPro?.goDash) {
    setTimeout(() => window.__fdlPro.goDash(), 0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ARCHIV HELPERS  — globale Suche + Dashboard-Stats
   ══════════════════════════════════════════════════════════════════════════ */

function parseMetaAmount(raw) {
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function dispDateToISO(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

const SEARCH_MONTHS = {
  januar:'01', february:'02', februar:'02', märz:'03', maerz:'03', march:'03', april:'04', mai:'05', may:'05',
  juni:'06', june:'06', juli:'07', july:'07', august:'08', september:'09', oktober:'10', october:'10',
  november:'11', dezember:'12', december:'12'
};

const SEARCH_CATEGORY_ALIASES = {
  privat:   ['privat', 'private', 'persönlich', 'persoenlich'],
  fidelior: ['fidelior'],
  objekte:  ['objekt', 'objekte', 'liegenschaft', 'liegenschaften', 'immobilie', 'immobilien']
};

const SEARCH_TYPE_SYNONYMS = {
  rechnung:          ['rechnung', 'rechnungen', 'eingangsrechnung', 'eingangsrechnungen', 'invoice'],
  dokument:          ['dokument', 'dokumente', 'vertrag', 'verträge', 'vertraege', 'vertraglich', 'unterlage', 'unterlagen'],
  gutschrift:        ['gutschrift', 'gutschriften'],
  angebot:           ['angebot', 'angebote', 'offerte', 'offerten'],
  abrechnungsbelege: ['abrechnung', 'abrechnungen', 'abrechnungsbeleg', 'abrechnungsbelege'],
};

const SEARCH_TOPIC_SYNONYMS = {
  handwerker:  ['handwerker', 'reparatur', 'reparaturen', 'montage', 'sanitär', 'sanitaer', 'elektriker', 'heizung', 'wartung', 'hausmeister', 'dienstleister'],
  versicherung:['versicherung', 'versicherungen', 'police', 'schaden', 'schadensmeldung', 'beitrag', 'haftpflicht', 'kasko'],
  telefon:     ['telefon', 'telekom', 'vodafone', 'o2', 'mobilfunk', 'internet', 'dsl'],
  strom:       ['strom', 'energie', 'versorger', 'abschlag'],
  wasser:      ['wasser', 'abwasser'],
  steuer:      ['steuer', 'steuererklaerung', 'steuererklärung', 'finanzamt'],
};

function normalizeSearchValue(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[ä]/g, 'ae')
    .replace(/[ö]/g, 'oe')
    .replace(/[ü]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchValue(v) {
  return normalizeSearchValue(v).split(' ').filter(Boolean);
}

function parseAmountLoose(raw) {
  if (raw === null || raw === undefined) return 0;
  const cleaned = String(raw)
    .replace(/[^0-9,.-]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function deriveArchiveScopeCategory(code) {
  const raw = window.fdlDeriveCategory ? window.fdlDeriveCategory(code) : code;
  if (!raw) return '';
  const n = normalizeSearchValue(raw);
  if (n.includes('privat')) return 'Privat';
  if (n.includes('fidelior')) return 'Fidelior';
  return 'Objekte';
}

function buildArchiveSearchFilter(query) {
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    const cloned = { ...query };
    const raw = String(cloned.raw || cloned.text || '').trim();
    const text = String(cloned.text || '').trim();
    cloned.raw = raw || text;
    cloned.text = text;
    cloned.category = cloned.category || cloned.scopeCategory || '';
    cloned.sender = String(cloned.sender || '').trim();
    cloned.textTokens = cloned.textTokens || tokenizeSearchValue(text);
    return cloned;
  }

  const raw = String(query || '').trim();
  const lower = raw.toLowerCase();
  const filter = { raw, text: raw, textTokens: tokenizeSearchValue(raw) };

  const yearM = lower.match(/\b(20\d{2})\b/);
  if (yearM) filter.year = yearM[1];

  const normalized = normalizeSearchValue(lower);
  for (const [name, month] of Object.entries(SEARCH_MONTHS)) {
    if (normalized.includes(normalizeSearchValue(name))) {
      filter.month = month;
      break;
    }
  }

  const gtM = lower.match(/\b(?:ueber|über|ab|mehr als|mindestens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (gtM) filter.amountGt = parseFloat(gtM[1].replace(',', '.'));

  const ltM = lower.match(/\b(?:unter|bis|maximal|hoechstens|höchstens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (ltM) filter.amountLt = parseFloat(ltM[1].replace(',', '.'));

  const senderM = lower.match(/\b(?:von|bei)\s+([a-zäöüß0-9&][a-zäöüß0-9& .\-]{1,40}?)(?:\s+(?:im|in|aus|ueber|über)\b|\s+20\d{2}\b|$)/i);
  if (senderM) filter.sender = senderM[1].trim();

  if (/\brechnungen?\b/i.test(lower)) filter.docType = 'rechnung';
  else if (/\b(gutschriften?)\b/i.test(lower)) filter.docType = 'gutschrift';
  else if (/\b(angebote?|offerten?)\b/i.test(lower)) filter.docType = 'angebot';
  else if (/\b(vertrag|vertraege|verträge|dokumente?)\b/i.test(lower)) filter.docType = 'dokument';

  if (SEARCH_CATEGORY_ALIASES.privat.some(k => normalized.includes(normalizeSearchValue(k)))) {
    filter.category = 'Privat';
  } else if (SEARCH_CATEGORY_ALIASES.fidelior.some(k => normalized.includes(normalizeSearchValue(k)))) {
    filter.category = 'Fidelior';
  } else if (SEARCH_CATEGORY_ALIASES.objekte.some(k => normalized.includes(normalizeSearchValue(k)))) {
    filter.category = 'Objekte';
  }

  return filter;
}

function buildArchiveSearchEntry(f) {
  const invoiceDate = dispDateToISO(f.meta?.datum);
  const amount = parseAmountLoose(f.meta?.betrag);
  const scopeCategory = deriveArchiveScopeCategory(f.objectCode || '');
  const folderType = fmtFolderType(f.folderType || '');
  const searchParts = [
    f.name || '',
    f.objectCode || '',
    f.objectName || '',
    folderType,
    f.folderType || '',
    scopeCategory,
    f.year || '',
    f.subfolder || '',
    f.meta?.absender || '',
    f.meta?.betrag || '',
    f.meta?.datum || ''
  ];
  const tokens = tokenizeSearchValue(searchParts.join(' '));

  return {
    file: f,
    normalizedHaystack: normalizeSearchValue(searchParts.join(' ')),
    tokens,
    tokenSet: new Set(tokens),
    amount,
    invoiceDate,
    month: invoiceDate ? invoiceDate.slice(5, 7) : '',
    scopeCategory,
    folderType,
    senderNorm: normalizeSearchValue(f.meta?.absender || ''),
    objectNorm: normalizeSearchValue(`${f.objectCode || ''} ${f.objectName || ''}`),
    subfolderNorm: normalizeSearchValue(f.subfolder || ''),
    fileNameNorm: normalizeSearchValue(f.name || ''),
  };
}

function computeArchiveSearchScore(entry, filter) {
  const file = entry.file;
  let score = 0;

  if (filter.objectCode) {
    if ((file.objectCode || '').toUpperCase() !== String(filter.objectCode).toUpperCase()) return -1;
    score += 220;
  }

  if (filter.year) {
    if (String(file.year || '') !== String(filter.year)) return -1;
    score += 120;
  }

  if (filter.month) {
    if (entry.month !== String(filter.month).padStart(2, '0')) return -1;
    score += 90;
  }

  if (filter.category) {
    if (normalizeSearchValue(entry.scopeCategory) !== normalizeSearchValue(filter.category)) return -1;
    score += 110;
  }

  if (filter.scopeCategory) {
    if (normalizeSearchValue(entry.scopeCategory) !== normalizeSearchValue(filter.scopeCategory)) return -1;
    score += 110;
  }

  if (filter.docType) {
    const want = normalizeSearchValue(filter.docType);
    const aliases = SEARCH_TYPE_SYNONYMS[want] || [want];
    if (!aliases.some(a => entry.tokens.includes(normalizeSearchValue(a)))) return -1;
    score += 90;
  }

  if (filter.amountGt !== undefined && !(entry.amount > Number(filter.amountGt))) return -1;
  if (filter.amountLt !== undefined && !(entry.amount < Number(filter.amountLt))) return -1;
  if (filter.amountGt !== undefined || filter.amountLt !== undefined) score += 70;

  const sender = normalizeSearchValue(filter.sender || '');
  if (sender) {
    if (entry.senderNorm === sender) score += 220;
    else if (entry.senderNorm.includes(sender)) score += 150;
    else if (entry.fileNameNorm.includes(sender)) score += 110;
    else return -1;
  }

  const raw = normalizeSearchValue(filter.raw || '');
  if (raw && entry.fileNameNorm.includes(raw)) score += 65;
  else if (raw && entry.normalizedHaystack.includes(raw)) score += 35;

  const textTokens = Array.isArray(filter.textTokens) ? filter.textTokens : tokenizeSearchValue(filter.text || '');
  if (textTokens.length) {
    let matched = 0;

    for (const token of textTokens) {
      if (token.length < 2) continue;

      if (entry.tokenSet.has(token)) {
        matched += 1;
        score += 34;
        continue;
      }

      const fuzzy = [...entry.tokenSet].some(t => t.includes(token) || token.includes(t));
      if (fuzzy) {
        matched += 1;
        score += 22;
        continue;
      }

      let synonymHit = false;
      for (const words of Object.values(SEARCH_TOPIC_SYNONYMS)) {
        const normalizedWords = words.map(normalizeSearchValue);
        if (!normalizedWords.includes(token)) continue;
        if (normalizedWords.some(w => entry.tokenSet.has(w) || entry.normalizedHaystack.includes(w))) {
          matched += 1;
          score += 18;
          synonymHit = true;
          break;
        }
      }

      if (!synonymHit && token.length >= 4) return -1;
    }

    if (!matched) return -1;
    if (matched === textTokens.length) score += 45;
  }

  const ageBoost = Math.max(0, 18 - Math.floor((Date.now() - (file.modified || 0)) / 86400000 / 45));
  score += ageBoost;

  return score;
}

function archiveFileToSearchDoc(f, score = 0) {
  const scopeCategory = deriveArchiveScopeCategory(f.objectCode || '');
  const folderType = fmtFolderType(f.folderType || '');
  return {
    __source: 'archive',
    source: 'archive',
    fileName: f.name || '',
    objectCode: f.objectCode || '',
    objectName: f.objectName || '',
    docType: folderType,
    amount: parseAmountLoose(f.meta?.betrag),
    invoiceDate: dispDateToISO(f.meta?.datum),
    savedAt: new Date(f.modified || docDateMs(f) || Date.now()).toISOString(),
    modified: f.modified || 0,
    sender: f.meta?.absender || '',
    senderNorm: normalizeSearchValue(f.meta?.absender || ''),
    serviceDesc: f.subfolder || '',
    keywords: [],
    ocrText: '',
    score,
    searchScore: score,
    selectName: f.name || '',
    archiveKey: encodeURIComponent((f.name || '') + '||' + (f.modified || '')),
    archiveModified: f.modified || 0,
    archiveRef: {
      code: f.objectCode || '',
      scopeCategory,
      selectName: f.name || '',
      folderType,
      modified: f.modified || 0,
    }
  };
}

const __fdlArchivSearchCache = { ts: 0, data: null, pending: null };

async function getArchiveSearchIndex(force = false) {
  const now = Date.now();
  if (!force && __fdlArchivSearchCache.data && (now - __fdlArchivSearchCache.ts) < 30000) {
    return __fdlArchivSearchCache.data;
  }
  if (__fdlArchivSearchCache.pending) return __fdlArchivSearchCache.pending;

  __fdlArchivSearchCache.pending = (async () => {
    const docs = await (window.FideliorCore?.getDocuments?.(force) || Promise.resolve([]));

    const list = docs.map(d => buildArchiveSearchEntry({
      name: d.fileName || '',
      objectCode: d.objectCode || '',
      objectName: d.objectName || '',
      folderType: d.type === 'Rechnung' ? 'Rechnungsbelege' : 'Dokumente',
      year: d.year || '',
      subfolder: '',
      modified: d.savedAt ? new Date(d.savedAt).getTime() : 0,
      meta: {
        absender: d.sender || '',
        betrag: d.amount || '',
        datum: d.date || ''
      },
      __core: d
    }));

    __fdlArchivSearchCache.ts = Date.now();
    __fdlArchivSearchCache.data = list;
    return list;
  })();

  try {
    return await __fdlArchivSearchCache.pending;
  } finally {
    __fdlArchivSearchCache.pending = null;
  }
}

async function searchArchiveGlobal(query, opts = {}) {
  const filter = buildArchiveSearchFilter(query);
  if (!String(filter.raw || filter.text || '').trim() && !filter.objectCode && !filter.year && !filter.sender) {
    return { results: [], total: 0, filter };
  }

  const entries = await getArchiveSearchIndex(Boolean(opts.forceRefresh));
  const results = [];

  for (const entry of entries) {
    if (opts.scopeCategory && normalizeSearchValue(entry.scopeCategory) !== normalizeSearchValue(opts.scopeCategory)) continue;

    const score = computeArchiveSearchScore(entry, {
      ...filter,
      scopeCategory: filter.scopeCategory || opts.scopeCategory || filter.category || ''
    });

    if (score < 0) continue;
    results.push(archiveFileToSearchDoc(entry.file, score));
  }

  results.sort((a, b) =>
    (b.searchScore || 0) - (a.searchScore || 0) ||
    (b.archiveModified || 0) - (a.archiveModified || 0)
  );

  const limit = opts.limit || 100;
  return { results: results.slice(0, limit), total: results.length, filter };
}

const __fdlArchivStatsCache = { ts: 0, data: null, pending: null };

async function getArchiveDashboardStats(force = false) {
  const nowTs = Date.now();

  if (!force && __fdlArchivStatsCache.data && (nowTs - __fdlArchivStatsCache.ts) < 30000) {
    return __fdlArchivStatsCache.data;
  }
  if (__fdlArchivStatsCache.pending) return __fdlArchivStatsCache.pending;

  __fdlArchivStatsCache.pending = (async () => {
    const docs = await (window.FideliorCore?.getDocuments?.(force) || Promise.resolve([]));
    if (!docs.length) return null;

    const now = new Date();
    const weekStartMs = nowTs - (7 * 86400000);
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const out = {
      total: 0,
      weekCount: 0,
      monthCount: 0,
      monthAmount: 0,
      byObj: {},
      recent: [],
      categoryCounts: { Objekte: 0, Fidelior: 0, Privat: 0 },
      thisYear: now.getFullYear()
    };

    for (const d of docs) {
      const ms = d.savedAt ? new Date(d.savedAt).getTime() : 0;
      const amt = parseMetaAmount(d.amount || '');

      out.total++;
      if (ms >= weekStartMs) out.weekCount++;
      if (ms >= monthStartMs) {
        out.monthCount++;
        out.monthAmount += amt;
      }

      if (!out.byObj[d.objectCode]) {
        out.byObj[d.objectCode] = {
          code: d.objectCode,
          name: d.objectName,
          count: 0,
          amount: 0,
          lastSaved: null,
          openTasks: 0
        };
      }

      out.byObj[d.objectCode].count++;
      out.byObj[d.objectCode].amount += amt;
      if (!out.byObj[d.objectCode].lastSaved || ms > new Date(out.byObj[d.objectCode].lastSaved).getTime()) {
        out.byObj[d.objectCode].lastSaved = d.savedAt;
      }

      const cat = window.fdlDeriveCategory ? window.fdlDeriveCategory(d.objectCode) : 'Objekte';
      out.categoryCounts[cat] = (out.categoryCounts[cat] || 0) + 1;

      out.recent.push({
        fileName: d.fileName || '',
        objectCode: d.objectCode || '',
        docType: d.type || '',
        amount: amt,
        savedAt: d.savedAt || ''
      });
    }

    out.recent.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    out.recent = out.recent.slice(0, 25);

    __fdlArchivStatsCache.ts = Date.now();
    __fdlArchivStatsCache.data = out;
    return out;
  })();

  try {
    return await __fdlArchivStatsCache.pending;
  } finally {
    __fdlArchivStatsCache.pending = null;
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

  if (addon) {
    if (addon.firstChild) addon.insertBefore(btn, addon.firstChild);
    else addon.appendChild(btn);
    return;
  }

  if (hdr) {
    const s = document.getElementById('settingsBtn');
    if (s && s.parentNode === hdr) hdr.insertBefore(btn, s);
    else hdr.appendChild(btn);
  }

}

function init() {
  injectCSS();
try {
  injectButton();
} catch (e) {
  console.warn("Archiv Button Injection failed:", e);
}

window.addEventListener('load', () => {
  try {
    injectButton();
  } catch (e) {
    console.warn("Archiv Button Injection failed after load:", e);
  }
});



  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) open();
  });

  console.info('[FideliorArchiv v3.1] bereit — Gruppierung: Ordnertyp + Jahr, Sortierung: Dokumentdatum');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.fdlArchivOpen = open;
window.fdlArchivSearch = searchArchiveGlobal;
window.fdlArchivGetDashboardStats = getArchiveDashboardStats;
window.fdlArchivInvalidateSearchCache = () => {
  __fdlArchivSearchCache.ts = 0;
  __fdlArchivSearchCache.data = null;
};

})();