/* ==========================================================================
   Fidelior Nav  v1.1  —  Tab-Navigation & Dashboard mit echten Archivdaten
   ==========================================================================
   ZWECK:
   - Tab-Navigation
   - Dashboard als Startbildschirm
   - Dashboard-Zahlen primär aus dem echten Scopevisio-Archiv
   - Fallback auf IndexedDB nur wenn Archiv nicht verfügbar ist

   WICHTIG:
   - Kein Eingriff in app.js / index.html
   - Keine Änderung an Ablage-Logik
   - Keine Änderung an Scopevisio-Struktur
   ========================================================================== */

(() => {
'use strict';

/* ─────────────────────────────── IDB ───────────────────────────────────── */
function idbGetAll(dbName, store) {
  return new Promise(res => {
    const r = indexedDB.open(dbName);
    r.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(store)) { res([]); return; }
      const q = db.transaction(store, 'readonly').objectStore(store).getAll();
      q.onsuccess = e2 => res(e2.target.result || []);
      q.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  });
}

/* ─────────────────────────────── CONFIG ────────────────────────────────── */
let _objectsMap = null;

async function loadObjectsConfig() {
  if (_objectsMap) return _objectsMap;
  _objectsMap = {};
  try {
    const cfgDir = window.configDirHandle;
    if (!cfgDir) return _objectsMap;
    const fh = await cfgDir.getFileHandle('objects.json', { create: false });
    const file = await fh.getFile();
    const json = JSON.parse(await file.text());
    for (const obj of (json.objects || [])) _objectsMap[obj.code] = obj;
  } catch (e) {
    console.warn('[FideliorNav] objects.json konnte nicht geladen werden:', e);
  }
  return _objectsMap;
}

function getScopeName(code) {
  return _objectsMap?.[code]?.scopevisioName || code;
}

/* ─────────────────────────────── ARCHIV HELPERS ────────────────────────── */
function getObjectOptions() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options)
    .filter(o => o.value)
    .map(o => ({ code: o.value, name: o.textContent.trim() }));
}

function buildScanRoots(code) {
  const sn = getScopeName(code);

  if (code === 'FIDELIOR') return [
    { segs: ['FIDELIOR', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' },
    { segs: ['FIDELIOR', 'Dokumente'], label: 'Dokumente' },
  ];

  if (code === 'PRIVAT') return [
    { segs: ['PRIVAT', 'Rechnungsbelege'], label: 'Rechnungsbelege' },
    { segs: ['PRIVAT', 'Dokumente'], label: 'Dokumente' },
  ];

  if (code === 'ARNDTCIE' || sn === 'ARNDT & CIE') return [
    { segs: ['ARNDT & CIE', 'Eingangsrechnungen'], label: 'Eingangsrechnungen' },
    { segs: ['ARNDT & CIE', 'Dokumente'], label: 'Dokumente' },
  ];

  return [
    { segs: ['OBJEKTE', sn, 'Rechnungsbelege'], label: 'Rechnungsbelege' },
    { segs: ['OBJEKTE', sn, 'Objektdokumente'], label: 'Objektdokumente' },
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
            name: entry.name,
            size: f.size,
            modified: f.lastModified,
            pathSegs: [...basePath],
          });
        } catch {}
      } else if (entry.kind === 'directory' && depth > 0) {
        await scanPDFs(entry, [...basePath, entry.name], depth - 1, out, seen);
      }
    }
  } catch {}
}

function extractYear(segs, modified) {
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^20\d{2}$/.test(segs[i])) return segs[i];
  }
  return modified ? String(new Date(modified).getFullYear()) : '';
}

function parseName(name) {
  const stem = String(name || '').replace(/\.pdf$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) return { raw: name, betrag: null, absender: null, datum: null };

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
    rest.shift();
  }

  return {
    betrag,
    absender: rest.join(' ').replace(/-/g, ' ').trim() || null,
    datum,
  };
}

function folderTypeToDocType(ft) {
  if (ft === 'Rechnungsbelege' || ft === 'Eingangsrechnungen' || ft === 'Abrechnungsbelege') return 'Rechnung';
  return 'Dokument';
}

function parseAmount(raw) {
  if (!raw) return 0;
  const n = parseFloat(
    String(raw)
      .replace(/[€\s]/g, '')
      .replace(/\./g, '')
      .replace(',', '.')
      .replace(/[^0-9.]/g, '')
  );
  return isFinite(n) ? n : 0;
}

