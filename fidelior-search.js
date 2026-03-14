
/* ==========================================================================
   Fidelior Search  v1.0  —  Volltext-Suche mit natürlicher Sprache
   ==========================================================================
   Erweitert das Suche-UI aus fidelior-index.js um:
   - Token-basiertes NL-Parsing mit Vorschlag-Chips
   - Ergebnis-Preview mit Volltexttreffern (highlights)
   - Filter-Sidebar (Objekt, Jahr, Typ, Betrag, Sammlung)
   - Tastaturnavigation (↑↓ Enter Escape)
   - Letzte Suchen (localStorage)
   Hängt sich an window.__fdlIdx.search() an.
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
      const q = db.transaction(store,'readonly').objectStore(store).getAll();
      q.onsuccess = e2 => res(e2.target.result||[]);
      q.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  });
}

/* ─────────────────────────────── FMT ───────────────────────────────────── */
const fmtDate = iso => {
  try {
    if (!iso) return '—';
    const value = typeof iso === 'number' ? iso : String(iso);
    const d = typeof value === 'number' || /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
    return isNaN(d) ? '—' : d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
  } catch { return '—'; }
};
const fmtEuro = n => !n ? '' : n.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';

/* ─────────────────────────────── HISTORY ───────────────────────────────── */
const HIST_KEY = 'fdl_search_history';
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)||'[]'); } catch { return []; }
}
function addHistory(q) {
  if (!q.trim()) return;
  try {
    let h = getHistory().filter(x => x !== q);
    h.unshift(q);
    h = h.slice(0,8);
    localStorage.setItem(HIST_KEY, JSON.stringify(h));
  } catch {}
}


const SEARCH_MONTH_MAP = {januar:'01',februar:'02',märz:'03',maerz:'03',april:'04',mai:'05',juni:'06',juli:'07',august:'08',september:'09',oktober:'10',november:'11',dezember:'12'};
const SEARCH_CATEGORY_KEYWORDS = {
  Privat: ['privat','private','persönlich','persoenlich'],
  Fidelior: ['fidelior'],
  Objekte: ['objekt','objekte','liegenschaft','liegenschaften','immobilie','immobilien']
};
function normalizeSearchValue(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[ä]/g,'ae').replace(/[ö]/g,'oe').replace(/[ü]/g,'ue').replace(/[ß]/g,'ss')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function tokenizeSearchValue(v) {
  return normalizeSearchValue(v).split(' ').filter(Boolean);
}

