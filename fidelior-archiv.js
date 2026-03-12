/* ==========================================================================
   Fidelior Archiv  v3.0  —  Professioneller Dokument-Browser
   Standalone · Read-only · Keine Eingriffe in Ablage-Logik
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   KONFIGURATION  – objects.json live laden, scopevisioName korrekt nutzen
   ══════════════════════════════════════════════════════════════════════════ */

let objectsMap = {};   // code → { scopevisioName, displayName, ... }

async function loadObjectsConfig() {
  try {
    const cfgDir = window.configDirHandle;
    if (!cfgDir) return;
    const fh   = await cfgDir.getFileHandle('objects.json', { create: false });
    const file  = await fh.getFile();
    const json  = JSON.parse(await file.text());
    for (const obj of (json.objects || [])) {
      objectsMap[obj.code] = obj;
    }
  } catch (e) {
    console.warn('[FideliorArchiv] objects.json nicht geladen:', e);
  }
}

function getScopeName(code) {
  return objectsMap[code]?.scopevisioName || code;
}

/* ══════════════════════════════════════════════════════════════════════════
   PFAD-MAPPING  (exakt wie preflightTargets in app.js)
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
  // Normale Objekte
  return [
    { segs: ['OBJEKTE', sn, 'Rechnungsbelege'],   label: 'Rechnungsbelege' },
    { segs: ['OBJEKTE', sn, 'Objektdokumente'],   label: 'Objektdokumente' },
    { segs: ['OBJEKTE', sn, 'Abrechnungsbelege'], label: 'Abrechnungsbelege' },
  ];
}

/* ══════════════════════════════════════════════════════════════════════════
   DATEISYSTEM SCAN  — entry aus values() IS bereits der Handle
   ══════════════════════════════════════════════════════════════════════════ */

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
    }
    all.push(...batch);
  }
  all.sort((a, b) => b.modified - a.modified);
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
  let rest = [...parts], datum = null, betrag = null, objekt = null;
  const last = rest[rest.length - 1];
  if (/^(\d{4})[.\-](\d{2})[.\-](\d{2})$/.test(last)) { datum = last.replace(/[.\-]/g, '.'); rest.pop(); }
  if (rest[0] && /^\d/.test(rest[0])) { betrag = rest.shift() + ' €'; }
  if (rest[0] && /^[A-ZÄÖÜ0-9]{2,10}$/.test(rest[0])) { objekt = rest.shift(); }
  return { betrag, objekt, absender: rest.join(' ').replace(/-/g, ' ').trim() || null, datum };
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtSize(b) {
  if (!b) return '';
  return b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

/* ══════════════════════════════════════════════════════════════════════════
   TASKS (aus Addon-DB)
   ══════════════════════════════════════════════════════════════════════════ */

async function loadTasks(fileName) {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fidelior_addon_v1', 1);
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e);
    });
    return await new Promise(res => {
      const req = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
      const stem = fileName.replace(/\.pdf$/i, '');
      req.onsuccess = e => res((e.target.result || []).filter(t =>
        (t.note || '').includes(stem) || (t.title || '').includes(stem)));
      req.onerror = () => res([]);
    });
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   CSS  —  Professionell, Nevi-Qualität, saubere SVG-Icons
   ══════════════════════════════════════════════════════════════════════════ */

