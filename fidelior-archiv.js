/* ==========================================================================
   Fidelior Archiv – Dokument-Browser & Viewer
   Version 1.0 — Non-invasive, standalone
   Liest aus bestehenden scopeRootHandle/pcloudRootHandle (read-only).
   Berührt KEINE Ablage-Logik.
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   PFAD-MAPPING (spiegelt die Ablage-Logik aus app.js exakt wider)
   ══════════════════════════════════════════════════════════════════════════ */

function buildScopePaths(obj) {
  const sn = obj.scopevisioName || obj.code;
  const paths = [];
  if (obj.code === 'FIDELIOR') {
    paths.push(['FIDELIOR', 'Eingangsrechnungen']);
    paths.push(['FIDELIOR', 'Dokumente']);
    paths.push(['FIDELIOR', 'VERWALTUNG']);
  } else if (obj.code === 'PRIVAT') {
    paths.push(['PRIVAT', 'Rechnungsbelege']);
    paths.push(['PRIVAT', 'Dokumente']);
  } else {
    paths.push(['OBJEKTE', sn, 'Rechnungsbelege']);
    paths.push(['OBJEKTE', sn, 'Objektdokumente']);
    // B75 Spezial
    if (obj.specialSubfoldersScopevisio) {
      for (const sub of obj.specialSubfoldersScopevisio) {
        paths.push(['OBJEKTE', sn, 'Rechnungsbelege', sub]);
      }
    }
  }
  return paths;
}

/* ══════════════════════════════════════════════════════════════════════════
   DATEINAME PARSEN  →  { betrag, objekt, absender, datum }
   Template: {BETRAG}_{OBJEKT}_{ABSENDER}_{DATUM}.pdf
   ══════════════════════════════════════════════════════════════════════════ */

function parseFileName(name) {
  const stem = name.replace(/\.pdf$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) return { raw: name };

  // Datum: letzter Part der Form YYYY.MM.DD oder YYYY-MM-DD
  const dateRx = /^(\d{4})[.\-](\d{2})[.\-](\d{2})$/;
  let datum = null, rest = [...parts];

  const last = rest[rest.length - 1];
  if (dateRx.test(last)) { datum = last.replace(/[.\-]/g, '.'); rest.pop(); }

  // Betrag: erster Part mit Zahlen/Komma
  let betrag = null;
  const first = rest[0] || '';
  if (/^\d/.test(first)) { betrag = first + ' €'; rest.shift(); }

  // Objekt: nächster kurzer Großbuchstaben-Part (Code)
  let objekt = null;
  if (rest[0] && /^[A-Z0-9]{2,8}$/.test(rest[0].replace(/\s/g, ''))) {
    objekt = rest.shift();
  }

  const absender = rest.join(' ').replace(/-/g, ' ').trim() || null;

  return { betrag, objekt, absender, datum, raw: name };
}

/* ══════════════════════════════════════════════════════════════════════════
   DATEISYSTEM SCANNEN
   ══════════════════════════════════════════════════════════════════════════ */

async function scanDir(dirHandle, depth) {
  const files = [];
  if (!dirHandle || depth < 0) return files;
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {
        const file = await entry.getFile();
        files.push({
          handle:   entry,
          name:     entry.name,
          size:     file.size,
          modified: file.lastModified,
          meta:     parseFileName(entry.name),
        });
      } else if (entry.kind === 'directory' && depth > 0) {
        const sub = await entry.getDirectoryHandle(entry.name, { create: false }).catch(() => null)
          || await dirHandle.getDirectoryHandle(entry.name, { create: false }).catch(() => null);
        if (sub) {
          const sub2 = await entry; // entry IS the dirHandle
          const deeper = await scanDir(entry, depth - 1);
          files.push(...deeper);
        }
      }
    }
  } catch {}
  return files;
}

async function navigatePath(rootHandle, segments) {
  let cur = rootHandle;
  for (const seg of segments) {
    try { cur = await cur.getDirectoryHandle(seg, { create: false }); }
    catch { return null; }
  }
  return cur;
}