function toISOFromFilenameDate(datum) {
  if (!datum) return '';
  const m = String(datum).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function deriveSavedAt(file) {
  const iso = toISOFromFilenameDate(file.meta?.datum);
  if (iso) return `${iso}T12:00:00.000Z`;
  try {
    return new Date(file.modified).toISOString();
  } catch {
    return '';
  }
}

async function loadArchiveDocs() {
  const root = window.scopeRootHandle;
  if (!root) return [];

  await loadObjectsConfig();

  const objList = getObjectOptions();
  const all = [];
  const seen = new Set();

  for (const obj of objList) {
    const roots = buildScanRoots(obj.code);

    for (const { segs, label } of roots) {
      const dir = await navigateTo(root, segs);
      if (!dir) continue;

      const batch = [];
      await scanPDFs(dir, segs, 2, batch, seen);

      for (const f of batch) {
        f.folderType = label;
        f.meta = parseName(f.name);
        f.year = extractYear(f.pathSegs, f.modified);
        f.objectCode = obj.code;
        f.objectName = getScopeName(obj.code);

        all.push({
          fileName: f.name,
          objectCode: f.objectCode,
          objectName: f.objectName,
          docType: folderTypeToDocType(f.folderType),
          amount: parseAmount(f.meta?.betrag),
          amountRaw: f.meta?.betrag || '',
          sender: f.meta?.absender || '',
          senderNorm: (f.meta?.absender || '').toLowerCase(),
          invoiceDate: toISOFromFilenameDate(f.meta?.datum),
          savedAt: deriveSavedAt(f),
          modified: f.modified || 0,
          year: f.year || '',
          source: 'archive',
        });
      }
    }
  }

  all.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return all;
}

/* ─────────────────────────────── ARCHIVE CACHE ─────────────────────────── */
const ARCHIVE_CACHE_MS = 45000;
let _archiveCache = {
  ts: 0,
  docs: [],
};

async function getArchiveDocsCached(force = false) {
  const now = Date.now();
  if (!force && _archiveCache.docs.length && (now - _archiveCache.ts) < ARCHIVE_CACHE_MS) {
    return _archiveCache.docs;
  }
  const docs = await loadArchiveDocs();
  _archiveCache = { ts: now, docs };
  return docs;
}

function invalidateArchiveCache() {
  _archiveCache = { ts: 0, docs: [] };
}

/* ─────────────────────────────── DATA ──────────────────────────────────── */
async function loadAllData() {
  const [activity, tasks, indexDocs, archiveDocs] = await Promise.all([
    idbGetAll('fidelior_addon_v1', 'activity'),
    idbGetAll('fidelior_addon_v1', 'tasks'),
    idbGetAll('fidelior_index_v1', 'documents').catch(() => []),
    getArchiveDocsCached().catch(() => []),
  ]);
  return { activity, tasks, indexDocs, archiveDocs };
}

function computeStats({ activity, tasks, indexDocs, archiveDocs }) {
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth();
  const wk = new Date(now.getTime() - 7 * 86400000).toISOString();
  const mst = new Date(yr, mo, 1).toISOString();
  const tod = now.toISOString().slice(0, 10);

  const docs = archiveDocs.length ? archiveDocs : (indexDocs.length ? indexDocs : activity);

  const openTasks = tasks.filter(t => t.status !== 'done');
  const overdueTasks = openTasks.filter(t => t.dueDate && t.dueDate < tod);
  const recent = [...docs]
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
    .slice(0, 25);

  const weekDocs = docs.filter(d => (d.savedAt || '') >= wk);
  const monthDocs = docs.filter(d => (d.savedAt || '') >= mst);

  const monthAmount = monthDocs.reduce((s, d) => {
    const n = parseFloat(String(d.amount || d.amountRaw || '0').replace(',', '.').replace(/[^0-9.]/g, ''));
    return s + (isFinite(n) ? n : 0);
  }, 0);

  const byObj = {};
  const sel = document.getElementById('objectSelect');
  if (sel) {
    Array.from(sel.options).filter(o => o.value).forEach(o => {
      byObj[o.value] = {
        code: o.value,
        name: o.textContent.trim(),
        count: 0,
        amount: 0,
        lastSaved: null,
        openTasks: 0,
      };
    });
  }

  for (const d of docs) {
    const c = d.objectCode;
    if (!c) continue;
    if (!byObj[c]) {
      byObj[c] = {
        code: c,
        name: c,
        count: 0,
        amount: 0,
        lastSaved: null,
        openTasks: 0,
      };
    }
    byObj[c].count++;
    const n = parseFloat(String(d.amount || d.amountRaw || '0').replace(',', '.').replace(/[^0-9.]/g, ''));
    byObj[c].amount += isFinite(n) ? n : 0;
    if (!byObj[c].lastSaved || (d.savedAt || '') > byObj[c].lastSaved) byObj[c].lastSaved = d.savedAt || '';
  }

  for (const t of openTasks) {
    if (t.objectCode && byObj[t.objectCode]) byObj[t.objectCode].openTasks++;
  }

  const objCards = Object.values(byObj).filter(o => o.count > 0 || o.openTasks > 0);

  const categoryCounts = {
    objectGroups: objCards.filter(o => o.code !== 'FIDELIOR' && o.code !== 'PRIVAT').length,
    fideliorDocs: byObj.FIDELIOR?.count || 0,
    privatDocs: byObj.PRIVAT?.count || 0,
  };

  return {
    total: docs.length,
    weekCount: weekDocs.length,
    monthCount: monthDocs.length,
    openTasks: openTasks.length,
    overdueTasks: overdueTasks.length,
    monthAmount,
    byObj,
    recent,
    openTasksList: openTasks.slice(0, 8),
    thisYear: yr,
    categoryCounts,
    source: archiveDocs.length ? 'archive' : (indexDocs.length ? 'index' : 'activity'),
  };
}

/* ─────────────────────────────── FMT ───────────────────────────────────── */
const fmtDate = iso => {
  try {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '—';
  }
};
const fmtShort = iso => {
  try {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  } catch {
    return '—';
  }
};
const fmtEuro = n => !n ? '' : n.toLocaleString('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}) + ' €';

function fmtRel(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return 'Gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Gestern';
  if (d < 7) return `vor ${d} Tagen`;
  return fmtDate(iso);
}

/* ─────────────────────────────── CSS ───────────────────────────────────── */
function injectCSS() {
  if (document.getElementById('fdl-nav-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-nav-css';
  s.textContent = `
#fdl-nav{background:var(--surface,#fff);border-bottom:1px solid var(--border,#E7E2E0);position:sticky;top:56px;z-index:40;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.fdl-nav-inner{max-width:1400px;margin:0 auto;padding:0 1.2rem;display:flex;align-items:stretch;height:42px}
.fdl-nav-tab{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-ui,inherit);font-size:12.5px;font-weight:500;color:var(--muted,#6A6666);padding:0 16px;border:none;background:transparent;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s;white-space:nowrap}
.fdl-nav-tab:hover{color:var(--primary,#5B1B70)}
.fdl-nav-tab.active{color:var(--primary,#5B1B70);font-weight:700;border-bottom-color:var(--primary,#5B1B70)}
.fdl-nav-badge{display:inline-flex;align-items:center;justify-content:center;background:#EF4444;color:#fff;border-radius:10px;font-size:10px;font-weight:700;min-width:17px;height:17px;padding:0 4px}
.fdl-nav-badge.amber{background:#D97706}
.fdl-nav-spacer{flex:1}
.fdl-nav-sbtn{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-ui,inherit);font-size:12px;font-weight:500;color:var(--muted,#6A6666);padding:0 14px;border:none;background:transparent;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s;white-space:nowrap}
.fdl-nav-sbtn:hover{color:var(--primary,#5B1B70)}
.fdl-nav-kbd{font-size:10px;background:var(--surface-2,#F7F6F4);border:1px solid var(--border,#E7E2E0);border-radius:4px;padding:1px 5px;color:var(--muted,#6A6666)}

body.fdl-nav-mode .container{display:none}
#fdl-dash-panel{display:none;position:fixed;top:98px;left:0;right:0;bottom:0;background:var(--bg,#FAF9F7);overflow-y:auto;z-index:30;padding:28px;animation:fdl-fi .18s ease}
#fdl-dash-panel.visible{display:block}
@keyframes fdl-fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.fdl-di{max-width:1350px;margin:0 auto}

.fdl-dw{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}
.fdl-dw-t{font-size:20px;font-weight:700;color:var(--text,#1C1A1A)}
.fdl-dw-s{font-size:13px;color:var(--muted,#6A6666);margin-top:2px}
.fdl-qbtn{display:inline-flex;align-items:center;gap:8px;background:var(--primary,#5B1B70);color:#fff;border:none;border-radius:10px;padding:10px 20px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(91,27,112,.25);transition:background .15s}
.fdl-qbtn:hover{background:var(--primary-600,#6a2483)}

.fdl-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:22px}
@media(max-width:900px){.fdl-stats{grid-template-columns:repeat(3,1fr)}}
.fdl-sc{background:var(--surface,#fff);border:1px solid var(--border,#E7E2E0);border-radius:12px;padding:16px 18px;cursor:pointer;transition:box-shadow .15s,border-color .15s;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.fdl-sc:hover{box-shadow:0 4px 16px rgba(0,0,0,.08);border-color:var(--accent,#C9A6E0)}
.fdl-sc-n{font-size:26px;font-weight:700;color:var(--text,#1C1A1A);letter-spacing:-.02em;line-height:1;margin-bottom:4px}
.fdl-sc-l{font-size:11.5px;color:var(--muted,#6A6666);font-weight:500}
.fdl-sc-t{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;margin-top:6px;padding:2px 7px;border-radius:20px}
.fdl-sc-t.up{background:#D1FAE5;color:#065F46}.fdl-sc-t.warn{background:#FEF3C7;color:#92400E}.fdl-sc-t.red{background:#FEE2E2;color:#B91C1C}.fdl-sc-t.blue{background:#EFF6FF;color:#1E40AF}.fdl-sc-t.mu{background:var(--surface-2,#F7F6F4);color:var(--muted,#6A6666)}

.fdl-dg{display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start}
@media(max-width:1000px){.fdl-dg{grid-template-columns:1fr}}

.fdl-lh{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#6A6666);margin-bottom:10px}
.fdl-lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px;margin-bottom:18px}
.fdl-lc{background:var(--surface,#fff);border:1.5px solid var(--border,#E7E2E0);border-radius:10px;padding:14px 16px;cursor:pointer;transition:border-color .15s,box-shadow .15s;position:relative;overflow:hidden}
.fdl-lc:hover{border-color:var(--primary,#5B1B70);box-shadow:0 4px 16px rgba(91,27,112,.1)}
.fdl-lc::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--primary,#5B1B70);opacity:0;transition:opacity .15s}
.fdl-lc:hover::before{opacity:1}
.fdl-lc-code{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--primary,#5B1B70);background:#F5EEF8;border-radius:5px;padding:2px 7px;display:inline-block;margin-bottom:8px}
.fdl-lc-name{font-size:11.5px;color:var(--muted,#6A6666);margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fdl-lc-n{font-size:22px;font-weight:700;color:var(--text,#1C1A1A);line-height:1}
.fdl-lc-s{font-size:10.5px;color:var(--muted,#6A6666);margin-top:2px}
.fdl-lc-pills{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.fdl-pill{font-size:9.5px;font-weight:700;padding:2px 5px;border-radius:4px}
.fdl-pill.t{background:#FEF3C7;color:#92400E}.fdl-pill.a{background:#D1FAE5;color:#065F46}
.fdl-lc-last{font-size:10px;color:var(--muted,#6A6666);margin-top:6px}

.fdl-af{background:var(--surface,#fff);border:1px solid var(--border,#E7E2E0);border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.fdl-af-hdr{padding:13px 18px;border-bottom:1px solid var(--border,#E7E2E0);display:flex;align-items:center;justify-content:space-between}
.fdl-af-hdr-t{font-size:13px;font-weight:700;color:var(--text,#1C1A1A)}
.fdl-af-lnk{font-size:11.5px;color:var(--primary,#5B1B70);font-weight:600;cursor:pointer;border:none;background:none;font-family:inherit}
.fdl-af-lnk:hover{text-decoration:underline}
.fdl-ar{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid #F7F5F5;cursor:pointer;transition:background .1s}
.fdl-ar:last-child{border-bottom:none}
.fdl-ar:hover{background:#FAF5FB}
.fdl-ar-th{width:32px;height:38px;border-radius:5px;flex-shrink:0;background:#FEE2E2;border:1px solid #FECACA;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#DC2626}
.fdl-ar-n{font-size:12px;font-weight:600;color:var(--text,#1C1A1A);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.fdl-ar-cs{display:flex;gap:4px;margin-top:2px}
.fdl-ch{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}
.fdl-ch.o{background:#F5EEF8;color:#5B1B70}.fdl-ch.a{background:#D1FAE5;color:#065F46}.fdl-ch.t{background:#F3F4F6;color:#374151}
.fdl-ar-tm{font-size:10.5px;color:var(--muted,#6A6666);white-space:nowrap;margin-left:auto}
.fdl-empty{padding:28px;text-align:center;color:var(--muted,#6A6666);font-size:13px}

.fdl-dr{display:flex;flex-direction:column;gap:12px}
.fdl-wg{background:var(--surface,#fff);border:1px solid var(--border,#E7E2E0);border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.fdl-wg-h{padding:12px 16px;border-bottom:1px solid var(--border,#E7E2E0);display:flex;align-items:center;justify-content:space-between}
.fdl-wg-t{font-size:12.5px;font-weight:700;color:var(--text,#1C1A1A);display:flex;align-items:center;gap:6px}
.fdl-wg-l{font-size:11.5px;color:var(--primary,#5B1B70);font-weight:600;cursor:pointer;border:none;background:none;font-family:inherit}
.fdl-wg-l:hover{text-decoration:underline}
.fdl-tr{display:flex;align-items:flex-start;gap:10px;padding:10px 16px;border-bottom:1px solid #F7F5F5;cursor:pointer;transition:background .1s}
.fdl-tr:last-child{border-bottom:none}
.fdl-tr:hover{background:#FAF5FB}
.fdl-td{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
.fdl-td.high{background:#B91C1C}.fdl-td.medium{background:#D97706}.fdl-td.low{background:#6B7280}
.fdl-tt{font-size:12px;font-weight:600;color:var(--text,#1C1A1A);line-height:1.4}
.fdl-tm{font-size:10.5px;color:var(--muted,#6A6666);margin-top:1px}
.fdl-due{font-size:10.5px;font-weight:600;margin-left:auto;white-space:nowrap;padding:2px 6px;border-radius:4px}
.fdl-due.ov{background:#FEE2E2;color:#B91C1C}.fdl-due.so{background:#FEF3C7;color:#92400E}.fdl-due.ok{background:#F3F4F6;color:#6B7280}

.fdl-ib{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid #F7F5F5;cursor:pointer;transition:background .1s}
.fdl-ib:last-child{border-bottom:none}
.fdl-ib:hover{background:#FAF5FB}
.fdl-ib-ic{width:28px;height:34px;border-radius:4px;flex-shrink:0;background:#EFF6FF;border:1px solid #BFDBFE;display:flex;align-items:center;justify-content:center;font-size:11px}
.fdl-ib-n{font-size:11.5px;font-weight:500;color:var(--text,#1C1A1A);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}

.fdl-bar-w{padding:12px 16px}
.fdl-bar-r{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.fdl-bar-l{font-size:10.5px;color:var(--muted,#6A6666);width:56px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fdl-bar-tr{flex:1;background:var(--surface-2,#F7F6F4);border-radius:4px;height:8px;overflow:hidden}
.fdl-bar-fi{height:100%;background:var(--primary,#5B1B70);border-radius:4px;transition:width .4s ease}
.fdl-bar-v{font-size:10.5px;color:var(--muted,#6A6666);width:52px;text-align:right;flex-shrink:0}

.fdl-loading{display:flex;align-items:center;justify-content:center;height:180px;color:var(--muted,#6A6666);font-size:13px;gap:10px}
@keyframes fdl-sp{to{transform:rotate(360deg)}}
.fdl-sp{width:18px;height:18px;border-radius:50%;border:2px solid var(--border,#E7E2E0);border-top-color:var(--primary,#5B1B70);animation:fdl-sp .6s linear infinite}
`;
  document.head.appendChild(s);
}

/* ─────────────────────────────── NAV BUILD ─────────────────────────────── */
const TABS = [
  { id: 'dash',   label: 'Dashboard' },
  { id: 'ablage', label: 'Ablage' },
  { id: 'archiv', label: 'Archiv' },
  { id: 'tasks',  label: 'Aufgaben', badge: true },
  { id: 'admin',  label: 'Admin' },
];

let _tab = 'dash';

function buildNav() {
  if (document.getElementById('fdl-nav')) return;

  const nav = document.createElement('div');
  nav.id = 'fdl-nav';

  const inner = document.createElement('div');
  inner.className = 'fdl-nav-inner';

  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'fdl-nav-tab';
    b.dataset.tab = t.id;
    b.textContent = t.label;

    if (t.badge) {
      const badge = document.createElement('span');
      badge.className = 'fdl-nav-badge';
      badge.id = 'fdl-nav-tasks-badge';
      badge.style.display = 'none';
      b.appendChild(badge);
    }

    b.addEventListener('click', () => activateTab(t.id));
    inner.appendChild(b);
  }

  const spacer = document.createElement('div');
  spacer.className = 'fdl-nav-spacer';
  inner.appendChild(spacer);

  const sb = document.createElement('button');
  sb.className = 'fdl-nav-sbtn';
  sb.innerHTML = 'Suche <span class="fdl-nav-kbd">Ctrl+K</span>';
  sb.onclick = () => window.__fdlIdx?.openSearch?.();
  inner.appendChild(sb);

  nav.appendChild(inner);

  const hdr = document.querySelector('header.header');
  if (hdr?.nextSibling) hdr.parentNode.insertBefore(nav, hdr.nextSibling);
  else document.body.prepend(nav);
}

/* ─────────────────────────────── TAB SWITCH ────────────────────────────── */
function activateTab(id) {
  _tab = id;
  document.querySelectorAll('.fdl-nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  hideDash();
  document.body.classList.remove('fdl-nav-mode');

  if (id === 'dash') {
    document.body.classList.add('fdl-nav-mode');
    showDash();
  } else if (id === 'archiv') {
    window.fdlArchivOpen?.();
  } else if (id === 'tasks') {
    window.fdlTasksOpen?.() || document.getElementById('fdl-btn-tasks')?.click();
  } else if (id === 'admin') {
    document.getElementById('settingsBtn')?.click();
    setTimeout(() => { if (_tab === 'admin') activateTab('ablage'); }, 300);
  }
}

/* ─────────────────────────────── DASH PANEL ────────────────────────────── */
function buildDash() {
  if (document.getElementById('fdl-dash-panel')) return;
  const p = document.createElement('div');
  p.id = 'fdl-dash-panel';
  p.innerHTML = '<div class="fdl-di" id="fdl-di"></div>';
  document.body.appendChild(p);
}

function showDash() {
  buildDash();
  document.getElementById('fdl-dash-panel').classList.add('visible');
  renderDash();
}

function hideDash() {
  document.getElementById('fdl-dash-panel')?.classList.remove('visible');
}

/* ─────────────────────────────── RENDER ────────────────────────────────── */
async function renderDash() {
  const root = document.getElementById('fdl-di');
  if (!root) return;

  root.innerHTML = '<div class="fdl-loading"><div class="fdl-sp"></div> Lade Dashboard…</div>';

  let data, s;
  try {
    data = await loadAllData();
    s = computeStats(data);
  } catch (e) {
    root.innerHTML = `<p style="color:#B91C1C;padding:20px">Fehler: ${e.message}</p>`;
    return;
  }

  const now = new Date();
  const dayStr = now.toLocaleDateString('de-DE', { weekday: 'long' });
  const dateStr = now.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  const todISO = now.toISOString().slice(0, 10);
  const soonISO = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);

  const sc = (num, label, trendCls, trendTxt, onclick) => `
    <div class="fdl-sc" onclick="${onclick}">
      <div class="fdl-sc-n">${num}</div>
      <div class="fdl-sc-l">${label}</div>
      <div class="fdl-sc-t ${trendCls}">${trendTxt}</div>
    </div>`;

  const stats = `<div class="fdl-stats">
    ${sc(s.categoryCounts.objectGroups, 'Objekte', 'mu', 'Liegenschaften', "window.__fdlNav.goArchivCategory('Objekte')")}
    ${sc(s.categoryCounts.fideliorDocs, 'Fidelior', 'mu', 'Buchhaltung', "window.__fdlNav.goArchivCategory('Fidelior')")}
    ${sc(s.categoryCounts.privatDocs, 'Privat', 'mu', 'Buchhaltung', "window.__fdlNav.goArchivCategory('Privat')")}
    ${sc(s.total, 'Dokumente gesamt', 'mu', s.source === 'archive' ? 'Gesamtarchiv' : 'Index/Fallback', "window.__fdlNav.goArchiv()")}
    ${sc(s.weekCount, 'Diese Woche', s.weekCount > 0 ? 'up' : 'mu', s.weekCount > 0 ? 'Aktiv' : 'Ruhig', "window.__fdlNav.goArchiv()")}
    ${sc(s.openTasks, 'Offene Aufgaben',
      s.overdueTasks > 0 ? 'red' : s.openTasks > 0 ? 'warn' : 'up',
      s.overdueTasks > 0 ? `${s.overdueTasks} überfällig` : s.openTasks > 0 ? 'Offen' : 'Erledigt',
      "window.__fdlNav.goTasks()")}
    ${sc(s.monthAmount > 0 ? fmtEuro(s.monthAmount) : '—', 'Monatssumme', 'blue', now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), "window.__fdlNav.goArchiv()")}
  </div>`;

  const objList = Object.values(s.byObj)
    .filter(o => o.count > 0 || o.openTasks > 0)
    .sort((a, b) => b.count - a.count);

  const liegCards = objList.length ? objList.map(o => {
    const shortName = o.name.replace(/^[A-Z0-9]+ · /, '').replace(/^[A-Z0-9]+$/, '');
    return `<div class="fdl-lc" onclick="window.__fdlNav.goArchivObj('${o.code}')" title="${o.name}">
      <div class="fdl-lc-code">${o.code}</div>
      ${shortName ? `<div class="fdl-lc-name">${shortName}</div>` : ''}
      <div class="fdl-lc-n">${o.count}</div>
      <div class="fdl-lc-s">Dokumente</div>
      <div class="fdl-lc-pills">
        ${o.amount > 0 ? `<span class="fdl-pill a">${fmtEuro(o.amount)}</span>` : ''}
        ${o.openTasks > 0 ? `<span class="fdl-pill t">${o.openTasks} Aufgaben</span>` : ''}
      </div>
      ${o.lastSaved ? `<div class="fdl-lc-last">Zuletzt: ${fmtRel(o.lastSaved)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="fdl-empty">Noch keine Dokumente im Archiv</div>';

  const actRows = s.recent.length ? s.recent.map(d => {
    const fn = d.fileName || '';
    const short = fn.replace(/\.pdf$/i, '');
    const amt = d.amount ? fmtEuro(parseFloat(String(d.amount).replace(',', '.').replace(/[^0-9.]/g, ''))) : '';
    return `<div class="fdl-ar" onclick="window.__fdlNav.openActivity('${encodeURIComponent(JSON.stringify({ fileName: fn, objectCode: d.objectCode || '', docType: d.docType || '' }))}')" title="${fn}">
      <div class="fdl-ar-th">PDF</div>
      <div style="flex:1;min-width:0">
        <div class="fdl-ar-n">${short}</div>
        <div class="fdl-ar-cs">
          ${d.objectCode ? `<span class="fdl-ch o">${d.objectCode}</span>` : ''}
          ${amt ? `<span class="fdl-ch a">${amt}</span>` : ''}
          ${d.docType ? `<span class="fdl-ch t">${d.docType}</span>` : ''}
        </div>
      </div>
      <div class="fdl-ar-tm">${fmtRel(d.savedAt)}</div>
    </div>`;
  }).join('') : '<div class="fdl-empty">Noch keine Aktivität</div>';

  const taskRows = s.openTasksList.length ? s.openTasksList.map(t => {
    const dc = !t.dueDate ? 'ok' : t.dueDate < todISO ? 'ov' : t.dueDate <= soonISO ? 'so' : 'ok';
    const dl = !t.dueDate ? '' : t.dueDate < todISO ? fmtShort(t.dueDate) : fmtShort(t.dueDate);
    return `<div class="fdl-tr" onclick="window.__fdlNav.goTasks()">
      <div class="fdl-td ${t.priority || 'medium'}"></div>
      <div style="flex:1;min-width:0">
        <div class="fdl-tt">${t.title || '—'}</div>
        <div class="fdl-tm">${t.objectCode ? t.objectCode + ' · ' : ''}${t.docType || ''}</div>
      </div>
      ${dl ? `<div class="fdl-due ${dc}">${dl}</div>` : ''}
    </div>`;
  }).join('') : '<div class="fdl-empty" style="padding:16px">Keine offenen Aufgaben</div>';

  const inboxHtml = await buildInbox();

  const objAmts = objList.filter(o => o.amount > 0).slice(0, 6);
  const maxAmt = Math.max(...objAmts.map(o => o.amount), 1);
  const barHtml = objAmts.length ? `<div class="fdl-bar-w">${objAmts.map(o => `
    <div class="fdl-bar-r">
      <div class="fdl-bar-l">${o.code}</div>
      <div class="fdl-bar-tr"><div class="fdl-bar-fi" style="width:${Math.round(o.amount / maxAmt * 100)}%"></div></div>
      <div class="fdl-bar-v">${fmtEuro(o.amount)}</div>
    </div>`).join('')}</div>` : '<div class="fdl-empty" style="padding:12px;font-size:12px">Noch keine Beträge</div>';

  root.innerHTML = `
    <div class="fdl-dw">
      <div>
        <div class="fdl-dw-t">${dayStr}, ${dateStr}</div>
        <div class="fdl-dw-s">Fidelior DMS · Grundbesitzverwaltung</div>
      </div>
      <button class="fdl-qbtn" onclick="window.__fdlNav.goAblage()">Dokument ablegen</button>
    </div>
    ${stats}
    <div class="fdl-dg">
      <div>
        <div class="fdl-lh">Liegenschaften</div>
        <div class="fdl-lg">${liegCards}</div>
        <div class="fdl-af">
          <div class="fdl-af-hdr">
            <span class="fdl-af-hdr-t">Letzte Aktivität</span>
            <button class="fdl-af-lnk" onclick="window.__fdlNav.goArchiv()">Alle anzeigen</button>
          </div>
          ${actRows}
        </div>
      </div>
      <div class="fdl-dr">
        <div class="fdl-wg">
          <div class="fdl-wg-h">
            <span class="fdl-wg-t">Aufgaben ${s.openTasks > 0 ? `<span class="fdl-nav-badge ${s.overdueTasks > 0 ? 'amber' : ''}">${s.openTasks}</span>` : ''}</span>
            <button class="fdl-wg-l" onclick="window.__fdlNav.goTasks()">Alle</button>
          </div>
          ${taskRows}
        </div>
        <div class="fdl-wg">
          <div class="fdl-wg-h">
            <span class="fdl-wg-t">Posteingang</span>
            <button class="fdl-wg-l" onclick="window.__fdlNav.goAblage()">Öffnen</button>
          </div>
          ${inboxHtml}
        </div>
        <div class="fdl-wg">
          <div class="fdl-wg-h"><span class="fdl-wg-t">Beträge ${s.thisYear}</span></div>
          ${barHtml}
        </div>
      </div>
    </div>`;
}

/* ─────────────────────────────── INBOX ─────────────────────────────────── */
async function buildInbox() {
  try {
    const root = window.scopeRootHandle;
    if (!root) return '<div class="fdl-empty" style="font-size:12px;padding:14px">Scopevisio nicht verbunden</div>';

    const inbox = await root.getDirectoryHandle('Inbox', { create: false }).catch(() => null);
    if (!inbox) return '<div class="fdl-empty" style="font-size:12px;padding:14px">Inbox nicht gefunden</div>';

    const files = [];
    for await (const e of inbox.values()) {
      if (e.kind === 'file' && e.name.toLowerCase().endsWith('.pdf')) files.push(e.name);
    }

    if (!files.length) return '<div class="fdl-empty" style="font-size:12px;padding:14px">Inbox ist leer</div>';

    return files.slice(0, 5).map(n => `
      <div class="fdl-ib" onclick="window.__fdlNav.loadInboxFile('${encodeURIComponent(n)}')">
        <div class="fdl-ib-ic">PDF</div>
        <div class="fdl-ib-n" title="${n}">${n.replace(/\.pdf$/i, '')}</div>
      </div>`).join('') +
      (files.length > 5 ? `<div style="padding:7px 16px;font-size:11px;color:var(--muted)">+${files.length - 5} weitere</div>` : '');
  } catch {
    return '<div class="fdl-empty" style="font-size:12px;padding:14px">Inbox nicht verfügbar</div>';
  }
}

/* ─────────────────────────────── BADGE ─────────────────────────────────── */
async function refreshBadge() {
  const tasks = await idbGetAll('fidelior_addon_v1', 'tasks');
  const open = tasks.filter(t => t.status !== 'done');
  const badge = document.getElementById('fdl-nav-tasks-badge');
  if (!badge) return;

  if (open.length) {
    badge.textContent = open.length;
    badge.style.display = 'inline-flex';
    const hasOverdue = open.some(t => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10));
    badge.className = 'fdl-nav-badge' + (hasOverdue ? ' amber' : '');
  } else {
    badge.style.display = 'none';
  }
}

/* ─────────────────────────────── PUBLIC API ────────────────────────────── */
window.__fdlNav = {
  goAblage() {
    activateTab('ablage');
  },

  goArchiv() {
    activateTab('archiv');
  },

  goTasks() {
    window.fdlTasksOpen?.() || document.getElementById('fdl-btn-tasks')?.click();
  },

  goArchivCategory(category) {
    if (typeof window.fdlArchivOpen === 'function') {
      window.fdlArchivOpen({
        scopeCategory: category,
        sortOrder: 'date-desc'
      });
    }
  },

  goArchivObj(code) {
    if (window.__fdlPro?.goArchivObj) {
      window.__fdlPro.goArchivObj(code);
      return;
    }
    const scopeCategory = window.fdlDeriveCategory ? window.fdlDeriveCategory(code) : 'Objekte';
    window.fdlArchivOpen?.({ obj: code, code, scopeCategory, sortOrder: 'date-desc' });
  },

  openActivity(encoded) {
    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(encoded));
    } catch {
      payload = { fileName: decodeURIComponent(encoded) };
    }

    if (window.__fdlPro?.openIndexedDoc) {
      window.__fdlPro.openIndexedDoc({
        objectCode: payload.objectCode || '',
        docType: payload.docType || '',
        fileName: payload.fileName || ''
      });
      return;
    }

    const name = payload.fileName || '';
    const scopeCategory = window.fdlDeriveCategory ? window.fdlDeriveCategory(payload.objectCode || '') : '';
    window.fdlArchivOpen?.({
      obj: payload.objectCode || '',
      code: payload.objectCode || '',
      scopeCategory: scopeCategory || '',
      selectName: name,
      query: name.replace(/\.pdf$/i, '').slice(0, 50),
      sortOrder: 'date-desc'
    });
  },

  loadInboxFile(encoded) {
    this.goAblage();
    setTimeout(() => {
      const name = decodeURIComponent(encoded);
      document.querySelectorAll('#inboxList .inbox-item').forEach(el => {
        if (el.textContent.trim().includes(name.slice(0, 20))) el.click();
      });
    }, 250);
  },

  refreshDash(forceArchive = false) {
    if (forceArchive) invalidateArchiveCache();
    if (_tab === 'dash') renderDash();
  },
};

/* ─────────────────────────────── HOOKS ─────────────────────────────────── */
const _prev = window.fdlOnFileSaved;
window.fdlOnFileSaved = function(data) {
  try { _prev?.(data); } catch {}
  invalidateArchiveCache();
  setTimeout(() => {
    refreshBadge();
    if (_tab === 'dash') renderDash();
  }, 900);
};

/* ─────────────────────────────── ARCHIV CLOSE WATCHER ─────────────────── */
function watchArchiv() {
  const av3 = document.getElementById('fdl-av3');
  if (!av3) {
    setTimeout(watchArchiv, 600);
    return;
  }

  new MutationObserver(() => {
    if (!av3.classList.contains('open') && _tab === 'archiv') {
      document.querySelectorAll('.fdl-nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'ablage'));
      _tab = 'ablage';
    }
  }).observe(av3, { attributes: true, attributeFilter: ['class'] });
}

/* ─────────────────────────────── REDUNDANT BUTTONS ────────────────────── */
function hideRedundant() {
  ['fdl-av3-btn', 'fdl-btn-dash', 'fdl-idx-search-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

/* ─────────────────────────────── SHORTCUTS ─────────────────────────────── */
function attachShortcuts() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '1') activateTab('dash');
    if (e.key === '2') activateTab('ablage');
    if (e.key === '3') activateTab('archiv');
    if (e.key === '4') activateTab('tasks');
    if (e.key === 'd' || e.key === 'D') {
      e.stopImmediatePropagation();
      activateTab('dash');
    }
  }, true);
}

/* ─────────────────────────────── INIT ──────────────────────────────────── */
function init() {
  injectCSS();
  buildNav();
  buildDash();
  activateTab('dash');
  refreshBadge();
  attachShortcuts();
  setTimeout(hideRedundant, 700);
  setTimeout(watchArchiv, 900);
  setInterval(refreshBadge, 30000);
  console.info('[FideliorNav v1.1] bereit — Dashboard nutzt primär echte Archivdaten');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();