const SVG = {
  download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  externalLink: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  inbox: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  copy: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  link: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  task: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  check: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function injectCSS() {
  if (document.getElementById('fdl-av3-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-av3-css';
  s.textContent = `

/* ════════════════════════════════════════════
   HEADER BUTTON
   ════════════════════════════════════════════ */
#fdl-av3-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-ui, 'Inter', system-ui);
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 13px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid #D9DDE3;
  background: #FFFFFF;
  color: #5B1B70;
  transition: background .15s, border-color .15s, color .15s;
  white-space: nowrap;
  letter-spacing: .01em;
}

#fdl-av3-btn:hover {
  background: #F7F2FA;
  border-color: #C8B3D3;
  color: #4A155C;
}

#fdl-av3-btn svg {
  opacity: 1;
}

/* ════════════════════════════════════════════
   OVERLAY FULLSCREEN
   ════════════════════════════════════════════ */
#fdl-av3 {
  position: fixed; inset: 0; z-index: 9200;
  background: #F4F5F7;
  display: flex; flex-direction: column;
  opacity: 0; pointer-events: none;
  transition: opacity .18s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
#fdl-av3.open { opacity: 1; pointer-events: all; }

/* ════════════════════════════════════════════
   TOPBAR
   ════════════════════════════════════════════ */
.av3-topbar {
  display: flex; align-items: center; gap: 12px;
  height: 52px; padding: 0 20px;
  background: #fff; border-bottom: 1px solid #E5E7EB;
  flex-shrink: 0; position: relative; z-index: 10;
}
.av3-logo {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 700; color: #111827;
  letter-spacing: -.01em;
}
.av3-logo-dot { width: 8px; height: 8px; border-radius: 50%; background: #5B1B70; flex-shrink: 0; }
.av3-breadcrumb {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: #6B7280; min-width: 0;
}
.av3-breadcrumb .av3-bc-current {
  color: #111827; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.av3-bc-sep { color: #D1D5DB; font-size: 14px; }

.av3-search-wrap {
  flex: 1; max-width: 360px;
  position: relative; display: flex; align-items: center;
}
.av3-search-wrap .av3-search-icon {
  position: absolute; left: 11px; color: #9CA3AF; pointer-events: none;
  display: flex; align-items: center;
}
.av3-search-wrap input {
  width: 100%; padding: 7px 12px 7px 32px;
  font-family: inherit; font-size: 13px; color: #111827;
  background: #F9FAFB; border: 1.5px solid #E5E7EB; border-radius: 8px;
  outline: none; transition: border-color .15s, background .15s;
}
.av3-search-wrap input:focus { border-color: #5B1B70; background: #fff; box-shadow: 0 0 0 3px rgba(91,27,112,.08); }
.av3-search-wrap input::placeholder { color: #9CA3AF; }

.av3-sort-sel {
  font-family: inherit; font-size: 12px; padding: 6px 10px;
  border: 1.5px solid #E5E7EB; border-radius: 8px;
  background: #F9FAFB; color: #374151; outline: none; cursor: pointer;
}
.av3-topbar-close {
  width: 32px; height: 32px; border-radius: 8px; border: none;
  background: #F3F4F6; color: #6B7280; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s; margin-left: auto;
}
.av3-topbar-close:hover { background: #E5E7EB; color: #111827; }

/* ════════════════════════════════════════════
   LAYOUT  3 SPALTEN
   ════════════════════════════════════════════ */
.av3-body {
  flex: 1; display: grid;
  grid-template-columns: 200px 1fr 360px;
  min-height: 0; overflow: hidden;
}

/* ════════════════════════════════════════════
   SIDEBAR  —  Liegenschaften
   ════════════════════════════════════════════ */
.av3-sidebar {
  background: #fff; border-right: 1px solid #E5E7EB; overflow-y: auto;
}
.av3-sb-head {
  padding: 14px 16px 6px; font-size: 10px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase; color: #9CA3AF;
}
.av3-obj {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px 7px 16px; cursor: pointer;
  font-size: 13px; color: #374151; border-left: 3px solid transparent;
  transition: background .1s;
}
.av3-obj:hover { background: #F9FAFB; }
.av3-obj.active { background: #FAF5FB; color: #5B1B70; font-weight: 600; border-left-color: #5B1B70; }
.av3-obj-code {
  font-size: 9px; font-weight: 800; letter-spacing: .06em;
  background: #F3F0F6; color: #5B1B70; padding: 2px 5px; border-radius: 4px; flex-shrink: 0;
}
.av3-obj.active .av3-obj-code { background: #EDE9F5; }
.av3-obj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.av3-obj-cnt {
  font-size: 11px; color: #9CA3AF; background: #F3F4F6;
  border-radius: 20px; padding: 1px 8px; flex-shrink: 0; font-weight: 500;
}
.av3-obj.active .av3-obj-cnt { background: #EDE9F5; color: #5B1B70; }

/* ════════════════════════════════════════════
   DATEILISTE
   ════════════════════════════════════════════ */
.av3-list {
  background: #F4F5F7; border-right: 1px solid #E5E7EB;
  overflow-y: auto; display: flex; flex-direction: column;
}
.av3-list-head {
  padding: 10px 16px; background: #fff; border-bottom: 1px solid #E5E7EB;
  display: flex; align-items: center; justify-content: space-between;
  position: sticky; top: 0; z-index: 2; flex-shrink: 0;
}
.av3-list-count { font-size: 12px; color: #6B7280; font-weight: 500; }

.av3-year-sep {
  padding: 6px 16px; font-size: 11px; font-weight: 700; letter-spacing: .05em;
  color: #9CA3AF; background: #ECEEF1; border-bottom: 1px solid #E5E7EB;
  position: sticky; top: 44px; z-index: 1;
}

.av3-file {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 11px 14px 11px 16px; cursor: pointer;
  background: #fff; border-bottom: 1px solid #F3F4F6;
  border-left: 3px solid transparent; transition: background .1s;
}
.av3-file:hover { background: #FAFAFA; }
.av3-file.active { background: #FAF5FB; border-left-color: #5B1B70; }

.av3-thumb {
  width: 36px; height: 46px; border-radius: 5px; flex-shrink: 0;
  background: #FEF2F2; border: 1px solid #FECACA;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  font-size: 8.5px; font-weight: 800; color: #DC2626; letter-spacing: .04em;
}
.av3-thumb-line { width: 18px; height: 2px; background: #FECACA; border-radius: 1px; margin-top: 3px; }

.av3-file-body { flex: 1; min-width: 0; }
.av3-file-name {
  font-size: 12px; font-weight: 600; color: #111827; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;
}
.av3-file.active .av3-file-name { color: #5B1B70; }
.av3-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 3px; }
.av3-chip {
  font-size: 10.5px; padding: 1px 7px; border-radius: 4px;
  font-weight: 600; letter-spacing: .01em;
}
.av3-chip.amt  { background: #D1FAE5; color: #065F46; }
.av3-chip.dt   { background: #F3F4F6; color: #6B7280; font-weight: 500; }
.av3-chip.sub  { background: #FEF3C7; color: #92400E; }
.av3-chip.type { background: #EFF6FF; color: #1E40AF; }
.av3-file-sender { font-size: 11px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.av3-file-info   { font-size: 10.5px; color: #9CA3AF; margin-top: 2px; }

/* ════════════════════════════════════════════
   RECHTES PANEL
   ════════════════════════════════════════════ */
.av3-panel {
  background: #fff; display: flex; flex-direction: column; overflow: hidden; position: relative;
}
.av3-panel-rail {
  position: absolute; right: 0; top: 0; bottom: 0; width: 44px;
  display: flex; flex-direction: column; align-items: center;
  padding: 10px 0; gap: 2px;
  border-left: 1px solid #F3F4F6; background: #FAFAFA; z-index: 3;
}
.av3-rail-btn {
  width: 34px; height: 34px; border-radius: 8px; border: none;
  background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #9CA3AF; transition: background .12s, color .12s; position: relative;
}
.av3-rail-btn:hover { background: #F3F4F6; color: #374151; }
.av3-rail-btn.highlighted { color: #5B1B70; }
.av3-rail-btn[data-tip]:hover::after {
  content: attr(data-tip);
  position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%);
  background: #1F2937; color: #fff; font-size: 11.5px; font-family: inherit;
  white-space: nowrap; padding: 4px 10px; border-radius: 6px; pointer-events: none; z-index: 20;
}
.av3-rail-sep { width: 20px; height: 1px; background: #E5E7EB; margin: 4px 0; }

.av3-panel-scroll { flex: 1; overflow-y: auto; padding-right: 44px; }

/* Panel Header */
.av3-ph {
  padding: 16px 18px 14px; border-bottom: 1px solid #F3F4F6;
}
.av3-ph-date {
  font-size: 11.5px; color: #9CA3AF; margin-bottom: 4px;
  display: flex; align-items: center; gap: 5px;
}
.av3-ph-name {
  font-size: 14px; font-weight: 700; color: #111827; line-height: 1.4;
  word-break: break-word;
}

/* Sections */
.av3-sec { padding: 14px 18px; border-bottom: 1px solid #F3F4F6; }
.av3-sec:last-child { border-bottom: none; }
.av3-sec-title {
  font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: #9CA3AF; margin-bottom: 10px;
}

/* Kategorien */
.av3-cat-pills { display: flex; gap: 5px; flex-wrap: wrap; }
.av3-cat-pill {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 6px;
  background: #F3F0F6; color: #5B1B70; white-space: nowrap;
}
.av3-cat-pill.green { background: #D1FAE5; color: #065F46; }
.av3-cat-pill.amber { background: #FEF3C7; color: #92400E; }
.av3-cat-pill.blue  { background: #EFF6FF; color: #1E40AF; }

/* Metadaten-Grid */
.av3-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.av3-meta-row { display: flex; flex-direction: column; gap: 1px; }
.av3-meta-row.full { grid-column: 1 / -1; }
.av3-meta-label { font-size: 10.5px; color: #9CA3AF; font-weight: 500; }
.av3-meta-val { font-size: 13px; color: #111827; font-weight: 500; word-break: break-all; }
.av3-meta-val.mono { font-size: 11px; font-family: 'Menlo', 'Consolas', monospace; color: #374151; }

/* Aufgaben */
.av3-tasks-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.av3-task-add {
  font-family: inherit; font-size: 12px; font-weight: 600;
  padding: 4px 11px; border-radius: 7px;
  border: 1.5px solid #E5E7EB; background: transparent; color: #5B1B70; cursor: pointer;
}
.av3-task-add:hover { background: #FAF5FB; border-color: #5B1B70; }
.av3-task-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid #F9FAFB; font-size: 12.5px; color: #374151;
}
.av3-task-row:last-child { border-bottom: none; }
.av3-check-box {
  width: 15px; height: 15px; border-radius: 4px; flex-shrink: 0; margin-top: 1px;
  border: 2px solid #D1D5DB; display: flex; align-items: center; justify-content: center;
}
.av3-check-box.done { background: #5B1B70; border-color: #5B1B70; }
.av3-check-box.high { border-color: #EF4444; }
.av3-no-tasks { font-size: 12.5px; color: #9CA3AF; }

/* VORSCHAU */
.av3-prev-wrap { background: #F1F2F4; overflow-y: auto; padding: 16px; min-height: 320px; }
.av3-prev-canvas-wrap { display: flex; flex-direction: column; gap: 10px; align-items: center; }
.av3-prev-canvas-wrap canvas {
  width: 100%; border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 16px rgba(0,0,0,.1);
}
.av3-prev-more { font-size: 11.5px; color: #9CA3AF; text-align: center; padding: 6px 0; }

/* LEERE ZUSTÄNDE & LOADING */
.av3-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 48px 20px; color: #9CA3AF; text-align: center; gap: 8px;
}
.av3-empty-icon { font-size: 40px; line-height: 1; margin-bottom: 4px; }
.av3-empty-title { font-size: 14px; font-weight: 600; color: #374151; }
.av3-empty-sub   { font-size: 12.5px; }
.av3-loading {
  display: flex; align-items: center; justify-content: center;
  gap: 10px; padding: 40px 20px; color: #6B7280; font-size: 13px;
}
@keyframes av3spin { to { transform: rotate(360deg); } }
.av3-spinner {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid #E5E7EB; border-top-color: #5B1B70;
  animation: av3spin .65s linear infinite;
}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */

const S = {
  obj: null, files: [], filtered: [], selected: null,
  query: '', blobUrl: null, counts: {},
};

/* ══════════════════════════════════════════════════════════════════════════
   OBJEKTE-LISTE
   ══════════════════════════════════════════════════════════════════════════ */

function getObjList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options).filter(o => o.value).map(o => ({ code: o.value, name: o.textContent }));
}

function getShortName(o) {
  const obj = objectsMap[o.code];
  if (obj?.displayName) return obj.displayName.replace(o.code + ' · ', '').trim();
  return o.name.replace(o.code + ' · ', '').trim();
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: SIDEBAR
   ══════════════════════════════════════════════════════════════════════════ */

function renderSidebar() {
  const el = document.getElementById('fdl-av3-sb');
  if (!el) return;
  const objs = getObjList();
  let h = '<div class="av3-sb-head">Liegenschaften</div>';
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
      <div class="av3-empty-icon">📂</div>
      <div class="av3-empty-title">${S.query ? 'Keine Treffer' : 'Keine Dokumente'}</div>
      <div class="av3-empty-sub">${S.query ? 'Suche anpassen' : 'Ordner leer oder Scopevisio nicht verbunden'}</div>
    </div>`;
    return;
  }

  let html = '', lastYear = null;
  for (const f of files) {
    if (f.year && f.year !== lastYear) {
      html += `<div class="av3-year-sep">${f.year}</div>`;
      lastYear = f.year;
    }
    const m   = f.meta;
    const act = isSel(f) ? 'active' : '';
    const key = encodeURIComponent(f.name + '||' + f.modified);
    html += `<div class="av3-file ${act}" onclick="window.__av3.file('${key}')">
      <div class="av3-thumb">PDF<div class="av3-thumb-line"></div></div>
      <div class="av3-file-body">
        <div class="av3-file-name" title="${f.name}">${f.name}</div>
        <div class="av3-chips">
          ${m.betrag    ? `<span class="av3-chip amt">${m.betrag}</span>` : ''}
          ${m.datum     ? `<span class="av3-chip dt">${m.datum}</span>` : ''}
          ${f.subfolder ? `<span class="av3-chip sub">${f.subfolder}</span>` : ''}
          ${f.folderType && f.folderType !== 'Rechnungsbelege' ? `<span class="av3-chip type">${f.folderType}</span>` : ''}
        </div>
        ${m.absender ? `<div class="av3-file-sender">${m.absender}</div>` : ''}
        <div class="av3-file-info">${fmtDate(f.modified)} · ${fmtSize(f.size)}</div>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function isSel(f) { return S.selected && S.selected.name === f.name && S.selected.modified === f.modified; }

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: RECHTES PANEL
   ══════════════════════════════════════════════════════════════════════════ */

async function renderPanel(file) {
  const el = document.getElementById('fdl-av3-panel');
  if (!el) return;
  if (!file) {
    el.innerHTML = `<div class="av3-empty" style="flex:1;height:100%">
      <div class="av3-empty-icon">👈</div>
      <div class="av3-empty-title">Dokument auswählen</div>
      <div class="av3-empty-sub">Klicke auf ein Dokument in der Liste</div>
    </div>`;
    return;
  }

  const m     = file.meta;
  const tasks = await loadTasks(file.name);
  const open  = tasks.filter(t => t.status !== 'done');

  const catPills = [
    S.obj ? `<span class="av3-cat-pill">${SVG.folder} ${S.obj.name || S.obj.code}</span>` : '',
    file.folderType ? `<span class="av3-cat-pill green">${file.folderType}</span>` : '',
    file.year ? `<span class="av3-cat-pill blue">${file.year}</span>` : '',
    file.subfolder ? `<span class="av3-cat-pill amber">${file.subfolder}</span>` : '',
  ].filter(Boolean).join('');

  const taskHTML = tasks.length
    ? tasks.slice(0, 6).map(t => {
        const done = t.status === 'done', high = t.priority === 'high';
        return `<div class="av3-task-row">
          <div class="av3-check-box ${done ? 'done' : high ? 'high' : ''}">${done ? SVG.check : ''}</div>
          <span style="${done ? 'text-decoration:line-through;opacity:.5' : ''}">${t.title}</span>
        </div>`;
      }).join('')
    : '<div class="av3-no-tasks">Noch keine Aufgaben verknüpft</div>';

  el.innerHTML = `
    <!-- Rechte Icon-Leiste -->
    <div class="av3-panel-rail">
      <button class="av3-rail-btn" data-tip="Herunterladen"    onclick="window.__av3.dl()">${SVG.download}</button>
      <button class="av3-rail-btn" data-tip="In neuem Tab"     onclick="window.__av3.tab()">${SVG.externalLink}</button>
      <button class="av3-rail-btn" data-tip="In App laden"     onclick="window.__av3.load()">${SVG.inbox}</button>
      <div class="av3-rail-sep"></div>
      <button class="av3-rail-btn" data-tip="Name kopieren"    onclick="window.__av3.cpName()">${SVG.copy}</button>
      <button class="av3-rail-btn" data-tip="Pfad kopieren"    onclick="window.__av3.cpPath()">${SVG.link}</button>
      <div style="flex:1"></div>
      <button class="av3-rail-btn${open.length ? ' highlighted' : ''}" data-tip="Aufgabe erstellen" onclick="window.__av3.task()">${SVG.task}</button>
    </div>

    <!-- Scrollbarer Inhalt -->
    <div class="av3-panel-scroll">

      <div class="av3-ph">
        <div class="av3-ph-date">📅 ${fmtDate(file.modified)}</div>
        <div class="av3-ph-name">${file.name}</div>
      </div>

      <div class="av3-sec">
        <div class="av3-sec-title">Kategorien</div>
        <div class="av3-cat-pills">${catPills || '<span style="color:#9CA3AF;font-size:12px">—</span>'}</div>
      </div>

      <div class="av3-sec">
        <div class="av3-sec-title">Dokumentdaten</div>
        <div class="av3-meta">
          ${m.betrag   ? `<div class="av3-meta-row"><span class="av3-meta-label">Betrag</span><span class="av3-meta-val">${m.betrag}</span></div>` : ''}
          ${m.datum    ? `<div class="av3-meta-row"><span class="av3-meta-label">Belegdatum</span><span class="av3-meta-val">${m.datum}</span></div>` : ''}
          ${m.absender ? `<div class="av3-meta-row"><span class="av3-meta-label">Absender</span><span class="av3-meta-val">${m.absender}</span></div>` : ''}
          <div class="av3-meta-row"><span class="av3-meta-label">Dateigröße</span><span class="av3-meta-val">${fmtSize(file.size)}</span></div>
          <div class="av3-meta-row"><span class="av3-meta-label">Geändert</span><span class="av3-meta-val">${fmtDate(file.modified)}</span></div>
          ${file.subfolder ? `<div class="av3-meta-row"><span class="av3-meta-label">Unterordner</span><span class="av3-meta-val">${file.subfolder}</span></div>` : ''}
          <div class="av3-meta-row full"><span class="av3-meta-label">Pfad</span><span class="av3-meta-val mono">${(file.pathSegs || []).join(' › ')}</span></div>
        </div>
      </div>

      <div class="av3-sec">
        <div class="av3-tasks-hdr">
          <div class="av3-sec-title" style="margin:0">Aufgaben${open.length ? ' (' + open.length + ')' : ''}</div>
          <button class="av3-task-add" onclick="window.__av3.task()">+ Erstellen</button>
        </div>
        ${taskHTML}
      </div>

      <div class="av3-sec av3-prev-sec">
        <div class="av3-sec-title">Vorschau</div>
        <div class="av3-prev-wrap" id="fdl-av3-prev">
          <div class="av3-loading"><div class="av3-spinner"></div> PDF wird gerendert…</div>
        </div>
      </div>
    </div>`;

  renderPDF(file);
}

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
    if (!pjs) { wrap.innerHTML = `<embed src="${S.blobUrl}" type="application/pdf" style="width:100%;height:500px;border-radius:4px">`; return; }
    if (!pjs.GlobalWorkerOptions?.workerSrc)
      pjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const doc   = await pjs.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 8);
    wrap.innerHTML = '<div class="av3-prev-canvas-wrap" id="av3-cv-wrap"></div>';
    const cvWrap = document.getElementById('av3-cv-wrap');

    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const vp   = page.getViewport({ scale: 1.8 });
      const cv   = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
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
    wrap.innerHTML = `<div class="av3-empty"><div class="av3-empty-icon">⚠️</div><div class="av3-empty-sub">Vorschau nicht verfügbar</div></div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AKTIONEN
   ══════════════════════════════════════════════════════════════════════════ */

window.__av3 = {
  async obj(code) {
    const o = getObjList().find(x => x.code === code);
    if (!o) return;
    S.obj = { ...o, ...(objectsMap[code] || {}) };
    S.selected = null; S.files = []; S.filtered = []; S.query = '';
    const sf = document.getElementById('fdl-av3-search'); if (sf) sf.value = '';

    const bc = document.getElementById('fdl-av3-bc');
    if (bc) bc.innerHTML = `<span style="color:#9CA3AF">Archiv</span><span class="av3-bc-sep">/</span><span class="av3-bc-current">${o.name}</span>`;

    renderSidebar();

    const li = document.getElementById('fdl-av3-li');
    if (li) li.innerHTML = `<div class="av3-loading"><div class="av3-spinner"></div> Lade Dokumente…</div>`;
    renderPanel(null);

    const root = window.scopeRootHandle;
    if (!root) {
      if (li) li.innerHTML = `<div class="av3-empty"><div class="av3-empty-icon">🔌</div><div class="av3-empty-title">Scopevisio nicht verbunden</div></div>`;
      return;
    }

    const files = await loadFiles(code);
    S.files = files; S.filtered = files;
    S.counts[code] = files.length;
    const ce = document.getElementById(`av3c-${code}`); if (ce) ce.textContent = files.length;
    renderList(files);
  },

  async file(key) {
    const [name, mod] = decodeURIComponent(key).split('||');
    const f = S.files.find(x => x.name === name && String(x.modified) === mod) || S.files.find(x => x.name === name);
    if (!f) return;
    S.selected = f;
    renderList(S.filtered);
    await renderPanel(f);
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
      if (fi) { Object.defineProperty(fi, 'files', { value: dt.files, configurable: true }); fi.dispatchEvent(new Event('change', { bubbles: true })); close(); toast(`<strong>${f.name}</strong> geladen`, 2000); }
      else toast('Direkt-Laden nicht möglich', 3000);
    } catch (e) { toast('Fehler: ' + (e?.message || e), 3000); }
  },

  task() {
    if (!S.selected) return;
    close();
    setTimeout(() => {
      const ov = document.getElementById('fdl-tasks-overlay');
      if (ov) { ov.classList.add('open'); setTimeout(() => { const n = document.getElementById('fdl-f-note'), ob = document.getElementById('fdl-f-obj'); if (n) n.value = 'Dokument: ' + S.selected.name; if (ob && S.obj) ob.value = S.obj.code; }, 80); }
      else try { toast('Aufgaben-Addon nicht geladen', 2000); } catch {}
    }, 160);
  },
};

function toast(h, ms) { try { if (typeof window.toast === 'function') window.toast(h, ms || 2500); } catch {} }

/* ══════════════════════════════════════════════════════════════════════════
   FILTER & SORT
   ══════════════════════════════════════════════════════════════════════════ */

function applyFilter(q) {
  S.query = (q || '').trim().toLowerCase();
  S.filtered = !S.query ? S.files : S.files.filter(f =>
    f.name.toLowerCase().includes(S.query) ||
    (f.meta.absender || '').toLowerCase().includes(S.query) ||
    (f.meta.betrag || '').toLowerCase().includes(S.query) ||
    (f.meta.datum || '').toLowerCase().includes(S.query) ||
    (f.subfolder || '').toLowerCase().includes(S.query) ||
    (f.year || '').includes(S.query)
  );
  renderList(S.filtered);
}

function applySort(v) {
  const arr = [...S.filtered];
  if (v === 'date-desc') arr.sort((a, b) => b.modified - a.modified);
  if (v === 'date-asc')  arr.sort((a, b) => a.modified - b.modified);
  if (v === 'name-asc')  arr.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (v === 'amount')    arr.sort((a, b) => {
    const n = s => parseFloat((s.meta.betrag || '0').replace('.', '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
    return n(b) - n(a);
  });
  S.filtered = arr; renderList(arr);
}

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
      <select class="av3-sort-sel" id="fdl-av3-sort">
        <option value="date-desc">Neueste zuerst</option>
        <option value="date-asc">Älteste zuerst</option>
        <option value="name-asc">Name A–Z</option>
        <option value="amount">Betrag ↓</option>
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
            <div class="av3-empty-icon">📁</div>
            <div class="av3-empty-title">Liegenschaft wählen</div>
          </div>
        </div>
      </div>
      <div class="av3-panel" id="fdl-av3-panel">
        <div class="av3-empty" style="height:100%">
          <div class="av3-empty-icon">👈</div>
          <div class="av3-empty-title">Dokument auswählen</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('fdl-av3-close').onclick = close;
  document.getElementById('fdl-av3-search').addEventListener('input', e => applyFilter(e.target.value));
  document.getElementById('fdl-av3-sort').addEventListener('change', e => applySort(e.target.value));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
}

async function open() {
  buildOverlay();
  await loadObjectsConfig();
  renderSidebar();
  document.getElementById('fdl-av3').classList.add('open');

  // Counts im Hintergrund laden
  const root = window.scopeRootHandle;
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
}

/* ══════════════════════════════════════════════════════════════════════════
   HEADER-BUTTON
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

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

function init() {
  injectCSS(); injectButton();
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) open();
  });
  console.info('[FideliorArchiv v3.0] bereit');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
window.fdlArchivOpen = open;

})();
