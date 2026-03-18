/* ==========================================================================
   Fidelior Core v1.0  —  SINGLE SOURCE OF TRUTH
   ==========================================================================
   - EIN zentraler Zugriff auf alle Dokumente
   - Nutzt NUR echtes Archiv (Scopevisio)
   - Einheitliches Datenmodell
   - Cache integriert
   ========================================================================== */

(() => {
'use strict';

const CACHE_MS = 45000;

let _cache = {
  ts: 0,
  docs: []
};

let _objectsMap = null;

/* ─────────────────────────────────────────────────────────────
   CONFIG LADEN
───────────────────────────────────────────────────────────── */
async function loadObjectsConfig() {
  if (_objectsMap) return _objectsMap;

  _objectsMap = {};

  try {
    const cfgDir = window.configDirHandle;
    if (!cfgDir) return _objectsMap;

    const fh = await cfgDir.getFileHandle('objects.json', { create: false });
    const file = await fh.getFile();
    const json = JSON.parse(await file.text());

    for (const obj of (json.objects || [])) {
      _objectsMap[obj.code] = obj;
    }
  } catch {}

  return _objectsMap;
}

function getScopeName(code) {
  return _objectsMap?.[code]?.scopevisioName || code;
}

/* ─────────────────────────────────────────────────────────────
   PFADLOGIK (unverändert übernommen)
───────────────────────────────────────────────────────────── */
function buildScanRoots(code) {
  const sn = getScopeName(code);

  if (code === 'FIDELIOR') return [
    { segs: ['FIDELIOR', 'Eingangsrechnungen'], type: 'Rechnung' },
    { segs: ['FIDELIOR', 'Dokumente'], type: 'Dokument' }
  ];

  if (code === 'PRIVAT') return [
    { segs: ['PRIVAT', 'Rechnungsbelege'], type: 'Rechnung' },
    { segs: ['PRIVAT', 'Dokumente'], type: 'Dokument' }
  ];

  if (code === 'ARNDTCIE' || sn === 'ARNDT & CIE') return [
    { segs: ['ARNDT & CIE', 'Eingangsrechnungen'], type: 'Rechnung' },
    { segs: ['ARNDT & CIE', 'Dokumente'], type: 'Dokument' }
  ];

  return [
    { segs: ['OBJEKTE', sn, 'Rechnungsbelege'], type: 'Rechnung' },
    { segs: ['OBJEKTE', sn, 'Objektdokumente'], type: 'Dokument' },
    { segs: ['OBJEKTE', sn, 'Abrechnungsbelege'], type: 'Rechnung' }
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

/* ─────────────────────────────────────────────────────────────
   PARSER (einheitlich!)
───────────────────────────────────────────────────────────── */
function parseName(name) {
  const stem = name.replace(/\.pdf$/i, '');
  const parts = stem.split('_');

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
    amount: betrag,
    sender: rest.join(' ').replace(/-/g, ' ').trim() || null,
    date: datum
  };
}

function extractYear(segs, modified) {
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^20\d{2}$/.test(segs[i])) return segs[i];
  }
  return modified ? String(new Date(modified).getFullYear()) : '';
}

function toISO(d) {
  if (!d) return '';
  const m = d.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/* ─────────────────────────────────────────────────────────────
   SCAN
───────────────────────────────────────────────────────────── */
async function scanPDFs(dir, basePath, depth, out, seen, objectCode) {
  if (!dir || depth < 0) return;

  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {

      const key = basePath.join('/') + '/' + entry.name;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const f = await entry.getFile();
        const meta = parseName(entry.name);

        out.push({
          id: key,
          fileName: entry.name,
          objectCode,
          objectName: getScopeName(objectCode),
          type: meta.amount ? 'Rechnung' : 'Dokument',
          amount: meta.amount,
          sender: meta.sender,
          date: meta.date,
          savedAt: toISO(meta.date) || new Date(f.lastModified).toISOString(),
          year: extractYear(basePath, f.lastModified),
          handle: entry,
          source: 'archive'
        });

      } catch {}

    } else if (entry.kind === 'directory' && depth > 0) {
      await scanPDFs(entry, [...basePath, entry.name], depth - 1, out, seen, objectCode);
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   MAIN LOADER
───────────────────────────────────────────────────────────── */
async function loadDocuments() {
  const root = window.scopeRootHandle;
  if (!root) return [];

  await loadObjectsConfig();

  const sel = document.getElementById('objectSelect');
  if (!sel) return [];

  const objects = Array.from(sel.options)
    .filter(o => o.value)
    .map(o => o.value);

  const all = [];
  const seen = new Set();

  for (const code of objects) {
    const roots = buildScanRoots(code);

    for (const { segs } of roots) {
      const dir = await navigateTo(root, segs);
      if (!dir) continue;

      await scanPDFs(dir, segs, 2, all, seen, code);
    }
  }

  all.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

  return all;
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────────────────────── */
async function getDocuments(force = false) {
  const now = Date.now();

  if (!force && _cache.docs.length && (now - _cache.ts) < CACHE_MS) {
    return _cache.docs;
  }

  const docs = await loadDocuments();

  _cache = {
    ts: now,
    docs
  };

  return docs;
}

function invalidate() {
  _cache = { ts: 0, docs: [] };
}

/* ─────────────────────────────────────────────────────────────
   EXPORT
───────────────────────────────────────────────────────────── */
window.FideliorCore = {
  getDocuments,
  invalidate
};

})();