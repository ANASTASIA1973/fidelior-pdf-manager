/* ==========================================================================
   Fidelior Search  v2.0  —  Volltext-Suche mit natürlicher Sprache
   ==========================================================================
   Ziele:
   - robuste natürliche Suche
   - klickbare Filter-Chips
   - kompatibel zu Fidelior Index + Archiv
   - bessere Ranking-Qualität
   - relative Zeiträume / Superlative / Limits
   - sauberes UI ohne Sticky-Überlagerungen

   Kompatibilität:
   - nutzt weiterhin window.__fdlIdx.search(filter, opts) wenn vorhanden
   - nutzt weiterhin window.fdlArchivSearch(filter, opts) wenn vorhanden
   - öffnet Dokumente weiterhin über window.__fdlPro.openIndexedDoc / window.fdlArchivOpen
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

/* ─────────────────────────────── FMT ───────────────────────────────────── */
const fmtDate = iso => {
  try {
    if (!iso) return '—';
    const value = typeof iso === 'number' ? iso : String(iso);
    const d = typeof value === 'number' || /^\d+$/.test(value)
      ? new Date(Number(value))
      : new Date(value);
    return isNaN(d)
      ? '—'
      : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '—';
  }
};

const fmtEuro = n => {
  const num = Number(n);
  if (!isFinite(num) || num === 0) return '';
  return num.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' €';
};

/* ─────────────────────────────── HISTORY ───────────────────────────────── */
const HIST_KEY = 'fdl_search_history';

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
  catch { return []; }
}

function addHistory(q) {
  const clean = String(q || '').trim();
  if (!clean) return;
  try {
    let h = getHistory().filter(x => x !== clean);
    h.unshift(clean);
    h = h.slice(0, 10);
    localStorage.setItem(HIST_KEY, JSON.stringify(h));
  } catch {}
}

/* ─────────────────────────────── NORMALIZE ─────────────────────────────── */
const SEARCH_MONTH_MAP = {
  januar: '01', februar: '02', märz: '03', maerz: '03', april: '04', mai: '05', juni: '06',
  juli: '07', august: '08', september: '09', oktober: '10', november: '11', dezember: '12'
};

const SEARCH_CATEGORY_KEYWORDS = {
  Privat: ['privat', 'private', 'persönlich', 'persoenlich'],
  Fidelior: ['fidelior'],
  Objekte: ['objekt', 'objekte', 'liegenschaft', 'liegenschaften', 'immobilie', 'immobilien']
};

const SEARCH_STOPWORDS = new Set([
  'alle', 'welche', 'welcher', 'welches', 'zeige', 'zeig', 'mir', 'bitte',
  'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen',
  'und', 'oder', 'mit', 'von', 'bei', 'im', 'in', 'am', 'an', 'für', 'fuer',
  'zum', 'zur', 'aus', 'auf', 'über', 'ueber', 'unter', 'bis', 'ab',
  'habe', 'hab', 'gibt', 'gib', 'finde', 'find', 'suche',
  'dokument', 'dokumente', 'pdf', 'pdfs'
]);

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

function tokenizeSearchValue(v, keepStopwords = false) {
  const arr = normalizeSearchValue(v).split(' ').filter(Boolean);
  return keepStopwords ? arr : arr.filter(t => !SEARCH_STOPWORDS.has(t));
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toTs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const ts = Date.parse(String(value));
  return isNaN(ts) ? 0 : ts;
}

