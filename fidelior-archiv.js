/* ==========================================================================
   Fidelior Archiv – Dokument-Browser & Viewer  v2.0
   Non-invasive, standalone. Liest aus scopeRootHandle (read-only).
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   PFAD-MAPPING  (spiegelt preflightTargets exakt)
   ══════════════════════════════════════════════════════════════════════════ */

function buildScanRoots(obj) {
  const sn = obj.scopevisioName || obj.code;
  const roots = [];
  if (obj.code === 'FIDELIOR') {
    roots.push({ segs: ['FIDELIOR', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' });
    roots.push({ segs: ['FIDELIOR', 'Dokumente'],          label: 'Dokumente' });
  } else if (obj.code === 'PRIVAT') {
    roots.push({ segs: ['PRIVAT', 'Rechnungsbelege'], label: 'Rechnungsbelege' });
    roots.push({ segs: ['PRIVAT', 'Dokumente'],       label: 'Dokumente' });
  } else if (obj.code === 'ARNDTCIE' || sn === 'ARNDT & CIE') {
    roots.push({ segs: ['ARNDT & CIE', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' });
    roots.push({ segs: ['ARNDT & CIE', 'Dokumente'],           label: 'Dokumente' });
  } else {
    roots.push({ segs: ['OBJEKTE', sn, 'Rechnungsbelege'],  label: 'Rechnungsbelege' });
    roots.push({ segs: ['OBJEKTE', sn, 'Objektdokumente'],  label: 'Objektdokumente' });
    roots.push({ segs: ['OBJEKTE', sn, 'Abrechnungsbelege'],label: 'Abrechnungsbelege' });
  }
  return roots;
}

/* ══════════════════════════════════════════════════════════════════════════
   DATEISYSTEM SCAN  –  KORREKTE IMPLEMENTIERUNG
   entry aus dir.values() IST bereits der Handle, kein getDirectoryHandle nötig
   ══════════════════════════════════════════════════════════════════════════ */

async function navigateTo(rootHandle, segments) {
  let cur = rootHandle;
  for (const seg of segments) {
    try { cur = await cur.getDirectoryHandle(seg, { create: false }); }
    catch { return null; }
  }
  return cur;
}

async function scanForPDFs(dirHandle, basePath, maxDepth, results, seen) {
  if (!dirHandle || maxDepth < 0) return;
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {
        const key = basePath.join('/') + '/' + entry.name;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const file = await entry.getFile();
          results.push({ handle: entry, name: entry.name, size: file.size, modified: file.lastModified, pathSegs: [...basePath] });
        } catch {}
      } else if (entry.kind === 'directory' && maxDepth > 0) {
        // entry IS the DirectoryHandle directly – no extra getDirectoryHandle call needed
        await scanForPDFs(entry, [...basePath, entry.name], maxDepth - 1, results, seen);
      }
    }
  } catch {}
}

async function loadFilesForObject(obj, rootHandle) {
  if (!rootHandle) return [];
  const scanRoots = buildScanRoots(obj);
  const allFiles  = [];
  const seen      = new Set();

  for (const { segs, label } of scanRoots) {
    const dir = await navigateTo(rootHandle, segs);
    if (!dir) continue;
    const batch = [];
    await scanForPDFs(dir, segs, 2, batch, seen);
    for (const f of batch) {
      f.folderType = label;
      f.meta       = parseFileName(f.name);
      f.year       = inferYear(f.pathSegs, f.modified);
      f.subfolder  = inferSubfolder(f.pathSegs, segs, f.year);
    }
    allFiles.push(...batch);
  }

  allFiles.sort((a, b) => b.modified - a.modified);
  return allFiles;
}

function inferYear(pathSegs, modified) {
  for (let i = pathSegs.length - 1; i >= 0; i--) {
    if (/^20\d{2}$/.test(pathSegs[i])) return pathSegs[i];
  }
  return modified ? String(new Date(modified).getFullYear()) : '';
}

function inferSubfolder(pathSegs, baseSegs, year) {
  const afterBase = pathSegs.slice(baseSegs.length);
  const parts = afterBase.filter(s => !/^20\d{2}$/.test(s));
  return parts.join(' › ') || null;
}

function parseFileName(name) {
  const stem  = name.replace(/\.pdf$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) return { raw: name };
  let rest = [...parts], datum = null, betrag = null, objekt = null;
  const last = rest[rest.length - 1];
  if (/^(\d{4})[.\-](\d{2})[.\-](\d{2})$/.test(last)) { datum = last.replace(/[.\-]/g, '.'); rest.pop(); }
  if (rest[0] && /^\d/.test(rest[0])) { betrag = rest.shift().replace(',', ',') + ' €'; }
  if (rest[0] && /^[A-ZÄÖÜ0-9]{2,10}$/.test(rest[0])) { objekt = rest.shift(); }
  const absender = rest.join(' ').replace(/-/g, ' ').trim() || null;
  return { betrag, objekt, absender, datum, raw: name };
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function getObjList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options).filter(o => o.value).map(o => ({ code: o.value, name: o.textContent }));
}
function getObjRecord(code) {
  return (window.objectsCfg?.objects || []).find(o => o.code === code) || { code, scopevisioName: code };
}
function qs(sel, root) { return (root || document).querySelector(sel); }
function fdlToast(html, ms) { try { toast(html, ms || 3000); } catch {} }

/* ══════════════════════════════════════════════════════════════════════════
   CSS
   ══════════════════════════════════════════════════════════════════════════ */

function injectCSS() {
  if (document.getElementById('fdl-av-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-av-css';
  s.textContent = `
.fdl-av-hbtn{font-family:var(--font-ui);font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:8px;border:1.5px solid rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:background .15s;white-space:nowrap;}
.fdl-av-hbtn:hover{background:rgba(255,255,255,.2);}
#fdl-av-overlay{position:fixed;inset:0;z-index:9100;background:var(--bg);display:flex;flex-direction:column;opacity:0;pointer-events:none;transition:opacity .2s;}
#fdl-av-overlay.open{opacity:1;pointer-events:all;}
.fdl-av-topbar{display:flex;align-items:center;gap:.7rem;padding:0 1.2rem;height:52px;flex-shrink:0;background:var(--surface);border-bottom:1px solid var(--border);}
.fdl-av-logo{font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;}
.fdl-av-breadcrumb{display:flex;align-items:center;gap:.3rem;font-size:12px;color:var(--muted);}
.fdl-av-breadcrumb b{color:var(--text);font-weight:600;}
.fdl-av-bc-sep{color:var(--border-strong,#ccc);}
.fdl-av-search{flex:1;max-width:340px;font-family:var(--font-ui);font-size:12.5px;padding:6px 12px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface-2);color:var(--text);}
.fdl-av-search:focus{outline:none;border-color:var(--primary);box-shadow:var(--focus-ring);}
.fdl-av-topbar-close{width:30px;height:30px;border-radius:8px;border:none;background:var(--surface-2);color:var(--muted);font-size:16px;cursor:pointer;margin-left:auto;display:flex;align-items:center;justify-content:center;}
.fdl-av-topbar-close:hover{background:var(--border);color:var(--text);}
.fdl-av-list-sort{font-family:var(--font-ui);font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--muted);cursor:pointer;}
.fdl-av-body{flex:1;display:grid;grid-template-columns:190px 1fr 340px;min-height:0;overflow:hidden;}
.fdl-av-sidebar{border-right:1px solid var(--border);overflow-y:auto;background:var(--surface);}
.fdl-av-sb-head{padding:.65rem 1rem .3rem;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);}
.fdl-av-obj{display:flex;align-items:center;gap:.5rem;padding:.48rem .9rem;cursor:pointer;font-size:12.5px;color:var(--text);border-left:3px solid transparent;transition:background .1s;}
.fdl-av-obj:hover{background:var(--surface-2);}
.fdl-av-obj.active{background:rgba(91,27,112,.07);color:var(--primary);font-weight:600;border-left-color:var(--primary);}
.fdl-av-obj-badge{font-size:9.5px;font-weight:700;letter-spacing:.04em;background:rgba(91,27,112,.1);color:var(--primary);padding:1px 5px;border-radius:4px;flex-shrink:0;}
.fdl-av-obj-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}
.fdl-av-obj-count{font-size:10.5px;color:var(--muted);background:var(--surface-2);border-radius:10px;padding:1px 6px;flex-shrink:0;}
.fdl-av-obj.active .fdl-av-obj-count{background:rgba(91,27,112,.12);color:var(--primary);}
.fdl-av-list{border-right:1px solid var(--border);overflow-y:auto;background:var(--surface-2);display:flex;flex-direction:column;}
.fdl-av-list-head{padding:.6rem 1rem;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:2;flex-shrink:0;}
.fdl-av-list-count{font-size:11.5px;color:var(--muted);}
.fdl-av-file{display:flex;align-items:flex-start;gap:.6rem;padding:.65rem 1rem;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s;border-left:3px solid transparent;}
.fdl-av-file:hover{background:rgba(91,27,112,.03);}
.fdl-av-file.active{background:rgba(91,27,112,.07);border-left-color:var(--primary);}
.fdl-av-pdf-thumb{width:34px;height:42px;border-radius:5px;flex-shrink:0;background:#fee2e2;border:1px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:800;color:#b91c1c;letter-spacing:.02em;}
.fdl-av-file-body{flex:1;min-width:0;}
.fdl-av-file-name{font-size:11.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:.25rem;}
.fdl-av-file.active .fdl-av-file-name{color:var(--primary);}
.fdl-av-chips{display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:.2rem;}
.fdl-av-chip{font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;}
.fdl-av-chip.amount{background:rgba(26,122,69,.1);color:#1A7A45;}
.fdl-av-chip.date{background:var(--surface);color:var(--muted);border:1px solid var(--border);}
.fdl-av-chip.sub{background:rgba(180,130,0,.09);color:#7A5500;}
.fdl-av-chip.year{background:rgba(91,27,112,.09);color:var(--primary);}
.fdl-av-chip.type{background:var(--surface);color:var(--muted);font-weight:400;border:1px solid var(--border);}
.fdl-av-file-sender{font-size:11px;color:var(--muted);}
.fdl-av-file-info{font-size:10.5px;color:var(--muted);margin-top:.2rem;}
.fdl-av-year-sep{padding:.35rem 1rem;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:46px;z-index:1;}

/* ── Rechtes Panel ── */
.fdl-av-panel{display:flex;flex-direction:column;overflow:hidden;background:var(--surface);position:relative;}
.fdl-av-panel-icons{position:absolute;right:0;top:0;bottom:0;width:42px;display:flex;flex-direction:column;align-items:center;padding:.6rem 0;gap:.25rem;border-left:1px solid var(--border);background:var(--surface);z-index:2;}
.fdl-av-icon-btn{width:32px;height:32px;border-radius:8px;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--muted);transition:background .12s;position:relative;}
.fdl-av-icon-btn:hover{background:var(--surface-2);color:var(--text);}
.fdl-av-icon-btn[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:calc(100% + 6px);top:50%;transform:translateY(-50%);background:#222;color:#fff;font-size:11px;white-space:nowrap;padding:3px 8px;border-radius:5px;pointer-events:none;z-index:10;font-family:var(--font-ui);}
.fdl-av-panel-content{flex:1;overflow-y:auto;padding-right:44px;display:flex;flex-direction:column;}
.fdl-av-panel-hdr{padding:.8rem 1rem .6rem;border-bottom:1px solid var(--border);}
.fdl-av-panel-date{font-size:11.5px;color:var(--muted);margin-bottom:.3rem;}
.fdl-av-panel-name{font-size:13px;font-weight:700;color:var(--text);line-height:1.35;word-break:break-all;}
.fdl-av-sec{padding:.75rem 1rem;border-bottom:1px solid var(--border);}
.fdl-av-sec-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:.55rem;}
.fdl-av-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:.4rem .6rem;}
.fdl-av-meta-row{display:flex;flex-direction:column;}
.fdl-av-meta-label{font-size:10.5px;color:var(--muted);}
.fdl-av-meta-val{font-size:12.5px;color:var(--text);font-weight:500;word-break:break-all;}
.fdl-av-meta-row.full{grid-column:1/-1;}
.fdl-av-task-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;}
.fdl-av-task-add{font-family:var(--font-ui);font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;border:1.5px solid var(--border);background:transparent;color:var(--primary);cursor:pointer;}
.fdl-av-task-add:hover{background:rgba(91,27,112,.06);}
.fdl-av-task-item{display:flex;align-items:flex-start;gap:.45rem;padding:.32rem 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text);}
.fdl-av-task-item:last-child{border-bottom:none;}
.fdl-av-task-dot{width:13px;height:13px;border-radius:4px;flex-shrink:0;margin-top:1px;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:8px;}
.fdl-av-task-dot.done{background:var(--primary);border-color:var(--primary);color:#fff;}
.fdl-av-task-dot.high{border-color:#ef4444;}
.fdl-av-no-tasks{font-size:12px;color:var(--muted);}
.fdl-av-prev-sec{flex:1;display:flex;flex-direction:column;min-height:280px;}
.fdl-av-prev-body{flex:1;background:#e8e8ed;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:.6rem;padding:.8rem;}
.fdl-av-prev-body canvas{width:100%;border-radius:3px;box-shadow:0 2px 12px rgba(0,0,0,.18);}
.fdl-av-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem 1rem;color:var(--muted);text-align:center;gap:.5rem;font-size:13px;}
.fdl-av-empty-ico{font-size:2.8rem;}
.fdl-av-loading{display:flex;align-items:center;justify-content:center;padding:2rem;gap:.6rem;color:var(--muted);font-size:12.5px;}
@keyframes fdlSpin{to{transform:rotate(360deg);}}
.fdl-av-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--primary);animation:fdlSpin .7s linear infinite;flex-shrink:0;}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */

const S = { selectedObj: null, files: [], filtered: [], selected: null, query: '', blobUrl: null, counts: {} };

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: SIDEBAR
   ══════════════════════════════════════════════════════════════════════════ */

function renderSidebar() {
  const el = qs('#fdl-av-sb');
  if (!el) return;
  const objs = getObjList();
  let h = '<div class="fdl-av-sb-head">Liegenschaften</div>';
  for (const o of objs) {
    const short  = o.name.replace(o.code + ' · ', '');
    const active = S.selectedObj?.code === o.code ? 'active' : '';
    const cnt    = S.counts[o.code] !== undefined ? S.counts[o.code] : '…';
    h += `<div class="fdl-av-obj ${active}" onclick="window.__fdlAv.selObj('${o.code}')">
      <span class="fdl-av-obj-badge">${o.code}</span>
      <span class="fdl-av-obj-name">${short}</span>
      <span class="fdl-av-obj-count" id="fdl-avc-${o.code}">${cnt}</span>
    </div>`;
  }
  el.innerHTML = h;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: LISTE
   ══════════════════════════════════════════════════════════════════════════ */

function renderList(files) {
  const inner   = qs('#fdl-av-list-inner');
  const countEl = qs('#fdl-av-list-count');
  if (!inner) return;
  if (countEl) countEl.textContent = `${files.length} Dokument${files.length !== 1 ? 'e' : ''}`;

  if (files.length === 0) {
    inner.innerHTML = `<div class="fdl-av-empty">
      <div class="fdl-av-empty-ico">📂</div>
      <div>${S.query ? 'Keine Treffer für „' + S.query + '"' : 'Keine Dokumente gefunden'}</div>
      ${!S.query ? '<div style="font-size:11.5px">Scopevisio verbunden?</div>' : ''}
    </div>`;
    return;
  }

  let html = '', lastYear = null;
  for (const f of files) {
    if (f.year && f.year !== lastYear) {
      html += `<div class="fdl-av-year-sep">📅 ${f.year}</div>`;
      lastYear = f.year;
    }
    const m      = f.meta;
    const active = isSelected(f) ? 'active' : '';
    const key    = encodeURIComponent(f.name + '||' + f.modified);
    html += `<div class="fdl-av-file ${active}" onclick="window.__fdlAv.selFile('${key}')">
      <div class="fdl-av-pdf-thumb">PDF</div>
      <div class="fdl-av-file-body">
        <div class="fdl-av-file-name" title="${f.name}">${f.name}</div>
        <div class="fdl-av-chips">
          ${m.betrag    ? `<span class="fdl-av-chip amount">${m.betrag}</span>` : ''}
          ${m.datum     ? `<span class="fdl-av-chip date">📅 ${m.datum}</span>` : ''}
          ${f.subfolder ? `<span class="fdl-av-chip sub">${f.subfolder}</span>` : ''}
          ${f.folderType && f.folderType !== 'Rechnungsbelege' ? `<span class="fdl-av-chip type">${f.folderType}</span>` : ''}
        </div>
        ${m.absender ? `<div class="fdl-av-file-sender">${m.absender}</div>` : ''}
        <div class="fdl-av-file-info">${fmtDate(f.modified)} · ${fmtSize(f.size)}</div>
      </div>
    </div>`;
  }
  inner.innerHTML = html;
}

function isSelected(f) {
  return S.selected && S.selected.name === f.name && S.selected.modified === f.modified;
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER: RECHTES PANEL
   ══════════════════════════════════════════════════════════════════════════ */

async function renderPanel(file) {
  const panel = qs('#fdl-av-panel');
  if (!panel) return;
  if (!file) {
    panel.innerHTML = `<div class="fdl-av-empty" style="flex:1"><div class="fdl-av-empty-ico">👆</div><div>Dokument auswählen</div></div>`;
    return;
  }

  const m     = file.meta;
  const tasks = await loadTasksForFile(file.name);
  const oTask = tasks.filter(t => t.status !== 'done');

  const taskRows = tasks.length
    ? tasks.slice(0, 6).map(t => {
        const done = t.status === 'done', high = t.priority === 'high';
        return `<div class="fdl-av-task-item">
          <div class="fdl-av-task-dot ${done ? 'done' : high ? 'high' : ''}">${done ? '✓' : ''}</div>
          <span style="${done ? 'text-decoration:line-through;opacity:.55' : ''}">${t.title}</span>
        </div>`;
      }).join('')
    : '<div class="fdl-av-no-tasks">Keine Aufgaben</div>';

  const pathStr  = (file.pathSegs || []).join(' › ');
  const objLabel = S.selectedObj ? (S.selectedObj.name || S.selectedObj.code) : '';

  panel.innerHTML = `
    <div class="fdl-av-panel-icons">
      <button class="fdl-av-icon-btn" data-tip="Herunterladen"      onclick="window.__fdlAv.download()">⬇️</button>
      <button class="fdl-av-icon-btn" data-tip="Neuer Tab"          onclick="window.__fdlAv.newTab()">↗</button>
      <button class="fdl-av-icon-btn" data-tip="In App laden"       onclick="window.__fdlAv.loadIntoApp()">📥</button>
      <button class="fdl-av-icon-btn" data-tip="Name kopieren"      onclick="window.__fdlAv.copyName()">📋</button>
      <button class="fdl-av-icon-btn" data-tip="Pfad kopieren"      onclick="window.__fdlAv.copyPath()">🔗</button>
      <div style="flex:1"></div>
      <button class="fdl-av-icon-btn" data-tip="Aufgabe erstellen"
              style="${oTask.length ? 'color:var(--primary)' : ''}"
              onclick="window.__fdlAv.createTask()">✅</button>
    </div>
    <div class="fdl-av-panel-content">
      <div class="fdl-av-panel-hdr">
        <div class="fdl-av-panel-date">📅 ${fmtDate(file.modified)}</div>
        <div class="fdl-av-panel-name">${file.name}</div>
      </div>
      <div class="fdl-av-sec">
        <div class="fdl-av-sec-title">Kategorien</div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;">
          ${objLabel ? `<span class="fdl-av-chip year" style="font-size:11.5px;padding:3px 9px">${objLabel}</span>` : ''}
          ${file.folderType ? `<span class="fdl-av-chip sub" style="font-size:11.5px;padding:3px 9px">${file.folderType}</span>` : ''}
          ${file.year ? `<span class="fdl-av-chip date" style="font-size:11.5px;padding:3px 9px">${file.year}</span>` : ''}
          ${file.subfolder ? `<span class="fdl-av-chip date" style="font-size:11.5px;padding:3px 9px">${file.subfolder}</span>` : ''}
        </div>
      </div>
      <div class="fdl-av-sec">
        <div class="fdl-av-sec-title">Dokumentdaten</div>
        <div class="fdl-av-meta-grid">
          ${m.betrag   ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Betrag</span><span class="fdl-av-meta-val">${m.betrag}</span></div>` : ''}
          ${m.datum    ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Datum</span><span class="fdl-av-meta-val">${m.datum}</span></div>` : ''}
          ${m.absender ? `<div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Absender</span><span class="fdl-av-meta-val">${m.absender}</span></div>` : ''}
          <div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Größe</span><span class="fdl-av-meta-val">${fmtSize(file.size)}</span></div>
          <div class="fdl-av-meta-row"><span class="fdl-av-meta-label">Geändert</span><span class="fdl-av-meta-val">${fmtDate(file.modified)}</span></div>
          <div class="fdl-av-meta-row full"><span class="fdl-av-meta-label">Pfad</span><span class="fdl-av-meta-val" style="font-size:10.5px">${pathStr}</span></div>
        </div>
      </div>
      <div class="fdl-av-sec">
        <div class="fdl-av-task-hdr">
          <div class="fdl-av-sec-title" style="margin-bottom:0">Aufgaben${oTask.length ? ' (' + oTask.length + ')' : ''}</div>
          <button class="fdl-av-task-add" onclick="window.__fdlAv.createTask()">+ Erstellen</button>
        </div>
        ${taskRows}
      </div>
      <div class="fdl-av-prev-sec">
        <div class="fdl-av-sec-title" style="padding:.7rem 1rem .3rem;margin:0">Vorschau</div>
        <div class="fdl-av-prev-body" id="fdl-av-prev">
          <div class="fdl-av-loading"><div class="fdl-av-spinner"></div> Lade PDF…</div>
        </div>
      </div>
    </div>`;

  renderPDF(file);
}

async function renderPDF(file) {
  const wrap = qs('#fdl-av-prev');
  if (!wrap) return;
  if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch {} S.blobUrl = null; }
  try {
    const fileObj = await file.handle.getFile();
    const buf     = await fileObj.arrayBuffer();
    const blob    = new Blob([buf], { type: 'application/pdf' });
    S.blobUrl     = URL.createObjectURL(blob);

    const pjs = window.pdfjsLib;
    if (!pjs) { wrap.innerHTML = `<embed src="${S.blobUrl}" type="application/pdf" style="width:100%;height:480px">`; return; }
    if (!pjs.GlobalWorkerOptions?.workerSrc) pjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const doc   = await pjs.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 6);
    wrap.innerHTML = '';
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const vp   = page.getViewport({ scale: 1.5 });
      const cv   = document.createElement('canvas');
      cv.width   = vp.width; cv.height = vp.height; cv.style.width = '100%';
      wrap.appendChild(cv);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    if (doc.numPages > 6) { const n = document.createElement('div'); n.style.cssText='font-size:11px;color:var(--muted);text-align:center;padding:.4rem'; n.textContent=`+ ${doc.numPages-6} weitere Seiten`; wrap.appendChild(n); }
  } catch {
    wrap.innerHTML = `<div class="fdl-av-empty"><div class="fdl-av-empty-ico">⚠️</div><div style="font-size:12px">PDF konnte nicht gerendert werden</div></div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TASKS
   ══════════════════════════════════════════════════════════════════════════ */

async function loadTasksForFile(fileName) {
  try {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('fidelior_addon_v1',1); r.onsuccess=e=>res(e.target.result); r.onerror=e=>rej(e.target.error); });
    return await new Promise((res) => {
      const req = db.transaction('tasks','readonly').objectStore('tasks').getAll();
      req.onsuccess = e => { const stem = fileName.replace(/\.pdf$/i,''); res((e.target.result||[]).filter(t=>(t.note||'').includes(stem)||(t.title||'').includes(stem))); };
      req.onerror = ()=>res([]);
    });
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   AKTIONEN
   ══════════════════════════════════════════════════════════════════════════ */

window.__fdlAv = {
  async selObj(code) {
    const o = getObjList().find(x => x.code === code);
    if (!o) return;
    S.selectedObj = { ...o, ...getObjRecord(code) };
    S.selected = null; S.files = []; S.filtered = []; S.query = '';
    const sf = qs('#fdl-av-search'); if (sf) sf.value = '';
    const bc = qs('#fdl-av-bc');
    if (bc) bc.innerHTML = `<span>Archiv</span><span class="fdl-av-bc-sep">/</span><b>${o.name}</b>`;
    renderSidebar();
    const li = qs('#fdl-av-list-inner');
    if (li) li.innerHTML = `<div class="fdl-av-loading"><div class="fdl-av-spinner"></div> Lade Dokumente…</div>`;
    await renderPanel(null);
    const root = window.scopeRootHandle || null;
    if (!root) { if (li) li.innerHTML = `<div class="fdl-av-empty"><div class="fdl-av-empty-ico">🔌</div><div>Scopevisio nicht verbunden</div></div>`; return; }
    const files = await loadFilesForObject(S.selectedObj, root);
    S.files = files; S.filtered = files;
    S.counts[code] = files.length;
    const ce = qs(`#fdl-avc-${code}`); if (ce) ce.textContent = files.length;
    renderList(files);
  },

  async selFile(key) {
    const [name, modified] = decodeURIComponent(key).split('||');
    const f = S.files.find(x => x.name === name && String(x.modified) === modified) || S.files.find(x => x.name === name);
    if (!f) return;
    S.selected = f;
    renderList(S.filtered);
    await renderPanel(f);
  },

  download() { if (S.blobUrl && S.selected) { const a = Object.assign(document.createElement('a'),{href:S.blobUrl,download:S.selected.name}); a.click(); } },
  newTab()   { if (S.blobUrl) window.open(S.blobUrl,'_blank'); },
  copyName() { if (S.selected) navigator.clipboard.writeText(S.selected.name).then(()=>fdlToast('Dateiname kopiert ✓',1500)); },
  copyPath() { if (S.selected) { const p=(S.selected.pathSegs||[]).join(' › ')+' › '+S.selected.name; navigator.clipboard.writeText(p).then(()=>fdlToast('Pfad kopiert ✓',1500)); } },

  async loadIntoApp() {
    if (!S.selected) return;
    try {
      if (typeof window.openPdfFromHandle === 'function') { await window.openPdfFromHandle(S.selected.handle); close(); return; }
      const file = await S.selected.handle.getFile();
      // Direkt in die pdfDoc Variable laden (wie beim Öffnen aus Inbox)
      const dt = new DataTransfer(); dt.items.add(file);
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) { Object.defineProperty(fileInput,'files',{value:dt.files,configurable:true}); fileInput.dispatchEvent(new Event('change',{bubbles:true})); close(); fdlToast(`<strong>${file.name}</strong> geladen`,2000); }
      else fdlToast('Direktes Laden nicht möglich – bitte manuell öffnen.',4000);
    } catch(e) { fdlToast('Fehler: '+(e?.message||e),3000); }
  },

  createTask() {
    if (!S.selected) return;
    close();
    setTimeout(() => {
      const ov = document.getElementById('fdl-tasks-overlay');
      if (ov) { ov.classList.add('open'); setTimeout(()=>{ const n=document.getElementById('fdl-f-note'),ob=document.getElementById('fdl-f-obj'); if(n)n.value='Dokument: '+S.selected.name; if(ob&&S.selectedObj)ob.value=S.selectedObj.code; },80); }
      else fdlToast('Aufgaben-Addon nicht geladen.',2000);
    },160);
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   SUCHE & SORT
   ══════════════════════════════════════════════════════════════════════════ */

function applyFilter(q) {
  S.query = (q||'').trim().toLowerCase();
  S.filtered = !S.query ? S.files : S.files.filter(f =>
    f.name.toLowerCase().includes(S.query) ||
    (f.meta.absender||'').toLowerCase().includes(S.query) ||
    (f.meta.betrag||'').toLowerCase().includes(S.query) ||
    (f.meta.datum||'').toLowerCase().includes(S.query) ||
    (f.subfolder||'').toLowerCase().includes(S.query) ||
    (f.year||'').includes(S.query)
  );
  renderList(S.filtered);
}

function applySort(v) {
  let arr = [...S.filtered];
  if (v==='date-desc') arr.sort((a,b)=>b.modified-a.modified);
  if (v==='date-asc')  arr.sort((a,b)=>a.modified-b.modified);
  if (v==='name-asc')  arr.sort((a,b)=>a.name.localeCompare(b.name,'de'));
  if (v==='amount')    arr.sort((a,b)=>{
    const pa=parseFloat((a.meta.betrag||'0').replace('.','').replace(',','.').replace(/[^0-9.]/g,''))||0;
    const pb=parseFloat((b.meta.betrag||'0').replace('.','').replace(',','.').replace(/[^0-9.]/g,''))||0;
    return pb-pa;
  });
  S.filtered=arr; renderList(arr);
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERLAY
   ══════════════════════════════════════════════════════════════════════════ */

function buildOverlay() {
  if (document.getElementById('fdl-av-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'fdl-av-overlay';
  ov.innerHTML = `
    <div class="fdl-av-topbar">
      <div class="fdl-av-logo">📁 Archiv</div>
      <div class="fdl-av-breadcrumb" id="fdl-av-bc"><span>Alle Liegenschaften</span></div>
      <input class="fdl-av-search" id="fdl-av-search" placeholder="🔍  Suche in Dokumenten…" type="search" autocomplete="off">
      <select id="fdl-av-sort" class="fdl-av-list-sort">
        <option value="date-desc">Neueste zuerst</option>
        <option value="date-asc">Älteste zuerst</option>
        <option value="name-asc">Name A–Z</option>
        <option value="amount">Betrag ↓</option>
      </select>
      <button class="fdl-av-topbar-close" id="fdl-av-close">✕</button>
    </div>
    <div class="fdl-av-body">
      <div class="fdl-av-sidebar" id="fdl-av-sb"></div>
      <div class="fdl-av-list">
        <div class="fdl-av-list-head">
          <span class="fdl-av-list-count" id="fdl-av-list-count">—</span>
        </div>
        <div id="fdl-av-list-inner"><div class="fdl-av-empty"><div class="fdl-av-empty-ico">📁</div><div>Liegenschaft wählen</div></div></div>
      </div>
      <div class="fdl-av-panel" id="fdl-av-panel"><div class="fdl-av-empty" style="flex:1"><div class="fdl-av-empty-ico">👆</div><div>Dokument auswählen</div></div></div>
    </div>`;
  document.body.appendChild(ov);
  qs('#fdl-av-close',ov).addEventListener('click', close);
  qs('#fdl-av-search',ov).addEventListener('input', e=>applyFilter(e.target.value));
  qs('#fdl-av-sort',ov).addEventListener('change', e=>applySort(e.target.value));
  document.addEventListener('keydown', e=>{ if (e.key==='Escape'&&ov.classList.contains('open')) close(); });
}

async function open() {
  buildOverlay();
  renderSidebar();
  document.getElementById('fdl-av-overlay').classList.add('open');
  const root = window.scopeRootHandle || null;
  if (root) {
    for (const o of getObjList()) {
      const rec = getObjRecord(o.code);
      loadFilesForObject({...o,...rec}, root).then(files=>{ S.counts[o.code]=files.length; const el=qs(`#fdl-avc-${o.code}`); if(el)el.textContent=files.length; }).catch(()=>{});
    }
  }
}

function close() {
  document.getElementById('fdl-av-overlay')?.classList.remove('open');
  if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch {} S.blobUrl = null; }
}

function injectButton() {
  if (document.getElementById('fdl-av-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'fdl-av-btn'; btn.className = 'fdl-av-hbtn';
  btn.textContent = '📁 Archiv'; btn.title = 'Archiv öffnen (A)';
  btn.onclick = open;
  const addonBtns = document.getElementById('fdl-addon-btns');
  const header    = document.querySelector('.header-inner, header');
  if (addonBtns)  addonBtns.insertBefore(btn, addonBtns.firstChild);
  else if (header) { const s=document.getElementById('settingsBtn'); if(s)header.insertBefore(btn,s); else header.appendChild(btn); }
}

function init() {
  injectCSS(); injectButton();
  document.addEventListener('keydown', e=>{
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key==='a'&&!e.ctrlKey&&!e.metaKey) open();
  });
  console.info('[FideliorArchiv v2.0] bereit');
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
window.fdlArchivOpen = open;

})();
