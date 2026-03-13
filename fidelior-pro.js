/* ==========================================================================
   Fidelior Pro Shell  v2.0
   ==========================================================================
   REPLACES: fidelior-nav.js (emoji-based)
   REQUIRES: fidelior-pro.css loaded before this script

   DELIVERS:
   - Left sidebar with tree navigation (3 levels max)
   - Professional topbar with integrated search trigger
   - Connection status in sidebar
   - Dashboard view (inline, not modal)
   - Archive view (reuses fidelior-archiv.js inline)
   - Filing view (existing form, no change)
   - Zero emojis — SVG Lucide icons throughout

   HOOKS (no app.js changes):
   - window.fdlOnFileSaved  → dashboard refresh
   - window.fdlArchivOpen   → redirected to archive view
   - window.configDirHandle → sidebar counts
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════
   SVG ICON SYSTEM  (Lucide, 24×24 viewBox, 2px stroke)
   ══════════════════════════════════════════════════════ */
const I = {
  layout:   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  inbox:    '<svg viewBox="0 0 24 24"><path d="M22 12H16l-2 3H10L8 12H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
  check:    '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
  folder:   '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  file:     '<svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  search:   '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  upload:   '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  plus:     '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chevron:  '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
  link2:    '<svg viewBox="0 0 24 24"><path d="M15 7h3a5 5 0 015 5 5 5 0 01-5 5h-3m-6 0H6a5 5 0 01-5-5 5 5 0 015-5h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  brain:    '<svg viewBox="0 0 24 24"><path d="M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-2.5 2.5h-1A2.5 2.5 0 016 19.5v-1a2.5 2.5 0 01-.5-5V12a3 3 0 013-3h1V7a2.5 2.5 0 012.5-2.5h0"/><path d="M14.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 002.5 2.5h1a2.5 2.5 0 002.5-2.5v-1a2.5 2.5 0 00.5-5V12a3 3 0 00-3-3h-1V7A2.5 2.5 0 0012 4.5h0"/></svg>',
  mail:     '<svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>',
  tag:      '<svg viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  grid:     '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  refresh:  '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
  building: '<svg viewBox="0 0 24 24"><path d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18"/><path d="M6 12H4a2 2 0 00-2 2v6a2 2 0 002 2h2"/><path d="M18 9h2a2 2 0 012 2v9a2 2 0 01-2 2h-2"/><path d="M10 6h4M10 10h4M10 14h4M10 18h4"/></svg>',
  receipt:  '<svg viewBox="0 0 24 24"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M16 8H8M16 12H8M12 16H8"/></svg>',
  circle:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
};

function icon(name, extra) {
  const svg = I[name] || I.file;
  return svg.replace('<svg ', `<svg style="stroke-linecap:round;stroke-linejoin:round;stroke-width:1.75;fill:none;stroke:currentColor;${extra||''}" `);
}
function sbIcon(name) { return `<span class="fdl-sb-icon">${icon(name)}</span>`; }

/* ══════════════════════════════════════════════════════
   IDB helpers
   ══════════════════════════════════════════════════════ */
function idbGetAll(dbName, store) {
  return new Promise(res => {
    const r = indexedDB.open(dbName);
    r.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(store)) { res([]); return; }
      const q = db.transaction(store,'readonly').objectStore(store).getAll();
      q.onsuccess = e2 => res(e2.target.result||[]);
      q.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  });
}

/* ══════════════════════════════════════════════════════
   DATA
   ══════════════════════════════════════════════════════ */
async function loadData() {
  const [activity, tasks, indexDocs] = await Promise.all([
    idbGetAll('fidelior_addon_v1','activity'),
    idbGetAll('fidelior_addon_v1','tasks'),
    idbGetAll('fidelior_index_v1','documents').catch(()=>[]),
  ]);
  return { activity, tasks, indexDocs };
}

