/* ==========================================================================
   Fidelior Addon – Aufgaben & Dashboard
   Version 1.0 – Standalone, non-invasive
   Schreibt NUR in eigene IndexedDB (fidelior_addon_v1).
   Berührt KEINE Ablage-Logik, KEINE Config-Dateien.
   ========================================================================== */

(() => {
'use strict';

/* ── Konstanten ─────────────────────────────────────────────────────────── */
const DB_NAME    = 'fidelior_addon_v1';
const DB_VERSION = 1;
const S_ACTIVITY = 'activity';
const S_TASKS    = 'tasks';

const PRIO_LABELS = { low: 'Niedrig', medium: 'Mittel', high: 'Hoch' };
const PRIO_COLORS = { low: '#1A7A45', medium: '#B45A00', high: '#B91C1C' };

/* ── IndexedDB ──────────────────────────────────────────────────────────── */
function dbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(S_ACTIVITY)) {
        const s = db.createObjectStore(S_ACTIVITY, { keyPath: 'id', autoIncrement: true });
        s.createIndex('objectCode', 'objectCode', { unique: false });
        s.createIndex('savedAt',    'savedAt',    { unique: false });
      }
      if (!db.objectStoreNames.contains(S_TASKS)) {
        const t = db.createObjectStore(S_TASKS, { keyPath: 'id', autoIncrement: true });
        t.createIndex('objectCode', 'objectCode', { unique: false });
        t.createIndex('dueDate',    'dueDate',    { unique: false });
        t.createIndex('status',     'status',     { unique: false });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbAdd(store, val) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbPut(store, val) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbGetAll(store) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbDelete(store, id) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

/* ── CSS ────────────────────────────────────────────────────────────────── */
function injectCSS() {
  if (document.getElementById('fdl-addon-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-addon-css';
  s.textContent = `
/* ── Addon: Header-Buttons ── */
.fdl-addon-btns {
  display: flex; gap: .4rem; align-items: center; margin-left: auto; margin-right: .5rem;
}
.fdl-addon-btn {
  font-family: var(--font-ui);
  font-size: 11.5px; font-weight: 600;
  padding: 5px 12px; border-radius: 8px; border: 1.5px solid transparent;
  cursor: pointer; letter-spacing: .02em; transition: background .15s, border-color .15s;
  display: flex; align-items: center; gap: .35rem; white-space: nowrap;
}
.fdl-addon-btn.dash {
  background: rgba(255,255,255,.12); color: #fff; border-color: rgba(255,255,255,.2);
}
.fdl-addon-btn.dash:hover { background: rgba(255,255,255,.22); }
.fdl-addon-btn.tasks {
  background: var(--primary); color: #fff; border-color: var(--primary);
}
.fdl-addon-btn.tasks:hover { background: var(--primary-600); }
.fdl-addon-badge {
  background: #ef4444; color: #fff; border-radius: 10px;
  font-size: 10px; font-weight: 700; padding: 1px 5px; min-width: 17px; text-align: center;
}

/* ── Addon-Dialog-Basis ── */
.fdl-dialog {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0,0,0,.45); backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 16px 16px;
  opacity: 0; pointer-events: none; transition: opacity .18s;
}
.fdl-dialog.open { opacity: 1; pointer-events: all; }
.fdl-panel {
  background: var(--surface); border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,.18);
  width: 100%; max-width: 860px; max-height: calc(100vh - 80px);
  display: flex; flex-direction: column; overflow: hidden;
}
.fdl-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.1rem 1.5rem; border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.fdl-panel-head h2 {
  font-size: 15px; font-weight: 700; color: var(--text); margin: 0;
}
.fdl-panel-close {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: var(--surface-2); color: var(--muted); font-size: 14px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.fdl-panel-close:hover { background: var(--border); color: var(--text); }
.fdl-panel-body { flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem; }

/* ── Dashboard ── */
.fdl-dash-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem;
  margin-bottom: 1.5rem;
}
.fdl-obj-card {
  border: 1.5px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem;
  background: var(--surface-2); cursor: pointer; transition: border-color .15s, box-shadow .15s;
  position: relative;
}
.fdl-obj-card:hover { border-color: var(--primary); box-shadow: 0 4px 14px rgba(91,27,112,.1); }
.fdl-obj-code {
  font-size: 10.5px; font-weight: 700; letter-spacing: .08em;
  color: var(--primary); margin-bottom: .3rem; text-transform: uppercase;
}
.fdl-obj-name { font-size: 12.5px; font-weight: 600; color: var(--text); margin-bottom: .6rem; }
.fdl-obj-stats { display: flex; gap: .6rem; flex-wrap: wrap; }
.fdl-stat-pill {
  font-size: 11px; padding: 2px 8px; border-radius: 6px;
  background: rgba(91,27,112,.08); color: var(--primary); font-weight: 600;
}
.fdl-stat-pill.amount { background: rgba(26,122,69,.08); color: #1A7A45; }
.fdl-stat-pill.tasks  { background: rgba(180,90,0,.08); color: #B45A00; }
.fdl-obj-last { font-size: 11px; color: var(--muted); margin-top: .5rem; }

/* ── Aktivitätsliste ── */
.fdl-activity-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.fdl-activity-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: .6rem 1rem; background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.fdl-activity-head h3 { font-size: 12.5px; font-weight: 600; color: var(--text); margin: 0; }
.fdl-activity-filter {
  font-size: 11.5px; padding: 4px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text); font-family: var(--font-ui);
}
.fdl-activity-table { width: 100%; border-collapse: collapse; }
.fdl-activity-table th {
  font-size: 11px; font-weight: 600; color: var(--muted);
  padding: .45rem .85rem; text-align: left; background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.fdl-activity-table td {
  font-size: 12px; padding: .45rem .85rem;
  border-bottom: 1px solid var(--border); color: var(--text);
  vertical-align: middle;
}
.fdl-activity-table tr:last-child td { border-bottom: none; }
.fdl-activity-table tr:hover td { background: rgba(91,27,112,.03); }
.fdl-type-badge {
  font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
  background: rgba(91,27,112,.1); color: var(--primary);
}
.fdl-empty {
  text-align: center; padding: 2rem; color: var(--muted); font-size: 12.5px;
}

/* ── Tasks ── */
.fdl-task-toolbar {
  display: flex; gap: .6rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;
}
.fdl-task-filter {
  font-size: 11.5px; padding: 5px 10px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--surface-2);
  color: var(--text); font-family: var(--font-ui);
}
.fdl-btn-new-task {
  font-family: var(--font-ui); font-size: 12px; font-weight: 600;
  padding: 6px 14px; border-radius: 8px; border: none;
  background: var(--primary); color: #fff; cursor: pointer;
  margin-left: auto;
}
.fdl-btn-new-task:hover { background: var(--primary-600); }
.fdl-task-list { display: flex; flex-direction: column; gap: .5rem; }
.fdl-task-item {
  border: 1.5px solid var(--border); border-radius: 10px; padding: .75rem 1rem;
  background: var(--surface); display: flex; gap: .75rem; align-items: flex-start;
  transition: border-color .15s;
}
.fdl-task-item.done { opacity: .55; }
.fdl-task-item:hover { border-color: var(--primary); }
.fdl-task-check {
  width: 18px; height: 18px; border-radius: 5px; border: 2px solid var(--border);
  background: var(--surface-2); cursor: pointer; flex-shrink: 0; margin-top: 1px;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s, border-color .15s;
}
.fdl-task-check.checked { background: var(--primary); border-color: var(--primary); color: #fff; font-size: 11px; }
.fdl-task-body { flex: 1; min-width: 0; }
.fdl-task-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: .2rem; }
.fdl-task-item.done .fdl-task-title { text-decoration: line-through; }
.fdl-task-meta { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.fdl-task-obj { font-size: 11px; color: var(--primary); font-weight: 600; }
.fdl-task-due { font-size: 11px; color: var(--muted); }
.fdl-task-due.overdue { color: #B91C1C; font-weight: 600; }
.fdl-task-prio {
  font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px;
}
.fdl-task-note { font-size: 11.5px; color: var(--muted); margin-top: .3rem; }
.fdl-task-del {
  width: 24px; height: 24px; border-radius: 6px; border: none;
  background: transparent; color: var(--muted); cursor: pointer; font-size: 13px;
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
}
.fdl-task-del:hover { background: #fee2e2; color: #B91C1C; }

/* ── Task-Form ── */
.fdl-task-form {
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 1.25rem;
}
.fdl-task-form h3 { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: .85rem; }
.fdl-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.fdl-form-full { grid-column: 1 / -1; }
.fdl-form-label { font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: .2rem; }
.fdl-form-input, .fdl-form-select {
  width: 100%; font-family: var(--font-ui); font-size: 12.5px;
  padding: 6px 10px; border-radius: 7px; border: 1.5px solid var(--border);
  background: var(--surface); color: var(--text);
}
.fdl-form-input:focus, .fdl-form-select:focus {
  outline: none; border-color: var(--primary);
  box-shadow: var(--focus-ring);
}
.fdl-form-textarea {
  width: 100%; font-family: var(--font-ui); font-size: 12.5px;
  padding: 6px 10px; border-radius: 7px; border: 1.5px solid var(--border);
  background: var(--surface); color: var(--text); resize: vertical; min-height: 54px;
}
.fdl-form-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .85rem; }
.fdl-btn-cancel {
  font-family: var(--font-ui); font-size: 12px; font-weight: 600;
  padding: 6px 14px; border-radius: 8px;
  border: 1.5px solid var(--border); background: var(--surface);
  color: var(--muted); cursor: pointer;
}
.fdl-btn-save {
  font-family: var(--font-ui); font-size: 12px; font-weight: 600;
  padding: 6px 14px; border-radius: 8px; border: none;
  background: var(--primary); color: #fff; cursor: pointer;
}
.fdl-btn-save:hover { background: var(--primary-600); }

/* ── Post-Save Prompt ── */
.fdl-postsave {
  position: fixed; bottom: 80px; right: 24px; z-index: 8500;
  background: var(--surface); border: 1.5px solid var(--primary);
  border-radius: 14px; padding: 1rem 1.1rem; box-shadow: 0 8px 32px rgba(0,0,0,.14);
  max-width: 300px; animation: fdlSlideIn .25s ease;
}
@keyframes fdlSlideIn {
  from { transform: translateX(20px); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
.fdl-postsave-title {
  font-size: 12.5px; font-weight: 700; color: var(--text); margin-bottom: .25rem;
}
.fdl-postsave-file {
  font-size: 11px; color: var(--muted); margin-bottom: .7rem;
  word-break: break-all; line-height: 1.4;
}
.fdl-postsave-btns { display: flex; gap: .4rem; }
.fdl-postsave-yes {
  flex: 1; font-family: var(--font-ui); font-size: 11.5px; font-weight: 600;
  padding: 6px; border-radius: 7px; border: none;
  background: var(--primary); color: #fff; cursor: pointer;
}
.fdl-postsave-no {
  font-family: var(--font-ui); font-size: 11.5px; font-weight: 600;
  padding: 6px 10px; border-radius: 7px;
  border: 1.5px solid var(--border); background: transparent;
  color: var(--muted); cursor: pointer;
}

/* ── Sections ── */
.fdl-section-title {
  font-size: 11px; font-weight: 700; letter-spacing: .07em;
  color: var(--muted); text-transform: uppercase; margin-bottom: .75rem;
}
.fdl-divider { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }
  `;
  document.head.appendChild(s);
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtAmount(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return null;
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date(new Date().toDateString());
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function getObjectList() {
  // Liest Liegenschaften aus dem bestehenden objectSelect-Dropdown (live, sicher)
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options)
    .filter(o => o.value)
    .map(o => ({ code: o.value, name: o.textContent }));
}
function getCurrentObjectCode() {
  return document.getElementById('objectSelect')?.value || '';
}

/* ── Activity Log ───────────────────────────────────────────────────────── */
async function logActivity(data) {
  await dbAdd(S_ACTIVITY, {
    fileName:   data.fileName   || '',
    objectCode: data.objectCode || '',
    objectName: data.objectName || data.objectCode || '',
    docType:    data.docType    || '',
    amount:     data.amount     || '',
    invoiceDate:data.invoiceDate|| '',
    targets:    data.targets    || [],
    savedAt:    new Date().toISOString(),
  });
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */
let dashEl = null;

function buildDashboard() {
  if (document.getElementById('fdl-dash-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'fdl-dialog';
  overlay.id = 'fdl-dash-overlay';
  overlay.innerHTML = `
    <div class="fdl-panel" style="max-width:920px">
      <div class="fdl-panel-head">
        <h2>📊 Liegenschafts-Dashboard</h2>
        <button class="fdl-panel-close" id="fdl-dash-close">✕</button>
      </div>
      <div class="fdl-panel-body" id="fdl-dash-body">
        <div class="fdl-empty">Lade Daten…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  dashEl = overlay;

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDash(); });
  document.getElementById('fdl-dash-close').addEventListener('click', closeDash);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeDash(); });
}

function closeDash() { dashEl?.classList.remove('open'); }

async function openDash() {
  if (!dashEl) buildDashboard();
  dashEl.classList.add('open');
  await renderDash('');
}

async function renderDash(filterCode) {
  const body    = document.getElementById('fdl-dash-body');
  const objects = getObjectList();
  const [allActivity, allTasks] = await Promise.all([dbGetAll(S_ACTIVITY), dbGetAll(S_TASKS)]);

  // Aggregationen pro Objekt
  const thisYear  = new Date().getFullYear();
  const thisMonth = new Date().getMonth();

  const stats = {};
  for (const obj of objects) {
    const acts = allActivity.filter(a => a.objectCode === obj.code);
    const yearActs = acts.filter(a => new Date(a.savedAt).getFullYear() === thisYear);
    const monthActs = acts.filter(a => {
      const d = new Date(a.savedAt);
      return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    });
    const totalAmount = yearActs.reduce((s, a) => {
      const n = parseFloat(String(a.amount || '').replace(',', '.').replace(/[^0-9.]/g, ''));
      return s + (isNaN(n) ? 0 : n);
    }, 0);
    const openTasks = allTasks.filter(t => t.objectCode === obj.code && t.status !== 'done').length;
    const lastAct = acts.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
    stats[obj.code] = { obj, total: acts.length, yearCount: yearActs.length, monthCount: monthActs.length, totalAmount, openTasks, lastAct, acts: yearActs };
  }

  const filterTarget = filterCode || '';
  const activityToShow = filterTarget
    ? allActivity.filter(a => a.objectCode === filterTarget).sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 50)
    : allActivity.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 50);

  // HTML
  let html = '';

  // ── Karten-Raster ──
  html += `<div class="fdl-section-title">Übersicht – ${thisYear}</div>`;
  html += '<div class="fdl-dash-grid">';

  const cardsObjects = filterTarget ? objects.filter(o => o.code === filterTarget) : objects;
  for (const obj of cardsObjects) {
    const s = stats[obj.code];
    if (!s) continue;
    html += `
      <div class="fdl-obj-card ${filterTarget === obj.code ? 'selected' : ''}"
           data-code="${obj.code}" onclick="window.__fdlDashFilter('${obj.code}')">
        <div class="fdl-obj-code">${obj.code}</div>
        <div class="fdl-obj-name">${obj.name.replace(obj.code + ' · ', '')}</div>
        <div class="fdl-obj-stats">
          <span class="fdl-stat-pill">${s.yearCount} Dok. ${thisYear}</span>
          ${s.monthCount > 0 ? `<span class="fdl-stat-pill">${s.monthCount} diesen Monat</span>` : ''}
          ${s.totalAmount > 0 ? `<span class="fdl-stat-pill amount">${s.totalAmount.toLocaleString('de-DE', {minimumFractionDigits:2, maximumFractionDigits:2})} €</span>` : ''}
          ${s.openTasks > 0 ? `<span class="fdl-stat-pill tasks">${s.openTasks} Aufgabe${s.openTasks>1?'n':''}</span>` : ''}
        </div>
        ${s.lastAct ? `<div class="fdl-obj-last">Zuletzt: ${fmtDate(s.lastAct.savedAt)}</div>` : ''}
      </div>`;
  }
  html += '</div>';

  if (filterTarget) {
    html += `<button onclick="window.__fdlDashFilter('')" style="font-family:var(--font-ui);font-size:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:4px 12px;cursor:pointer;color:var(--muted);margin-bottom:1rem">← Alle anzeigen</button>`;
  }

  // ── Aktivitätsliste ──
  html += `<hr class="fdl-divider">`;
  html += `<div class="fdl-activity-wrap">
    <div class="fdl-activity-head">
      <h3>${filterTarget ? 'Dokumente · ' + filterTarget : 'Alle Dokumente'} (${activityToShow.length})</h3>
      <select class="fdl-activity-filter" onchange="window.__fdlDashFilter(this.value)">
        <option value="">Alle Liegenschaften</option>
        ${objects.map(o => `<option value="${o.code}" ${filterTarget===o.code?'selected':''}>${o.code} – ${o.name.replace(o.code+' · ','')}</option>`).join('')}
      </select>
    </div>`;

  if (activityToShow.length === 0) {
    html += `<div class="fdl-empty">Noch keine Dokumente abgelegt.<br><small>Abgelegte Dokumente erscheinen hier automatisch.</small></div>`;
  } else {
    html += `<table class="fdl-activity-table">
      <thead><tr>
        <th>Dateiname</th><th>Liegenschaft</th><th>Typ</th><th>Betrag</th><th>Abgelegt am</th>
      </tr></thead><tbody>`;
    for (const a of activityToShow) {
      html += `<tr>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${a.fileName}">${a.fileName}</td>
        <td><span style="font-size:10.5px;font-weight:700;color:var(--primary)">${a.objectCode || '—'}</span></td>
        <td><span class="fdl-type-badge">${a.docType || '—'}</span></td>
        <td style="font-weight:600">${fmtAmount(a.amount) || '—'}</td>
        <td style="color:var(--muted)">${fmtDate(a.savedAt)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  html += '</div>';

  body.innerHTML = html;
}

window.__fdlDashFilter = (code) => renderDash(code);

/* ── Tasks Panel ────────────────────────────────────────────────────────── */
let tasksEl    = null;
let taskFormOpen = false;
let prefillForTask = null; // { objectCode, fileName }

function buildTasksPanel() {
  if (document.getElementById('fdl-tasks-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'fdl-dialog';
  overlay.id = 'fdl-tasks-overlay';
  overlay.innerHTML = `
    <div class="fdl-panel" style="max-width:700px">
      <div class="fdl-panel-head">
        <h2>✅ Aufgaben</h2>
        <button class="fdl-panel-close" id="fdl-tasks-close">✕</button>
      </div>
      <div class="fdl-panel-body" id="fdl-tasks-body">
        <div class="fdl-empty">Lade…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  tasksEl = overlay;

  overlay.addEventListener('click', e => { if (e.target === overlay) closeTasks(); });
  document.getElementById('fdl-tasks-close').addEventListener('click', closeTasks);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeTasks(); });
}

function closeTasks() { tasksEl?.classList.remove('open'); taskFormOpen = false; prefillForTask = null; }

async function openTasks(prefill) {
  prefillForTask = prefill || null;
  if (!tasksEl) buildTasksPanel();
  tasksEl.classList.add('open');
  taskFormOpen = !!prefill;
  await renderTasks('all');
}

async function renderTasks(filterStatus) {
  const body   = document.getElementById('fdl-tasks-body');
  const tasks  = await dbGetAll(S_TASKS);
  const objects= getObjectList();
  const filter = filterStatus || 'all';

  const filtered = filter === 'all'
    ? tasks
    : tasks.filter(t => t.status === filter);

  filtered.sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (b.status === 'done' && a.status !== 'done') return -1;
    return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });

  const openCount = tasks.filter(t => t.status !== 'done').length;

  let html = '';

  // Formular
  if (taskFormOpen) {
    const pre = prefillForTask || {};
    html += `<div class="fdl-task-form" id="fdl-task-form-wrap">
      <h3>${pre.id ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h3>
      <div class="fdl-form-grid">
        <div class="fdl-form-full">
          <div class="fdl-form-label">Titel *</div>
          <input class="fdl-form-input" id="fdl-f-title" placeholder="z.B. Rechnung prüfen und freigeben" value="${pre.title || ''}">
        </div>
        <div>
          <div class="fdl-form-label">Liegenschaft</div>
          <select class="fdl-form-select" id="fdl-f-obj">
            <option value="">—</option>
            ${objects.map(o => `<option value="${o.code}" ${(pre.objectCode||getCurrentObjectCode())===o.code?'selected':''}>${o.code} – ${o.name.replace(o.code+' · ','')}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="fdl-form-label">Fällig am</div>
          <input class="fdl-form-input" id="fdl-f-due" type="date" value="${pre.dueDate || todayISO()}">
        </div>
        <div>
          <div class="fdl-form-label">Priorität</div>
          <select class="fdl-form-select" id="fdl-f-prio">
            <option value="medium" ${(pre.priority||'medium')==='medium'?'selected':''}>Mittel</option>
            <option value="high"   ${pre.priority==='high'?'selected':''}>Hoch</option>
            <option value="low"    ${pre.priority==='low'?'selected':''}>Niedrig</option>
          </select>
        </div>
        <div>
          <div class="fdl-form-label">Status</div>
          <select class="fdl-form-select" id="fdl-f-status">
            <option value="open"        ${(pre.status||'open')==='open'?'selected':''}>Offen</option>
            <option value="in-progress" ${pre.status==='in-progress'?'selected':''}>In Arbeit</option>
            <option value="done"        ${pre.status==='done'?'selected':''}>Erledigt</option>
          </select>
        </div>
        <div class="fdl-form-full">
          <div class="fdl-form-label">Notiz (optional)</div>
          <textarea class="fdl-form-textarea" id="fdl-f-note" placeholder="z.B. zugehöriger Dateiname, weitere Infos…">${pre.note || (pre.fileName ? 'Dokument: ' + pre.fileName : '')}</textarea>
        </div>
      </div>
      <div class="fdl-form-actions">
        <button class="fdl-btn-cancel" onclick="window.__fdlTaskFormCancel()">Abbrechen</button>
        <button class="fdl-btn-save"   onclick="window.__fdlTaskFormSave(${pre.id || 'null'})">Speichern</button>
      </div>
    </div>`;
  }

  // Toolbar
  html += `<div class="fdl-task-toolbar">
    <select class="fdl-task-filter" onchange="window.__fdlTasksFilter(this.value)">
      <option value="all"         ${filter==='all'?'selected':''}>Alle (${tasks.length})</option>
      <option value="open"        ${filter==='open'?'selected':''}>Offen</option>
      <option value="in-progress" ${filter==='in-progress'?'selected':''}>In Arbeit</option>
      <option value="done"        ${filter==='done'?'selected':''}>Erledigt</option>
    </select>
    ${openCount > 0 ? `<span style="font-size:11.5px;color:var(--muted)">${openCount} offen</span>` : ''}
    ${!taskFormOpen ? `<button class="fdl-btn-new-task" onclick="window.__fdlTaskFormOpen()">+ Aufgabe</button>` : ''}
  </div>`;

  // Liste
  if (filtered.length === 0) {
    html += `<div class="fdl-empty">Keine Aufgaben vorhanden.<br><small>Aufgaben können hier oder direkt nach dem Ablegen eines Dokuments angelegt werden.</small></div>`;
  } else {
    html += '<div class="fdl-task-list">';
    for (const t of filtered) {
      const prioColor = PRIO_COLORS[t.priority] || PRIO_COLORS.medium;
      const prioLabel = PRIO_LABELS[t.priority] || 'Mittel';
      const over = isOverdue(t.dueDate) && t.status !== 'done';
      html += `
        <div class="fdl-task-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
          <div class="fdl-task-check ${t.status === 'done' ? 'checked' : ''}"
               onclick="window.__fdlTaskToggle(${t.id})">${t.status === 'done' ? '✓' : ''}</div>
          <div class="fdl-task-body">
            <div class="fdl-task-title">${t.title}</div>
            <div class="fdl-task-meta">
              ${t.objectCode ? `<span class="fdl-task-obj">${t.objectCode}</span>` : ''}
              ${t.dueDate ? `<span class="fdl-task-due ${over ? 'overdue' : ''}">📅 ${fmtDate(t.dueDate)}${over ? ' ⚠' : ''}</span>` : ''}
              <span class="fdl-task-prio" style="background:${prioColor}18;color:${prioColor}">${prioLabel}</span>
              ${t.status === 'in-progress' ? `<span class="fdl-task-prio" style="background:rgba(59,130,246,.1);color:#2563eb">In Arbeit</span>` : ''}
            </div>
            ${t.note ? `<div class="fdl-task-note">${t.note}</div>` : ''}
          </div>
          <button class="fdl-task-del" title="Aufgabe löschen" onclick="window.__fdlTaskDelete(${t.id})">✕</button>
        </div>`;
    }
    html += '</div>';
  }

  body.innerHTML = html;

  // Focus ins Formular
  if (taskFormOpen) {
    setTimeout(() => document.getElementById('fdl-f-title')?.focus(), 80);
  }

  updateBadge();
}

window.__fdlTasksFilter = (f) => { renderTasks(f); };
window.__fdlTaskFormOpen = () => { taskFormOpen = true; prefillForTask = null; renderTasks('all'); };
window.__fdlTaskFormCancel = () => { taskFormOpen = false; prefillForTask = null; renderTasks('all'); };

window.__fdlTaskFormSave = async (existingId) => {
  const title  = document.getElementById('fdl-f-title')?.value?.trim();
  if (!title) { document.getElementById('fdl-f-title')?.focus(); return; }
  const obj    = document.getElementById('fdl-f-obj')?.value || '';
  const due    = document.getElementById('fdl-f-due')?.value || '';
  const prio   = document.getElementById('fdl-f-prio')?.value || 'medium';
  const status = document.getElementById('fdl-f-status')?.value || 'open';
  const note   = document.getElementById('fdl-f-note')?.value?.trim() || '';
  const task   = { title, objectCode: obj, dueDate: due, priority: prio, status, note, createdAt: new Date().toISOString() };
  if (existingId) task.id = existingId;
  await dbPut(S_TASKS, task);
  taskFormOpen = false; prefillForTask = null;
  await renderTasks('all');
};

window.__fdlTaskToggle = async (id) => {
  const all  = await dbGetAll(S_TASKS);
  const task = all.find(t => t.id === id);
  if (!task) return;
  task.status = task.status === 'done' ? 'open' : 'done';
  await dbPut(S_TASKS, task);
  await renderTasks('all');
};

window.__fdlTaskDelete = async (id) => {
  await dbDelete(S_TASKS, id);
  await renderTasks('all');
};

/* ── Post-Save Prompt ───────────────────────────────────────────────────── */
function showPostSavePrompt(data) {
  // Alten Prompt entfernen falls vorhanden
  document.getElementById('fdl-postsave-prompt')?.remove();

  const el = document.createElement('div');
  el.className = 'fdl-postsave';
  el.id = 'fdl-postsave-prompt';
  el.innerHTML = `
    <div class="fdl-postsave-title">📌 Aufgabe anlegen?</div>
    <div class="fdl-postsave-file">${data.fileName}</div>
    <div class="fdl-postsave-btns">
      <button class="fdl-postsave-yes" id="fdl-ps-yes">Ja, Aufgabe erstellen</button>
      <button class="fdl-postsave-no"  id="fdl-ps-no">Nein</button>
    </div>`;
  document.body.appendChild(el);

  document.getElementById('fdl-ps-yes').addEventListener('click', () => {
    el.remove();
    openTasks({ objectCode: data.objectCode, fileName: data.fileName });
  });
  document.getElementById('fdl-ps-no').addEventListener('click', () => el.remove());

  // Auto-close after 8s
  setTimeout(() => el?.remove(), 8000);
}

/* ── Badge (offene Aufgaben im Header-Button) ───────────────────────────── */
async function updateBadge() {
  const tasks = await dbGetAll(S_TASKS);
  const open  = tasks.filter(t => t.status !== 'done').length;
  const badge = document.getElementById('fdl-tasks-badge');
  if (!badge) return;
  badge.textContent = open > 0 ? open : '';
  badge.style.display = open > 0 ? 'inline' : 'none';
}

/* ── Header-Buttons injizieren ──────────────────────────────────────────── */
function injectButtons() {
  if (document.getElementById('fdl-addon-btns')) return;
  const headerInner = document.querySelector('.header-inner');
  if (!headerInner) return;

  const wrap = document.createElement('div');
  wrap.className = 'fdl-addon-btns';
  wrap.id = 'fdl-addon-btns';
  wrap.innerHTML = `
    <button class="fdl-addon-btn dash" id="fdl-btn-dash" title="Liegenschafts-Dashboard öffnen">
      📊 Dashboard
    </button>
    <button class="fdl-addon-btn tasks" id="fdl-btn-tasks" title="Aufgaben öffnen">
      ✅ Aufgaben
      <span class="fdl-addon-badge" id="fdl-tasks-badge" style="display:none">0</span>
    </button>`;

  // Vor dem Settings-Button einfügen
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    headerInner.insertBefore(wrap, settingsBtn);
  } else {
    headerInner.appendChild(wrap);
  }

  document.getElementById('fdl-btn-dash').addEventListener('click', openDash);
  document.getElementById('fdl-btn-tasks').addEventListener('click', () => openTasks());
}

/* ── Öffentlicher Hook (wird von app.js aufgerufen) ─────────────────────── */
async function onFileSaved(data) {
  try {
    // 1) Aktivität loggen
    await logActivity({
      fileName:    data.fileName    || '',
      objectCode:  data.objectCode  || '',
      objectName:  data.objectName  || data.objectCode || '',
      docType:     data.docType     || '',
      amount:      data.amount      || '',
      invoiceDate: data.invoiceDate || '',
      targets:     data.targets     || [],
    });

    // 2) Badge aktualisieren
    await updateBadge();

    // 3) Post-save Prompt (kleine Verzögerung damit der Gespeichert-Toast zuerst kommt)
    setTimeout(() => showPostSavePrompt({
      fileName:   data.fileName   || '',
      objectCode: data.objectCode || '',
    }), 800);

  } catch (e) {
    console.warn('[Fidelior Addon] onFileSaved error:', e);
  }
}

/* ── Init ───────────────────────────────────────────────────────────────── */
function init() {
  injectCSS();
  injectButtons();
  buildDashboard();
  buildTasksPanel();
  updateBadge();

  // Keyboard-Shortcut: D = Dashboard, T = Tasks (nur wenn kein Input fokussiert)
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'd' && !e.ctrlKey && !e.metaKey) openDash();
    if (e.key === 't' && !e.ctrlKey && !e.metaKey) openTasks();
  });
}

// Auf DOMContentLoaded oder sofort wenn DOM schon bereit ist
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Hook für app.js
window.fdlOnFileSaved = onFileSaved;

})();
