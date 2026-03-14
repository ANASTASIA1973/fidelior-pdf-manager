
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

/* ─────────────────────────────── NL-PARSER ─────────────────────────────── */
function parseQuery(q) {
  const lower = q.toLowerCase().trim();
  const chips = [];  // { label, removable }
  const filter = { raw: q };

  // Objekte aus objectSelect
  const sel = document.getElementById('objectSelect');
  const objCodes = sel ? Array.from(sel.options).filter(o=>o.value).map(o=>o.value.toLowerCase()) : [];
  for (const code of objCodes) {
    if (lower.includes(code.toLowerCase())) {
      filter.objectCode = code.toUpperCase();
      chips.push({ label: `Objekt: ${filter.objectCode}`, type:'obj' });
      break;
    }
  }

  // Jahres-Erkennung
  const ym = lower.match(/\b(20\d{2})\b/);
  if (ym) {
    filter.year = ym[1];
    chips.push({ label: `Jahr: ${ym[1]}`, type:'year' });
  }

  // Monats-Erkennung
  const MONTHS = {januar:1,februar:2,märz:3,maerz:3,april:4,mai:5,juni:6,juli:7,august:8,september:9,oktober:10,november:11,dezember:12};
  for (const [name, num] of Object.entries(MONTHS)) {
    if (lower.includes(name)) {
      filter.month = String(num).padStart(2,'0');
      chips.push({ label: name.charAt(0).toUpperCase()+name.slice(1), type:'month' });
      break;
    }
  }

  // Betrag-Operatoren
  const gtM = lower.match(/über\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (gtM) { filter.amountGt = parseFloat(gtM[1].replace(',','.')); chips.push({label:`> ${fmtEuro(filter.amountGt)}`, type:'amt'}); }
  const ltM = lower.match(/unter\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (ltM) { filter.amountLt = parseFloat(ltM[1].replace(',','.')); chips.push({label:`< ${fmtEuro(filter.amountLt)}`, type:'amt'}); }

  // Dokumenttyp
  const TYPES = { rechnung:'rechnung', rechnungen:'rechnung', gutschrift:'gutschrift', vertrag:'vertrag', angebot:'angebot', sonstiges:'sonstiges', dokument:'dokument', dokumente:'dokument' };
  for (const [kw, key] of Object.entries(TYPES)) {
    if (lower.includes(kw)) { filter.docType = key; chips.push({label:key.charAt(0).toUpperCase()+key.slice(1), type:'type'}); break; }
  }

  // Absender nach "von"
  const smatch = lower.match(/\bvon\s+([a-zäöüß0-9&][a-zäöüß0-9&\-\.\s]{2,40})(?:\s+\d{4}|\s+im\b|\s*$)/i);
  if (smatch) { filter.sender = smatch[1].trim(); chips.push({label:`Von: ${filter.sender}`, type:'sender'}); }

  // Rest = Freitext
  let rest = q;
  [/\b20\d{2}\b/g, /\büber\s+\d[\d.,]*\s*(?:euro|€)?/gi, /\bunter\s+\d[\d.,]*\s*(?:euro|€)?/gi,
   /\bvon\s+\S.{1,40}/gi, /\b(Rechnungen?|Gutschriften?|Verträge?|Angebote?|Sonstiges|Dokumente?)\b/gi,
   /\b(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/gi,
  ].forEach(p => { rest = rest.replace(p,''); });
  // Objekt-Codes entfernen
  for (const code of objCodes) rest = rest.replace(new RegExp('\\b'+code+'\\b','gi'),'');
  rest = rest.trim().replace(/\s{2,}/g,' ');
  if (rest.length > 1) { filter.text = rest; chips.push({label:`"${rest}"`, type:'text'}); }

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

/* Chips */
.fdl-srch-chips{
  display:flex;gap:5px;flex-wrap:wrap;padding:8px 18px 0;
  min-height:0;transition:all .15s;
}
.fdl-srch-chips:empty{display:none}
.fdl-srch-chip{
  display:inline-flex;align-items:center;gap:4px;
  font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:20px;
  border:1px solid transparent;
}
.fdl-srch-chip.obj   {background:#F5EEF8;color:#5B1B70;border-color:#E8D5F5}
.fdl-srch-chip.year  {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.month {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.amt   {background:#D1FAE5;color:#065F46;border-color:#A7F3D0}
.fdl-srch-chip.type  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}
.fdl-srch-chip.sender{background:#FEF3C7;color:#92400E;border-color:#FDE68A}
.fdl-srch-chip.text  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}

/* Meta */
.fdl-srch-meta{
  padding:5px 18px 6px;font-size:11px;color:#9CA3AF;
  border-bottom:1px solid #F9FAFB;display:flex;align-items:center;justify-content:space-between;
}

/* Results */
.fdl-srch-results{flex:1;overflow-y:auto}
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
  _chips.innerHTML = chips.map(c =>
    `<span class="fdl-srch-chip ${c.type}">${c.label}</span>`
  ).join('');
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