function stats(data) {
  const { activity, tasks, indexDocs } = data;
  const docs  = indexDocs.length ? indexDocs : activity;
  const now   = new Date();
  const yr    = now.getFullYear();
  const mo    = now.getMonth();
  const wk    = new Date(now-7*86400000).toISOString();
  const mst   = new Date(yr,mo,1).toISOString();
  const tod   = now.toISOString().slice(0,10);

  const open      = tasks.filter(t=>t.status!=='done');
  const overdue   = open.filter(t=>t.dueDate&&t.dueDate<tod);
  const recent    = [...docs].sort((a,b)=>(b.savedAt||'').localeCompare(a.savedAt||'')).slice(0,20);
  const wkDocs    = docs.filter(d=>(d.savedAt||'')>=wk);
  const moDocs    = docs.filter(d=>(d.savedAt||'')>=mst);
  const moAmt     = moDocs.reduce((s,d)=>{const n=parseFloat(String(d.amount||'0').replace(',','.').replace(/[^0-9.]/g,''));return s+(isFinite(n)?n:0);},0);

  const byObj = {};
  const sel = document.getElementById('objectSelect');
  if (sel) Array.from(sel.options).filter(o=>o.value).forEach(o=>{
    byObj[o.value]={code:o.value,name:o.textContent.trim(),count:0,amount:0,lastSaved:null,openTasks:0};
  });
  for (const d of docs) {
    const c=d.objectCode; if(!c) continue;
    if(!byObj[c]) byObj[c]={code:c,name:c,count:0,amount:0,lastSaved:null,openTasks:0};
    byObj[c].count++;
    const n=parseFloat(String(d.amount||'0').replace(',','.').replace(/[^0-9.]/g,''));
    byObj[c].amount+=isFinite(n)?n:0;
    if(!byObj[c].lastSaved||d.savedAt>byObj[c].lastSaved) byObj[c].lastSaved=d.savedAt;
  }
  for (const t of open) if(t.objectCode&&byObj[t.objectCode]) byObj[t.objectCode].openTasks++;

  return {
    total:docs.length, wkCount:wkDocs.length, moCount:moDocs.length,
    openCount:open.length, overdueCount:overdue.length,
    moAmt, byObj, recent, openTasks:open.slice(0,8), yr,
  };
}

const fmtD = iso=>{try{return new Date(iso).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});}catch{return'—';}};
const fmtS = iso=>{try{return new Date(iso).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});}catch{return'—';}};
const fmtE = n=>!n?'':n.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
function fmtR(iso) {
  if (!iso) return '';
  const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);
  if(m<2) return 'Gerade eben';
  if(m<60) return `vor ${m} Min.`;
  const h=Math.floor(m/60); if(h<24) return `vor ${h} Std.`;
  const d=Math.floor(h/24); if(d===1) return 'Gestern';
  if(d<7) return `vor ${d} Tagen`;
  return fmtD(iso);
}

/* ══════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════ */
let _view = 'filing'; // dash | filing | archive | tasks | admin

function getObjList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options).filter(o=>o.value).map(o=>({code:o.value,name:o.textContent.trim()}));
}

/* ══════════════════════════════════════════════════════
   BUILD SIDEBAR
   ══════════════════════════════════════════════════════ */
function buildSidebar() {
  if (document.getElementById('fdl-sidebar')) return;

  const sb = document.createElement('div');
  sb.id = 'fdl-sidebar';
  sb.innerHTML = buildSidebarHTML();
  document.body.appendChild(sb);
  document.body.classList.add('fdl-pro');

  attachSidebarEvents();
}

