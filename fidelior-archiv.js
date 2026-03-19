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

  const rec = await loadIndexedDocumentRecord(file);

  let out;
  if (rec) {
    out = {
      title:
        rec.title ||
        rec.dashboard?.title ||
        buildArchivTitle({
          file,
          docType: rec.docType || '',
          sender: rec.sender || '',
          amount: rec.amountRaw || '',
          objectCode: rec.objectCode || file.objectCode || '',
          objectName: file.objectName || ''
        }),
      summary:
        rec.serviceDesc ||
        rec.dashboard?.summary ||
        buildArchivSummary({
          file,
          docType: rec.docType || '',
          sender: rec.sender || '',
          amount: rec.amountRaw || '',
          docDate: rec.invoiceDate ? fmtDate(rec.invoiceDate) : '',
          objectCode: rec.objectCode || file.objectCode || '',
          objectName: file.objectName || ''
        }),
      keywords: uniqClean(rec.keywords || []),
   emails: uniqClean(
  Array.isArray(rec.emailsFound) ? rec.emailsFound :
  rec.email ? [rec.email] : []
),
      dueDate: rec.dueDate || '',
      invoiceNo: rec.invoiceNo || '',
      iban: rec.iban || '',
      ustId: rec.ustId || '',
      importantFacts: uniqClean([
        rec.sender ? `Absender: ${rec.sender}` : '',
        rec.amountRaw ? `Betrag: ${rec.amountRaw}` : '',
        rec.invoiceDate ? `Belegdatum: ${fmtDate(rec.invoiceDate)}` : '',
        rec.invoiceNo ? `Referenz: ${rec.invoiceNo}` : '',
        rec.objectCode ? `Objekt: ${rec.objectCode}` : ''
      ]),
      source: 'document-index'
    };
  } else {
    out = fallbackInsightsFromArchive(file);
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

  const docType = core?.type || fmtFolderType(file.folderType);
  const amount = core?.amount || m.betrag || '';
  const docDate = core?.date || m.datum || '';
  const sender = core?.sender || m.absender || '';
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
const largeTitle = insights?.title || buildArchivTitle({
  file,
  core,
  docType,
  amount,
  sender,
  objectCode,
  objectName
});

const summary = insights?.summary || buildArchivSummary({
  file,
  core,
  docType,
  amount,
  docDate,
  sender,
  objectCode,
  objectName
});

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
          ${insights?.dueDate ? `<div class="av3-meta-row"><span class="av3-meta-label">Frist</span><span class="av3-meta-val">${esc(insights.dueDate)}</span></div>` : ''}
          ${insights?.invoiceNo ? `<div class="av3-meta-row"><span class="av3-meta-label">Referenz</span><span class="av3-meta-val">${esc(insights.invoiceNo)}</span></div>` : ''}
          ${insights?.iban ? `<div class="av3-meta-row"><span class="av3-meta-label">IBAN</span><span class="av3-meta-val mono">${esc(insights.iban)}</span></div>` : ''}
          ${insights?.ustId ? `<div class="av3-meta-row"><span class="av3-meta-label">USt-Id</span><span class="av3-meta-val mono">${esc(insights.ustId)}</span></div>` : ''}
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
            <span class="av3-meta-val">${esc(insights?.source === 'document-index' ? 'Dokumentenindex' : 'Archiv')}</span>
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
  const {
    file, docType, sender, amount, objectCode
  } = ctx || {};

  const nameStem = String(file?.name || '').replace(/\.pdf$/i, '');

if (String(docType || '').toLowerCase().startsWith('rechnung')) {
  const parts = [];
  if (docType) parts.push(docType);
  if (sender) parts.push(sender);
  if (objectCode) parts.push(objectCode);
  if (amount) parts.push(amount);
  return parts.filter(Boolean).join(' – ');
}

  if (sender) return sender;
  return nameStem || 'Dokument';
}

function buildArchivSummary(ctx) {
  const {
    docType, sender, amount, docDate, objectCode, objectName, file
  } = ctx || {};

  const bits = [];

  if (docType) bits.push(docType);
  if (sender) bits.push(`Absender ${sender}`);
  if (objectCode) bits.push(`Objekt ${objectCode}${objectName ? ` (${objectName})` : ''}`);
  if (amount) bits.push(`Betrag ${amount}`);
  if (docDate) bits.push(`vom ${docDate}`);
  if (!bits.length && file?.name) bits.push(file.name.replace(/\.pdf$/i, ''));

  return bits.join(' · ');
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