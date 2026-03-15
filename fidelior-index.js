/* ==========================================================================
   Fidelior Index  v1.0  —  Persistenter Metadaten-Index & Intelligenz-Schicht
   ==========================================================================

   ZWECK:
   Zentraler Kern für alle KI-Features:
   - Persistenter DocumentRecord-Index (IndexedDB)
   - Volltext-Suche (OCR-Text + Metadaten)
   - Natürliche-Sprache-Anfragen
   - Sammlungen (virtuelle Tags)
   - Lernhistorie (Checkbox + Sammlungs-Vorschläge)
   - Konflikterkennung
   - Filing-Simulation Panel

   INTEGRATION:
   Ausschließlich über bestehende Hooks – KEIN Eingriff in app.js:
   - window.fdlOnFileSaved  → DocumentRecord anlegen
   - window.fdlKiOnOcr      → OCR-Text + Keywords nachpflegen
   - window.configDirHandle → objects.json lesen
   - window.scopeRootHandle → für Index-Reparatur-Scan
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   DATENBANK-SCHEMA
   ══════════════════════════════════════════════════════════════════════════ */

const DB_NAME    = 'fidelior_index_v1';
const DB_VERSION = 1;

// Stores
const S_DOCS        = 'documents';       // DocumentRecord
const S_COLLECTIONS = 'collections';     // CollectionRecord
const S_LEARN       = 'learn';           // LearnRecord (Lernhistorie)

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;

      /* ── documents ── */
      if (!db.objectStoreNames.contains(S_DOCS)) {
        const s = db.createObjectStore(S_DOCS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('fileName',    'fileName',    { unique: false });
        s.createIndex('objectCode',  'objectCode',  { unique: false });
        s.createIndex('sender',      'sender',      { unique: false });
        s.createIndex('invoiceDate', 'invoiceDate', { unique: false });
        s.createIndex('savedAt',     'savedAt',     { unique: false });
        s.createIndex('year',        'year',        { unique: false });
        s.createIndex('docType',     'docType',     { unique: false });
      }

      /* ── collections ── */
      if (!db.objectStoreNames.contains(S_COLLECTIONS)) {
        const c = db.createObjectStore(S_COLLECTIONS, { keyPath: 'id' });
        c.createIndex('name', 'name', { unique: true });
      }

      /* ── learn ── */
      if (!db.objectStoreNames.contains(S_LEARN)) {
        const l = db.createObjectStore(S_LEARN, { keyPath: 'id', autoIncrement: true });
        l.createIndex('senderKey',   'senderKey',   { unique: false });
        l.createIndex('objectCode',  'objectCode',  { unique: false });
        l.createIndex('checkboxId',  'checkboxId',  { unique: false });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbAdd(store, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).add(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbPut(store, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbGetAll(store, indexName, query) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const os  = tx.objectStore(store);
    const req = (indexName && query !== undefined)
      ? os.index(indexName).getAll(query)
      : os.getAll();
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbCount(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = e => res(e.target.result || 0);
    req.onerror   = () => res(0);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   DOKUMENTEN-RECORD STRUCTURE
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * DocumentRecord – wird pro abgelegtem Dokument gespeichert
 * @typedef {Object} DocumentRecord
 * @prop {number}   id           - auto-increment PK
 * @prop {string}   fileName     - z.B. 128,52_FIDELIOR_workingbits_2026.03.12.pdf
 * @prop {string}   objectCode   - FIDELIOR | EGYO | B75 …
 * @prop {string}   docType      - rechnung | dokument | vertrag | sonstiges …
 * @prop {number}   amount       - Legacy/Fallback-Betrag
 * @prop {string}   amountRaw    - "128,52"
 * @prop {number}   amountNet    - Netto
 * @prop {number}   amountVat    - MwSt
 * @prop {number}   amountGross  - Brutto/Gesamt
 * @prop {string}   invoiceDate  - ISO: 2026-03-12
 * @prop {string}   dueDate      - ISO: 2026-03-16
 * @prop {string}   savedAt      - ISO datetime
 * @prop {string}   sender       - KI-extrahierter oder manueller Absender
 * @prop {string}   senderNorm   - toLowerCase für Index
 * @prop {string}   title        - erkannter Dokumenttitel / Kurzbeschreibung
 * @prop {string[]} scopePath    - ['FIDELIOR','Eingangsrechnungen','2026']
 * @prop {string}   folderType   - Rechnungsbelege | Objektdokumente …
 * @prop {string}   year         - "2026"
 * @prop {string[]} collections  - virtuelle Sammlungs-IDs
 * @prop {string}   ocrText      - Volltext (erste 3 Seiten)
 * @prop {string[]} keywords     - auto-extrahiert
 * @prop {string}   serviceDesc  - Dienstleistungs-Beschreibung
 * @prop {string}   iban         - erkannte IBAN
 * @prop {string}   ustId        - erkannte USt-IdNr.
 * @prop {string}   email        - erkannte E-Mail
 * @prop {string[]} emailsFound  - alle erkannten E-Mails
 * @prop {string[]} ibansFound   - alle erkannten IBANs
 * @prop {string[]} targets      - Ablage-Ziele ['Scopevisio', 'pCloud']
 * @prop {string[]} emailsSent   - Empfänger-IDs wenn E-Mail versendet
 * @prop {string}   invoiceNo    - Rechnungsnummer
 * @prop {Object}   confidence   - einfache Feld-Sicherheiten
 */

function makeDocRecord(data, ocrData) {
  const amount = parseAmountFloat(data.amount);
  const sn     = (data.sender || data.senderRaw || '').trim();
  const date   = data.invoiceDate ? dispToISO(data.invoiceDate) : null;
  const year   = date ? date.slice(0, 4) : String(new Date().getFullYear());

  const ocrText = ocrData?.text || '';
  const inferredDocType = detectDocTypeFromText(ocrText, data.docType || '');
  const amountNet = Number(ocrData?.amountNet || 0) || 0;
  const amountVat = Number(ocrData?.amountVat || 0) || 0;
  const amountGross = Number(ocrData?.amountGross || 0) || amount || 0;
  const collections = detectCollectionsFromText(ocrText, sn, ocrData?.keywords || []);

  return {
    // Kernfelder aus fdlOnFileSaved
    fileName:    data.fileName    || '',
    objectCode:  data.objectCode  || '',
    docType:     inferredDocType,
    amount:      amountGross || amount,
    amountRaw:   data.amount      || '',
    amountNet,
    amountVat,
    amountGross,
    invoiceDate: date || '',
    savedAt:     new Date().toISOString(),
    sender:      sn,
    senderNorm:  sn.toLowerCase(),
    title:       ocrData?.title || ocrData?.serviceDesc || '',
    scopePath:   data.scopePath   || [],
    folderType:  data.folderType  || 'Rechnungsbelege',
    year,
    collections,
    targets:     data.targets     || [],
    emailsSent:  data.emailsSent  || [],
    invoiceNo:   data.invoiceNo   || ocrData?.invoiceNo || '',
    size:        data.size        || 0,

    // OCR-Felder
    ocrText,
    keywords:    ocrData?.keywords || [],
    serviceDesc: ocrData?.serviceDesc || '',
    iban:        ocrData?.iban    || '',
    ibansFound:  ocrData?.ibansFound || [],
    dueDate:     ocrData?.dueDate || '',
    ustId:       ocrData?.ustId || '',
    email:       ocrData?.email || '',
    emailsFound: ocrData?.emailsFound || [],

    confidence: {
      type:        inferredDocType ? 0.85 : 0,
      collections: collections.length ? 0.75 : 0,
      sender:      sn ? 0.9 : 0,
      amountGross: amountGross ? 0.85 : 0,
      invoiceDate: date ? 0.8 : 0,
      invoiceNo:   (data.invoiceNo || ocrData?.invoiceNo) ? 0.75 : 0
    }
  };
}


/* ══════════════════════════════════════════════════════════════════════════
   HILFSFUNKTIONEN
   ══════════════════════════════════════════════════════════════════════════ */

function parseAmountFloat(raw) {
  if (!raw) return 0;
  const s = String(raw).trim().replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function dispToISO(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtEuro(n) {
  if (!n && n !== 0) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function normSender(s) { return (s || '').toLowerCase().trim(); }

/* ══════════════════════════════════════════════════════════════════════════
   TEXT-ANALYSE
   ══════════════════════════════════════════════════════════════════════════ */

function extractKeywords(text) {
  if (!text) return [];
  // Entferne Zahlen, kurze Wörter, Stopwörter
  const STOP = new Set([
    'der','die','das','ein','eine','und','oder','mit','von','zu','an','in','aus',
    'für','bei','bis','nach','über','unter','auf','im','am','ist','sind','wird',
    'haben','hat','werden','kann','per','des','dem','den','zur','zum',
    'rechnungsdatum','rechnungsnummer','betrag','datum','seite','ihre','ihr','wir'
  ]);
  const words = text.toLowerCase()
    .replace(/[^a-zäöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP.has(w));

  // Häufigkeit
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 12)
    .map(([w]) => w);
}
function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  return [...new Set(matches.map(s => String(s).trim().toLowerCase()))].slice(0, 10);
}

function extractEmail(text) {
  return extractEmails(text)[0] || '';
}

function extractUstId(text) {
  if (!text) return '';
  const patterns = [
    /\b(?:USt-IdNr\.?|USt IdNr\.?|Umsatzsteuer-Identifikationsnummer|VAT ID)[:\s]*([A-Z]{2}[A-Z0-9]{8,14})\b/i,
    /\b(DE[0-9]{9})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return String(m[1] || '').replace(/\s/g, '');
  }
  return '';
}

function extractInvoiceNo(text) {
  if (!text) return '';
  const patterns = [
    /\b(?:Rechnungsnummer|Rechnung Nr\.?|Rechnung-Nr\.?|Invoice No\.?|Invoice Number|Belegnr\.?)[:\s#-]*([A-Z0-9\-\/]{2,40})\b/i,
    /\bNr\.?\s*([A-Z0-9\-\/]{2,20})\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return String(m[1] || '').trim();
  }
  return '';
}

function extractMoneyCandidates(text) {
  if (!text) return [];
  const matches = text.match(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g) || [];
  const values = matches
    .map(v => parseAmountFloat(v))
    .filter(v => isFinite(v) && v > 0);
  return [...new Set(values)].sort((a, b) => b - a);
}

function extractVatAmount(text) {
  if (!text) return 0;
  const patterns = [
    /\b(?:MwSt\.?|USt\.?|Mehrwertsteuer|VAT)[:\s]*([\d\.,]+)\b/i,
    /\b19%\s*[:\-]?\s*([\d\.,]+)\b/i,
    /\b7%\s*[:\-]?\s*([\d\.,]+)\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseAmountFloat(m[1]);
      if (n > 0) return n;
    }
  }
  return 0;
}

function extractNetAmount(text) {
  if (!text) return 0;
  const patterns = [
    /\b(?:Netto|Nettobetrag|Zwischensumme)[:\s]*([\d\.,]+)\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseAmountFloat(m[1]);
      if (n > 0) return n;
    }
  }
  return 0;
}

function extractGrossAmount(text) {
  if (!text) return 0;
  const patterns = [
    /\b(?:Gesamtbetrag|Rechnungsbetrag|Brutto|Bruttobetrag|Endbetrag|Zu zahlen|Zahlbetrag|Summe)[:\s]*([\d\.,]+)\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseAmountFloat(m[1]);
      if (n > 0) return n;
    }
  }
  const fallback = extractMoneyCandidates(text);
  return fallback[0] || 0;
}

function detectCollectionsFromText(text, sender, keywords) {
  const hay = [text || '', sender || '', ...(keywords || [])].join(' ').toLowerCase();

  const map = {
    steuererklarung: [
      'finanzamt', 'steuer', 'steuerberater', 'steuerberatung', 'elster', 'datev',
      'einkommensteuer', 'umsatzsteuer', 'gewerbesteuer', 'grundsteuer', 'bescheid',
      'zinniikus'
    ],
    betriebskosten: [
      'betriebskosten', 'nebenkosten', 'heizkosten', 'wasser', 'abwasser', 'müll',
      'hausmeister', 'schornsteinfeger', 'wartung', 'allgemeinstrom',
      'treppenhausreinigung'
    ]
  };

  const found = [];
  for (const [colId, terms] of Object.entries(map)) {
    if (terms.some(t => hay.includes(t))) found.push(colId);
  }
  return found;
}

function detectDocTypeFromText(text, fallbackType) {
  const hay = String(text || '').toLowerCase();

  const invoiceSignals = [
    'rechnung', 'invoice', 'rechnungsnummer', 'zahlbetrag', 'gesamtbetrag',
    'fälligkeit', 'netto', 'brutto', 'mwst', 'ust'
  ].filter(t => hay.includes(t)).length;

  if (invoiceSignals >= 2) return 'rechnung';
  if (fallbackType) return String(fallbackType).toLowerCase();
  return 'dokument';
}

function extractIBAN(text) {
  if (!text) return '';
  const m = text.match(/\b(DE\d{2}[\s]?[\d]{4}[\s]?[\d]{4}[\s]?[\d]{4}[\s]?[\d]{4}[\s]?[\d]{2})\b/);
  if (m) return m[1].replace(/\s/g, '');
  return '';
}

function extractDueDate(text) {
  if (!text) return '';
  const PATTERNS = [
    /(?:fällig(?:keit)?(?:sdatum)?|fälligkeit|zahlungsziel|zahlung\s+bis)[:\s]+(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/i,
    /(?:zu\s+zahlen\s+bis|bis\s+(?:spätestens)?)[:\s]+(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/i,
  ];
  for (const p of PATTERNS) {
    const m = text.match(p);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return '';
}

function extractServiceDesc(lines) {
  if (!lines || !lines.length) return '';
  // Suche nach "Leistung", "Betreff", "Beschreibung", "Re:" in ersten 20 Zeilen
  const KEYS = /^(leistung|betreff|beschreibung|re:|subject|bestellung|auftrag|für|service|lieferung)[\s:]+/i;
  for (const line of lines.slice(0, 20)) {
    if (KEYS.test(line.trim())) {
      const clean = line.trim().replace(KEYS, '').trim();
      if (clean.length > 5 && clean.length < 120) return clean;
    }
  }
  // Fallback: suche Zeile die "buchführung", "miete", "strom", "wartung" enthält
  const SERVICE_WORDS = /\b(buchführung|lohnbuch|miete|strom|gas|wasser|wartung|versicherung|reparatur|instandhaltung|hausgeld|nebenkosten)\b/i;
  for (const line of lines.slice(0, 30)) {
    const m = line.match(SERVICE_WORDS);
    if (m) return line.trim().slice(0, 100);
  }
  return '';
}

function analyzeOcrData(text, lines) {
  const safeText = (text || '').slice(0, 12000);
  const keywords = extractKeywords(safeText);
  const email = extractEmail(safeText);
  const emailsFound = extractEmails(safeText);
  const iban = extractIBAN(safeText);
  const ibansFound = iban ? [iban] : [];
  const dueDate = extractDueDate(safeText);
  const serviceDesc = extractServiceDesc(lines || []);
  const ustId = extractUstId(safeText);
  const invoiceNo = extractInvoiceNo(safeText);
  const amountNet = extractNetAmount(safeText);
  const amountVat = extractVatAmount(safeText);
  const amountGross = extractGrossAmount(safeText);

  return {
    text: safeText,
    keywords,
    iban,
    ibansFound,
    dueDate,
    serviceDesc,
    email,
    emailsFound,
    ustId,
    invoiceNo,
    amountNet,
    amountVat,
    amountGross,
    title: serviceDesc || '',
  };
}


/* ══════════════════════════════════════════════════════════════════════════
   LERNHISTORIE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Speichert eine Lern-Beobachtung nach dem Speichern.
 * LearnRecord: { senderKey, objectCode, checkboxId, collectionId, savedAt }
 */
async function recordLearning(docRecord, checkboxStates) {
  const senderKey = normSender(docRecord.sender);
  if (!senderKey) return;

  // Checkboxen die aktiv waren
  const activeBoxes = (checkboxStates || []).filter(c => c.checked).map(c => c.id);
  for (const boxId of activeBoxes) {
    await dbAdd(S_LEARN, {
      senderKey,
      objectCode:  docRecord.objectCode,
      checkboxId:  boxId,
      collectionId: null,
      savedAt:     docRecord.savedAt,
      type:        'checkbox',
    }).catch(() => {});
  }

  // Sammlungen die zugeordnet wurden
  for (const colId of (docRecord.collections || [])) {
    await dbAdd(S_LEARN, {
      senderKey,
      objectCode:  docRecord.objectCode,
      checkboxId:  null,
      collectionId: colId,
      savedAt:     docRecord.savedAt,
      type:        'collection',
    }).catch(() => {});
  }
}

/**
 * Berechnet Vorschläge für Checkboxen basierend auf Absender + Objekt.
 * Gibt zurück: [{ checkboxId, confidence, count, total }]
 */
async function suggestCheckboxes(senderRaw, objectCode) {
  const senderKey = normSender(senderRaw);
  if (!senderKey) return [];
  try {
    const all = await dbGetAll(S_LEARN, 'senderKey', senderKey);
    const recent = all
      .filter(r => r.type === 'checkbox' && r.objectCode === objectCode)
      .slice(-20); // letzte 20
    if (!recent.length) return [];

    const total = recent.length;
    const byCb  = {};
    for (const r of recent) {
      byCb[r.checkboxId] = (byCb[r.checkboxId] || 0) + 1;
    }
    return Object.entries(byCb)
      .map(([checkboxId, count]) => ({
        checkboxId,
        count,
        total,
        ratio:      count / total,
        confidence: count / total >= 0.7 ? 'high' : count / total >= 0.4 ? 'medium' : 'low',
      }))
      .filter(s => s.confidence !== 'low')
      .sort((a, b) => b.ratio - a.ratio);
  } catch { return []; }
}

/**
 * Berechnet Sammlungs-Vorschläge basierend auf Absender.
 */
async function suggestCollections(senderRaw) {
  const senderKey = normSender(senderRaw);
  if (!senderKey) return [];
  try {
    const all = await dbGetAll(S_LEARN, 'senderKey', senderKey);
    const recent = all.filter(r => r.type === 'collection').slice(-20);
    if (!recent.length) return [];

    const byColl = {};
    for (const r of recent) {
      if (r.collectionId) byColl[r.collectionId] = (byColl[r.collectionId] || 0) + 1;
    }
    return Object.entries(byColl)
      .map(([colId, count]) => ({ colId, count, confidence: count >= 3 ? 'high' : 'medium' }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   KONFLIKTERKENNUNG
   ══════════════════════════════════════════════════════════════════════════ */

async function detectConflicts(sender, objectCode, invoiceDateISO, year) {
  const conflicts = [];
  if (!sender) return conflicts;
  const senderNorm = normSender(sender);

  try {
    const all = await dbGetAll(S_DOCS);
    const senderDocs = all.filter(d => d.senderNorm === senderNorm).slice(-10);

    // 1) Objekt-Mismatch: Absender wurde zuletzt bei anderem Objekt abgelegt
    if (senderDocs.length >= 2) {
      const others = senderDocs.filter(d => d.objectCode !== objectCode);
      if (others.length >= 2) {
        conflicts.push({
          type:    'object-mismatch',
          level:   'warning',
          message: `Absender zuletzt bei ${others[others.length-1].objectCode} abgelegt (${others.length}× in letzten ${senderDocs.length} Dokumenten)`,
        });
      }
    }

    // 2) Jahres-Mismatch: Rechnungsdatum-Jahr ≠ Ziel-Jahr
    if (invoiceDateISO && year) {
      const docYear = invoiceDateISO.slice(0, 4);
      if (docYear && docYear !== String(year)) {
        conflicts.push({
          type:    'year-mismatch',
          level:   'warning',
          message: `Rechnungsdatum ${docYear} aber Zielordner ${year} – bitte prüfen`,
        });
      }
    }

    // 3) Absender normalerweise mit Sammlung – fehlt hier
    const collSuggestions = await suggestCollections(sender);
    for (const s of collSuggestions) {
      if (s.count >= 3 && s.confidence === 'high') {
        const col = await dbGet(S_COLLECTIONS, s.colId);
        if (col) {
          conflicts.push({
            type:    'missing-collection',
            level:   'info',
            message: `Sammlung „${col.name}" meist zugeordnet (${s.count}×)`,
            colId:   s.colId,
            colName: col.name,
          });
        }
      }
    }
  } catch (e) {
    console.warn('[FideliorIndex] Konfliktprüfung fehlgeschlagen:', e);
  }

  return conflicts;
}

/* ══════════════════════════════════════════════════════════════════════════
   VOLLTEXT-SUCHE
   ══════════════════════════════════════════════════════════════════════════ */

const IDX_MONTHS = { januar:'01', februar:'02', märz:'03', maerz:'03', april:'04', mai:'05', juni:'06', juli:'07', august:'08', september:'09', oktober:'10', november:'11', dezember:'12' };
const IDX_TOPIC_SYNONYMS = {
  handwerker: ['handwerker','reparatur','reparaturen','wartung','montage','elektriker','sanitaer','sanitär','hausmeister'],
  versicherung: ['versicherung','versicherungen','police','schaden','beitrag','haftpflicht','kasko'],
  telefon: ['telefon','telekom','vodafone','o2','mobilfunk','internet'],
  strom: ['strom','energie','versorger','abschlag'],
  wasser: ['wasser','abwasser'],
  steuer: ['steuer','steuererklaerung','steuererklärung','finanzamt'],
};

function normSearch(v) {
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

function tokenizeSearch(v) {
  const STOP = new Set([
    'alle','und','oder','mit','von','bei','im','in','am','für','der','die','das'
  ]);
  return normSearch(v)
    .split(' ')
    .filter(t => t && !STOP.has(t));
}

/**
 * Natürliche-Sprache-Anfrage → strukturierte Filter
 */
function parseNaturalQuery(q) {
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    const cloned = { ...q };
    const raw = String(cloned.raw || cloned.text || '').trim();
    cloned.raw = raw;
    cloned.text = String(cloned.text || '').trim();
    cloned.sender = String(cloned.sender || '').trim();
    cloned.textTokens = cloned.textTokens || tokenizeSearch(cloned.text);
    return cloned;
  }

  const raw = String(q || '').trim();
  const lower = raw.toLowerCase().trim();
  const filter = { raw, text: '', textTokens: [] };

  const objList = getObjectList();
  for (const o of objList) {
    const codeNorm = normSearch(o.code);
    const nameNorm = normSearch(o.displayName || '');
    if (codeNorm && normSearch(lower).includes(codeNorm)) {
      filter.objectCode = o.code;
      break;
    }
    if (nameNorm) {
      const head = nameNorm.split(' ').slice(0, 2).join(' ');
      if (head && normSearch(lower).includes(head)) {
        filter.objectCode = o.code;
        break;
      }
    }
  }

  const yearM = lower.match(/\b(20\d{2})\b/);
  if (yearM) filter.year = yearM[1];

  for (const [name, month] of Object.entries(IDX_MONTHS)) {
    if (normSearch(lower).includes(normSearch(name))) {
      filter.month = month;
      break;
    }
  }

  const amtGtM = lower.match(/\b(?:ueber|über|ab|mehr als|mindestens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (amtGtM) filter.amountGt = parseFloat(amtGtM[1].replace(',', '.'));

  const amtLtM = lower.match(/\b(?:unter|bis|maximal|hoechstens|höchstens)\s+(\d+[\.,]?\d*)\s*(?:euro|€)?/i);
  if (amtLtM) filter.amountLt = parseFloat(amtLtM[1].replace(',', '.'));

 if (/\brechnungen?\b/.test(lower)) filter.docType = 'rechnung';
else if (/\bverträge?\b|\bvertraege?\b/.test(lower)) filter.docType = 'vertrag';
else if (/\bdokumente?\b/.test(lower)) filter.docType = 'dokument';
else if (/\bgutschriften?\b/.test(lower)) filter.docType = 'gutschrift';
else if (/\bangebote?\b/.test(lower)) filter.docType = 'angebot';

  const senderM = lower.match(/\b(?:von|bei)\s+([a-zäöüß0-9&][a-zäöüß0-9&\s\-.]{1,40}?)(?:\s+20\d{2}\b|\s+(?:im|in|aus|ueber|über)\b|$)/i);
  if (senderM) filter.sender = senderM[1].trim();

  const colWords = ['steuererklärung','steuererklarung','betriebskosten','lohnbuch','versicherung'];
  for (const cw of colWords) {
    if (normSearch(lower).includes(normSearch(cw))) { filter.collectionHint = cw; break; }
  }

 let stripped = raw;
[
  /\b(Rechnungen?|Dokumente?|Verträge?|Vertraege?|Gutschriften?|Angebote?|von|bei|über|unter|ab|bis|im|im Jahr)\b/gi,
  /\b20\d{2}\b/g,
  /\b(?:ueber|über|ab|mehr als|mindestens|unter|bis|maximal|hoechstens|höchstens)\s+\d+[\.,]?\d*\s*(?:euro|€)?/gi,
  /\b(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/gi,
].forEach(pattern => stripped = stripped.replace(pattern, ' '));

for (const o of objList) {
  if (!o.code) continue;
  const escCode = String(o.code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  stripped = stripped.replace(new RegExp(`\\b${escCode}\\b`, 'gi'), ' ');
}

stripped = stripped.replace(/[€]/g, ' ').replace(/\s+/g, ' ').trim();
filter.text = stripped;
filter.textTokens = tokenizeSearch(stripped);

  return filter;
}

function buildIndexSearchDoc(doc) {
  const hayParts = [
    doc.fileName, doc.sender, doc.ocrText, doc.serviceDesc,
    ...(doc.keywords || []), doc.invoiceNo, doc.objectCode, doc.docType, doc.year,
  ];
  const tokens = tokenizeSearch(hayParts.join(' '));
  return {
    doc,
    tokenSet: new Set(tokens),
    tokens,
    haystack: normSearch(hayParts.join(' ')),
    senderNorm: normSearch(doc.senderNorm || doc.sender || ''),
    fileNameNorm: normSearch(doc.fileName || ''),
    objectNorm: normSearch(doc.objectCode || ''),
  };
}

function computeIndexSearchScore(entry, filter) {
  const doc = entry.doc;
  let score = 0;
  if (filter.objectCode) {
    if (String(doc.objectCode || '').toUpperCase() !== String(filter.objectCode).toUpperCase()) return -1;
    score += 220;
  }
  if (filter.year) {
    if (String(doc.year || '') !== String(filter.year)) return -1;
    score += 120;
  }
  if (filter.month) {
    if (!doc.invoiceDate || doc.invoiceDate.slice(5, 7) !== String(filter.month).padStart(2, '0')) return -1;
    score += 90;
  }
  if (filter.amountGt !== undefined && !(Number(doc.amount || 0) > Number(filter.amountGt))) return -1;
  if (filter.amountLt !== undefined && !(Number(doc.amount || 0) < Number(filter.amountLt))) return -1;
  if (filter.amountGt !== undefined || filter.amountLt !== undefined) score += 70;
  if (filter.docType) {
    const want = normSearch(filter.docType);
    const docTypeNorm = normSearch(doc.docType || '');
    if (!(docTypeNorm === want || docTypeNorm.includes(want) || (want === 'vertrag' && docTypeNorm.includes('dokument')))) return -1;
    score += 90;
  }
  const sender = normSearch(filter.sender || '');
  if (sender) {
    if (entry.senderNorm === sender) score += 220;
    else if (entry.senderNorm.includes(sender)) score += 150;
    else if (entry.fileNameNorm.includes(sender)) score += 110;
    else return -1;
  }
  if (filter.collectionId && !(doc.collections || []).includes(filter.collectionId)) return -1;

  const raw = normSearch(filter.raw || '');
  if (raw && entry.fileNameNorm.includes(raw)) score += 65;
  else if (raw && entry.haystack.includes(raw)) score += 35;

  const textTokens = Array.isArray(filter.textTokens) ? filter.textTokens : tokenizeSearch(filter.text || '');
  if (textTokens.length) {
    let matched = 0;
    for (const token of textTokens) {
      if (token.length < 2) continue;
      if (entry.tokenSet.has(token)) {
        matched += 1;
        score += 34;
        continue;
      }
      const fuzzy = [...entry.tokenSet].some(t => t.includes(token) || token.includes(t));
      if (fuzzy) {
        matched += 1;
        score += 22;
        continue;
      }
      let synonymHit = false;
      for (const words of Object.values(IDX_TOPIC_SYNONYMS)) {
        const normalizedWords = words.map(normSearch);
        if (!normalizedWords.includes(token)) continue;
        if (normalizedWords.some(w => entry.tokenSet.has(w) || entry.haystack.includes(w))) {
          matched += 1;
          score += 18;
          synonymHit = true;
          break;
        }
      }
      if (!synonymHit && token.length >= 4) return -1;
    }
    if (!matched) return -1;
    if (matched === textTokens.length) score += 45;
  }
  return score;
}

/**
 * Haupt-Suchfunktion: kombiniert alle Index-Quellen
 */
async function search(query, opts = {}) {
  const filter = typeof query === 'string' ? parseNaturalQuery(query) : parseNaturalQuery(query || {});
  const all = await dbGetAll(S_DOCS);

  const scored = [];
  for (const doc of all) {
    const entry = buildIndexSearchDoc(doc);
    const score = computeIndexSearchScore(entry, filter);
    if (score < 0) continue;
    scored.push({ ...doc, score, searchScore: score });
  }

  scored.sort((a, b) => (b.searchScore || 0) - (a.searchScore || 0) || String(b.savedAt || '').localeCompare(String(a.savedAt || '')));

  return {
    results: scored.slice(0, opts.limit || 200),
    total: scored.length,
    filter,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   SAMMLUNGEN
   ══════════════════════════════════════════════════════════════════════════ */

async function initDefaultCollections() {
  const defaults = [
    { id: 'steuererklarung', name: 'Steuererklärung', icon: '📑', color: '#5B1B70' },
    { id: 'betriebskosten',  name: 'Betriebskosten',  icon: '🏢', color: '#0D6E3E' },
  ];

  for (const col of defaults) {
    const existing = await dbGet(S_COLLECTIONS, col.id).catch(() => null);
    if (!existing) {
      await dbPut(S_COLLECTIONS, { ...col, docCount: 0, createdAt: new Date().toISOString() });
    }
  }
}

async function getAllCollections() {
  return dbGetAll(S_COLLECTIONS);
}

async function getCollectionDocs(colId) {
  const all = await dbGetAll(S_DOCS);
  return all.filter(d => (d.collections || []).includes(colId));
}

async function addDocToCollection(docId, colId) {
  const doc = await dbGet(S_DOCS, docId);
  if (!doc) return;
  if (!(doc.collections || []).includes(colId)) {
    doc.collections = [...(doc.collections || []), colId];
    await dbPut(S_DOCS, doc);
  }
}

async function removeDocFromCollection(docId, colId) {
  const doc = await dbGet(S_DOCS, docId);
  if (!doc) return;
  doc.collections = (doc.collections || []).filter(c => c !== colId);
  await dbPut(S_DOCS, doc);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATISTIKEN FÜR DASHBOARD
   ══════════════════════════════════════════════════════════════════════════ */

async function getDashboardStats() {
  try {
    const all = await dbGetAll(S_DOCS);
    const now = new Date();
    const thisYear  = now.getFullYear();
    const thisMonth = now.getMonth();
    const weekAgo   = new Date(now - 7 * 86400000).toISOString();

    const stats = {
      total:       all.length,
      thisYear:    all.filter(d => d.year === String(thisYear)).length,
      thisMonth:   all.filter(d => {
        const dt = new Date(d.savedAt);
        return dt.getFullYear() === thisYear && dt.getMonth() === thisMonth;
      }).length,
      lastWeek:    all.filter(d => d.savedAt >= weekAgo).length,
      byObject:    {},
      totalAmount: 0,
      monthAmount: 0,
    };

    for (const doc of all) {
      const code = doc.objectCode || '—';
      if (!stats.byObject[code]) stats.byObject[code] = { count: 0, amount: 0, lastSaved: null };
      stats.byObject[code].count++;
      stats.byObject[code].amount += (doc.amount || 0);
      if (!stats.byObject[code].lastSaved || doc.savedAt > stats.byObject[code].lastSaved)
        stats.byObject[code].lastSaved = doc.savedAt;

      stats.totalAmount += (doc.amount || 0);
    }

    // Monats-Betrag
    const monthDocs = all.filter(d => {
      const dt = new Date(d.savedAt);
      return dt.getFullYear() === thisYear && dt.getMonth() === thisMonth;
    });
    stats.monthAmount = monthDocs.reduce((s, d) => s + (d.amount || 0), 0);

    // Letzte 20 Aktivitäten
    stats.recentActivity = [...all]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, 20);

    return stats;
  } catch (e) {
    console.error('[FideliorIndex] getDashboardStats:', e);
    return { total: 0, thisYear: 0, lastWeek: 0, byObject: {}, totalAmount: 0, monthAmount: 0, recentActivity: [] };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   FILING-SIMULATION
   ══════════════════════════════════════════════════════════════════════════ */

async function computeFilingSimulation(formData) {
  const {
    fileName, objectCode, docType, amount, invoiceDate, sender,
    year, scopePath, folderType,
  } = formData;

  const cbSuggestions  = await suggestCheckboxes(sender, objectCode);
  const colSuggestions = await suggestCollections(sender);
  const conflicts      = await detectConflicts(sender, objectCode, dispToISO(invoiceDate), year);

  // KI-Konfidenz-Vorschläge zusammenstellen
  const suggestions = [];

  if (objectCode) {
    suggestions.push({
      type:       'object',
      value:      objectCode,
      label:      `Objekt: ${objectCode}`,
      confidence: 'high',
      reason:     'Aus Zuordnungsregel oder OCR-Erkennung',
    });
  }

  if (amount && parseAmountFloat(amount) > 0) {
    suggestions.push({
      type:       'amount',
      value:      amount,
      label:      `Betrag: ${amount} €`,
      confidence: 'high',
      reason:     'Aus PDF-Text erkannt',
    });
  }

  for (const s of colSuggestions) {
    const col = await dbGet(S_COLLECTIONS, s.colId).catch(() => null);
    if (col) {
      suggestions.push({
        type:       'collection',
        value:      s.colId,
        label:      `Sammlung: ${col.name}`,
        confidence: s.confidence,
        reason:     `Absender ${s.count}× in dieser Sammlung`,
      });
    }
  }

  for (const c of cbSuggestions.slice(0, 3)) {
    suggestions.push({
      type:       'checkbox',
      value:      c.checkboxId,
      label:      `Checkbox: ${c.checkboxId}`,
      confidence: c.confidence,
      reason:     `${c.count} von ${c.total} letzten Ablagen mit diesem Absender aktiv`,
    });
  }

  return {
    suggestions,
    conflicts,
    primaryPath: scopePath || [],
    folderType:  folderType || 'Rechnungsbelege',
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   OBJEKTE-LISTE (aus window oder objectSelect)
   ══════════════════════════════════════════════════════════════════════════ */

function getObjectList() {
  const sel = document.getElementById('objectSelect');
  if (!sel) return [];
  return Array.from(sel.options)
    .filter(o => o.value)
    .map(o => ({ code: o.value, displayName: o.textContent }));
}

/* ══════════════════════════════════════════════════════════════════════════
   FILING-SIMULATION PANEL (UI)
   ══════════════════════════════════════════════════════════════════════════ */

function injectSimulationCSS() {
  if (document.getElementById('fdl-idx-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-idx-css';
  s.textContent = `
/* ── Filing-Simulation Panel ── */
#fdl-sim-panel {
  position: fixed; right: 0; top: 52px; bottom: 0; width: 340px;
  background: #fff; border-left: 1px solid #E5E7EB;
  box-shadow: -4px 0 16px rgba(0,0,0,.06);
  display: flex; flex-direction: column; z-index: 8500;
  transform: translateX(100%); transition: transform .22s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
}
#fdl-sim-panel.open { transform: translateX(0); }

.fdl-sim-hdr {
  padding: 14px 16px; border-bottom: 1px solid #F3F4F6;
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.fdl-sim-hdr-title { font-size: 13px; font-weight: 700; color: #111827; flex: 1; }
.fdl-sim-toggle {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: #F3F4F6; cursor: pointer; display: flex; align-items: center;
  justify-content: center; font-size: 14px; color: #6B7280;
}
.fdl-sim-toggle:hover { background: #E5E7EB; }
.fdl-sim-body { flex: 1; overflow-y: auto; padding: 14px 16px; }

/* Sections */
.fdl-sim-sec { margin-bottom: 18px; }
.fdl-sim-sec-title {
  font-size: 10px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; color: #9CA3AF; margin-bottom: 8px;
}

/* Suggestion rows */
.fdl-sim-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; border-radius: 8px; border: 1px solid #F3F4F6;
  background: #FAFAFA; margin-bottom: 5px; cursor: default;
}
.fdl-sim-row.conflict  { background: #FEF2F2; border-color: #FCA5A5; }
.fdl-sim-row.info-row  { background: #EFF6FF; border-color: #BFDBFE; }
.fdl-sim-row.warning-row { background: #FEF3C7; border-color: #FDE68A; }

.fdl-sim-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px;
}
.fdl-sim-dot.high   { background: #16A34A; }
.fdl-sim-dot.medium { background: #D97706; }
.fdl-sim-dot.low    { background: #9CA3AF; }
.fdl-sim-dot.conflict { background: #EF4444; }
.fdl-sim-dot.info   { background: #2563EB; }

.fdl-sim-row-label  { font-size: 12.5px; font-weight: 600; color: #111827; flex: 1; }
.fdl-sim-row-reason { font-size: 11px; color: #6B7280; margin-top: 1px; }
.fdl-sim-row-conf {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; flex-shrink: 0;
}
.fdl-sim-row-conf.high   { background: #D1FAE5; color: #065F46; }
.fdl-sim-row-conf.medium { background: #FEF3C7; color: #92400E; }
.fdl-sim-row-conf.low    { background: #F3F4F6; color: #6B7280; }

.fdl-sim-accept {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 5px;
  border: 1.5px solid #D1D5DB; background: transparent; cursor: pointer;
  color: #374151; transition: all .12s; white-space: nowrap;
}
.fdl-sim-accept:hover { background: #5B1B70; color: #fff; border-color: #5B1B70; }

/* Path preview */
.fdl-sim-path {
  font-family: 'Menlo', 'Consolas', monospace; font-size: 10.5px;
  color: #374151; background: #F9FAFB; border: 1px solid #E5E7EB;
  border-radius: 6px; padding: 8px 10px; line-height: 1.8;
}
.fdl-sim-path-seg { color: #5B1B70; font-weight: 500; }
.fdl-sim-path-sep { color: #9CA3AF; }

/* Tab trigger button */
#fdl-sim-tab-btn {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  width: 28px; background: #5B1B70; color: #fff; border: none;
  border-radius: 8px 0 0 8px; cursor: pointer; z-index: 8490;
  writing-mode: vertical-rl; font-size: 10px; font-weight: 700;
  letter-spacing: .06em; padding: 12px 5px; box-shadow: -2px 0 8px rgba(0,0,0,.15);
  transition: right .22s ease;
}
#fdl-sim-tab-btn.shifted { right: 340px; }
#fdl-sim-tab-btn:hover { background: #6a2483; }

/* ── Suchleiste ── */
#fdl-idx-search-bar {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%);
  width: min(560px, calc(100vw - 200px));
  background: #fff; border: 1.5px solid #E5E7EB;
  border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,.12);
  z-index: 9000; display: none; flex-direction: column;
  overflow: hidden;
}
#fdl-idx-search-bar.open { display: flex; }
.fdl-idx-search-input-wrap {
  display: flex; align-items: center; padding: 10px 14px; gap: 8px;
}
.fdl-idx-search-input {
  flex: 1; border: none; outline: none; font-size: 14px; color: #111827;
  font-family: inherit; background: transparent;
}
.fdl-idx-search-close {
  width: 26px; height: 26px; border: none; border-radius: 6px;
  background: #F3F4F6; cursor: pointer; color: #6B7280; font-size: 13px;
}
.fdl-idx-search-results {
  max-height: 420px; overflow-y: auto; border-top: 1px solid #F3F4F6;
}
.fdl-idx-search-empty { padding: 20px; text-align: center; color: #9CA3AF; font-size: 13px; }
.fdl-idx-search-item {
  padding: 10px 14px; display: flex; align-items: flex-start; gap: 10px;
  border-bottom: 1px solid #F9FAFB; cursor: pointer; transition: background .1s;
}
.fdl-idx-search-item:hover { background: #FAF5FB; }
.fdl-idx-search-item:last-child { border-bottom: none; }
.fdl-idx-si-thumb {
  width: 32px; height: 40px; border-radius: 4px; flex-shrink: 0;
  background: #FEE2E2; border: 1px solid #FECACA;
  display: flex; align-items: center; justify-content: center;
  font-size: 8px; font-weight: 800; color: #DC2626;
}
.fdl-idx-si-name {
  font-size: 12px; font-weight: 600; color: #111827; margin-bottom: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 380px;
}
.fdl-idx-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.fdl-idx-chip {
  font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
}
.fdl-idx-chip.obj { background: #F5EEF8; color: #5B1B70; }
.fdl-idx-chip.amt { background: #D1FAE5; color: #065F46; }
.fdl-idx-chip.dt  { background: #F3F4F6; color: #6B7280; }
.fdl-idx-search-count {
  padding: 6px 14px; font-size: 11px; color: #9CA3AF;
  border-top: 1px solid #F3F4F6; background: #FAFAFA;
}
  `;
  document.head.appendChild(s);
}

/* ── Panel bauen ── */
function buildSimPanel() {
  if (document.getElementById('fdl-sim-panel')) return;
  injectSimulationCSS();

  const panel = document.createElement('div');
  panel.id = 'fdl-sim-panel';
  panel.innerHTML = `
    <div class="fdl-sim-hdr">
      <span style="font-size:14px">📋</span>
      <span class="fdl-sim-hdr-title">Filing-Simulation</span>
      <button class="fdl-sim-toggle" id="fdl-sim-close" title="Panel schließen">✕</button>
    </div>
    <div class="fdl-sim-body" id="fdl-sim-body">
      <div style="color:#9CA3AF;font-size:12.5px;text-align:center;padding:24px 0">
        Dokument laden um Vorschläge zu sehen
      </div>
    </div>`;
  document.body.appendChild(panel);

  const tab = document.createElement('button');
  tab.id = 'fdl-sim-tab-btn';
  tab.textContent = 'KI-Vorschläge';
  tab.title = 'Filing-Simulation öffnen';
  tab.onclick = toggleSim;
  document.body.appendChild(tab);

  document.getElementById('fdl-sim-close').onclick = closeSim;
}

function openSim() {
  document.getElementById('fdl-sim-panel')?.classList.add('open');
  document.getElementById('fdl-sim-tab-btn')?.classList.add('shifted');
}

function closeSim() {
  document.getElementById('fdl-sim-panel')?.classList.remove('open');
  document.getElementById('fdl-sim-tab-btn')?.classList.remove('shifted');
}

function toggleSim() {
  const p = document.getElementById('fdl-sim-panel');
  if (p?.classList.contains('open')) closeSim(); else openSim();
}

async function renderSimulation() {
  const body = document.getElementById('fdl-sim-body');
  if (!body) return;

  // Aktuellen Formular-Zustand lesen
  const formData = readCurrentForm();
  if (!formData.fileName && !formData.sender && !formData.objectCode) {
    body.innerHTML = `<div style="color:#9CA3AF;font-size:12.5px;text-align:center;padding:24px 0">Dokument laden um Vorschläge zu sehen</div>`;
    return;
  }

  body.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:20px;color:#9CA3AF;font-size:12.5px"><div style="width:14px;height:14px;border-radius:50%;border:2px solid #E5E7EB;border-top-color:#5B1B70;animation:av3spin .6s linear infinite"></div> Berechne Vorschläge…</div>`;

  try {
    const sim = await computeFilingSimulation(formData);

    let html = '';

    // ── Vorschläge ──
    if (sim.suggestions.length) {
      html += `<div class="fdl-sim-sec"><div class="fdl-sim-sec-title">KI-Vorschläge</div>`;
      for (const s of sim.suggestions) {
        if (s.type === 'checkbox') continue; // Checkboxen separat
        html += `<div class="fdl-sim-row">
          <div class="fdl-sim-dot ${s.confidence}"></div>
          <div style="flex:1;min-width:0">
            <div class="fdl-sim-row-label">${s.label}</div>
            <div class="fdl-sim-row-reason">${s.reason}</div>
          </div>
          <span class="fdl-sim-row-conf ${s.confidence}">${confLabel(s.confidence)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    // ── Konflikte ──
    if (sim.conflicts.length) {
      html += `<div class="fdl-sim-sec"><div class="fdl-sim-sec-title">Konflikte &amp; Hinweise</div>`;
      for (const c of sim.conflicts) {
        const cls = c.level === 'warning' ? 'conflict' : c.level === 'info' ? 'info-row' : 'warning-row';
        const dotCls = c.level === 'warning' ? 'conflict' : 'info';
        html += `<div class="fdl-sim-row ${cls}">
          <div class="fdl-sim-dot ${dotCls}"></div>
          <div style="flex:1;min-width:0">
            <div class="fdl-sim-row-label">${c.message}</div>
          </div>
        </div>`;
        // Sammlung direkt hinzufügen
        if (c.type === 'missing-collection' && c.colId) {
          html += html.endsWith(`</div>`) ? '' : '';
        }
      }
      html += `</div>`;
    }

    // ── Zielpfad ──
    if (sim.primaryPath.length) {
      html += `<div class="fdl-sim-sec"><div class="fdl-sim-sec-title">Zielpfad (Scopevisio)</div>
        <div class="fdl-sim-path">${sim.primaryPath.map((seg, i) =>
          `<span class="fdl-sim-path-seg">${seg}</span>${i < sim.primaryPath.length - 1 ? '<span class="fdl-sim-path-sep"> › </span>' : ''}`
        ).join('')}</div>
      </div>`;
    }

    // ── Checkbox-Vorschläge ──
    const cbSugg = sim.suggestions.filter(s => s.type === 'checkbox');
    if (cbSugg.length) {
      html += `<div class="fdl-sim-sec"><div class="fdl-sim-sec-title">Checkbox-Vorschläge</div>`;
      for (const s of cbSugg) {
        html += `<div class="fdl-sim-row">
          <div class="fdl-sim-dot ${s.confidence}"></div>
          <div style="flex:1;min-width:0">
            <div class="fdl-sim-row-label">${s.value}</div>
            <div class="fdl-sim-row-reason">${s.reason}</div>
          </div>
          <button class="fdl-sim-accept" onclick="window.__fdlIdx.applyCb('${s.value}')">Aktivieren</button>
        </div>`;
      }
      html += `</div>`;
    }

    if (!html) {
      html = `<div style="color:#9CA3AF;font-size:12.5px;text-align:center;padding:24px 0">Keine Vorschläge – erste Ablagen werden gelernt</div>`;
    }

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div style="color:#EF4444;font-size:12px;padding:14px">Fehler: ${e?.message || e}</div>`;
  }
}

function confLabel(c) {
  return c === 'high' ? 'Sicher' : c === 'medium' ? 'Möglich' : 'Niedrig';
}

function readCurrentForm() {
  return {
    fileName:    document.getElementById('fileNamePreview')?.textContent || '',
    objectCode:  document.getElementById('objectSelect')?.value || '',
    docType:     document.getElementById('docTypeSelect')?.value || '',
    amount:      document.getElementById('amountInput')?.value || '',
    invoiceDate: document.getElementById('invoiceDate')?.value || '',
    sender:      document.getElementById('senderInput')?.value || '',
    invoiceNo:   document.getElementById('invoiceNo')?.value || '',
   year:        ((document.getElementById('invoiceDate')?.value || '').match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear()),
    scopePath:   [],
    folderType:  'Rechnungsbelege',
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   SUCHLEISTE (Global, Ctrl+K)
   ══════════════════════════════════════════════════════════════════════════ */

function buildSearchBar() {
  if (document.getElementById('fdl-idx-search-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'fdl-idx-search-bar';
  bar.innerHTML = `
    <div class="fdl-idx-search-input-wrap">
      <span style="font-size:14px;color:#9CA3AF">🔍</span>
      <input class="fdl-idx-search-input" id="fdl-idx-q" type="search" autocomplete="off"
             placeholder="Suche: Rechnungen von Zinnikus EGYO 2026 …">
      <button class="fdl-idx-search-close" id="fdl-idx-search-close">✕</button>
    </div>
    <div class="fdl-idx-search-results" id="fdl-idx-results">
      <div class="fdl-idx-search-empty">⌨ Suchbegriff eingeben</div>
    </div>
    <div class="fdl-idx-search-count" id="fdl-idx-count" style="display:none"></div>`;
  document.body.appendChild(bar);

  let debounce;
  document.getElementById('fdl-idx-q').addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(e.target.value), 220);
  });
  document.getElementById('fdl-idx-search-close').onclick = closeSearch;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); toggleSearch(); }
    if (e.key === 'Escape') closeSearch();
  });
}

function openSearch() {
  const bar = document.getElementById('fdl-idx-search-bar');
  bar?.classList.add('open');
  setTimeout(() => document.getElementById('fdl-idx-q')?.focus(), 50);
}

function closeSearch() {
  document.getElementById('fdl-idx-search-bar')?.classList.remove('open');
}

function toggleSearch() {
  const bar = document.getElementById('fdl-idx-search-bar');
  if (bar?.classList.contains('open')) closeSearch(); else openSearch();
}

async function runSearch(q) {
  const res  = document.getElementById('fdl-idx-results');
  const cnt  = document.getElementById('fdl-idx-count');
  if (!q.trim()) {
    if (res) res.innerHTML = '<div class="fdl-idx-search-empty">⌨ Suchbegriff eingeben</div>';
    if (cnt) cnt.style.display = 'none';
    return;
  }
  if (res) res.innerHTML = '<div class="fdl-idx-search-empty">Suche…</div>';
  try {
    const { results, total, filter } = await search(q, { limit: 30 });
    if (cnt) {
      cnt.style.display = 'block';
      cnt.textContent = `${total} Dokument${total !== 1 ? 'e' : ''} gefunden`;
    }
    if (!results.length) {
      if (res) res.innerHTML = '<div class="fdl-idx-search-empty">Keine Dokumente gefunden</div>';
      return;
    }
    if (res) res.innerHTML = results.map(d => `
      <div class="fdl-idx-search-item" onclick="window.__fdlIdx.openInArchiv(${d.id})">
        <div class="fdl-idx-si-thumb">PDF</div>
        <div style="flex:1;min-width:0">
          <div class="fdl-idx-si-name" title="${d.fileName}">${d.fileName}</div>
          <div class="fdl-idx-chips">
            <span class="fdl-idx-chip obj">${d.objectCode}</span>
            ${d.amount ? `<span class="fdl-idx-chip amt">${fmtEuro(d.amount)}</span>` : ''}
            ${d.invoiceDate ? `<span class="fdl-idx-chip dt">${fmtDate(d.invoiceDate)}</span>` : ''}
            ${d.serviceDesc ? `<span class="fdl-idx-chip" style="background:#EFF6FF;color:#1E40AF">${d.serviceDesc.slice(0,40)}</span>` : ''}
          </div>
        </div>
        <div style="font-size:11px;color:#9CA3AF;white-space:nowrap;margin-left:8px">${fmtDate(d.savedAt)}</div>
      </div>`).join('');
  } catch (e) {
    if (res) res.innerHTML = `<div class="fdl-idx-search-empty">Fehler: ${e.message}</div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   HOOKS – fdlOnFileSaved & fdlKiOnOcr
   ══════════════════════════════════════════════════════════════════════════ */

// OCR-Zwischenspeicher: wird bis zum nächsten fdlOnFileSaved gehalten
let _pendingOcr = null;

// 1) OCR-Hook (kommt VOR dem Speichern)
const _originalKiOcr = window.fdlKiOnOcr;
window.fdlKiOnOcr = function(txt, lines, assignmentsCfg) {
  // Bestehenden KI-Hook weiterleiten
  try { _originalKiOcr?.(txt, lines, assignmentsCfg); } catch {}
  // OCR-Daten für Index merken
  _pendingOcr = analyzeOcrData(txt, lines);
};

// 2) FileSaved-Hook (kommt NACH dem Speichern)
const _originalFileSaved = window.fdlOnFileSaved;
window.fdlOnFileSaved = async function(data) {
  // Bestehenden Addon-Hook weiterleiten
  try { _originalFileSaved?.(data); } catch {}
  // Index-Record anlegen
  try {
    const rec = makeDocRecord(data, _pendingOcr);
    _pendingOcr = null;
    const id  = await dbAdd(S_DOCS, rec);
    rec.id = id;

    // Sammlungs-Vorschläge automatisch anbieten (nach 500ms)
    setTimeout(() => offerCollectionSuggestions(id, rec), 500);

    // Lernhistorie aufzeichnen
    const activeBoxes = readActiveCheckboxes();
    await recordLearning(rec, activeBoxes);

    // Simulation aktualisieren
    if (document.getElementById('fdl-sim-panel')?.classList.contains('open')) {
      renderSimulation();
    }
  } catch (e) {
    console.warn('[FideliorIndex] fdlOnFileSaved-Fehler:', e);
  }
};

function readActiveCheckboxes() {
  const rows = document.querySelectorAll('#saveTargets .chk input[type=checkbox], #emailTargets .chk input[type=checkbox]');
  return Array.from(rows).map(el => ({ id: el.id, checked: el.checked }));
}

async function offerCollectionSuggestions(docId, rec) {
  try {
    const suggestions = await suggestCollections(rec.sender);
    if (!suggestions.length) return;
    const colNames = [];
    for (const s of suggestions) {
      const col = await dbGet(S_COLLECTIONS, s.colId).catch(() => null);
      if (col) colNames.push({ id: s.colId, name: col.name });
    }
    if (!colNames.length) return;
    // Toast über window.toast (bestehend in app.js)
    const names = colNames.slice(0, 2).map(c => `<strong>${c.name}</strong>`).join(', ');
    const ids   = colNames.slice(0, 2).map(c => c.id).join(',');
    try {
      window.toast?.(
        `Zur Sammlung hinzufügen? ${names}
         <button onclick="window.__fdlIdx.bulkAddToCollections(${docId},'${ids}')" style="margin-left:8px;font-family:inherit;font-size:11px;background:#5B1B70;color:#fff;border:none;border-radius:5px;padding:3px 9px;cursor:pointer">Ja, hinzufügen</button>`,
        7000
      );
    } catch {}
  } catch {}
}

async function bulkAddToCollections(docId, idsStr) {
  const ids = idsStr.split(',');
  for (const id of ids) {
    await addDocToCollection(docId, id.trim()).catch(() => {});
  }
  try { window.toast?.('Zu Sammlungen hinzugefügt ✓', 2000); } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   REAKTIVE SIMULATION: bei Formular-Änderungen aktualisieren
   ══════════════════════════════════════════════════════════════════════════ */

function attachFormListeners() {
  const WATCH = ['objectSelect', 'docTypeSelect', 'invoiceDate', 'amountInput', 'senderInput'];
  let debounce;
  for (const id of WATCH) {
    const el = document.getElementById(id);
    el?.addEventListener('change', () => {
      clearTimeout(debounce);
      debounce = setTimeout(renderSimulation, 400);
    });
    el?.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(renderSimulation, 600);
    });
  }

  // Neues Dokument geladen: sofort rendern + Panel öffnen
  const fileInput = document.getElementById('fileInput');
  fileInput?.addEventListener('change', () => {
    setTimeout(async () => {
      await renderSimulation();
      // Panel nur öffnen wenn OCR schon fertig und ein Objekt vorgeschlagen wurde
    }, 2500); // Warten bis autoRecognize läuft
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════════════════════ */

window.__fdlIdx = {
  // CRUD
  search,
  getAllDocs:       () => dbGetAll(S_DOCS),
  getDoc:          (id) => dbGet(S_DOCS, id),
  deleteDoc:       (id) => dbDelete(S_DOCS, id),

  // Sammlungen
  getAllCollections,
  getCollectionDocs,
  addDocToCollection,
  removeDocFromCollection,
  bulkAddToCollections,
  createCollection: async (col) => { await dbPut(S_COLLECTIONS, col); },

  // Statistiken
  getDashboardStats,

  // Simulation
  computeFilingSimulation,
  renderSimulation,
  openSim,
  closeSim,
  toggleSim,

  // Suche
  openSearch,
  closeSearch,
  toggleSearch,
  parseNaturalQuery,

  // Lernhistorie
  suggestCheckboxes,
  suggestCollections,
  detectConflicts,

  // Checkbox anwenden
  applyCb(checkboxId) {
    const el = document.getElementById(checkboxId);
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  },

  // Im Archiv öffnen
  openInArchiv(docId) {
    closeSearch();
    dbGet(S_DOCS, docId).then(doc => {
      if (!doc) return;
      if (window.__fdlPro?.openIndexedDoc) {
        window.__fdlPro.openIndexedDoc(doc);
        return;
      }
      if (typeof window.fdlArchivOpen === 'function') {
        const derive = window.fdlDeriveCategory ? window.fdlDeriveCategory(doc.objectCode) : '';
        const typeFilter =
          doc.docType === 'Rechnung' ? 'Rechnungen' :
          doc.docType === 'Dokument' ? 'Dokumente' :
          'all';
        window.fdlArchivOpen({
          obj: doc.objectCode || '',
          code: doc.objectCode || '',
          scopeCategory: derive || '',
          typeFilter,
          selectName: doc.fileName || '',
          query: (doc.fileName || '').replace(/\.pdf$/i, ''),
          sortOrder: 'date-desc'
        });
      }
    });
  },

  // Lernzentrale öffnen
  openLernzentrale: () => openLernzentrale(),
};

/* ══════════════════════════════════════════════════════════════════════════
   LERNZENTRALE  (Admin-Overlay)
   ══════════════════════════════════════════════════════════════════════════ */

function buildLernzentraleCSS() {
  if (document.getElementById('fdl-lz-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-lz-css';
  s.textContent = `
#fdl-lz-overlay {
  position: fixed; inset: 0; z-index: 9300;
  background: rgba(0,0,0,.45); backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 16px; opacity: 0; pointer-events: none; transition: opacity .18s;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
#fdl-lz-overlay.open { opacity: 1; pointer-events: all; }
.fdl-lz-panel {
  background: #fff; border-radius: 14px; width: 100%; max-width: 780px;
  max-height: 85vh; display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.18);
}
.fdl-lz-hdr {
  padding: 18px 22px; border-bottom: 1px solid #F3F4F6;
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
}
.fdl-lz-hdr-title { font-size: 15px; font-weight: 700; color: #111827; }
.fdl-lz-close {
  margin-left: auto; width: 30px; height: 30px; border: none;
  border-radius: 8px; background: #F3F4F6; cursor: pointer; font-size: 13px;
}
.fdl-lz-body { flex: 1; overflow-y: auto; padding: 18px 22px; }
.fdl-lz-sec-title {
  font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: #9CA3AF; margin: 0 0 10px;
}
.fdl-lz-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fdl-lz-table th {
  text-align: left; padding: 7px 10px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .05em; text-transform: uppercase; color: #9CA3AF;
  border-bottom: 1.5px solid #F3F4F6;
}
.fdl-lz-table td { padding: 9px 10px; border-bottom: 1px solid #F9FAFB; vertical-align: top; }
.fdl-lz-table tr:last-child td { border-bottom: none; }
.fdl-lz-conf {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
}
.fdl-lz-conf.high   { background: #D1FAE5; color: #065F46; }
.fdl-lz-conf.medium { background: #FEF3C7; color: #92400E; }
  `;
  document.head.appendChild(s);
}

async function openLernzentrale() {
  buildLernzentraleCSS();
  let ov = document.getElementById('fdl-lz-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'fdl-lz-overlay';
    ov.innerHTML = `
      <div class="fdl-lz-panel">
        <div class="fdl-lz-hdr">
          <span style="font-size:16px">🎓</span>
          <span class="fdl-lz-hdr-title">Lernzentrale – Erlernte Muster</span>
          <button class="fdl-lz-close" id="fdl-lz-close">✕</button>
        </div>
        <div class="fdl-lz-body" id="fdl-lz-body">Lade…</div>
      </div>`;
    document.body.appendChild(ov);
    document.getElementById('fdl-lz-close').onclick = () => ov.classList.remove('open');
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
  }
  ov.classList.add('open');
  await renderLernzentrale();
}

async function renderLernzentrale() {
  const body = document.getElementById('fdl-lz-body');
  if (!body) return;

  try {
    const allLearn = await dbGetAll(S_LEARN);
    const allDocs  = await dbGetAll(S_DOCS);
    const allCols  = await getAllCollections();
    const colMap   = Object.fromEntries(allCols.map(c => [c.id, c]));

    // Aggregieren pro Absender + Objekt
    const groups = {};
    for (const r of allLearn) {
      const key = `${r.senderKey}::${r.objectCode}`;
      if (!groups[key]) groups[key] = { sender: r.senderKey, object: r.objectCode, cbs: {}, cols: {} };
      if (r.type === 'checkbox' && r.checkboxId) groups[key].cbs[r.checkboxId] = (groups[key].cbs[r.checkboxId] || 0) + 1;
      if (r.type === 'collection' && r.collectionId) groups[key].cols[r.collectionId] = (groups[key].cols[r.collectionId] || 0) + 1;
    }

    let html = '';

    // Absender-Statistik
    const senderStats = {};
    for (const d of allDocs) {
      const sn = d.senderNorm || '—';
      if (!senderStats[sn]) senderStats[sn] = { count: 0, objects: {}, lastDate: '' };
      senderStats[sn].count++;
      senderStats[sn].objects[d.objectCode] = (senderStats[sn].objects[d.objectCode] || 0) + 1;
      if (d.savedAt > senderStats[sn].lastDate) senderStats[sn].lastDate = d.savedAt;
    }

    const topSenders = Object.entries(senderStats)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 15);

    html += `<div class="fdl-lz-sec-title">Häufigste Absender (${topSenders.length})</div>
    <table class="fdl-lz-table">
      <thead><tr><th>Absender</th><th>Dokumente</th><th>Objekte</th><th>Zuletzt</th></tr></thead>
      <tbody>`;
    for (const [sender, s] of topSenders) {
      const objList = Object.entries(s.objects).sort(([,a],[,b])=>b-a).map(([o,c])=>`${o} (${c})`).join(', ');
      html += `<tr>
        <td style="font-weight:500">${sender}</td>
        <td>${s.count}</td>
        <td style="color:#6B7280;font-size:11.5px">${objList}</td>
        <td style="color:#9CA3AF">${fmtDate(s.lastDate)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;

    // Checkbox-Lernmuster
    const cbEntries = Object.values(groups).filter(g => Object.keys(g.cbs).length > 0);
    if (cbEntries.length) {
      html += `<div class="fdl-lz-sec-title" style="margin-top:20px">Checkbox-Lernmuster</div>
      <table class="fdl-lz-table">
        <thead><tr><th>Absender</th><th>Objekt</th><th>Checkbox</th><th>Häufigkeit</th><th>Konfidenz</th></tr></thead>
        <tbody>`;
      for (const g of cbEntries.slice(0, 20)) {
        const cbMax = Object.entries(g.cbs).sort(([,a],[,b])=>b-a)[0];
        const total = Object.values(g.cbs).reduce((s,v)=>s+v,0);
        const ratio = cbMax[1] / total;
        const conf  = ratio >= 0.7 ? 'high' : 'medium';
        html += `<tr>
          <td style="font-weight:500">${g.sender}</td>
          <td><span style="font-size:10px;font-weight:700;background:#F5EEF8;color:#5B1B70;padding:2px 5px;border-radius:4px">${g.object}</span></td>
          <td style="font-family:'Menlo',monospace;font-size:11px">${cbMax[0]}</td>
          <td>${cbMax[1]}× von ${total}</td>
          <td><span class="fdl-lz-conf ${conf}">${conf === 'high' ? 'Hoch' : 'Mittel'}</span></td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    // Sammlungs-Muster
    const colEntries = Object.values(groups).filter(g => Object.keys(g.cols).length > 0);
    if (colEntries.length) {
      html += `<div class="fdl-lz-sec-title" style="margin-top:20px">Sammlungs-Zuordnungen</div>
      <table class="fdl-lz-table">
        <thead><tr><th>Absender</th><th>Sammlung</th><th>Häufigkeit</th></tr></thead>
        <tbody>`;
      for (const g of colEntries.slice(0, 15)) {
        for (const [colId, cnt] of Object.entries(g.cols)) {
          const colName = colMap[colId]?.name || colId;
          html += `<tr>
            <td style="font-weight:500">${g.sender}</td>
            <td>${colName}</td>
            <td>${cnt}×</td>
          </tr>`;
        }
      }
      html += `</tbody></table>`;
    }

    if (!cbEntries.length && !colEntries.length && !topSenders.length) {
      html = `<div style="text-align:center;color:#9CA3AF;padding:32px;font-size:13px">Noch keine Lernhistorie vorhanden.<br><small>Dokumente ablegen um Muster zu lernen.</small></div>`;
    }

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div style="color:#EF4444;padding:14px">Fehler: ${e.message}</div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

async function init() {
  injectSimulationCSS();
  buildSimPanel();
  buildSearchBar();
  await initDefaultCollections();
  attachFormListeners();

  // Lernzentrale-Button in Einstellungen einfügen (nach Aufgaben-Checkbox-Dialog)
  const settingsList = document.querySelector('#settingsDialog .list ul.stack');
  if (settingsList && !document.getElementById('btnSettingsLernzentrale')) {
    const li = document.createElement('li');
    li.innerHTML = `<button id="btnSettingsLernzentrale" type="button" class="btn slim">🎓 Lernzentrale &amp; Muster</button>`;
    settingsList.appendChild(li);
    document.getElementById('btnSettingsLernzentrale').onclick = () => {
      document.getElementById('settingsDialog')?.close();
      openLernzentrale();
    };
  }

  // Suche in Header: Ctrl+K Hinweis
  const hdr = document.querySelector('.header-inner');
  if (hdr && !document.getElementById('fdl-idx-search-btn')) {
    const btn = document.createElement('button');
    btn.id = 'fdl-idx-search-btn';
    btn.title = 'Suche öffnen (Ctrl+K)';
    btn.style.cssText = `
      display:inline-flex;align-items:center;gap:6px;
      font-family:inherit;font-size:11.5px;font-weight:600;
      padding:5px 13px;border-radius:8px;cursor:pointer;
      border:1.5px solid rgba(255,255,255,.2);
      background:rgba(255,255,255,.08);color:#fff;white-space:nowrap;
    `;
    btn.innerHTML = `🔍 Suche <span style="font-size:10px;opacity:.6;background:rgba(255,255,255,.1);border-radius:3px;padding:1px 5px">Ctrl+K</span>`;
    btn.onclick = openSearch;
  const settings = document.getElementById('settingsBtn');
if (settings && settings.parentNode === hdr) {
  hdr.insertBefore(btn, settings);
} else {
  hdr.appendChild(btn);
}

  }

  console.info('[FideliorIndex v1.0] bereit – Suche: Ctrl+K, Filing-Panel: Seitenleiste');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