function buildSidebarHTML() {
  const objs = getObjList();

  // Separate branch vs object entries
  const branches = objs.filter(o=>['FIDELIOR','PRIVAT','ARNDTCIE'].includes(o.code));
  const objects  = objs.filter(o=>!['FIDELIOR','PRIVAT','ARNDTCIE'].includes(o.code));

  const branchItems = branches.map(b => {
    const label = b.code === 'ARNDTCIE' ? 'ARNDT & CIE' : b.code;
    return `
    <div class="fdl-sb-group" data-group="${b.code}">
      <button class="fdl-sb-group-toggle">
        ${sbIcon('receipt')}
        <span class="fdl-sb-label">${label}</span>
        <span class="fdl-sb-chevron">${icon('chevron')}</span>
      </button>
      <div class="fdl-sb-sub">
        <button class="fdl-sb-item" data-view="archive" data-obj="${b.code}" data-folder="rechnung">
          ${sbIcon('receipt')} <span class="fdl-sb-label">Rechnungen</span>
        </button>
        <button class="fdl-sb-item" data-view="archive" data-obj="${b.code}" data-folder="other">
          ${sbIcon('file')} <span class="fdl-sb-label">Dokumente</span>
        </button>
      </div>
    </div>`;
  }).join('');

  const objItems = objects.map(o => {
    const shortName = o.name.replace(/^[A-Z0-9]+ · /,'');
    // B75 special subfolders
    const isB75 = o.code === 'B75';
    const b75Subs = isB75 ? `
      <div class="fdl-sb-sub">
        <button class="fdl-sb-item" data-view="archive" data-obj="B75" data-folder="D1">
          ${sbIcon('folder')} <span class="fdl-sb-label">D1</span>
        </button>
        <button class="fdl-sb-item" data-view="archive" data-obj="B75" data-folder="D4">
          ${sbIcon('folder')} <span class="fdl-sb-label">D4</span>
        </button>
        <button class="fdl-sb-item" data-view="archive" data-obj="B75" data-folder="Allgemein">
          ${sbIcon('folder')} <span class="fdl-sb-label">Allgemein</span>
        </button>
      </div>` : `
      <div class="fdl-sb-sub">
        <button class="fdl-sb-item" data-view="archive" data-obj="${o.code}" data-folder="rechnung">
          ${sbIcon('receipt')} <span class="fdl-sb-label">Rechnungen</span>
        </button>
        <button class="fdl-sb-item" data-view="archive" data-obj="${o.code}" data-folder="other">
          ${sbIcon('file')} <span class="fdl-sb-label">Dokumente</span>
        </button>
      </div>`;

    return `
    <div class="fdl-sb-group" data-group="${o.code}">
      <button class="fdl-sb-group-toggle">
        ${sbIcon('building')}
        <span class="fdl-sb-label">${shortName||o.code}</span>
        <span id="fdl-sbcnt-${o.code}" class="fdl-sb-count"></span>
        <span class="fdl-sb-chevron">${icon('chevron')}</span>
      </button>
      ${isB75 ? '<div class="fdl-sb-sub"><button class="fdl-sb-item" data-view="archive" data-obj="B75" data-folder="rechnung">'+sbIcon('receipt')+'<span class="fdl-sb-label">Rechnungen</span></button>'+b75Subs+'<button class="fdl-sb-item" data-view="archive" data-obj="B75" data-folder="other">'+sbIcon('file')+'<span class="fdl-sb-label">Dokumente</span></button></div>' : b75Subs}
    </div>`;
  }).join('');

  return `
    <!-- Logo -->
    <div class="fdl-sb-logo">
      <div class="fdl-sb-logo-mark">${icon('grid','width:14px;height:14px;')}</div>
      <div>
        <div class="fdl-sb-logo-text">Fidelior</div>
        <div class="fdl-sb-logo-sub">DMS</div>
      </div>
    </div>

    <!-- Workspace -->
    <div class="fdl-sb-section"><span class="fdl-sb-section-label">Workspace</span></div>
    <button class="fdl-sb-item" data-view="dash">
      ${sbIcon('layout')} <span class="fdl-sb-label">Dashboard</span>
    </button>
    <button class="fdl-sb-item" data-view="filing">
      ${sbIcon('upload')} <span class="fdl-sb-label">Dokument ablegen</span>
    </button>
    <button class="fdl-sb-item" data-view="inbox">
      ${sbIcon('inbox')} <span class="fdl-sb-label">Posteingang</span>
      <span class="fdl-sb-badge" id="fdl-sb-inbox-badge" style="display:none">0</span>
    </button>
    <button class="fdl-sb-item" data-view="tasks">
      ${sbIcon('check')} <span class="fdl-sb-label">Aufgaben</span>
      <span class="fdl-sb-badge" id="fdl-sb-tasks-badge" style="display:none">0</span>
    </button>

    <div class="fdl-sb-divider"></div>

    <!-- Branches: Fidelior, Privat, ARNDT & CIE -->
    ${branchItems ? `<div class="fdl-sb-section"><span class="fdl-sb-section-label">Buchhaltung</span></div>${branchItems}<div class="fdl-sb-divider"></div>` : ''}

    <!-- Objekte -->
    <div class="fdl-sb-section"><span class="fdl-sb-section-label">Objekte</span></div>
    ${objItems}

    <div class="fdl-sb-divider"></div>

    <!-- Admin -->
    <div class="fdl-sb-section"><span class="fdl-sb-section-label">System</span></div>
    <button class="fdl-sb-item" data-view="admin">
      ${sbIcon('settings')} <span class="fdl-sb-label">Einstellungen</span>
    </button>
    <button class="fdl-sb-item" data-view="learn">
      ${sbIcon('brain')} <span class="fdl-sb-label">Lernzentrale</span>
    </button>
    <button class="fdl-sb-item" data-view="email">
      ${sbIcon('mail')} <span class="fdl-sb-label">E-Mail Vorlagen</span>
    </button>

    <div class="fdl-sb-divider"></div>

    <!-- Connection status -->
    <div style="padding:8px 0 14px">
      <div class="fdl-conn-row" id="fdl-conn-scope">
        <span class="fdl-conn-dot off" id="fdl-conn-scope-dot"></span>
        <span>Scopevisio</span>
      </div>
      <div class="fdl-conn-row" id="fdl-conn-pcloud">
        <span class="fdl-conn-dot off" id="fdl-conn-pcloud-dot"></span>
        <span>pCloud</span>
      </div>
    </div>`;
}