async function loadFilesForObject(obj, rootHandle) {
  if (!rootHandle) return [];
  const paths = buildScopePaths(obj);
  const allFiles = [];
  const seen = new Set();

  for (const segs of paths) {
    const dir = await navigatePath(rootHandle, segs);
    if (!dir) continue;

    // Scanne bis 2 Ebenen tief (Jahr-Unterordner)
    try {
      for await (const entry of dir.values()) {
        if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {
          if (!seen.has(entry.name)) {
            seen.add(entry.name);
            const file = await entry.getFile();
            allFiles.push({
              handle: entry, name: entry.name,
              size: file.size, modified: file.lastModified,
              meta: parseFileName(entry.name),
              path: segs,
            });
          }
        } else if (entry.kind === 'directory') {
          // Jahres-Unterordner
          try {
            for await (const sub of entry.values()) {
              if (sub.kind === 'file' && /\.pdf$/i.test(sub.name)) {
                const key = entry.name + '/' + sub.name;
                if (!seen.has(key)) {
                  seen.add(key);
                  const file = await sub.getFile();
                  allFiles.push({
                    handle: sub, name: sub.name,
                    size: file.size, modified: file.lastModified,
                    meta: parseFileName(sub.name),
                    path: [...segs, entry.name],
                    subfolder: entry.name,
                  });
                }
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  allFiles.sort((a, b) => b.modified - a.modified);
  return allFiles;
}

/* ══════════════════════════════════════════════════════════════════════════
   CSS
   ══════════════════════════════════════════════════════════════════════════ */

function injectCSS() {
  if (document.getElementById('fdl-archiv-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-archiv-css';
  s.textContent = `

/* ── Header-Button ── */
.fdl-archiv-hbtn {
  font-family: var(--font-ui); font-size: 11.5px; font-weight: 600;
  padding: 5px 12px; border-radius: 8px;
  border: 1.5px solid rgba(255,255,255,.22);
  background: rgba(255,255,255,.1); color: #fff;
  cursor: pointer; transition: background .15s; white-space: nowrap;
}
.fdl-archiv-hbtn:hover { background: rgba(255,255,255,.2); }

/* ── Overlay (vollbild) ── */
#fdl-archiv-overlay {
  position: fixed; inset: 0; z-index: 9100;
  background: var(--bg); display: flex; flex-direction: column;
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
#fdl-archiv-overlay.open { opacity: 1; pointer-events: all; }

/* ── Top-Bar ── */
.fdl-av-topbar {
  display: flex; align-items: center; gap: .75rem;
  padding: 0 1.25rem; height: 52px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.fdl-av-topbar-title {
  font-size: 14px; font-weight: 700; color: var(--text);
  display: flex; align-items: center; gap: .4rem;
}
.fdl-av-close {
  width: 30px; height: 30px; border-radius: 8px; border: none;
  background: var(--surface-2); color: var(--muted); font-size: 16px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  margin-left: auto;
}
.fdl-av-close:hover { background: var(--border); color: var(--text); }
.fdl-av-search {
  flex: 1; max-width: 320px; font-family: var(--font-ui); font-size: 12.5px;
  padding: 6px 12px; border-radius: 8px;
  border: 1.5px solid var(--border); background: var(--surface-2); color: var(--text);
}
.fdl-av-search:focus { outline: none; border-color: var(--primary); box-shadow: var(--focus-ring); }
.fdl-av-breadcrumb {
  font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: .3rem;
}
.fdl-av-breadcrumb span { color: var(--primary); font-weight: 600; cursor: pointer; }
.fdl-av-breadcrumb span:hover { text-decoration: underline; }

/* ── Layout: Sidebar + List + Viewer ── */
.fdl-av-body {
  flex: 1; display: grid;
  grid-template-columns: 200px 1fr 1fr;
  min-height: 0; overflow: hidden;
}
@media (max-width: 900px) {
  .fdl-av-body { grid-template-columns: 160px 1fr; }
  .fdl-av-viewer { display: none; }
}

/* ── Sidebar (Objekte) ── */
.fdl-av-sidebar {
  border-right: 1px solid var(--border); overflow-y: auto;
  background: var(--surface);
}
.fdl-av-sidebar-head {
  padding: .75rem 1rem .4rem;
  font-size: 10.5px; font-weight: 700; color: var(--muted);
  letter-spacing: .07em; text-transform: uppercase;
}
.fdl-av-obj-item {
  display: flex; align-items: center; gap: .55rem;
  padding: .5rem 1rem; cursor: pointer; font-size: 12.5px;
  color: var(--text); transition: background .12s; border-radius: 0;
  border-left: 3px solid transparent;
}
.fdl-av-obj-item:hover { background: var(--surface-2); }
.fdl-av-obj-item.active {
  background: rgba(91,27,112,.08); color: var(--primary); font-weight: 600;
  border-left-color: var(--primary);
}
.fdl-av-obj-code {
  font-size: 10px; font-weight: 700; letter-spacing: .05em;
  background: rgba(91,27,112,.1); color: var(--primary);
  padding: 1px 5px; border-radius: 4px;
}
.fdl-av-obj-count {
  margin-left: auto; font-size: 10.5px; color: var(--muted);
  background: var(--surface-2); border-radius: 10px; padding: 1px 7px;
}

/* ── Dateiliste ── */
.fdl-av-list {
  border-right: 1px solid var(--border); overflow-y: auto;
  background: var(--surface-2);
}
.fdl-av-list-head {
  padding: .7rem 1rem; background: var(--surface);
  border-bottom: 1px solid var(--border); display: flex;
  align-items: center; justify-content: space-between;
  position: sticky; top: 0; z-index: 1;
}
.fdl-av-list-count { font-size: 11.5px; color: var(--muted); }
.fdl-av-list-sort {
  font-family: var(--font-ui); font-size: 11px;
  padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--muted);
}
.fdl-av-file-item {
  display: flex; align-items: flex-start; gap: .6rem;
  padding: .7rem 1rem; cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background .12s;
}
.fdl-av-file-item:hover { background: rgba(91,27,112,.04); }
.fdl-av-file-item.active {
  background: rgba(91,27,112,.08); border-left: 3px solid var(--primary);
  padding-left: calc(1rem - 3px);
}
.fdl-av-file-icon {
  width: 34px; height: 42px; border-radius: 5px;
  background: #fee2e2; border: 1px solid #fca5a5;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; color: #b91c1c; flex-shrink: 0;
  letter-spacing: .02em;
}
.fdl-av-file-body { flex: 1; min-width: 0; }
.fdl-av-file-name {
  font-size: 12px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-bottom: .2rem;
}
.fdl-av-file-item.active .fdl-av-file-name { color: var(--primary); }
.fdl-av-file-meta { display: flex; gap: .4rem; flex-wrap: wrap; }
.fdl-av-chip {
  font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
  background: rgba(91,27,112,.08); color: var(--primary); font-weight: 600;
}
.fdl-av-chip.amount { background: rgba(26,122,69,.09); color: #1A7A45; }
.fdl-av-chip.date   { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
.fdl-av-chip.sub    { background: rgba(200,160,0,.09); color: #7A5800; }
.fdl-av-file-date { font-size: 10.5px; color: var(--muted); margin-top: .2rem; }

/* ── Viewer ── */
.fdl-av-viewer {
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface);
}
.fdl-av-viewer-head {
  padding: .7rem 1.1rem; border-bottom: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0;
  display: flex; align-items: center; gap: .6rem;
}
.fdl-av-viewer-name {
  font-size: 13px; font-weight: 700; color: var(--text); flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fdl-av-action-btn {
  font-family: var(--font-ui); font-size: 11.5px; font-weight: 600;
  padding: 5px 12px; border-radius: 7px; cursor: pointer; display: flex;
  align-items: center; gap: .35rem; white-space: nowrap;
}
.fdl-av-btn-download {
  background: var(--primary); color: #fff; border: none;
}
.fdl-av-btn-download:hover { background: var(--primary-600, #6a2483); }
.fdl-av-btn-task {
  background: var(--surface-2); color: var(--text);
  border: 1.5px solid var(--border);
}
.fdl-av-btn-task:hover { border-color: var(--primary); color: var(--primary); }
.fdl-av-btn-open {
  background: transparent; color: var(--muted);
  border: 1.5px solid var(--border);
}
.fdl-av-btn-open:hover { background: var(--surface-2); }

/* ── Viewer-Body (Metadaten + PDF) ── */
.fdl-av-viewer-body {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column;
}
.fdl-av-meta-panel {
  padding: 1rem 1.1rem; border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.fdl-av-meta-title {
  font-size: 10.5px; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; color: var(--muted); margin-bottom: .6rem;
}
.fdl-av-meta-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: .35rem .75rem;
}
.fdl-av-meta-row { display: flex; flex-direction: column; }
.fdl-av-meta-label { font-size: 10px; color: var(--muted); font-weight: 600; }
.fdl-av-meta-value { font-size: 12.5px; color: var(--text); font-weight: 500; }

/* ── Tasks im Viewer ── */
.fdl-av-tasks-panel {
  padding: .85rem 1.1rem; border-bottom: 1px solid var(--border);
}
.fdl-av-tasks-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: .6rem;
}
.fdl-av-tasks-title {
  font-size: 10.5px; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; color: var(--muted);
}
.fdl-av-task-add {
  font-family: var(--font-ui); font-size: 11px; font-weight: 600;
  padding: 3px 10px; border-radius: 6px; border: 1.5px solid var(--border);
  background: transparent; color: var(--primary); cursor: pointer;
}
.fdl-av-task-add:hover { background: rgba(91,27,112,.06); }
.fdl-av-task-mini {
  display: flex; align-items: center; gap: .5rem;
  font-size: 12px; padding: .35rem 0; color: var(--text);
}
.fdl-av-task-check-mini {
  width: 15px; height: 15px; border-radius: 4px;
  border: 2px solid var(--border); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 9px;
}
.fdl-av-task-check-mini.done { background: var(--primary); border-color: var(--primary); color:#fff; }
.fdl-av-no-tasks { font-size: 11.5px; color: var(--muted); }

/* ── PDF-Embed-Wrapper ── */
.fdl-av-pdf-wrap {
  flex: 1; background: #e5e7eb; display: flex;
  align-items: flex-start; justify-content: center;
  padding: 1rem; overflow-y: auto;
}
.fdl-av-pdf-wrap canvas {
  max-width: 100%; border-radius: 4px;
  box-shadow: 0 4px 20px rgba(0,0,0,.15);
}
.fdl-av-pdf-pages { display: flex; flex-direction: column; gap: .75rem; align-items: center; width: 100%; }

/* ── Leere Zustände ── */
.fdl-av-empty {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; padding: 3rem 1rem;
  color: var(--muted); font-size: 13px; text-align: center; gap: .5rem;
}
.fdl-av-empty-icon { font-size: 2.5rem; }
.fdl-av-loading {
  display: flex; align-items: center; justify-content: center;
  padding: 2rem; gap: .6rem; color: var(--muted); font-size: 12.5px;
}
@keyframes fdlSpin { to { transform: rotate(360deg); } }
.fdl-av-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--primary);
  animation: fdlSpin .7s linear infinite;
}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */

const State = {
  overlay:      null,
  selectedObj:  null,
  files:        [],
  filteredFiles:[],
  selectedFile: null,
  searchQuery:  '',
  loading:      false,
  pdfPages:     [],
  currentBlobUrl: null,
};

/* ══════════════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function getObjectList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options).filter(o => o.value).map(o => ({ code: o.value, name: o.textContent }));
}
function getObjectRecord(code) {
  const cfg = window.objectsCfg?.objects || [];
  return cfg.find(o => o.code === code) || { code, scopevisioName: code };
}
function getScopeRoot()  { return window.scopeRootHandle  || null; }

function qs(sel, el) { return (el || document).querySelector(sel); }

/* ══════════════════════════════════════════════════════════════════════════
   TASKS (aus Addon-IndexedDB)
   ══════════════════════════════════════════════════════════════════════════ */

async function getTasksForFile(fileName) {
  if (!window.fdlOnFileSaved) return []; // Addon nicht geladen
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('fidelior_addon_v1', 1);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    return await new Promise((res, rej) => {
      const tx  = db.transaction('tasks', 'readonly');
      const req = tx.objectStore('tasks').getAll();
      req.onsuccess = e => {
        const all = e.target.result || [];
        // Aufgaben mit Dateiname-Bezug filtern
        const relevant = all.filter(t =>
          t.note?.includes(fileName) ||
          t.title?.includes(fileName.replace(/\.pdf$/i, ''))
        );
        res(relevant);
      };
      req.onerror = e => rej(e.target.error);
    });
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   HTML RENDERN
   ══════════════════════════════════════════════════════════════════════════ */

function renderSidebar() {
  const el = qs('#fdl-av-sidebar');
  if (!el) return;
  const objects = getObjectList();
  let html = '<div class="fdl-av-sidebar-head">Liegenschaften</div>';
  for (const obj of objects) {
    const shortName = obj.name.replace(obj.code + ' · ', '');
    const isActive = State.selectedObj?.code === obj.code;
    html += `
      <div class="fdl-av-obj-item ${isActive ? 'active' : ''}" data-code="${obj.code}" onclick="window.__fdlAvSelectObj('${obj.code}')">
        <span class="fdl-av-obj-code">${obj.code}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shortName}</span>
        <span class="fdl-av-obj-count" id="fdl-av-count-${obj.code}">…</span>
      </div>`;
  }
  el.innerHTML = html;
}

function renderFileList(files) {
  const el = qs('#fdl-av-list-inner');
  const countEl = qs('#fdl-av-list-count');
  if (!el) return;

  if (countEl) countEl.textContent = `${files.length} Dokument${files.length !== 1 ? 'e' : ''}`;

  if (files.length === 0) {
    el.innerHTML = `<div class="fdl-av-empty">
      <div class="fdl-av-empty-icon">📂</div>
      <div>${State.searchQuery ? 'Keine Treffer für „' + State.searchQuery + '"' : 'Keine Dokumente gefunden'}</div>
      <div style="font-size:11.5px">${State.searchQuery ? '' : 'Scopevisio-Verbindung aktiv?'}</div>
    </div>`;
    return;
  }

  let html = '';
  for (const f of files) {
    const m = f.meta;
    const isActive = State.selectedFile?.name === f.name && State.selectedFile?.modified === f.modified;
    html += `
      <div class="fdl-av-file-item ${isActive ? 'active' : ''}"
           onclick="window.__fdlAvSelectFile('${encodeURIComponent(f.name)}', ${f.modified})">
        <div class="fdl-av-file-icon">PDF</div>
        <div class="fdl-av-file-body">
          <div class="fdl-av-file-name" title="${f.name}">${f.name}</div>
          <div class="fdl-av-file-meta">
            ${m.betrag ? `<span class="fdl-av-chip amount">${m.betrag}</span>` : ''}
            ${m.datum  ? `<span class="fdl-av-chip date">📅 ${m.datum.replace(/\./g, '.')}</span>` : ''}
            ${f.subfolder ? `<span class="fdl-av-chip sub">${f.subfolder}</span>` : ''}
          </div>
          ${m.absender ? `<div class="fdl-av-file-date">${m.absender}</div>` : ''}
          <div class="fdl-av-file-date">${fmtDate(f.modified)} · ${fmtSize(f.size)}</div>
        </div>
      </div>`;
  }
  el.innerHTML = html;
}

async function renderViewer(file) {
  const el = qs('#fdl-av-viewer');
  if (!el || !file) {
    if (el) el.innerHTML = `<div class="fdl-av-empty" style="flex:1;justify-content:flex-start;padding-top:4rem">
      <div class="fdl-av-empty-icon">👆</div>
      <div>Dokument auswählen</div>
    </div>`;
    return;
  }

  const m = file.meta;
  const tasks = await getTasksForFile(file.name);
  const openTasks = tasks.filter(t => t.status !== 'done');

  const taskHtml = tasks.length > 0
    ? tasks.slice(0, 5).map(t => `
        <div class="fdl-av-task-mini">
          <div class="fdl-av-task-check-mini ${t.status === 'done' ? 'done' : ''}">${t.status === 'done' ? '✓' : ''}</div>
          <span style="${t.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}">${t.title}</span>
        </div>`).join('')
    : '<div class="fdl-av-no-tasks">Keine Aufgaben</div>';

  el.innerHTML = `
    <div class="fdl-av-viewer-head">
      <div class="fdl-av-viewer-name" title="${file.name}">${file.name}</div>
      <button class="fdl-av-action-btn fdl-av-btn-open" onclick="window.__fdlAvOpenNewTab()" title="In neuem Tab öffnen">↗</button>
      <button class="fdl-av-action-btn fdl-av-btn-task" onclick="window.__fdlAvCreateTask()" title="Aufgabe anlegen">
        ✅ Aufgabe${openTasks.length > 0 ? ' (' + openTasks.length + ')' : ''}
      </button>
      <button class="fdl-av-action-btn fdl-av-btn-download" onclick="window.__fdlAvDownload()">
        ⬇ Download
      </button>
    </div>
    <div class="fdl-av-viewer-body">

      <!-- Metadaten -->
      <div class="fdl-av-meta-panel">
        <div class="fdl-av-meta-title">Dokumentdaten</div>
        <div class="fdl-av-meta-grid">
          ${m.betrag  ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Betrag</span><span class="fdl-av-meta-value">${m.betrag}</span></div>` : ''}
          ${m.datum   ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Datum</span><span class="fdl-av-meta-value">${m.datum}</span></div>` : ''}
          ${m.absender ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Absender</span><span class="fdl-av-meta-value">${m.absender}</span></div>` : ''}
          ${m.objekt  ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Objekt</span><span class="fdl-av-meta-value">${m.objekt}</span></div>` : ''}
          <div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Größe</span><span class="fdl-av-meta-value">${fmtSize(file.size)}</span></div>
          <div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Zuletzt geändert</span><span class="fdl-av-meta-value">${fmtDate(file.modified)}</span></div>
          ${file.subfolder ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Unterordner</span><span class="fdl-av-meta-value">${file.subfolder}</span></div>` : ''}
          ${file.path ? `<div class="fdl-av-meta-row" style="grid-column:1/-1"><span class="fdl-av-meta-label">Pfad</span><span class="fdl-av-meta-value" style="font-size:11px;word-break:break-all">${file.path.join(' › ')}</span></div>` : ''}
        </div>
      </div>

      <!-- Aufgaben -->
      <div class="fdl-av-tasks-panel">
        <div class="fdl-av-tasks-head">
          <div class="fdl-av-tasks-title">Aufgaben</div>
          <button class="fdl-av-task-add" onclick="window.__fdlAvCreateTask()">+ Erstellen</button>
        </div>
        ${taskHtml}
      </div>

      <!-- PDF Vorschau -->
      <div class="fdl-av-pdf-wrap" id="fdl-av-pdf-wrap">
        <div class="fdl-av-loading"><div class="fdl-av-spinner"></div> PDF wird geladen…</div>
      </div>
    </div>`;

  // PDF laden
  renderPDF(file);
}

async function renderPDF(file) {
  const wrap = qs('#fdl-av-pdf-wrap');
  if (!wrap) return;

  // Alten Blob URL aufräumen
  if (State.currentBlobUrl) {
    try { URL.revokeObjectURL(State.currentBlobUrl); } catch {}
    State.currentBlobUrl = null;
  }

  try {
    const fileObj = await file.handle.getFile();
    const arrayBuf = await fileObj.arrayBuffer();

    // Blob-URL für neuen Tab / Download
    const blob = new Blob([arrayBuf], { type: 'application/pdf' });
    State.currentBlobUrl = URL.createObjectURL(blob);

    // pdfjsLib aus app.js nutzen (bereits geladen)
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      // Fallback: Embed-Element
      wrap.innerHTML = `<embed src="${State.currentBlobUrl}" type="application/pdf" style="width:100%;height:600px;border-radius:4px">`;
      return;
    }

    if (!pdfjsLib.GlobalWorkerOptions?.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const numPages = Math.min(pdfDoc.numPages, 8); // max 8 Seiten

    wrap.innerHTML = '<div class="fdl-av-pdf-pages" id="fdl-av-pages"></div>';
    const pagesEl = qs('#fdl-av-pages');

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = '100%';
      pagesEl.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }

    if (pdfDoc.numPages > 8) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11.5px;color:var(--muted);text-align:center;padding:.5rem';
      note.textContent = `+ ${pdfDoc.numPages - 8} weitere Seiten — zum Anzeigen herunterladen`;
      pagesEl.appendChild(note);
    }

  } catch (e) {
    wrap.innerHTML = `<div class="fdl-av-empty">
      <div class="fdl-av-empty-icon">⚠️</div>
      <div>PDF konnte nicht geladen werden</div>
      <div style="font-size:11px">${e?.message || e}</div>
    </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AKTIONEN (global, von onclick aufgerufen)
   ══════════════════════════════════════════════════════════════════════════ */

window.__fdlAvSelectObj = async (code) => {
  const objects = getObjectList();
  const obj = objects.find(o => o.code === code);
  if (!obj) return;

  State.selectedObj  = { ...obj, ...getObjectRecord(code) };
  State.selectedFile = null;
  State.files        = [];
  State.filteredFiles= [];
  State.searchQuery  = '';

  // Breadcrumb
  const bc = qs('#fdl-av-breadcrumb');
  if (bc) bc.innerHTML = `Archiv <span style="color:var(--muted)">/</span> <span>${obj.name}</span>`;

  // Suchfeld leeren
  const sf = qs('#fdl-av-search-inp');
  if (sf) sf.value = '';

  renderSidebar();

  // Dateiliste: Ladeindikator
  const listInner = qs('#fdl-av-list-inner');
  if (listInner) listInner.innerHTML = `<div class="fdl-av-loading"><div class="fdl-av-spinner"></div> Lade Dokumente…</div>`;

  // Viewer leeren
  const viewer = qs('#fdl-av-viewer');
  if (viewer) viewer.innerHTML = `<div class="fdl-av-empty" style="flex:1">
    <div class="fdl-av-empty-icon">👆</div><div>Dokument auswählen</div>
  </div>`;

  // Dateien laden
  const root = getScopeRoot();
  const files = await loadFilesForObject(State.selectedObj, root);
  State.files = files;
  State.filteredFiles = files;

  // Count in Sidebar aktualisieren
  const countEl = qs(`#fdl-av-count-${code}`);
  if (countEl) countEl.textContent = files.length || '0';

  renderFileList(files);
};

window.__fdlAvSelectFile = async (encodedName, modified) => {
  const name = decodeURIComponent(encodedName);
  const file = State.files.find(f => f.name === name && f.modified === modified)
            || State.files.find(f => f.name === name);
  if (!file) return;

  State.selectedFile = file;
  renderFileList(State.filteredFiles); // Aktiv-Markierung aktualisieren
  await renderViewer(file);
};

window.__fdlAvDownload = async () => {
  if (!State.currentBlobUrl) return;
  const a = document.createElement('a');
  a.href     = State.currentBlobUrl;
  a.download = State.selectedFile?.name || 'dokument.pdf';
  a.click();
};

window.__fdlAvOpenNewTab = () => {
  if (State.currentBlobUrl) window.open(State.currentBlobUrl, '_blank');
};

window.__fdlAvCreateTask = () => {
  if (!State.selectedFile) return;
  // Addon-Aufgaben-Panel öffnen (falls geladen)
  if (typeof window.fdlOnFileSaved === 'function' && typeof window.__fdlTaskFormOpen === 'function') {
    const overlay = document.getElementById('fdl-archiv-overlay');
    if (overlay) overlay.classList.remove('open');
    // Kurz warten, dann Aufgaben-Panel mit Prefill öffnen
    setTimeout(() => {
      if (typeof window.openTasks === 'function') {
        // openTasks aus fidelior-addon.js (falls sichtbar)
      }
      // Direktaufruf Tasks-Overlay
      const tasksOv = document.getElementById('fdl-tasks-overlay');
      if (tasksOv) {
        window.__fdlTaskFormOpen?.();
        // Prefill via globale Felder
        setTimeout(() => {
          const noteEl = document.getElementById('fdl-f-note');
          const objEl  = document.getElementById('fdl-f-obj');
          if (noteEl) noteEl.value = `Dokument: ${State.selectedFile.name}`;
          if (objEl && State.selectedObj) objEl.value = State.selectedObj.code;
          tasksOv.classList.add('open');
        }, 80);
      }
    }, 150);
  } else {
    fdlToast('Aufgaben-Addon nicht geladen.', 2000);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   SUCHE
   ══════════════════════════════════════════════════════════════════════════ */

function applySearch(query) {
  State.searchQuery = query.trim().toLowerCase();
  if (!State.searchQuery) {
    State.filteredFiles = State.files;
  } else {
    State.filteredFiles = State.files.filter(f =>
      f.name.toLowerCase().includes(State.searchQuery) ||
      (f.meta.absender || '').toLowerCase().includes(State.searchQuery) ||
      (f.meta.betrag   || '').toLowerCase().includes(State.searchQuery) ||
      (f.meta.datum    || '').toLowerCase().includes(State.searchQuery) ||
      (f.subfolder     || '').toLowerCase().includes(State.searchQuery)
    );
  }
  renderFileList(State.filteredFiles);
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERLAY AUFBAUEN
   ══════════════════════════════════════════════════════════════════════════ */

function buildOverlay() {
  if (document.getElementById('fdl-archiv-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'fdl-archiv-overlay';
  overlay.innerHTML = `
    <div class="fdl-av-topbar">
      <div class="fdl-av-topbar-title">📁 Archiv</div>
      <div class="fdl-av-breadcrumb" id="fdl-av-breadcrumb">Alle Liegenschaften</div>
      <input class="fdl-av-search" id="fdl-av-search-inp" placeholder="🔍  Suche in Dokumenten…" type="search">
      <button class="fdl-av-close" id="fdl-av-close-btn">✕</button>
    </div>
    <div class="fdl-av-body">
      <div class="fdl-av-sidebar" id="fdl-av-sidebar"></div>
      <div class="fdl-av-list">
        <div class="fdl-av-list-head">
          <span class="fdl-av-list-count" id="fdl-av-list-count">—</span>
          <select class="fdl-av-list-sort" id="fdl-av-sort">
            <option value="date-desc">Neueste zuerst</option>
            <option value="date-asc">Älteste zuerst</option>
            <option value="name-asc">Name A–Z</option>
            <option value="amount-desc">Betrag ↓</option>
          </select>
        </div>
        <div id="fdl-av-list-inner">
          <div class="fdl-av-empty">
            <div class="fdl-av-empty-icon">📁</div>
            <div>Liegenschaft wählen</div>
          </div>
        </div>
      </div>
      <div class="fdl-av-viewer" id="fdl-av-viewer">
        <div class="fdl-av-empty" style="flex:1">
          <div class="fdl-av-empty-icon">👆</div>
          <div>Dokument auswählen</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  State.overlay = overlay;

  // Events
  document.getElementById('fdl-av-close-btn').addEventListener('click', closeArchiv);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeArchiv();
  });

  document.getElementById('fdl-av-search-inp').addEventListener('input', e => {
    applySearch(e.target.value);
  });

  document.getElementById('fdl-av-sort').addEventListener('change', e => {
    const v = e.target.value;
    let files = [...State.filteredFiles];
    if (v === 'date-desc') files.sort((a, b) => b.modified - a.modified);
    if (v === 'date-asc')  files.sort((a, b) => a.modified - b.modified);
    if (v === 'name-asc')  files.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    if (v === 'amount-desc') files.sort((a, b) => {
      const pa = parseFloat((a.meta.betrag || '0').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
      const pb = parseFloat((b.meta.betrag || '0').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
      return pb - pa;
    });
    State.filteredFiles = files;
    renderFileList(files);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   ÖFFNEN / SCHLIESSEN
   ══════════════════════════════════════════════════════════════════════════ */

async function openArchiv() {
  buildOverlay();
  renderSidebar();
  State.overlay.classList.add('open');

  // Dateianzahlen für alle Objekte vorladen (im Hintergrund)
  const root = getScopeRoot();
  if (!root) {
    fdlToast('Scopevisio-Verbindung fehlt – bitte erst verbinden.', 4000);
  } else {
    const objects = getObjectList();
    for (const obj of objects) {
      const rec = getObjectRecord(obj.code);
      loadFilesForObject({ ...obj, ...rec }, root).then(files => {
        const el = qs(`#fdl-av-count-${obj.code}`);
        if (el) el.textContent = files.length || '0';
      }).catch(() => {});
    }
  }
}

function closeArchiv() {
  State.overlay?.classList.remove('open');
  if (State.currentBlobUrl) {
    try { URL.revokeObjectURL(State.currentBlobUrl); } catch {}
    State.currentBlobUrl = null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TOAST HELPER
   ══════════════════════════════════════════════════════════════════════════ */

function fdlToast(html, ms) {
  try { if (typeof toast === 'function') toast(html, ms || 3500); } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   HEADER-BUTTON INJIZIEREN
   ══════════════════════════════════════════════════════════════════════════ */

function injectButton() {
  if (document.getElementById('fdl-archiv-btn')) return;
  const addonBtns = document.getElementById('fdl-addon-btns');
  const headerInner = document.querySelector('.header-inner');

  const btn = document.createElement('button');
  btn.className = 'fdl-archiv-hbtn';
  btn.id = 'fdl-archiv-btn';
  btn.textContent = '📁 Archiv';
  btn.title = 'Dokument-Archiv öffnen (A)';
  btn.addEventListener('click', openArchiv);

  if (addonBtns) {
    addonBtns.insertBefore(btn, addonBtns.firstChild);
  } else if (headerInner) {
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) headerInner.insertBefore(btn, settingsBtn);
    else headerInner.appendChild(btn);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

function init() {
  injectCSS();
  injectButton();

  // Keyboard: A = Archiv öffnen
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) openArchiv();
  });

  console.info('[FideliorArchiv v1.0] geladen – Dokument-Browser aktiv');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Public API
window.fdlArchivOpen = openArchiv;

})();