function dateToIso(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function quarterRange(baseDate) {
  const month = baseDate.getMonth();
  const qStartMonth = Math.floor(month / 3) * 3;
  const from = new Date(baseDate.getFullYear(), qStartMonth, 1);
  const to = new Date(baseDate.getFullYear(), qStartMonth + 3, 0);
  return { from: dateToIso(from), to: dateToIso(to) };
}

function halfYearRange(baseDate, halfNumber) {
  const from = new Date(baseDate.getFullYear(), halfNumber === 1 ? 0 : 6, 1);
  const to = new Date(baseDate.getFullYear(), halfNumber === 1 ? 6 : 12, 0);
  return { from: dateToIso(from), to: dateToIso(to) };
}

function buildDateRangeChipLabel(from, to) {
  if (!from && !to) return '';
  if (from && to) return `${fmtDate(from)} – ${fmtDate(to)}`;
  if (from) return `ab ${fmtDate(from)}`;
  return `bis ${fmtDate(to)}`;
}

function getObjectOptions() {
  const sel = document.getElementById('objectSelect');
  return sel
    ? Array.from(sel.options)
        .filter(o => o.value)
        .map(o => ({ code: String(o.value || '').toUpperCase(), name: o.textContent || '' }))
    : [];
}

function getTypeAliases() {
  return {
    rechnung: 'rechnung',
    rechnungen: 'rechnung',
    eingangsrechnung: 'rechnung',
    eingangsrechnungen: 'rechnung',
    gutschrift: 'gutschrift',
    gutschriften: 'gutschrift',
    vertrag: 'vertrag',
    verträge: 'vertrag',
    vertraege: 'vertrag',
    vertragen: 'vertrag',
    angebot: 'angebot',
    angebote: 'angebot',
    dokument: 'dokument',
    dokumente: 'dokument',
    pdf: 'pdf',
    pdfs: 'pdf'
  };
}

/* ─────────────────────────────── PARSER ────────────────────────────────── */
function parseQuery(q) {
  const raw = String(q || '').trim();
  const lower = raw.toLowerCase();
  const normalized = normalizeSearchValue(lower);
  const normTokens = tokenizeSearchValue(lower, true);
  const textTokensRaw = tokenizeSearchValue(lower, false);

  const filter = {
    raw,
    text: '',
    textTokens: [],
    senderCandidate: '',
    limit: null,
    sortBy: '',
    sortDir: ''
  };
  const chips = [];

  const now = new Date();
  const objOptions = getObjectOptions();

  /* Objekt */
  for (const obj of objOptions) {
    const codeNorm = normalizeSearchValue(obj.code);
    const nameNorm = normalizeSearchValue(obj.name);
    const firstWords = nameNorm.split(' ').slice(0, 2).join(' ');
    const hasCode = codeNorm && new RegExp(`(^|\\s)${escapeRegExp(codeNorm)}(\\s|$)`, 'i').test(normalized);
    const hasName = firstWords && new RegExp(`(^|\\s)${escapeRegExp(firstWords)}(\\s|$)`, 'i').test(normalized);

    if (hasCode || hasName) {
      filter.objectCode = obj.code.toUpperCase();
      chips.push({ label: `Objekt: ${filter.objectCode}`, type: 'obj', key: 'objectCode' });
      break;
    }
  }

  /* Jahr */
  const ym = lower.match(/\b(20\d{2})\b/);
  if (ym) {
    filter.year = ym[1];
    chips.push({ label: `Jahr: ${ym[1]}`, type: 'year', key: 'year' });
  }

  /* Monat */
  for (const [name, num] of Object.entries(SEARCH_MONTH_MAP)) {
    if (normalized.includes(normalizeSearchValue(name))) {
      filter.month = num;
      chips.push({ label: name.charAt(0).toUpperCase() + name.slice(1), type: 'month', key: 'month' });
      break;
    }
  }

  /* Relative Zeiträume */
  if (/\bdieses jahr\b/i.test(lower)) {
    filter.year = String(now.getFullYear());
    if (!chips.some(c => c.key === 'year')) {
      chips.push({ label: `Jahr: ${filter.year}`, type: 'year', key: 'year' });
    }
  } else if (/\bletztes jahr\b/i.test(lower)) {
    filter.year = String(now.getFullYear() - 1);
    if (!chips.some(c => c.key === 'year')) {
      chips.push({ label: `Jahr: ${filter.year}`, type: 'year', key: 'year' });
    }
  }

  if (/\bdieser monat\b/i.test(lower)) {
    const from = startOfMonth(now);
    const to = endOfMonth(now);
    filter.dateFrom = dateToIso(from);
    filter.dateTo = dateToIso(to);
    chips.push({ label: buildDateRangeChipLabel(filter.dateFrom, filter.dateTo), type: 'date', key: 'dateRange' });
  } else if (/\bletzter monat\b/i.test(lower)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    filter.dateFrom = dateToIso(startOfMonth(d));
    filter.dateTo = dateToIso(endOfMonth(d));
    chips.push({ label: buildDateRangeChipLabel(filter.dateFrom, filter.dateTo), type: 'date', key: 'dateRange' });
  } else if (/\bvorletzter monat\b/i.test(lower)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    filter.dateFrom = dateToIso(startOfMonth(d));
    filter.dateTo = dateToIso(endOfMonth(d));
    chips.push({ label: buildDateRangeChipLabel(filter.dateFrom, filter.dateTo), type: 'date', key: 'dateRange' });
  }

  const qAbs = lower.match(/\bq([1-4])\s*(20\d{2})?\b/i);
  if (qAbs) {
    const qNo = Number(qAbs[1]);
    const year = Number(qAbs[2] || now.getFullYear());
    const from = new Date(year, (qNo - 1) * 3, 1);
    const to = new Date(year, qNo * 3, 0);
    filter.dateFrom = dateToIso(from);
    filter.dateTo = dateToIso(to);
    chips.push({ label: `Q${qNo} ${year}`, type: 'date', key: 'dateRange' });
  } else if (/\bdieses quartal\b/i.test(lower)) {
    const qr = quarterRange(now);
    filter.dateFrom = qr.from;
    filter.dateTo = qr.to;
    chips.push({ label: 'Dieses Quartal', type: 'date', key: 'dateRange' });
  }

  if (/\berstes halbjahr\b/i.test(lower)) {
    const hr = halfYearRange(now, 1);
    filter.dateFrom = hr.from;
    filter.dateTo = hr.to;
    chips.push({ label: 'Erstes Halbjahr', type: 'date', key: 'dateRange' });
  } else if (/\bzweites halbjahr\b/i.test(lower)) {
    const hr = halfYearRange(now, 2);
    filter.dateFrom = hr.from;
    filter.dateTo = hr.to;
    chips.push({ label: 'Zweites Halbjahr', type: 'date', key: 'dateRange' });
  }

  /* Betrag */
  const gtM = lower.match(/\b(?:ueber|über|ab|mehr als|mindestens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (gtM) {
    filter.amountGt = parseFloat(gtM[1].replace(',', '.'));
    chips.push({ label: `> ${fmtEuro(filter.amountGt)}`, type: 'amt', key: 'amountGt' });
  }

  const ltM = lower.match(/\b(?:unter|bis|maximal|hoechstens|höchstens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (ltM) {
    filter.amountLt = parseFloat(ltM[1].replace(',', '.'));
    chips.push({ label: `< ${fmtEuro(filter.amountLt)}`, type: 'amt', key: 'amountLt' });
  }

  const bareAmount = lower.match(/\b(\d{2,6}(?:[.,]\d{1,2})?)\s*(?:euro|€)?\b/i);
  if (
    bareAmount &&
    filter.amountGt === undefined &&
    filter.amountLt === undefined &&
    !filter.year &&
    !/\bq[1-4]\b/i.test(lower)
  ) {
    const num = parseFloat(bareAmount[1].replace(',', '.'));
    if (isFinite(num) && num <= 999999) {
      filter.amountEq = num;
      chips.push({ label: `≈ ${fmtEuro(filter.amountEq)}`, type: 'amt', key: 'amountEq' });
    }
  }

  /* Typ */
  const TYPES = getTypeAliases();
  for (const [kw, key] of Object.entries(TYPES)) {
    if (normalized.includes(normalizeSearchValue(kw))) {
      if (key !== 'pdf') {
        filter.docType = key;
        chips.push({ label: key.charAt(0).toUpperCase() + key.slice(1), type: 'type', key: 'docType' });
      } else {
        filter.fileType = 'pdf';
        chips.push({ label: 'PDF', type: 'type', key: 'fileType' });
      }
      break;
    }
  }

  /* Sender explizit */
  const smatch = lower.match(/\b(?:von|bei)\s+([a-zäöüß0-9&][a-zäöüß0-9&\-.\s]{1,50}?)(?:\s+\d{4}|\s+(?:im|in|aus|über|ueber|unter|bis|ab)\b|\s*$)/i);
  if (smatch) {
    filter.sender = smatch[1].trim();
    chips.push({ label: `Von: ${filter.sender}`, type: 'sender', key: 'sender' });
  }

  /* Kategorie */
  for (const [category, words] of Object.entries(SEARCH_CATEGORY_KEYWORDS)) {
    if (words.some(word => normalized.includes(normalizeSearchValue(word)))) {
      filter.category = category;
      chips.push({ label: `Kategorie: ${category}`, type: 'cat', key: 'category' });
      break;
    }
  }

  /* Limits */
  const explicitLimit = lower.match(/\b(?:top|die|den|der|das)?\s*(\d{1,2})\s+(?:neueste[nr]?|älteste[nr]?|groesste[nr]?|größte[nr]?|hoechste[nr]?|höchste[nr]?|vertraege|verträge|rechnungen|dokumente|angebote)\b/i);
  if (explicitLimit) {
    filter.limit = Math.max(1, Math.min(50, Number(explicitLimit[1])));
    chips.push({ label: `Limit: ${filter.limit}`, type: 'limit', key: 'limit' });
  }

  /* Superlative / Sortierung */
if (/\b(?:hoechst\w*|höchst\w*|groesst\w*|größt\w*)\b/i.test(lower)) {
  filter.sortBy = 'amount';
  filter.sortDir = 'desc';
  if (!filter.limit) filter.limit = 1;
  chips.push({ label: 'Betrag ↓', type: 'sort', key: 'sort' });
  if (!chips.some(c => c.key === 'limit')) chips.push({ label: `Limit: ${filter.limit}`, type: 'limit', key: 'limit' });
} else if (/\b(?:kleinst\w*|niedrigst\w*)\b/i.test(lower)) {
  filter.sortBy = 'amount';
  filter.sortDir = 'asc';
  if (!filter.limit) filter.limit = 1;
  chips.push({ label: 'Betrag ↑', type: 'sort', key: 'sort' });
  if (!chips.some(c => c.key === 'limit')) chips.push({ label: `Limit: ${filter.limit}`, type: 'limit', key: 'limit' });
} else if (/\b(?:neuest\w*|letzt\w*)\b/i.test(lower)) {
  filter.sortBy = 'date';
  filter.sortDir = 'desc';
  if (!filter.limit) filter.limit = 1;
  chips.push({ label: 'Datum ↓', type: 'sort', key: 'sort' });
  if (!chips.some(c => c.key === 'limit')) chips.push({ label: `Limit: ${filter.limit}`, type: 'limit', key: 'limit' });
} else if (/\b(?:ältest\w*|aeltest\w*|erst\w*)\b/i.test(lower)) {
  filter.sortBy = 'date';
  filter.sortDir = 'asc';
  if (!filter.limit) filter.limit = 1;
  chips.push({ label: 'Datum ↑', type: 'sort', key: 'sort' });
  if (!chips.some(c => c.key === 'limit')) chips.push({ label: `Limit: ${filter.limit}`, type: 'limit', key: 'limit' });
}

  /* Resttext bereinigen */
  let rest = raw;
[
  /\b20\d{2}\b/g,
  /\bq[1-4]\s*(?:20\d{2})?\b/gi,
  /\b(?:dieses jahr|letztes jahr|dieser monat|letzter monat|vorletzter monat|dieses quartal|erstes halbjahr|zweites halbjahr)\b/gi,
  /\b(?:ueber|über|ab|mehr als|mindestens|unter|bis|maximal|hoechstens|höchstens)\s+\d[\d.,]*\s*(?:euro|€)?/gi,
  /\b\d{2,6}(?:[.,]\d{1,2})?\s*(?:euro|€)?\b/gi,
  /\b(?:von|bei)\s+[a-zäöüß0-9&][a-zäöüß0-9&\-.\s]{1,50}/gi,
  /\b(Rechnungen?|Eingangsrechnungen?|Gutschriften?|Verträge?|Vertraege?|Angebote?|Dokumente?|PDFs?)\b/gi,
  /\b(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/gi,
  /\b(?:privat|persönlich|persoenlich|fidelior|objekte|objekt|liegenschaft|liegenschaften|immobilie|immobilien)\b/gi,
  /\b(?:hoechst\w*|höchst\w*|groesst\w*|größt\w*|kleinst\w*|niedrigst\w*|neuest\w*|letzt\w*|ältest\w*|aeltest\w*|erst\w*)\b/gi,
  /\b(?:top)\s+\d{1,2}\b/gi,
  /\b(?:welche|welcher|welches|zeige|zeig|mir|bitte|hat|haben|den|die|das|dem|des|ein|eine|einen)\b/gi,
  /\b(?:betrag|betraege|beträge)\b/gi
].forEach(p => { rest = rest.replace(p, ' '); });

  for (const obj of objOptions) {
    rest = rest.replace(new RegExp(`\\b${escapeRegExp(obj.code)}\\b`, 'gi'), ' ');
  }

  rest = rest.replace(/[€]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const restTokens = tokenizeSearchValue(rest, false);

  /* Sender-Heuristik ohne "von/bei" */
  if (!filter.sender) {
    const reserved = new Set([
      ...Object.keys(SEARCH_MONTH_MAP),
      ...Object.keys(getTypeAliases()),
      'jahr', 'monat', 'quartal', 'halbjahr', 'dieses', 'letztes', 'letzter', 'vorletzter',
      'unter', 'ueber', 'über', 'ab', 'bis', 'mehr', 'mindestens', 'maximal',
      'höchstens', 'hoechstens', 'top', 'neueste', 'letzte', 'älteste', 'erste',
      'groesste', 'größte', 'hoechste', 'höchste'
    ]);

    const senderCandidateTokens = restTokens.filter(t => {
      if (!t || reserved.has(t) || SEARCH_STOPWORDS.has(t)) return false;
      if (/^\d+$/.test(t)) return false;
      if (objOptions.some(o => normalizeSearchValue(o.code) === t)) return false;
      return true;
    });

    if (senderCandidateTokens.length === 1 && senderCandidateTokens[0].length >= 4) {
      filter.senderCandidate = senderCandidateTokens[0];
    } else if (senderCandidateTokens.length >= 2) {
      filter.senderCandidate = senderCandidateTokens.slice(0, 2).join(' ');
    }
  }

  if (rest.length > 1) {
    filter.text = rest;
    filter.textTokens = restTokens;
    chips.push({ label: `"${rest}"`, type: 'text', key: 'text' });
  } else {
    filter.text = '';
    filter.textTokens = [];
  }

  return { filter, chips };
}

/* ─────────────────────────────── HIGHLIGHT ─────────────────────────────── */
function highlightText(text, query) {
  if (!text || !query) return text || '';
  const words = tokenizeSearchValue(query, false).filter(w => w.length > 2).slice(0, 6);
  let out = String(text).slice(0, 220);

  for (const w of words) {
    const re = new RegExp(`(${escapeRegExp(w)})`, 'gi');
    out = out.replace(re, '<mark style="background:#FDE68A;border-radius:2px;padding:0 1px">$1</mark>');
  }

  return out;
}

/* ─────────────────────────────── NORMALIZE DOC ─────────────────────────── */
function normalizeSearchDoc(d, source) {
  return {
    source,
    id: d.id,
    fileName: d.fileName || d.name || '',
    objectCode: d.objectCode || '',
    objectName: d.objectName || '',
    category: d.category || '',
    docType: d.docType || '',
    amount: Number(d.amount || 0),
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
    archiveRef: d.archiveRef || null,
    searchScore: Number(d.searchScore || d.score || 0)
  };
}

/* ─────────────────────────────── MERGE / RANK ──────────────────────────── */
function dedupeDocs(docs) {
  const seen = new Map();

  for (const d of docs) {
    const key = [
      d.objectCode || '',
      d.fileName || '',
      d.invoiceDate || '',
      d.amount || '',
      d.invoiceNo || ''
    ].join('||');

    if (!seen.has(key)) {
      seen.set(key, d);
      continue;
    }

    const prev = seen.get(key);

    if (prev.source === 'index' && d.source === 'archive') {
      continue;
    }

    if (prev.source === 'archive' && d.source === 'index') {
      seen.set(key, {
        ...d,
        archiveRef: prev.archiveRef || d.archiveRef,
        modified: prev.modified || d.modified,
        searchScore: Math.max(Number(prev.searchScore || 0), Number(d.searchScore || 0))
      });
      continue;
    }

    if ((d.searchScore || 0) > (prev.searchScore || 0)) {
      seen.set(key, d);
    }
  }

  return [...seen.values()];
}

function computeClientBoost(doc, filter) {
  let score = Number(doc.searchScore || 0);
  const fileNameNorm = normalizeSearchValue(doc.fileName);
  const senderNorm = normalizeSearchValue(doc.senderNorm || doc.sender);
  const haystack = normalizeSearchValue([
    doc.fileName, doc.sender, doc.ocrText, doc.serviceDesc, doc.invoiceNo,
    ...(doc.keywords || [])
  ].join(' '));

  if (filter.sender) {
    const want = normalizeSearchValue(filter.sender);
    if (senderNorm === want) score += 220;
    else if (senderNorm.includes(want)) score += 150;
    else if (fileNameNorm.includes(want)) score += 110;
    else score -= 80;
  } else if (filter.senderCandidate) {
    const want = normalizeSearchValue(filter.senderCandidate);
    if (senderNorm === want) score += 120;
    else if (senderNorm.includes(want)) score += 85;
    else if (fileNameNorm.includes(want)) score += 60;
    else if (haystack.includes(want)) score += 28;
  }

if (filter.textTokens?.length) {
  let matched = 0;
  for (const token of filter.textTokens) {
    if (!token || token.length < 2) continue;
    if (haystack.includes(token)) {
      matched += 1;
      score += 22;
    }
  }

  if (!matched) return -1;

  const minNeeded = filter.textTokens.length >= 2 ? Math.ceil(filter.textTokens.length / 2) : 1;
  if (matched < minNeeded) return -1;

  if (matched === filter.textTokens.length) score += 36;
}

  if (filter.amountEq !== undefined) {
    const amt = Number(doc.amount || 0);
    if (amt && Math.abs(amt - filter.amountEq) <= 0.01) score += 90;
  }

  if (filter.fileType === 'pdf') score += 4;

  return score;
}

function applyClientFilters(results, filter) {
  return results.filter(d => {
    if (filter.objectCode && String(d.objectCode || '').toUpperCase() !== String(filter.objectCode).toUpperCase()) return false;
    if (filter.year && String(d.year || '') !== String(filter.year)) {
      if (!(d.invoiceDate || '').startsWith(String(filter.year))) return false;
    }

    if (filter.month) {
      const inv = String(d.invoiceDate || '');
      if (!inv || inv.slice(5, 7) !== String(filter.month).padStart(2, '0')) return false;
    }

    if (filter.dateFrom) {
      const inv = String(d.invoiceDate || '');
      if (!inv || inv < filter.dateFrom) return false;
    }
    if (filter.dateTo) {
      const inv = String(d.invoiceDate || '');
      if (!inv || inv > filter.dateTo) return false;
    }

    if (filter.amountGt !== undefined && !(Number(d.amount || 0) > Number(filter.amountGt))) return false;
    if (filter.amountLt !== undefined && !(Number(d.amount || 0) < Number(filter.amountLt))) return false;
    if (filter.amountEq !== undefined) {
      const amt = Number(d.amount || 0);
      if (!amt || Math.abs(amt - Number(filter.amountEq)) > 0.01) return false;
    }

    if (filter.docType) {
      const dt = normalizeSearchValue(d.docType || '');
      const want = normalizeSearchValue(filter.docType);
      if (!(dt === want || dt.includes(want) || (want === 'dokument' && dt.includes('vertrag')) || (want === 'vertrag' && dt.includes('dokument')))) {
        return false;
      }
    }

    if (filter.sender) {
      const want = normalizeSearchValue(filter.sender);
      const sender = normalizeSearchValue(d.senderNorm || d.sender);
      const fileNameNorm = normalizeSearchValue(d.fileName);
      if (!(sender.includes(want) || fileNameNorm.includes(want))) return false;
    }

    return true;
  });
}

function sortMergedResults(results, filter) {
  const list = [...results];

  if (filter.sortBy === 'amount') {
    list.sort((a, b) => {
      const av = Number(a.amount || 0);
      const bv = Number(b.amount || 0);
      return filter.sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }

  if (filter.sortBy === 'date') {
    list.sort((a, b) => {
      const av = toTs(a.invoiceDate || a.savedAt || a.modified);
      const bv = toTs(b.invoiceDate || b.savedAt || b.modified);
      return filter.sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }

  list.sort((a, b) => {
    const as = Number(a.searchScore || a.score || 0);
    const bs = Number(b.searchScore || b.score || 0);
    if (bs !== as) return bs - as;

    const ad = a.invoiceDate || a.savedAt || a.modified || 0;
    const bd = b.invoiceDate || b.savedAt || b.modified || 0;
    return toTs(bd) - toTs(ad);
  });

  return list;
}

/* ─────────────────────────────── SEARCH CORE ───────────────────────────── */
async function runSearch(filter, opts = {}) {
  let idxResults = { results: [], total: 0, filter };
  let archResults = { results: [], total: 0, filter };

  try {
    if (window.__fdlIdx?.search) {
      idxResults = await window.__fdlIdx.search(filter, { ...opts, limit: Math.max(opts.limit || 100, 100) });
    } else {
      const docs = await idbGetAll('fidelior_index_v1', 'documents');
      const tf = filter;

      let results = docs.filter(d => {
        if (tf.objectCode && d.objectCode !== tf.objectCode) return false;
        if (tf.year && d.year !== tf.year && !(d.invoiceDate || '').startsWith(tf.year)) return false;
        if (tf.month && d.invoiceDate && !String(d.invoiceDate).slice(5, 7).startsWith(tf.month)) return false;
        if (tf.dateFrom && (!d.invoiceDate || d.invoiceDate < tf.dateFrom)) return false;
        if (tf.dateTo && (!d.invoiceDate || d.invoiceDate > tf.dateTo)) return false;
        if (tf.amountGt !== undefined && Number(d.amount || 0) <= tf.amountGt) return false;
        if (tf.amountLt !== undefined && Number(d.amount || 0) >= tf.amountLt) return false;
        if (tf.amountEq !== undefined) {
          const amt = Number(d.amount || 0);
          if (!amt || Math.abs(amt - tf.amountEq) > 0.01) return false;
        }
        if (tf.docType && normalizeSearchValue(d.docType || '') !== normalizeSearchValue(tf.docType)) return false;
        if (tf.sender) {
          const senderWant = normalizeSearchValue(tf.sender);
          const sNorm = normalizeSearchValue(d.senderNorm || d.sender);
          const fileNameNorm = normalizeSearchValue(d.fileName);
          if (!(sNorm.includes(senderWant) || fileNameNorm.includes(senderWant))) return false;
        }
        if (tf.textTokens?.length) {
          const h = normalizeSearchValue([d.fileName, d.sender, d.ocrText, d.serviceDesc, ...(d.keywords || [])].join(' '));
          let matched = 0;
          for (const token of tf.textTokens) {
            if (token.length < 2) continue;
            if (h.includes(token)) matched++;
          }
          if (!matched) return false;
        }
        return true;
      });

      results = results.map(d => normalizeSearchDoc(d, 'index'));
      results = results.map(d => ({ ...d, searchScore: computeClientBoost(d, tf) }));
      results = sortMergedResults(results, tf);

      idxResults = { results, total: results.length, filter };
    }
  } catch (e) {
    console.warn('[FideliorSearch] Index-Suche fehlgeschlagen:', e);
  }

  try {
    if (typeof window.fdlArchivSearch === 'function') {
      archResults = await window.fdlArchivSearch(filter, {
        limit: Math.max(opts.limit || 100, 100),
        maxAgeMs: 30000
      });
    }
  } catch (e) {
    console.warn('[FideliorSearch] Archiv-Suche fehlgeschlagen:', e);
  }

  let merged = dedupeDocs([
    ...(idxResults.results || []).map(d => normalizeSearchDoc(d, 'index')),
    ...(archResults.results || []).map(d => normalizeSearchDoc(d, 'archive'))
  ]);

  merged = applyClientFilters(merged, filter);
  merged = merged.map(d => ({ ...d, searchScore: computeClientBoost(d, filter) }));
  merged = sortMergedResults(merged, filter);
const finalLimit = Math.max(1, Math.min(100, Number(filter.limit || opts.limit || 100)));
const visibleResults = merged.slice(0, finalLimit);

return {
  results: visibleResults,
  total: merged.length,
  visibleTotal: visibleResults.length,
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
  background:rgba(0,0,0,.50);backdrop-filter:blur(4px);
  display:none;align-items:flex-start;justify-content:center;
  padding:60px 20px 20px;
}
#fdl-srch-overlay.open{display:flex;animation:fdl-srop .16s ease}
@keyframes fdl-srop{from{opacity:0}to{opacity:1}}
@keyframes fdl-sp{from{transform:rotate(0)}to{transform:rotate(360deg)}}

.fdl-srch-box{
  background:#fff;border-radius:16px;
  width:100%;max-width:760px;max-height:84vh;
  display:flex;flex-direction:column;
  box-shadow:0 24px 64px rgba(0,0,0,.22);
  overflow:hidden;
}

.fdl-srch-input-row{
  display:flex;align-items:center;gap:10px;padding:14px 18px;
  border-bottom:1px solid #F3F4F6;flex-shrink:0;background:#fff;
}
.fdl-srch-icon{font-size:15px;color:#9CA3AF;flex-shrink:0}
.fdl-srch-input{
  flex:1;border:none;outline:none;font-size:15px;color:#111827;
  font-family:inherit;background:transparent;min-width:0;
}
.fdl-srch-input::placeholder{color:#C0C0C8}
.fdl-srch-close{
  width:30px;height:30px;border:none;border-radius:8px;
  background:#F3F4F6;cursor:pointer;color:#6B7280;font-size:13px;flex-shrink:0;
}
.fdl-srch-close:hover{background:#E5E7EB}

.fdl-srch-chips{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  padding:8px 18px 8px;
  min-height:0;
  overflow:visible;
  align-items:center;
  position:relative;
  background:#fff;
  z-index:1;
  flex-shrink:0;
}
.fdl-srch-chips:empty{display:none}

.fdl-srch-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:11.5px;
  font-weight:600;
  padding:4px 10px;
  border-radius:999px;
  border:1px solid transparent;
  cursor:pointer;
  appearance:none;
  background-clip:padding-box;
  font-family:inherit;
}
.fdl-srch-chip:hover{filter:brightness(.98)}
.fdl-srch-chip-x{
  font-size:12px;
  line-height:1;
  opacity:.72;
}
.fdl-srch-chip.obj   {background:#F5EEF8;color:#5B1B70;border-color:#E8D5F5}
.fdl-srch-chip.year  {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.month {background:#EFF6FF;color:#1E40AF;border-color:#BFDBFE}
.fdl-srch-chip.amt   {background:#D1FAE5;color:#065F46;border-color:#A7F3D0}
.fdl-srch-chip.type  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}
.fdl-srch-chip.sender{background:#FEF3C7;color:#92400E;border-color:#FDE68A}
.fdl-srch-chip.text  {background:#F3F4F6;color:#374151;border-color:#E5E7EB}
.fdl-srch-chip.cat   {background:#E0F2FE;color:#075985;border-color:#BAE6FD}
.fdl-srch-chip.date  {background:#FEF3C7;color:#92400E;border-color:#FDE68A}
.fdl-srch-chip.sort  {background:#EDE9FE;color:#5B21B6;border-color:#DDD6FE}
.fdl-srch-chip.limit {background:#ECFDF5;color:#065F46;border-color:#A7F3D0}

.fdl-srch-meta{
  padding:6px 18px 8px;
  font-size:11px;
  color:#9CA3AF;
  border-bottom:1px solid #F9FAFB;
  display:flex;
  align-items:center;
  justify-content:space-between;
  position:relative;
  z-index:1;
  background:#fff;
  overflow:visible;
  flex-shrink:0;
}

.fdl-srch-results{
  flex:1 1 auto;
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
  width:34px;height:42px;border-radius:6px;flex-shrink:0;
  background:#FEE2E2;border:1px solid #FECACA;
  display:flex;align-items:center;justify-content:center;
  font-size:8px;font-weight:800;color:#DC2626;
}

.fdl-srch-result-main{flex:1;min-width:0}
.fdl-srch-result-name{
  font-size:12.8px;font-weight:600;color:#111827;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px;
}
.fdl-srch-result-sub{
  font-size:11.5px;color:#6B7280;margin-top:2px;line-height:1.45;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px;
}
.fdl-srch-result-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}
.fdl-srch-rc{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}
.fdl-srch-rc.o{background:#F5EEF8;color:#5B1B70}
.fdl-srch-rc.a{background:#D1FAE5;color:#065F46}
.fdl-srch-rc.t{background:#F3F4F6;color:#374151}
.fdl-srch-rc.s{background:#FEF3C7;color:#92400E}
.fdl-srch-result-date{
  font-size:11px;color:#9CA3AF;white-space:nowrap;margin-left:auto;flex-shrink:0
}

.fdl-srch-empty{padding:36px;text-align:center;color:#9CA3AF;font-size:13px}
.fdl-srch-sect{
  font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:#C0C0C8;padding:10px 18px 4px
}
.fdl-srch-hist{
  display:flex;align-items:center;gap:8px;padding:10px 18px;
  cursor:pointer;color:#6B7280;font-size:13px;transition:background .1s;
}
.fdl-srch-hist:hover{background:#FAF5FB;color:#5B1B70}

.fdl-srch-footer{
  padding:8px 18px;border-top:1px solid #F3F4F6;
  display:flex;gap:16px;font-size:11px;color:#9CA3AF;
  background:#FAFAFA;flex-shrink:0;
}
.fdl-srch-footer span{display:flex;align-items:center;gap:4px}
.fdl-srch-kbdtag{
  background:#F3F4F6;border:1px solid #E5E7EB;border-radius:4px;
  padding:1px 5px;font-size:10px;color:#6B7280;
}`;
  document.head.appendChild(s);
}

/* ─────────────────────────────── UI BUILD ───────────────────────────────── */
let _overlay, _input, _chips, _results, _meta;
let _debounce = null;
let _selIdx = -1;
let _lastResults = [];
let _lastParsed = { filter: {}, chips: [] };

function build() {
  if (document.getElementById('fdl-srch-overlay')) return;
  injectCSS();

  _overlay = document.createElement('div');
  _overlay.id = 'fdl-srch-overlay';
  _overlay.innerHTML = `
    <div class="fdl-srch-box" id="fdl-srch-box">
      <div class="fdl-srch-input-row">
        <span class="fdl-srch-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
        </span>
        <input class="fdl-srch-input" id="fdl-srch-input" type="search" autocomplete="off" spellcheck="false"
               placeholder="Suche: Rechnungen von Zinnikus EGYO 2026…">
        <button class="fdl-srch-close" id="fdl-srch-close" title="Schließen (Esc)">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18M6 6l12 12"></path>
          </svg>
        </button>
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

  _input = document.getElementById('fdl-srch-input');
  _chips = document.getElementById('fdl-srch-chips');
  _results = document.getElementById('fdl-srch-results');
  _meta = document.getElementById('fdl-srch-meta');

  _overlay.addEventListener('click', e => {
    if (e.target === _overlay) close();
  });

  document.getElementById('fdl-srch-close').addEventListener('click', close);
  _input.addEventListener('input', onInput);
  _input.addEventListener('keydown', onKeyDown);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      toggle();
    }
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
  if (_overlay?.classList.contains('open')) close();
  else open();
}

/* ─────────────────────────────── INPUT / KEYS ──────────────────────────── */
function onInput(e) {
  clearTimeout(_debounce);
  const q = String(e.target.value || '');
  _selIdx = -1;

  if (!q.trim()) {
    _lastParsed = { filter: {}, chips: [] };
    _chips.innerHTML = '';
    hideMeta();
    showHistory();
    return;
  }

  const parsed = parseQuery(q);
  _lastParsed = parsed;
  renderChips(parsed.chips);

  _debounce = setTimeout(() => doSearch(parsed.filter, q), 170);
}

function onKeyDown(e) {
  const items = _results.querySelectorAll('.fdl-srch-result');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selIdx = Math.min(_selIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === _selIdx));
    if (items[_selIdx]) items[_selIdx].scrollIntoView({ block: 'nearest' });
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selIdx = Math.max(_selIdx - 1, -1);
    items.forEach((el, i) => el.classList.toggle('selected', i === _selIdx));
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    if (_selIdx >= 0 && _lastResults[_selIdx]) {
      openResult(_lastResults[_selIdx]);
    } else if (_input.value.trim()) {
      addHistory(_input.value.trim());
    }
  }
}

/* ─────────────────────────────── CHIPS ─────────────────────────────────── */
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

  const parsed = parseQuery(q);
  const chip = parsed.chips[idx];
  if (!chip) return;

  let next = q;

  switch (chip.type) {
    case 'obj': {
      const code = chip.label.replace('Objekt: ', '').trim();
      next = next.replace(new RegExp(`\\b${escapeRegExp(code)}\\b`, 'i'), ' ');
      break;
    }

    case 'year': {
      const year = chip.label.replace('Jahr: ', '').trim();
      next = next.replace(new RegExp(`\\b${escapeRegExp(year)}\\b`, 'i'), ' ');
      next = next.replace(/\b(?:dieses jahr|letztes jahr)\b/i, ' ');
      break;
    }

    case 'month': {
      next = next.replace(new RegExp(`\\b${escapeRegExp(chip.label)}\\b`, 'i'), ' ');
      break;
    }

    case 'date': {
      next = next
        .replace(/\b(?:dieser monat|letzter monat|vorletzter monat|dieses quartal|erstes halbjahr|zweites halbjahr)\b/i, ' ')
        .replace(/\bq[1-4]\s*(?:20\d{2})?\b/i, ' ');
      break;
    }

    case 'amt': {
      next = next.replace(/\b(?:ueber|über|ab|mehr als|mindestens|unter|bis|maximal|hoechstens|höchstens)?\s*\d[\d.,]*\s*(?:euro|€)?\b/i, ' ');
      break;
    }

    case 'type': {
      next = next.replace(/\b(?:Rechnungen?|Eingangsrechnungen?|Gutschriften?|Verträge?|Vertraege?|Angebote?|Dokumente?|PDFs?)\b/i, ' ');
      break;
    }

    case 'sender': {
      const sender = chip.label.replace(/^Von:\s*/i, '').trim();
      next = next.replace(new RegExp(`\\b(?:von|bei)\\s+${escapeRegExp(sender)}\\b`, 'i'), ' ');
      break;
    }

    case 'cat': {
      next = next.replace(/\b(?:privat|persönlich|persoenlich|fidelior|objekte|objekt|liegenschaft|liegenschaften|immobilie|immobilien)\b/i, ' ');
      break;
    }

    case 'sort': {
      next = next.replace(/\b(?:hoechste|höchste|groesste|größte|kleinste|niedrigste|neueste|letzte|älteste|erste)\b/i, ' ');
      break;
    }

    case 'limit': {
      next = next.replace(/\b(?:top\s+\d{1,2}|\d{1,2}\s+(?:neueste[nr]?|älteste[nr]?|groesste[nr]?|größte[nr]?|hoechste[nr]?|höchste[nr]?|vertraege|verträge|rechnungen|dokumente|angebote))\b/i, ' ');
      break;
    }

    case 'text': {
      const txt = chip.label.replace(/^"/, '').replace(/"$/, '').trim();
      next = next.replace(new RegExp(escapeRegExp(txt), 'i'), ' ');
      break;
    }
  }

  next = next.replace(/\s{2,}/g, ' ').trim();
  _input.value = next;
  _input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ─────────────────────────────── META ──────────────────────────────────── */
function hideMeta() {
  _meta.style.display = 'none';
}

function showMeta(total, ms) {
  _meta.style.display = 'flex';
  _meta.innerHTML = `<span>${total} Dokument${total !== 1 ? 'e' : ''} gefunden</span><span>${ms}ms</span>`;
}

/* ─────────────────────────────── SEARCH RUN ────────────────────────────── */
async function doSearch(filter, rawQuery) {
  _results.innerHTML = '<div class="fdl-srch-empty"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #E5E7EB;border-top-color:#5B1B70;animation:fdl-sp .6s linear infinite;vertical-align:middle;margin-right:6px"></span>Suche…</div>';

  const t0 = Date.now();

  try {
    const { results, total } = await runSearch(filter, { limit: 50 });
    const ms = Date.now() - t0;

    _lastResults = results;
    showMeta(total, ms);

    if (!results.length) {
      _results.innerHTML = `<div class="fdl-srch-empty">Keine Dokumente gefunden für „${rawQuery}“</div>`;
      return;
    }

    _results.innerHTML = results.map((d, i) => {
      const fn = d.fileName || '';
      const short = fn.replace(/\.pdf$/i, '');
      const snipSource = d.serviceDesc || d.ocrText || d.sender || '';
      const snip = String(snipSource || '').slice(0, 120).replace(/\n/g, ' ');
      const amt = d.amount ? fmtEuro(d.amount) : '';
      const docType = d.docType || '';
      const sender = d.sender || '';

      return `
        <div class="fdl-srch-result ${i === _selIdx ? 'selected' : ''}" data-idx="${i}" onclick="window.__fdlSrch.openIdx(${i})">
          <div class="fdl-srch-result-thumb">PDF</div>
          <div class="fdl-srch-result-main">
            <div class="fdl-srch-result-name" title="${fn.replace(/"/g, '&quot;')}">${short}</div>
            ${sender ? `<div class="fdl-srch-result-sub">${sender}</div>` : (snip ? `<div class="fdl-srch-result-sub">${highlightText(snip, filter.text || filter.senderCandidate || rawQuery)}</div>` : '')}
            <div class="fdl-srch-result-chips">
              ${d.objectCode ? `<span class="fdl-srch-rc o">${d.objectCode}</span>` : ''}
              ${amt ? `<span class="fdl-srch-rc a">${amt}</span>` : ''}
              ${docType ? `<span class="fdl-srch-rc t">${docType}</span>` : ''}
              ${d.invoiceNo ? `<span class="fdl-srch-rc t">${d.invoiceNo}</span>` : ''}
              ${d.source === 'archive' ? `<span class="fdl-srch-rc t">Archiv</span>` : ''}
              ${(d.searchScore || 0) > 0 && !filter.sortBy ? `<span class="fdl-srch-rc s">${Math.round(d.searchScore)}</span>` : ''}
            </div>
          </div>
          <div class="fdl-srch-result-date">${fmtDate(d.invoiceDate || d.savedAt || d.modified)}</div>
        </div>`;
    }).join('');

  } catch (e) {
    _results.innerHTML = `<div class="fdl-srch-empty">Fehler: ${e?.message || e}</div>`;
  }
}

/* ─────────────────────────────── HISTORY UI ────────────────────────────── */
function showHistory() {
  const hist = getHistory();

  if (!hist.length) {
    _results.innerHTML = '<div class="fdl-srch-empty">Suchbegriff eingeben</div>';
    hideMeta();
    return;
  }

  hideMeta();
  _results.innerHTML =
    `<div class="fdl-srch-sect">Letzte Suchen</div>` +
    hist.map(h => `
      <div class="fdl-srch-hist" onclick="window.__fdlSrch.useHistory('${encodeURIComponent(h)}')">
        <span style="color:#C0C0C8;font-size:13px">↩</span> ${h}
      </div>`
    ).join('');
}

/* ─────────────────────────────── OPEN RESULT ───────────────────────────── */
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
      sortOrder: filterSortToArchivOrder(_lastParsed?.filter)
    });
  }
}

function filterSortToArchivOrder(filter) {
  if (!filter || !filter.sortBy) return 'date-desc';
  if (filter.sortBy === 'date' && filter.sortDir === 'asc') return 'date-asc';
  if (filter.sortBy === 'date' && filter.sortDir === 'desc') return 'date-desc';
  return 'date-desc';
}

/* ─────────────────────────────── PUBLIC ────────────────────────────────── */
window.__fdlSrch = {
  open,
  close,
  toggle,
  openIdx(i) {
    if (_lastResults[i]) openResult(_lastResults[i]);
  },
  useHistory(encoded) {
    const q = decodeURIComponent(encoded);
    _input.value = q;
    _input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

/* ─────────────────────────────── BRIDGE ────────────────────────────────── */
const _prevIdx = window.__fdlIdx;

Object.defineProperty(window, '__fdlIdx', {
  get() { return _prevIdx; },
  set(v) {
    if (v && typeof v === 'object') {
      v.openSearch = open;
      v.closeSearch = close;
    }
  },
  configurable: true
});

if (window.__fdlIdx) {
  window.__fdlIdx.openSearch = open;
  window.__fdlIdx.closeSearch = close;
}

/* ─────────────────────────────── INIT ──────────────────────────────────── */
function init() {
  build();
  console.info('[FideliorSearch v2.0] bereit — Ctrl+K');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();