function attachSidebarEvents() {
  const sb = document.getElementById('fdl-sidebar');

  // Group toggles
  sb.querySelectorAll('.fdl-sb-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.parentElement;
      group.classList.toggle('open');
    });
  });

  // Nav items
  sb.querySelectorAll('.fdl-sb-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view  = btn.dataset.view;
      const obj   = btn.dataset.obj;
      const folder= btn.dataset.folder;
      activateView(view, { obj, folder });
    });
  });
}

/* ══════════════════════════════════════════════════════
   BUILD TOPBAR
   ══════════════════════════════════════════════════════ */
function buildTopbar() {
  const hdrInner = document.querySelector('.header-inner');
  if (!hdrInner || document.getElementById('fdl-tb-content')) return;

  const wrap = document.createElement('div');
  wrap.id = 'fdl-tb-content';
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%';
  wrap.innerHTML = `
    <!-- Search trigger -->
    <div class="fdl-tb-search" id="fdl-tb-search" role="button" tabindex="0" aria-label="Suche öffnen">
      <span class="fdl-tb-search-icon">${icon('search')}</span>
      <span class="fdl-tb-search-text">Dokumente suchen…</span>
      <span class="fdl-tb-kbd">Ctrl+K</span>
    </div>

    <!-- Actions -->
    <div class="fdl-tb-actions">
      <button class="fdl-tb-btn" id="fdl-tb-refresh" title="Aktualisieren">${icon('refresh')}</button>
      <button class="fdl-tb-cta" id="fdl-tb-upload">
        ${icon('plus','width:14px;height:14px;stroke-width:2.5')} Ablegen
      </button>
    </div>`;

  hdrInner.appendChild(wrap);

  document.getElementById('fdl-tb-search').addEventListener('click', openSearch);
  document.getElementById('fdl-tb-search').addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' ') openSearch(); });
  document.getElementById('fdl-tb-upload').addEventListener('click', () => activateView('filing'));
  document.getElementById('fdl-tb-refresh').addEventListener('click', () => { if(_view==='dash') renderDash(); });
}

function openSearch() {
  window.__fdlSrch?.open?.() || window.__fdlIdx?.openSearch?.();
}

/* ══════════════════════════════════════════════════════
   BUILD MAIN + VIEWS
   ══════════════════════════════════════════════════════ */
function buildMain() {
  if (document.getElementById('fdl-main')) return;

  const main = document.createElement('div');
  main.id = 'fdl-main';

  const content = document.createElement('div');
  content.id = 'fdl-content';

  // Dashboard view
  const dashView = document.createElement('div');
  dashView.id = 'fdl-view-dash';
  dashView.className = 'fdl-view';

  // Archive view
  const archView = document.createElement('div');
  archView.id = 'fdl-view-archive';
  archView.className = 'fdl-view';

  content.appendChild(dashView);
  content.appendChild(archView);
  main.appendChild(content);
  document.body.appendChild(main);

  // Move existing app container into main
  const container = document.querySelector('main.container');
  if (container) {
    main.appendChild(container);
  }
}

/* ══════════════════════════════════════════════════════
   VIEW SWITCHING
   ══════════════════════════════════════════════════════ */