/* ─────────────────────────────── NL-PARSER ─────────────────────────────── */
function parseQuery(q) {
  const raw = String(q || '').trim();
  const lower = raw.toLowerCase();
  const normalized = normalizeSearchValue(lower);
  const chips = [];
  const filter = { raw };

  const sel = document.getElementById('objectSelect');
  const objOptions = sel ? Array.from(sel.options).filter(o => o.value).map(o => ({ code: o.value, name: o.textContent || '' })) : [];
for (const obj of objOptions) {
  const codeNorm = normalizeSearchValue(obj.code);
  const nameNorm = normalizeSearchValue(obj.name);
  const firstWords = nameNorm.split(' ').slice(0, 2).join(' ');
  const hasCode = codeNorm && new RegExp(`(^|\\s)${codeNorm}(\\s|$)`, 'i').test(normalized);
  const hasName = firstWords && new RegExp(`(^|\\s)${firstWords.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(\\s|$)`, 'i').test(normalized);

  if (hasCode || hasName) {
    filter.objectCode = obj.code.toUpperCase();
    chips.push({ label: `Objekt: ${filter.objectCode}`, type:'obj' });
    break;
  }
}

  const ym = lower.match(/\b(20\d{2})\b/);
  if (ym) {
    filter.year = ym[1];
    chips.push({ label: `Jahr: ${ym[1]}`, type:'year' });
  }

  for (const [name, num] of Object.entries(SEARCH_MONTH_MAP)) {
    if (normalized.includes(normalizeSearchValue(name))) {
      filter.month = num;
      chips.push({ label: name.charAt(0).toUpperCase()+name.slice(1), type:'month' });
      break;
    }
  }

  const gtM = lower.match(/\b(?:ueber|über|ab|mehr als|mindestens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (gtM) {
    filter.amountGt = parseFloat(gtM[1].replace(',','.'));
    chips.push({label:`> ${fmtEuro(filter.amountGt)}`, type:'amt'});
  }
  const ltM = lower.match(/\b(?:unter|bis|maximal|hoechstens|höchstens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (ltM) {
    filter.amountLt = parseFloat(ltM[1].replace(',','.'));
    chips.push({label:`< ${fmtEuro(filter.amountLt)}`, type:'amt'});
  }
const bareAmount = lower.match(/\b(\d{2,6}(?:[.,]\d{1,2})?)\s*(?:euro|€)?\b/i);
if (bareAmount && filter.amountGt === undefined && filter.amountLt === undefined) {
  filter.amountEq = parseFloat(bareAmount[1].replace(',','.'));
  chips.push({label:`≈ ${fmtEuro(filter.amountEq)}`, type:'amt'});
}
  const TYPES = { rechnung:'rechnung', rechnungen:'rechnung', eingangsrechnung:'rechnung', gutschrift:'gutschrift', vertrag:'vertrag', verträge:'vertrag', vertraege:'vertrag', angebot:'angebot', angebote:'angebot', dokument:'dokument', dokumente:'dokument' };
  for (const [kw, key] of Object.entries(TYPES)) {
    if (normalized.includes(normalizeSearchValue(kw))) { filter.docType = key; chips.push({label:key.charAt(0).toUpperCase()+key.slice(1), type:'type'}); break; }
  }

  const smatch = lower.match(/\b(?:von|bei)\s+([a-zäöüß0-9&][a-zäöüß0-9&\-.\s]{1,40}?)(?:\s+\d{4}|\s+(?:im|in|aus|über|ueber)\b|\s*$)/i);
  if (smatch) {
    filter.sender = smatch[1].trim();
    chips.push({label:`Von: ${filter.sender}`, type:'sender'});
  }

  for (const [category, words] of Object.entries(SEARCH_CATEGORY_KEYWORDS)) {
    if (words.some(word => normalized.includes(normalizeSearchValue(word)))) {
      filter.category = category;
      chips.push({label:`Kategorie: ${category}`, type:'cat'});
      break;
    }
  }

  let rest = raw;
 [
  /\b20\d{2}\b/g,
  /\b(?:ueber|über|ab|mehr als|mindestens|unter|bis|maximal|hoechstens|höchstens)\s+\d[\d.,]*\s*(?:euro|€)?/gi,
  /\b\d{2,6}(?:[.,]\d{1,2})?\s*(?:euro|€)?\b/gi,
  /\b(?:von|bei)\s+[a-zäöüß0-9&][a-zäöüß0-9&\-.\s]{1,40}/gi,
  /\b(Rechnungen?|Eingangsrechnungen?|Gutschriften?|Verträge?|Vertraege?|Angebote?|Dokumente?)\b/gi,
  /\b(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/gi,
  /\b(?:privat|persönlich|persoenlich|fidelior|objekte|objekt|liegenschaft|liegenschaften|immobilie|immobilien)\b/gi,
].forEach(p => { rest = rest.replace(p,' '); });
  for (const obj of objOptions) rest = rest.replace(new RegExp('\\b'+obj.code+'\\b','gi'),' ');
  rest = rest.replace(/\s{2,}/g,' ').trim();
  if (rest.length > 1) {
    filter.text = rest;
    filter.textTokens = tokenizeSearchValue(rest);
    chips.push({label:`"${rest}"`, type:'text'});
  } else {
    filter.text = '';
    filter.textTokens = [];
  }

  return { filter, chips };
}

/* ─────────────────────────────── HIGHLIGHT ─────────────────────────────── */
function highlightText(text, query) {
  if (!text || !query) return text || '';
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let out = text.slice(0, 200);
  for (const w of words) {
    const re = new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
    out = out.replace(re, '<mark style="background:#FDE68A;border-radius:2px;padding:0 1px">$1</mark>');
  }
  return out;
}

function normalizeSearchDoc(d, source) {
  return {
    source,
    id: d.id,
    fileName: d.fileName || d.name || '',
    objectCode: d.objectCode || '',
    objectName: d.objectName || '',
    category: d.category || '',
    docType: d.docType || '',
    amount: d.amount || 0,
    amountRaw: d.amountRaw || '',
    invoiceDate: d.invoiceDate || '',
    savedAt: d.savedAt || '',
    modified: d.modified || 0,
    sender: d.sender || '',
    senderNorm: d.senderNorm || (d.sender || '').toLowerCase(),
    ocrText: d.ocrText || '',
    serviceDesc: d.serviceDesc || '',
    keywords: d.keywords || [],
    year: d.year || '',
   subfolder: d.subfolder || '',
invoiceNo: d.invoiceNo || '',
selectName: d.selectName || d.fileName || d.name || '',
archiveRef: d.archiveRef || null
  };
}

function dedupeDocs(docs) {
  const seen = new Map();
  for (const d of docs) {
    const key = [
      d.objectCode || '',
      d.fileName || '',
      d.invoiceDate || '',
      d.modified || '',
      d.amount || ''
    ].join('||');

    if (!seen.has(key)) {
      seen.set(key, d);
      continue;
    }

    const prev = seen.get(key);
    if (prev.source === 'index' && d.source === 'archive') continue;
    if (prev.source === 'archive' && d.source === 'index') {
      seen.set(key, { ...d, archiveRef: prev.archiveRef || d.archiveRef, modified: prev.modified || d.modified });
    }
  }
  return [...seen.values()];
}

function sortMergedResults(results) {
  return [...results].sort((a, b) => {
    const as = Number(a.searchScore || a.score || 0);
    const bs = Number(b.searchScore || b.score || 0);
    if (bs !== as) return bs - as;
    const ad = a.invoiceDate || a.savedAt || a.modified || 0;
    const bd = b.invoiceDate || b.savedAt || b.modified || 0;
    const ats = typeof ad === 'number' ? ad : Date.parse(ad) || 0;
    const bts = typeof bd === 'number' ? bd : Date.parse(bd) || 0;
    return bts - ats;
  });
}

/* ─────────────────────────────── SEARCH CORE ───────────────────────────── */
async function runSearch(filter, opts = {}) {
  let idxResults = { results: [], total: 0, filter };
  let archResults = { results: [], total: 0, filter };

  try {
    if (window.__fdlIdx?.search) {
      idxResults = await window.__fdlIdx.search(filter, opts);
    } else {
      const docs = await idbGetAll('fidelior_index_v1','documents');
      const tf = filter;
      const results = docs.filter(d => {
        if (tf.objectCode && d.objectCode !== tf.objectCode) return false;
        if (tf.year && d.year !== tf.year) return false;
        if (tf.month && d.invoiceDate && !d.invoiceDate.slice(5,7).startsWith(tf.month)) return false;
        if (tf.amountGt !== undefined && d.amount <= tf.amountGt) return false;
        if (tf.amountLt !== undefined && d.amount >= tf.amountLt) return false;
        if (tf.amountEq !== undefined) {
  const amt = Number(d.amount || 0);
  if (!amt || Math.abs(amt - tf.amountEq) > 0.01) return false;
}
        if (tf.docType && d.docType !== tf.docType) return false;
        if (tf.sender && !(d.senderNorm||'').includes(tf.sender.toLowerCase())) return false;
        if (tf.text) {
          const h = [d.fileName,d.sender,d.ocrText,d.serviceDesc,...(d.keywords||[])].join(' ').toLowerCase();
          if (!h.includes(tf.text.toLowerCase())) return false;
        }
        return true;
      });
      results.sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
      idxResults = { results: results.slice(0, opts.limit||100), total: results.length, filter };
    }
  } catch (e) {
    console.warn('[FideliorSearch] Index-Suche fehlgeschlagen:', e);
  }

  try {
    if (typeof window.fdlArchivSearch === 'function') {
      archResults = await window.fdlArchivSearch(filter, { limit: opts.limit || 100, maxAgeMs: 30000 });
    }
  } catch (e) {
    console.warn('[FideliorSearch] Archiv-Suche fehlgeschlagen:', e);
  }

  const merged = dedupeDocs([
    ...(idxResults.results || []).map(d => normalizeSearchDoc(d, 'index')),
    ...(archResults.results || []).map(d => normalizeSearchDoc(d, 'archive'))
  ]);

  const sorted = sortMergedResults(merged);
  return {
    results: sorted.slice(0, opts.limit || 100),
    total: sorted.length,
    filter
  };
}

/* ─────────────────────────────── CSS ───────────────────────────────────── */
function injectCSS() {
  if (document.getElementById('fdl-srch-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-srch-css';
  s.textContent = `
#fdl-srch-overlay{
  position:fixed;inset:0;z-index:9500;
  background:rgba(0,0,0,.5);backdrop-filter:blur(4px);
  display:none;align-items:flex-start;justify-content:center;
  padding:60px 20px 20px;
}
#fdl-srch-overlay.open{display:flex;animation:fdl-srop .18s ease}
@keyframes fdl-srop{from{opacity:0}to{opacity:1}}

.fdl-srch-box{
  background:#fff;border-radius:16px;
  width:100%;max-width:680px;max-height:82vh;
  display:flex;flex-direction:column;
  box-shadow:0 24px 64px rgba(0,0,0,.22);overflow:hidden;
}

.fdl-srch-input-row{
  display:flex;align-items:center;gap:10px;padding:14px 18px;
  border-bottom:1px solid #F3F4F6;
}
.fdl-srch-icon{font-size:15px;color:#9CA3AF;flex-shrink:0}
.fdl-srch-input{
  flex:1;border:none;outline:none;font-size:15px;color:#111827;
  font-family:inherit;background:transparent;min-width:0;
}
.fdl-srch-input::placeholder{color:#C0C0C8}
.fdl-srch-close{
  width:28px;height:28px;border:none;border-radius:7px;
  background:#F3F4F6;cursor:pointer;color:#6B7280;font-size:13px;flex-shrink:0;
}
.fdl-srch-close:hover{background:#E5E7EB}

/* Meta */
.fdl-srch-meta{
  padding:6px 18px 8px;
  font-size:11px;
  color:#9CA3AF;
  border-bottom:1px solid #F9FAFB;
  display:flex;
  align-items:center;
  justify-content:space-between;
  position:sticky;
  top:48px;
  z-index:3;
  background:#fff;
  margin-top:2px;
  overflow:visible;
}
.fdl-srch-chips{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  padding:8px 18px 8px;
  min-height:34px;
  overflow:visible;
  align-items:center;
  position:sticky;
  top:0;
  background:#fff;
  z-index:4;
  flex-shrink:0;
}


.fdl-srch-chips:empty{display:none}
.fdl-srch-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:11.5px;
  font-weight:600;
  padding:3px 9px;
  border-radius:20px;
  border:1px solid transparent;
  cursor:pointer;
  appearance:none;
  background-clip:padding-box;
}
.fdl-srch-chip:hover{
  filter:brightness(.98);
}
.fdl-srch-chip-x{
  font-size:12px;
  line-height:1;
  opacity:.7;
}
.fdl-srch-chip.obj   {background:#F5EEF8;color:#5B1B70;border-color:#E8D5F5}
.fdl-srch-chip.year  {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.month {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.amt   {background:#D1FAE5;color:#065F46;border-color:#A7F3D0}
.fdl-srch-chip.type  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}
.fdl-srch-chip.sender{background:#FEF3C7;color:#92400E;border-color:#FDE68A}
.fdl-srch-chip.text  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}
.fdl-srch-chip.cat   {background:#E0F2FE;color:#075985;border-color:#BAE6FD}


/* Results */
.fdl-srch-results{
  flex:1;
  overflow-y:auto;
  min-height:0;
  scrollbar-gutter:stable;
}
.fdl-srch-result{
  display:flex;align-items:flex-start;gap:12px;padding:12px 18px;
  border-bottom:1px solid #F9FAFB;cursor:pointer;transition:background .1s;
}
.fdl-srch-result:last-child{border-bottom:none}
.fdl-srch-result:hover,.fdl-srch-result.selected{background:#FAF5FB}
.fdl-srch-result-thumb{
  width:34px;height:42px;border-radius:5px;flex-shrink:0;
  background:#FEE2E2;border:1px solid #FECACA;
  display:flex;align-items:center;justify-content:center;
  font-size:8px;font-weight:800;color:#DC2626;
}
.fdl-srch-result-name{
  font-size:12.5px;font-weight:600;color:#111827;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:460px;
}
.fdl-srch-result-snip{
  font-size:11.5px;color:#6B7280;margin-top:3px;line-height:1.5;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:460px;
}
.fdl-srch-result-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.fdl-srch-rc{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}
.fdl-srch-rc.o{background:#F5EEF8;color:#5B1B70}
.fdl-srch-rc.a{background:#D1FAE5;color:#065F46}
.fdl-srch-rc.t{background:#F3F4F6;color:#374151}
.fdl-srch-result-date{font-size:11px;color:#9CA3AF;white-space:nowrap;margin-left:auto;flex-shrink:0}

/* Empty/Loading/History */
.fdl-srch-empty{padding:36px;text-align:center;color:#9CA3AF;font-size:13px}
.fdl-srch-sect{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#C0C0C8;padding:10px 18px 4px}
.fdl-srch-hist{
  display:flex;align-items:center;gap:8px;padding:9px 18px;
  cursor:pointer;color:#6B7280;font-size:13px;transition:background .1s;
}
.fdl-srch-hist:hover{background:#FAF5FB;color:#5B1B70}

/* Footer */
.fdl-srch-footer{
  padding:8px 18px;border-top:1px solid #F3F4F6;
  display:flex;gap:16px;font-size:11px;color:#9CA3AF;
  background:#FAFAFA;flex-shrink:0;
}
.fdl-srch-footer span{display:flex;align-items:center;gap:4px}
.fdl-srch-kbdtag{
  background:#F3F4F6;border:1px solid #E5E7EB;border-radius:4px;
  padding:1px 5px;font-size:10px;color:#6B7280;
}
  `;
  document.head.appendChild(s);
}

/* ─────────────────────────────── UI BUILD ───────────────────────────────── */
let _overlay, _input, _chips, _results, _meta;
let _debounce, _selIdx = -1, _lastResults = [];

function build() {
  if (document.getElementById('fdl-srch-overlay')) return;
  injectCSS();

  _overlay = document.createElement('div');
  _overlay.id = 'fdl-srch-overlay';
  _overlay.innerHTML = `
    <div class="fdl-srch-box" id="fdl-srch-box">
      <div class="fdl-srch-input-row">
        <span class="fdl-srch-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>
        <input class="fdl-srch-input" id="fdl-srch-input" type="search" autocomplete="off" spellcheck="false"
               placeholder="Suche: Rechnungen von Zinnikus EGYO 2026…">
        <button class="fdl-srch-close" id="fdl-srch-close" title="Schließen (Esc)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="fdl-srch-chips" id="fdl-srch-chips"></div>
      <div class="fdl-srch-meta" id="fdl-srch-meta" style="display:none"></div>
      <div class="fdl-srch-results" id="fdl-srch-results">
        <div class="fdl-srch-empty">Suchbegriff eingeben oder aus Verlauf auswählen</div>
      </div>
      <div class="fdl-srch-footer">
        <span><span class="fdl-srch-kbdtag">↑↓</span> Navigation</span>
        <span><span class="fdl-srch-kbdtag">Enter</span> Öffnen</span>
        <span><span class="fdl-srch-kbdtag">Esc</span> Schließen</span>
        <span style="margin-left:auto"><span class="fdl-srch-kbdtag">Ctrl+K</span> Suche</span>
      </div>
    </div>`;
  document.body.appendChild(_overlay);

  _input   = document.getElementById('fdl-srch-input');
  _chips   = document.getElementById('fdl-srch-chips');
  _results = document.getElementById('fdl-srch-results');
  _meta    = document.getElementById('fdl-srch-meta');

  _overlay.addEventListener('click', e => { if (e.target === _overlay) close(); });
  document.getElementById('fdl-srch-close').addEventListener('click', close);
  _input.addEventListener('input', onInput);
  _input.addEventListener('keydown', onKeyDown);

  // Ctrl+K global
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); toggle(); }
    if (e.key === 'Escape' && _overlay.classList.contains('open')) close();
  });
}

function open() {
  build();
  _overlay.classList.add('open');
  setTimeout(() => _input.focus(), 40);
  if (!_input.value.trim()) showHistory();
}

function close() {
  _overlay?.classList.remove('open');
  _selIdx = -1;
}

function toggle() {
  if (_overlay?.classList.contains('open')) close(); else open();
}

function onInput(e) {
  clearTimeout(_debounce);
  const q = e.target.value;
  _selIdx = -1;

  if (!q.trim()) { _chips.innerHTML = ''; hideMeta(); showHistory(); return; }

  const { filter, chips } = parseQuery(q);
  renderChips(chips);

  _debounce = setTimeout(() => doSearch(filter, q), 200);
}

function onKeyDown(e) {
  const items = _results.querySelectorAll('.fdl-srch-result');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selIdx = Math.min(_selIdx+1, items.length-1);
    items.forEach((el,i) => el.classList.toggle('selected', i === _selIdx));
    if (items[_selIdx]) items[_selIdx].scrollIntoView({block:'nearest'});
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selIdx = Math.max(_selIdx-1, -1);
    items.forEach((el,i) => el.classList.toggle('selected', i === _selIdx));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_selIdx >= 0 && _lastResults[_selIdx]) {
      openResult(_lastResults[_selIdx]);
    } else if (_input.value.trim()) {
      addHistory(_input.value.trim());
    }
  }
}

function renderChips(chips) {
  _chips.innerHTML = chips.map((c, i) =>
    `<button type="button" class="fdl-srch-chip ${c.type}" data-chip-idx="${i}" title="Filter entfernen">
      <span>${c.label}</span>
      <span class="fdl-srch-chip-x" aria-hidden="true">×</span>
    </button>`
  ).join('');

  _chips.querySelectorAll('[data-chip-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-chip-idx'));
      removeChipAt(idx);
    });
  });
}
function removeChipAt(idx) {
  const q = String(_input?.value || '').trim();
  if (!q) return;

  const { chips } = parseQuery(q);
  const chip = chips[idx];
  if (!chip) return;

  let next = q;

  if (chip.type === 'obj') {
    next = next.replace(new RegExp(`\\b${chip.label.replace('Objekt: ','').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'i'), ' ');
  } else if (chip.type === 'year') {
    const year = chip.label.replace('Jahr: ','').trim();
    next = next.replace(new RegExp(`\\b${year}\\b`, 'i'), ' ');
  } else if (chip.type === 'month') {
    next = next.replace(new RegExp(`\\b${chip.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'i'), ' ');
  } else if (chip.type === 'amt') {
    const amountLabel = chip.label
      .replace(/[<>≈]/g, '')
      .replace(/\./g, '\\.')
      .replace(',', '[,.]')
      .replace(/\s*€?/, '')
      .trim();
    next = next.replace(new RegExp(`\\b(?:ueber|über|ab|mehr als|mindestens|unter|bis|maximal|hoechstens|höchstens)?\\s*${amountLabel}\\s*(?:euro|€)?\\b`, 'i'), ' ');
  } else if (chip.type === 'type') {
    next = next.replace(/\b(Rechnungen?|Eingangsrechnungen?|Gutschriften?|Verträge?|Vertraege?|Angebote?|Dokumente?)\b/i, ' ');
  } else if (chip.type === 'sender') {
    const sender = chip.label.replace(/^Von:\s*/i, '').trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    next = next.replace(new RegExp(`\\b(?:von|bei)\\s+${sender}\\b`, 'i'), ' ');
  } else if (chip.type === 'cat') {
    next = next.replace(/\b(?:privat|persönlich|persoenlich|fidelior|objekte|objekt|liegenschaft|liegenschaften|immobilie|immobilien)\b/i, ' ');
  } else if (chip.type === 'text') {
    const txt = chip.label.replace(/^"/, '').replace(/"$/, '').trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    next = next.replace(new RegExp(txt, 'i'), ' ');
  }

  next = next.replace(/\s{2,}/g, ' ').trim();
  _input.value = next;
  _input.dispatchEvent(new Event('input', { bubbles:true }));
}
function hideMeta() { _meta.style.display = 'none'; }
function showMeta(total, ms) {
  _meta.style.display = 'flex';
  _meta.innerHTML = `<span>${total} Dokument${total!==1?'e':''} gefunden</span><span>${ms}ms</span>`;
}

async function doSearch(filter, rawQuery) {
  _results.innerHTML = '<div class="fdl-srch-empty"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #E5E7EB;border-top-color:#5B1B70;animation:fdl-sp .6s linear infinite;vertical-align:middle;margin-right:6px"></span>Suche…</div>';
  const t0 = Date.now();
  try {
    const { results, total } = await runSearch(filter, { limit: 50 });
    const ms = Date.now() - t0;
    _lastResults = results;
    showMeta(total, ms);

    if (!results.length) {
      _results.innerHTML = `<div class="fdl-srch-empty">Keine Dokumente gefunden für „${rawQuery}"</div>`;
      return;
    }

    _results.innerHTML = results.map((d, i) => {
      const fn    = d.fileName || '';
      const short = fn.replace(/\.pdf$/i,'');
      const snip  = d.serviceDesc || (d.ocrText ? d.ocrText.slice(0,80).replace(/\n/g,' ') : '');
      const amt   = d.amount ? fmtEuro(d.amount) : '';
      return `<div class="fdl-srch-result ${i===_selIdx?'selected':''}"
                   data-idx="${i}" onclick="window.__fdlSrch.openIdx(${i})">
        <div class="fdl-srch-result-thumb">PDF</div>
        <div style="flex:1;min-width:0">
          <div class="fdl-srch-result-name" title="${fn}">${short}</div>
          ${snip ? `<div class="fdl-srch-result-snip">${highlightText(snip, filter.text||rawQuery)}</div>` : ''}
          <div class="fdl-srch-result-chips">
            ${d.objectCode?`<span class="fdl-srch-rc o">${d.objectCode}</span>`:''}
            ${amt?`<span class="fdl-srch-rc a">${amt}</span>`:''}
            ${d.docType?`<span class="fdl-srch-rc t">${d.docType}</span>`:''}
            ${d.invoiceNo?`<span class="fdl-srch-rc t">${d.invoiceNo}</span>`:''}
            ${d.source==='archive'?`<span class="fdl-srch-rc t">Archiv</span>`:''}
          </div>
        </div>
        <div class="fdl-srch-result-date">${fmtDate(d.invoiceDate||d.savedAt||d.modified)}</div>
      </div>`;
    }).join('');

  } catch(e) {
    _results.innerHTML = `<div class="fdl-srch-empty">Fehler: ${e.message}</div>`;
  }
}

function showHistory() {
  const hist = getHistory();
  if (!hist.length) {
    _results.innerHTML = '<div class="fdl-srch-empty">Suchbegriff eingeben</div>';
    hideMeta(); return;
  }
  hideMeta();
  _results.innerHTML = `<div class="fdl-srch-sect">Letzte Suchen</div>` +
    hist.map(h => `<div class="fdl-srch-hist" onclick="window.__fdlSrch.useHistory('${encodeURIComponent(h)}')">
      <span style="color:#C0C0C8;font-size:13px">↩</span> ${h}
    </div>`).join('');
}

function openResult(doc) {
  addHistory(_input.value.trim());
  close();
  if (window.__fdlPro?.openIndexedDoc && doc.source !== 'archive') {
    window.__fdlPro.openIndexedDoc(doc);
    return;
  }
  if (typeof window.fdlArchivOpen === 'function') {
    const derive = doc.archiveRef?.scopeCategory || (window.fdlDeriveCategory ? window.fdlDeriveCategory(doc.objectCode) : '');
    const typeFilter =
      doc.docType === 'Rechnung' || doc.docType === 'Rechnungen' ? 'Rechnungen' :
      doc.docType === 'Dokument' || doc.docType === 'Dokumente' ? 'Dokumente' :
      doc.docType === 'Abrechnungsbelege' ? 'Abrechnungsbelege' :
      'all';
    window.fdlArchivOpen({
      obj: doc.archiveRef?.code || doc.objectCode || '',
      code: doc.archiveRef?.code || doc.objectCode || '',
      scopeCategory: derive || '',
      typeFilter,
      selectName: doc.selectName || doc.fileName || '',
      query: (doc.fileName || '').replace(/\.pdf$/i, ''),
      sortOrder: 'date-desc'
    });
  }
}

/* ─────────────────────────────── PUBLIC ────────────────────────────────── */
window.__fdlSrch = {
  open, close, toggle,
  openIdx(i) { if (_lastResults[i]) openResult(_lastResults[i]); },
  useHistory(encoded) {
    const q = decodeURIComponent(encoded);
    _input.value = q;
    _input.dispatchEvent(new Event('input',{bubbles:true}));
  },
};

// Kompatibilität: fidelior-index.js verwendet window.__fdlIdx.openSearch — weiterleiten
const _prevIdx = window.__fdlIdx;
Object.defineProperty(window, '__fdlIdx', {
  get() { return _prevIdx; },
  set(v) {
    if (v && typeof v === 'object') {
      v.openSearch  = open;
      v.closeSearch = close;
    }
  },
  configurable: true,
});
// Falls __fdlIdx schon existiert, openSearch überschreiben
if (window.__fdlIdx) {
  window.__fdlIdx.openSearch  = open;
  window.__fdlIdx.closeSearch = close;
}

/* ─────────────────────────────── INIT ──────────────────────────────────── */
function init() {
  build();
  console.info('[FideliorSearch v1.0] bereit — Ctrl+K');
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