function activateView(view, opts = {}) {
  _view = view;

  // Remove all view classes from body
  document.body.classList.remove('view-dash','view-archive','view-filing','view-tasks');

  // Update sidebar active state
  document.querySelectorAll('.fdl-sb-item').forEach(b => {
    const bView   = b.dataset.view;
    const bObj    = b.dataset.obj;
    const bFolder = b.dataset.folder;
    const match   = bView === view &&
      (!opts.obj    || bObj    === opts.obj    || !bObj)    &&
      (!opts.folder || bFolder === opts.folder || !bFolder);
    b.classList.toggle('active', match && bView === view &&
      (bObj ? bObj === opts.obj : true) &&
      (bFolder ? bFolder === opts.folder : !opts.folder || !bObj));
  });

  // Set single active item (simple: exact match)
  document.querySelectorAll('.fdl-sb-item').forEach(b => b.classList.remove('active'));
  if (opts.obj && opts.folder) {
    document.querySelector(`.fdl-sb-item[data-view="${view}"][data-obj="${opts.obj}"][data-folder="${opts.folder}"]`)?.classList.add('active');
  } else if (opts.obj && !opts.folder) {
    document.querySelector(`.fdl-sb-item[data-view="${view}"][data-obj="${opts.obj}"]:not([data-folder])`)?.classList.add('active');
  } else {
    document.querySelector(`.fdl-sb-item[data-view="${view}"]:not([data-obj])`)?.classList.add('active');
  }

  // Hide all views
  document.getElementById('fdl-view-dash')?.classList.remove('active');
  document.getElementById('fdl-view-archive')?.classList.remove('active');

  switch (view) {
    case 'dash':
      document.body.classList.add('view-dash');
      document.getElementById('fdl-view-dash')?.classList.add('active');
      renderDash();
      break;

    case 'filing':
    case 'inbox':
      document.body.classList.add('view-filing');
      // existing form is visible (container not hidden)
      // If inbox: trigger inbox view in existing app
      if (view === 'inbox') {
        document.querySelector('.fdl-sb-item[data-view="inbox"]')?.classList.add('active');
      }
      break;

    case 'archive':
      document.body.classList.add('view-archive');
      document.getElementById('fdl-view-archive')?.classList.add('active');
      showArchiveView(opts);
      break;

    case 'tasks':
      // Keep current background view, open tasks panel
      window.fdlTasksOpen?.() || document.getElementById('fdl-btn-tasks')?.click();
      break;

    case 'admin':
      document.getElementById('settingsBtn').style.display = '';
      document.getElementById('settingsBtn')?.click();
      document.getElementById('settingsBtn').style.display = 'none';
      setTimeout(() => {
        if (_view === 'admin') activateView('filing');
      }, 400);
      break;

    case 'learn':
      window.__fdlIdx?.openLernzentrale?.();
      break;

    case 'email':
      document.getElementById('settingsBtn').style.display = '';
      document.getElementById('settingsBtn')?.click();
      document.getElementById('settingsBtn').style.display = 'none';
      // Click Versand-Button in dialog
      setTimeout(() => {
        document.getElementById('btnManageEmails')?.click();
        if(_view==='email') activateView('filing');
      }, 300);
      break;
  }
}

/* ══════════════════════════════════════════════════════
   ARCHIVE VIEW (reuse fidelior-archiv.js inline)
   ══════════════════════════════════════════════════════ */
function showArchiveView(opts = {}) {
  const archView = document.getElementById('fdl-view-archive');
  if (!archView) return;

  // If archiv module has its own overlay, move its content inline
  const existingOverlay = document.getElementById('fdl-av3');
  if (existingOverlay) {
    // Detach from body → attach to archView
    if (existingOverlay.parentElement !== archView) {
      archView.appendChild(existingOverlay);
    }
    // Override: make it static/visible
    existingOverlay.classList.add('open');
    existingOverlay.style.cssText = 'position:static;opacity:1;pointer-events:all;display:flex;height:100%;background:transparent;padding:0;';
  } else {
    // Trigger open (will create overlay) then move it
    window.fdlArchivOpen?.();
    setTimeout(() => {
      const ov = document.getElementById('fdl-av3');
      if (ov && ov.parentElement !== archView) {
        ov.style.cssText = 'position:static;opacity:1;pointer-events:all;display:flex;height:100%;background:transparent;padding:0;';
        archView.appendChild(ov);
      }
    }, 100);
  }

  // If obj filter requested
  if (opts.obj) {
    setTimeout(() => {
      document.querySelector(`[data-code="${opts.obj}"], .av3-obj-item[data-obj="${opts.obj}"]`)?.click();
    }, 350);
  }
}

/* ══════════════════════════════════════════════════════
   DASHBOARD RENDER
   ══════════════════════════════════════════════════════ */
async function renderDash() {
  const root = document.getElementById('fdl-view-dash');
  if (!root) return;
  root.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:40px;color:var(--pro-text3);font-size:13px"><div class="fdl-pro-spinner"></div> Lade Dashboard…</div>`;

  let data, s;
  try { data = await loadData(); s = stats(data); }
  catch(e) { root.innerHTML = `<p style="color:var(--pro-red);padding:20px">Fehler: ${e.message}</p>`; return; }

  const now = new Date();
  const todISO  = now.toISOString().slice(0,10);
  const soonISO = new Date(now.getTime()+3*86400000).toISOString().slice(0,10);
  const dayStr  = now.toLocaleDateString('de-DE',{weekday:'long',day:'numeric',month:'long'});

  /* KPI cards */
  const kpis = `<div class="fdl-kpis">
    <div class="fdl-kpi" onclick="window.__fdlPro.goArchiv()">
      <div class="fdl-kpi-val">${s.total}</div>
      <div class="fdl-kpi-lbl">Dokumente gesamt</div>
      <div class="fdl-kpi-trend neu">Gesamtarchiv</div>
    </div>
    <div class="fdl-kpi" onclick="window.__fdlPro.goArchiv()">
      <div class="fdl-kpi-val">${s.wkCount}</div>
      <div class="fdl-kpi-lbl">Diese Woche</div>
      <div class="fdl-kpi-trend ${s.wkCount>0?'up':'neu'}">${s.wkCount>0?'Aktiv':'Keine Aktivität'}</div>
    </div>
    <div class="fdl-kpi" onclick="window.__fdlPro.goTasks()">
      <div class="fdl-kpi-val">${s.openCount}</div>
      <div class="fdl-kpi-lbl">Offene Aufgaben</div>
      <div class="fdl-kpi-trend ${s.overdueCount>0?'red':s.openCount>0?'warn':'up'}">${s.overdueCount>0?s.overdueCount+' überfällig':s.openCount>0?'Offen':'Alles erledigt'}</div>
    </div>
    <div class="fdl-kpi">
      <div class="fdl-kpi-val" style="font-size:${s.moAmt>9999?'18px':'24px'}">${s.moAmt>0?fmtE(s.moAmt):'—'}</div>
      <div class="fdl-kpi-lbl">Monatssumme</div>
      <div class="fdl-kpi-trend neu">${now.toLocaleDateString('de-DE',{month:'long',year:'numeric'})}</div>
    </div>
  </div>`;

  /* Object cards */
  const objList = Object.values(s.byObj).filter(o=>o.count>0||o.openTasks>0).sort((a,b)=>b.count-a.count);
  const objCards = objList.length ? objList.map(o=>`
    <div class="fdl-obj-card" onclick="window.__fdlPro.goArchivObj('${o.code}')">
      <div class="fdl-obj-code">${o.code}</div>
      <div class="fdl-obj-n">${o.count}</div>
      <div class="fdl-obj-l">Dokumente</div>
      <div class="fdl-obj-pills">
        ${o.amount>0?`<span class="fdl-obj-pill a">${fmtE(o.amount)}</span>`:''}
        ${o.openTasks>0?`<span class="fdl-obj-pill t">${o.openTasks} Aufgabe${o.openTasks>1?'n':''}</span>`:''}
      </div>
    </div>`).join('') : '<div class="fdl-empty-state">Noch keine Dokumente</div>';

  /* Activity rows */
  const actRows = s.recent.length ? s.recent.map(d=>{
    const fn = d.fileName||'';
    const short = fn.replace(/\.pdf$/i,'');
    const amt = d.amount ? fmtE(parseFloat(String(d.amount).replace(',','.').replace(/[^0-9.]/g,''))) : '';
    return `<div class="fdl-row" onclick="window.__fdlPro.openDoc('${encodeURIComponent(fn)}')" title="${fn}">
      <div class="fdl-row-icon">${icon('file')}</div>
      <div style="flex:1;min-width:0">
        <div class="fdl-row-name">${short}</div>
        <div class="fdl-row-meta">
          ${d.objectCode?`<span class="fdl-tag obj">${d.objectCode}</span>`:''}
          ${amt?`<span class="fdl-tag amt">${amt}</span>`:''}
          ${d.docType?`<span class="fdl-tag type">${d.docType}</span>`:''}
        </div>
      </div>
      <div class="fdl-row-time">${fmtR(d.savedAt)}</div>
    </div>`;
  }).join('') : '<div class="fdl-empty-state">Noch keine Aktivität</div>';

  /* Task rows */
  const taskRows = s.openTasks.length ? s.openTasks.map(t=>{
    const dc=!t.dueDate?'ok':t.dueDate<todISO?'ov':t.dueDate<=soonISO?'so':'ok';
    const dl=!t.dueDate?'':t.dueDate<todISO?`⚠ ${fmtS(t.dueDate)}`:fmtS(t.dueDate);
    return `<div class="fdl-task-row" onclick="window.__fdlPro.goTasks()">
      <div class="fdl-task-dot ${t.priority||'medium'}"></div>
      <div style="flex:1;min-width:0">
        <div class="fdl-task-t">${t.title||'—'}</div>
        <div class="fdl-task-s">${t.objectCode||''}</div>
      </div>
      ${dl?`<div class="fdl-due ${dc}">${dl}</div>`:''}
    </div>`;
  }).join('') : '<div class="fdl-empty-state" style="padding:16px;font-size:12px">Keine offenen Aufgaben</div>';

  /* Inbox */
  const inboxHtml = await buildInboxWidget();

  /* Amount bars */
  const objAmts = objList.filter(o=>o.amount>0).slice(0,5);
  const maxAmt  = Math.max(...objAmts.map(o=>o.amount),1);
  const barsHtml = objAmts.length ? `<div class="fdl-bar-wrap">${objAmts.map(o=>`
    <div class="fdl-bar-row">
      <div class="fdl-bar-lbl">${o.code}</div>
      <div class="fdl-bar-trk"><div class="fdl-bar-fil" style="width:${Math.round(o.amount/maxAmt*100)}%"></div></div>
      <div class="fdl-bar-val">${fmtE(o.amount)}</div>
    </div>`).join('')}</div>`
  : '<div class="fdl-empty-state" style="padding:12px;font-size:12px">Keine Beträge</div>';

  /* Badge data for task count */
  const taskBadge = s.openCount>0 ? `<span class="fdl-sb-badge${s.overdueCount>0?' amber':''}" style="display:inline-flex">${s.openCount}</span>` : '';

  root.innerHTML = `<div class="fdl-pro-fadein">
    <div class="fdl-dash-hdr">
      <div>
        <div class="fdl-dash-hdr-t">${dayStr}</div>
        <div class="fdl-dash-hdr-s">Fidelior DMS · Grundbesitzverwaltung</div>
      </div>
      <button class="fdl-btn-new" onclick="window.__fdlPro.goFiling()">
        ${icon('plus','width:13px;height:13px;stroke-width:2.5')} Dokument ablegen
      </button>
    </div>

    ${kpis}

    <div style="margin-bottom:14px">
      <div class="fdl-card">
        <div class="fdl-card-hdr">
          <span class="fdl-card-title">${icon('building','width:13px;height:13px;margin-right:4px;vertical-align:middle')} Liegenschaften</span>
          <button class="fdl-card-link" onclick="window.__fdlPro.goArchiv()">Alle anzeigen</button>
        </div>
        <div class="fdl-obj-grid">${objCards}</div>
      </div>

      <div class="fdl-card">
        <div class="fdl-card-hdr">
          <span class="fdl-card-title">${icon('file','width:13px;height:13px;margin-right:4px;vertical-align:middle')} Letzte Aktivität</span>
          <button class="fdl-card-link" onclick="window.__fdlPro.goArchiv()">Alle</button>
        </div>
        ${actRows}
      </div>
    </div>

    <div class="fdl-dash-body">
      <div style="display:none"></div><!-- spacer hack for grid offset -->
      <div>
        <div class="fdl-card">
          <div class="fdl-card-hdr">
            <span class="fdl-card-title">${icon('check','width:13px;height:13px;margin-right:4px;vertical-align:middle')} Aufgaben</span>
            <button class="fdl-card-link" onclick="window.__fdlPro.goTasks()">Alle</button>
          </div>
          ${taskRows}
        </div>

        <div class="fdl-card">
          <div class="fdl-card-hdr">
            <span class="fdl-card-title">${icon('inbox','width:13px;height:13px;margin-right:4px;vertical-align:middle')} Posteingang</span>
            <button class="fdl-card-link" onclick="window.__fdlPro.goFiling()">Öffnen</button>
          </div>
          ${inboxHtml}
        </div>

        <div class="fdl-card">
          <div class="fdl-card-hdr">
            <span class="fdl-card-title">${icon('receipt','width:13px;height:13px;margin-right:4px;vertical-align:middle')} Beträge ${s.yr}</span>
          </div>
          ${barsHtml}
        </div>
      </div>
    </div>
  </div>`;

  // Also update sidebar badges
  updateBadges(s);
}

async function buildInboxWidget() {
  try {
    const root = window.scopeRootHandle;
    if (!root) return '<div class="fdl-empty-state" style="font-size:12px;padding:12px">Scopevisio nicht verbunden</div>';
    const inbox = await root.getDirectoryHandle('Inbox',{create:false}).catch(()=>null);
    if (!inbox) return '<div class="fdl-empty-state" style="font-size:12px;padding:12px">Inbox nicht verfügbar</div>';
    const files = [];
    for await (const e of inbox.values()) if(e.kind==='file'&&e.name.toLowerCase().endsWith('.pdf')) files.push(e.name);
    if (!files.length) return '<div class="fdl-empty-state" style="font-size:12px;padding:12px">Inbox ist leer</div>';

    // Update sidebar inbox badge
    const badge = document.getElementById('fdl-sb-inbox-badge');
    if (badge) { badge.textContent=files.length; badge.style.display='inline-flex'; badge.className='fdl-sb-badge muted'; }

    return files.slice(0,6).map(n=>`
      <div class="fdl-inbox-row" onclick="window.__fdlPro.goFiling()">
        <div class="fdl-inbox-icon">${icon('file')}</div>
        <div class="fdl-inbox-name" title="${n}">${n.replace(/\.pdf$/i,'')}</div>
      </div>`).join('')+
      (files.length>6?`<div style="padding:6px 16px;font-size:11px;color:var(--pro-text4)">+${files.length-6} weitere</div>`:'');
  } catch { return '<div class="fdl-empty-state" style="font-size:12px;padding:12px">Inbox nicht verfügbar</div>'; }
}

function updateBadges(s) {
  const tb = document.getElementById('fdl-sb-tasks-badge');
  if (tb) {
    if (s.openCount > 0) { tb.textContent=s.openCount; tb.style.display='inline-flex'; tb.className='fdl-sb-badge'+(s.overdueCount>0?' amber':''); }
    else { tb.style.display='none'; }
  }
}

/* ══════════════════════════════════════════════════════
   CONNECTION STATUS
   ══════════════════════════════════════════════════════ */
function updateConnStatus() {
  const scopeOk  = !!window.scopeRootHandle;
  const pcloudOk = !!window.pcloudRootHandle;
  const sd = document.getElementById('fdl-conn-scope-dot');
  const pd = document.getElementById('fdl-conn-pcloud-dot');
  if (sd) { sd.className='fdl-conn-dot '+(scopeOk?'ok':'off'); sd.title=scopeOk?'Verbunden':'Nicht verbunden'; }
  if (pd) { pd.className='fdl-conn-dot '+(pcloudOk?'ok':'off'); pd.title=pcloudOk?'Verbunden':'Nicht verbunden'; }
}

/* ══════════════════════════════════════════════════════
   REDIRECT fdlArchivOpen to our view switch
   ══════════════════════════════════════════════════════ */
function patchArchivHook() {
  const orig = window.fdlArchivOpen;
  window.fdlArchivOpen = function() {
    // Call original to ensure overlay is built, then move it
    orig?.();
    // Switch to archive view in our shell
    activateView('archive');
  };
}

/* ══════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════ */
window.__fdlPro = {
  goFiling()        { activateView('filing'); },
  goArchiv()        { activateView('archive'); },
  goArchivObj(code) { activateView('archive',{obj:code}); },
  goTasks()         { activateView('tasks'); },
  openDoc(encoded)  {
    const name = decodeURIComponent(encoded);
    activateView('archive');
    setTimeout(()=>{
      const sf=document.getElementById('fdl-av3-search');
      if(sf){sf.value=name.replace(/\.pdf$/i,'').slice(0,50);sf.dispatchEvent(new Event('input',{bubbles:true}));}
    },380);
  },
  refreshDash() { if(_view==='dash') renderDash(); },
};

/* ══════════════════════════════════════════════════════
   HOOK: fdlOnFileSaved
   ══════════════════════════════════════════════════════ */
const _prevSaved = window.fdlOnFileSaved;
window.fdlOnFileSaved = function(data) {
  try { _prevSaved?.(data); } catch {}
  setTimeout(()=>{ if(_view==='dash') renderDash(); updateBadges({openCount:0,overdueCount:0}); }, 900);
};

/* ══════════════════════════════════════════════════════
   REFRESH CONNECTION STATUS HOOK
   ══════════════════════════════════════════════════════ */
const _prevRefresh = window.fdlRefreshConnectionsUI;
window.fdlRefreshConnectionsUI = function() {
  try { _prevRefresh?.(); } catch {}
  updateConnStatus();
  // update sidebar object counts from index
  updateSidebarCounts();
};

async function updateSidebarCounts() {
  const docs = await idbGetAll('fidelior_index_v1','documents').catch(()=>
    idbGetAll('fidelior_addon_v1','activity'));
  const counts = {};
  for (const d of docs) { if(d.objectCode) counts[d.objectCode]=(counts[d.objectCode]||0)+1; }
  for (const [code, cnt] of Object.entries(counts)) {
    const el = document.getElementById(`fdl-sbcnt-${code}`);
    if (el) el.textContent = cnt > 0 ? cnt : '';
  }
}

/* ══════════════════════════════════════════════════════
   KEYBOARD
   ══════════════════════════════════════════════════════ */
function attachKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (e.key==='1') activateView('dash');
    if (e.key==='2') activateView('filing');
    if (e.key==='3') activateView('archive');
    if (e.key==='4') activateView('tasks');
  }, true);
}

/* ══════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════ */
function init() {
  buildSidebar();
  buildMain();
  buildTopbar();
  attachKeyboard();
  updateConnStatus();

  // Set connection refresh interval
  setInterval(updateConnStatus, 15000);
  setInterval(updateSidebarCounts, 60000);

  // Default view: dashboard
  setTimeout(() => {
    activateView('dash');
    updateSidebarCounts();
    // Patch archiv hook after module loads
    setTimeout(patchArchivHook, 800);
  }, 100);

  console.info('[FideliorPro v2.0] bereit — 1:Dashboard 2:Ablage 3:Archiv 4:Aufgaben Ctrl+K:Suche');
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
