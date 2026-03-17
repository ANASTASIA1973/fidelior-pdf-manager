/* ==========================================================================
   Fidelior KI – Absender-Erkennung & Lern-Engine
   Version 2.0 — standalone, non-invasive
   Hook: window.fdlKiOnOcr(txt, lines, assignmentsCfg)

   Ziel:
   - robustere Absender-Erkennung
   - weniger Fehlgriffe im Briefkopf
   - keine Änderung an Ablage-/Save-/Pfadlogik
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   BASIS / KONSTANTEN
   ══════════════════════════════════════════════════════════════════════════ */

const COMPANY_SUFFIXES_RX =
  /\b(GmbH|AG|SE|KGaA|KG|GbR|OHG|UG|e\.?\s?V\.?|eG|mbH|Inc\.?|Ltd\.?|LLC|S\.?A\.?R\.?L\.?|S\.?A\.?|Holding|Immobilien|Hausverwaltung|Verwaltung|Management|Consulting|Solutions|Services|Service|Handwerk|Bau|Bauservice|Sanitär|Heizung|Elektro|Stadtwerke|Energie|Versorgung|Versicherungen?|Versicherung|Makler|Notar|Rechtsanwälte?|Steuerberater|Kanzlei|Apotheke|Praxis|Bank|Sparkasse)\b/i;

const PERSON_LINE_RX =
  /^(Herr|Frau|Familie|Dr\.?|Prof\.?)\s+[A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+){0,3}$/i;

const SENDER_LABEL_RX =
  /(?:^|\b)(Absender|Von|Rechnungssteller|Lieferant|Anbieter|Auftragnehmer|Kreditor|Aussteller|Firma|Vendor|Supplier|Issued by|Bill from|Rechnung von)\s*[:\-]\s*([^\n\r]{3,120})/i;

const NEGATIVE_LINE_RX =
  /^(Rechnung|Invoice|Gutschrift|Angebot|Mahnung|Bestellung|Auftrag|Auftragsbestätigung|Lieferschein|Datum|Date|Nummer|No\.?|Page|Seite|Kundennr|Kunden-Nr|Rechnungsnr|Rechnungs-Nr|Dok\.?|Beleg|Referenz|Ref\.?|Betreff|Subject|Dear|Sehr geehrte|Sehr geehrter|An|An\s+Herrn|An\s+Frau|Telefon|Tel\.?|Fax|Mobil|Mobile|E-Mail|Email|Internet|Web|www\.|http|https|IBAN|BIC|Swift|USt|MwSt|Steuer|Tax|Bank|Konto|BLZ|Zahlbar|Fällig|Due|Leistung|Leistungszeitraum|Empfänger|Recipient|Kunde|Customer)\b/i;

const BAD_OCR_ONLY_RX = /^[\W_]+$/;
const ZIP_CITY_RX = /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{2,}(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{2,}){0,3}\b/;
const STREET_RX = /\b(?:straße|str\.|weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive)\b/i;
const VAT_RX = /\b(?:ust-id|ustid|umsatzsteuer|tax\s*id|vat)\b/i;
const CONTACT_RX = /\b(?:tel|telefon|fax|mobil|email|e-mail|www|http)\b/i;
const BANK_RX = /\b(?:iban|bic|swift|bank|konto|blz)\b/i;
const INVOICE_WORD_RX = /\b(?:rechnung|invoice|gutschrift|angebot|mahnung)\b/i;

const LEARN_PANEL_ID = 'fdl-ki-learn-panel';
const BADGE_ID = 'fdl-ki-sender-badge';
const STATUS_ID = 'fdl-ki-status';

let learnPanelEl = null;

/* ══════════════════════════════════════════════════════════════════════════
   DOM HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

function getSenderEl()  { return document.getElementById('senderInput'); }
function getObjSel()    { return document.getElementById('objectSelect'); }
function getSubSel()    { return document.getElementById('genericSubfolder'); }
function getTypeSel()   { return document.getElementById('docTypeSelect'); }
function getAmountEl()  { return document.getElementById('amountInput'); }
function getInvNoEl()   { return document.getElementById('invoiceNo'); }
function getInvDateEl() { return document.getElementById('invoiceDate'); }

function q(id) { return document.getElementById(id); }

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function escRx(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWs(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeForCompare(s) {
  return normalizeWs(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isVisible(el) {
  if (!el) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden';
}

/* ══════════════════════════════════════════════════════════════════════════
   CSS
   ══════════════════════════════════════════════════════════════════════════ */

function injectKiCSS() {
  if (q('fdl-ki-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-ki-css';
  s.textContent = `
.fdl-ki-badge{
  display:inline-flex;align-items:center;gap:5px;
  font-size:10.5px;font-weight:700;padding:2px 8px;
  border-radius:999px;vertical-align:middle;margin-left:6px;
  cursor:default;line-height:1.2;
}
.fdl-ki-badge.high{background:rgba(26,122,69,.12);color:#1A7A45}
.fdl-ki-badge.medium{background:rgba(184,122,0,.12);color:#8A6000}
.fdl-ki-badge.low{background:rgba(91,27,112,.10);color:#5B1B70}
.fdl-ki-badge .fdl-ki-src{font-weight:500;font-size:10px;opacity:.78}

.fdl-ki-status{
  font-size:11px;color:var(--muted);margin-top:.25rem;
  display:flex;align-items:center;gap:.35rem;min-height:16px;
}
.fdl-ki-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.fdl-ki-dot.high{background:#1A7A45}
.fdl-ki-dot.medium{background:#B87A00}
.fdl-ki-dot.low{background:#5B1B70}

.fdl-ki-learn{
  border:1.5px solid var(--primary);
  border-radius:12px;
  background:linear-gradient(135deg, rgba(91,27,112,.045) 0%, rgba(91,27,112,.015) 100%);
  padding:.95rem 1.1rem;
  margin-top:.85rem;
  animation:fdlKiSlideDown .22s ease;
  position:relative;
}
@keyframes fdlKiSlideDown{
  from{opacity:0;transform:translateY(-8px)}
  to{opacity:1;transform:none}
}
.fdl-ki-learn-title{
  font-size:11.5px;font-weight:700;color:var(--primary);
  margin-bottom:.6rem;display:flex;align-items:center;gap:.45rem;
}
.fdl-ki-learn-body{
  display:grid;grid-template-columns:1fr 1fr;gap:.55rem;
  margin-bottom:.7rem;
}
.fdl-ki-learn-field label{
  display:block;font-size:10.5px;font-weight:600;color:var(--muted);
  margin-bottom:.2rem;
}
.fdl-ki-learn-field input,
.fdl-ki-learn-field select{
  width:100%;font-family:var(--font-ui);font-size:12px;
  padding:6px 8px;border-radius:7px;
  border:1.5px solid var(--border);
  background:var(--surface);color:var(--text);
}
.fdl-ki-learn-field input:focus,
.fdl-ki-learn-field select:focus{
  outline:none;border-color:var(--primary);box-shadow:var(--focus-ring);
}
.fdl-ki-learn-field.full{grid-column:1 / -1}
.fdl-ki-learn-actions{display:flex;gap:.45rem;align-items:center}
.fdl-ki-save{
  font-family:var(--font-ui);font-size:12px;font-weight:700;
  padding:6px 16px;border-radius:8px;border:none;
  background:var(--primary);color:#fff;cursor:pointer;
}
.fdl-ki-save:hover{background:var(--primary-600,#6a2483)}
.fdl-ki-dismiss{
  font-family:var(--font-ui);font-size:12px;font-weight:500;
  padding:6px 12px;border-radius:8px;
  border:1.5px solid var(--border);background:transparent;
  color:var(--muted);cursor:pointer;
}
.fdl-ki-learn-close{
  position:absolute;top:.7rem;right:.8rem;
  width:22px;height:22px;border-radius:6px;border:none;
  background:transparent;color:var(--muted);font-size:12px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
}
.fdl-ki-learn-close:hover{background:var(--border);color:var(--text)}
.fdl-ki-pattern-hint{
  font-size:10.5px;color:var(--muted);margin-top:.2rem;
  font-family:monospace;word-break:break-all;
}
`;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════════════════ */

function fdlToast(html, ms) {
  try {
    if (typeof toast === 'function') toast(html, ms || 3500);
    else console.log('[FideliorKI]', html);
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   TEXT / OCR HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

function toCleanLines(txt, lines) {
  const fromLines = Array.isArray(lines) ? lines.map(v => normalizeWs(v)) : [];
  const fromText = String(txt || '').split(/\r?\n/).map(v => normalizeWs(v));
  const merged = [...fromLines, ...fromText].filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const line of merged) {
    const key = normalizeForCompare(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function cleanCandidate(raw) {
  let s = normalizeWs(raw);
  if (!s) return '';

  s = s
    .replace(/^[\-\–\—•·:;,.()\[\]{}|\\\/]+/, '')
    .replace(/[\-\–\—•·:;,.()\[\]{}|\\\/]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  s = s
    .replace(/\b(?:Tel\.?|Telefon|Fax|Mobil|E-Mail|Email|www\.)\b.*$/i, '')
    .replace(/\b(?:IBAN|BIC|Swift|Steuer|USt|MwSt|VAT)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (s.split(/\s+/).length > 10) return '';
  if (s.length < 3 || s.length > 95) return '';
  if (BAD_OCR_ONLY_RX.test(s)) return '';
  return s;
}

function looksLikeAddress(line) {
  const s = normalizeWs(line);
  return /\b\d{1,4}[a-zA-Z]?\b/.test(s) && STREET_RX.test(s);
}

function looksLikeZipCity(line) {
  return ZIP_CITY_RX.test(normalizeWs(line));
}

function countCompanySignals(line) {
  const s = normalizeWs(line);
  let score = 0;
  if (COMPANY_SUFFIXES_RX.test(s)) score += 7;
  if (/\b&\b/.test(s)) score += 1;
  if (/[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+/.test(s)) score += 1;
  if (/\b(hausverwaltung|immobilien|energie|versorgung|kanzlei|steuerberater|rechtsanwälte|bau|service|services|solutions|management)\b/i.test(s)) score += 2;
  return score;
}

function isClearlyBadSenderLine(line) {
  const s = normalizeWs(line);
  if (!s) return true;

  if (NEGATIVE_LINE_RX.test(s)) return true;
  if (PERSON_LINE_RX.test(s)) return true;

  const strongCompany =
    COMPANY_SUFFIXES_RX.test(s) ||
    /\b(energie|werke|versicherung|sanitätshaus|online|media|bau|service|services|solutions|management|autodoc)\b/i.test(s);

  if (looksLikeAddress(s) && !strongCompany) return true;
  if (looksLikeZipCity(s) && !strongCompany) return true;

  if (CONTACT_RX.test(s) && !strongCompany) return true;
  if (BANK_RX.test(s)) return true;
  if (VAT_RX.test(s)) return true;

  if (/hauptverwaltung/i.test(s)) return true;
  if (/kundenservice/i.test(s)) return true;

  if (/^\d[\d\s.,/-]*$/.test(s)) return true;

  if (s.length < 3 || s.length > 90) return true;

  return false;
}

function scoreHeaderCandidate(line, index, nearbyLines) {
  const s = cleanCandidate(line);
  if (!s) return null;
  if (isClearlyBadSenderLine(s)) return null;

  let score = 0;

  if (index <= 2) score += 6;
  else if (index <= 5) score += 4;
  else if (index <= 10) score += 2;

  score += countCompanySignals(s);

  if (!/\d/.test(s)) score += 1;
  if (/[A-ZÄÖÜ][a-zäöüß]/.test(s)) score += 1;
  if (s.split(/\s+/).length >= 2 && s.split(/\s+/).length <= 6) score += 1;

  const next = nearbyLines[index + 1] || '';
  const prev = nearbyLines[index - 1] || '';

  if (looksLikeAddress(next)) score += 2;
  if (looksLikeZipCity(next)) score += 1;
  if (looksLikeAddress(prev)) score += 1;

  if (/\b(rechnungssteller|lieferant|anbieter|auftragnehmer|firma|vendor|supplier)\b/i.test(prev)) score += 3;
  if (/\b(rechnungssteller|lieferant|anbieter|auftragnehmer|firma|vendor|supplier)\b/i.test(next)) score += 1;

  if (/[A-Z]{4,}/.test(s) && !COMPANY_SUFFIXES_RX.test(s)) score -= 2;
  if (s.length < 5) score -= 2;

  return { value: s, score };
}

function pickBestScoredCandidate(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const dedup = new Map();

  for (const item of list) {
    const key = normalizeForCompare(item.value);
    if (!key) continue;
    const prev = dedup.get(key);
    if (!prev || item.score > prev.score) dedup.set(key, item);
  }

  const finalList = [...dedup.values()].sort((a, b) => b.score - a.score);
  return finalList[0] || null;
}

function mapConfidence(score) {
  if (score >= 13) return 'high';
  if (score >= 9) return 'medium';
  return 'low';
}

function buildPatternFromVendor(vendor) {
  if (!vendor) return '';
  const core = String(vendor)
    .replace(/\b(GmbH|AG|SE|KGaA|KG|GbR|OHG|UG|e\.?\s?V\.?|eG|Inc\.?|Ltd\.?|LLC)\b.*$/i, '')
    .trim();
  return escRx(core || vendor);
}

/* ══════════════════════════════════════════════════════════════════════════
   EXTRAKTION
   ══════════════════════════════════════════════════════════════════════════ */

function extractSenderFromRule(matchedRule) {
  if (matchedRule?.sender?.trim()) {
    return {
      value: normalizeWs(matchedRule.sender),
      confidence: 'high',
      source: 'Zuordnungsregel',
      score: 100
    };
  }

  if (matchedRule?.note?.trim()) {
    const clean = normalizeWs(
      matchedRule.note
        .replace(/^auto:\s*/i, '')
        .split(/[·|]/)[0]
        .replace(/·?\s*\d{5,}.*$/, '')
    );

    if (clean && clean.length >= 3 && clean.length <= 80 && !/^\d+$/.test(clean)) {
      return {
        value: clean,
        confidence: 'medium',
        source: 'Zuordnungsregel (Hinweis)',
        score: 70
      };
    }
  }

  return null;
}

function extractSenderByLabel(txt) {
  const m = String(txt || '').match(SENDER_LABEL_RX);
  if (!m) return null;

  const candidate = cleanCandidate(m[2]);
  if (!candidate || isClearlyBadSenderLine(candidate)) return null;

  let score = 10 + countCompanySignals(candidate);
  if (!/\d/.test(candidate)) score += 1;

  return {
    value: candidate,
    confidence: mapConfidence(score),
    source: 'Label im Dokument',
    score
  };
}

function extractSenderFromHeader(lines) {
  const candidates = [];
  const head = (lines || []).slice(0, 24);

  for (let i = 0; i < head.length; i++) {
    const scored = scoreHeaderCandidate(head[i], i, head);
    if (scored) candidates.push(scored);
  }

  const best = pickBestScoredCandidate(candidates);
  if (!best) return null;

  return {
    value: best.value,
    confidence: mapConfidence(best.score),
    source: 'Briefkopf',
    score: best.score
  };
}

function extractSenderFromFullText(txt) {
  const t = String(txt || '');

  const patterns = [
    /([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{2,60}\b(?:GmbH|AG|SE|KG|UG|e\.?\s?V\.?|eG|Holding|Immobilien|Hausverwaltung|Verwaltung|Management|Consulting|Solutions|Services|Service|Stadtwerke|Energie|Versorgung|Versicherung|Versicherungen|Kanzlei|Bank|Sparkasse))/,
    /([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{2,60}\b(?:Hausverwaltung|Immobilien|Verwaltung|Kanzlei|Steuerberater|Rechtsanwälte|Stadtwerke|Energie|Versorgung))/i
  ];

  for (const rx of patterns) {
    const m = t.match(rx);
    if (!m) continue;
    const candidate = cleanCandidate(m[1]);
    if (!candidate || isClearlyBadSenderLine(candidate)) continue;

    let score = 7 + countCompanySignals(candidate);
    if (!/\d/.test(candidate)) score += 1;

    return {
      value: candidate,
      confidence: mapConfidence(score),
      source: 'Volltext',
      score
    };
  }

  return null;
}

function extractSender(txt, lines, matchedRule) {
  const byRule = extractSenderFromRule(matchedRule);
  if (byRule) return byRule;

  const byLabel = extractSenderByLabel(txt);
  const byHeader = extractSenderFromHeader(toCleanLines(txt, lines));
  const byText = extractSenderFromFullText(txt);

  const best = pickBestScoredCandidate(
    [byLabel, byHeader, byText].filter(Boolean).map(v => ({
      value: v.value,
      score: v.score,
      source: v.source,
      confidence: v.confidence
    }))
  );

  if (!best) return null;

  const sourceMap = [byLabel, byHeader, byText].find(v => normalizeForCompare(v.value) === normalizeForCompare(best.value));
  return sourceMap || {
    value: best.value,
    confidence: mapConfidence(best.score),
    source: 'OCR',
    score: best.score
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   UI: BADGE / STATUS
   ══════════════════════════════════════════════════════════════════════════ */

function removeSenderBadge() {
  q(BADGE_ID)?.remove();
}

function ensureStatusHost() {
  const senderEl = getSenderEl();
  if (!senderEl) return null;

  let host = q(STATUS_ID);
  if (host) return host;

  host = document.createElement('div');
  host.id = STATUS_ID;
  host.className = 'fdl-ki-status';

  const parent = senderEl.parentElement;
  if (parent) parent.appendChild(host);
  return host;
}

function setStatus(confidence, text) {
  const host = ensureStatusHost();
  if (!host) return;
  if (!text) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `<span class="fdl-ki-dot ${escHtml(confidence || 'low')}"></span><span>${escHtml(text)}</span>`;
}

function showSenderBadge(confidence, source) {
  removeSenderBadge();
  const senderEl = getSenderEl();
  if (!senderEl) return;

  const badge = document.createElement('span');
  badge.className = `fdl-ki-badge ${confidence}`;
  badge.id = BADGE_ID;
  badge.title = `Erkannt durch: ${source}`;
  badge.innerHTML = `KI <span class="fdl-ki-src">(${escHtml(source)})</span>`;

  const label = senderEl.previousElementSibling;
  if (label && label.tagName === 'LABEL') label.appendChild(badge);
}

function clearKiUi() {
  removeSenderBadge();
  setStatus('', '');
  removeLearnPanel();
}

/* ══════════════════════════════════════════════════════════════════════════
   LERN-PANEL
   ══════════════════════════════════════════════════════════════════════════ */

function removeLearnPanel() {
  learnPanelEl?.remove();
  learnPanelEl = null;
}

function getSubfolderValueIfVisible() {
  const sub = getSubSel();
  const row = sub?.closest('#subfolderRow');
  if (!sub || (row && !isVisible(row))) return '';
  return sub.value || '';
}

function bestLearnInsertPoint() {
  const metaDiv = document.querySelector('.meta[aria-live]');
  if (metaDiv?.parentElement) return { parent: metaDiv.parentElement, before: metaDiv };

  const senderEl = getSenderEl();
  if (!senderEl?.parentElement) return null;
  return { parent: senderEl.parentElement, before: null };
}

async function showLearnPanel(senderValue) {
  removeLearnPanel();

  const senderEl = getSenderEl();
  const objSel = getObjSel();
  if (!senderEl) return;

  const currentSender = normalizeWs(senderValue || senderEl.value || '');
  const currentObj = objSel?.value || '';
  const currentSub = getSubfolderValueIfVisible();

  if (!currentSender && !currentObj) return;

  const objOptions = Array.from(objSel?.options || [])
    .filter(o => o.value)
    .map(o => `<option value="${escHtml(o.value)}" ${o.value === currentObj ? 'selected' : ''}>${escHtml(o.textContent)}</option>`)
    .join('');

  const suggestedPattern = buildPatternFromVendor(currentSender);

  const panel = document.createElement('div');
  panel.className = 'fdl-ki-learn';
  panel.id = LEARN_PANEL_ID;
  panel.innerHTML = `
    <button class="fdl-ki-learn-close" title="Schließen" id="fdl-ki-close-btn">✕</button>
    <div class="fdl-ki-learn-title">Regel aus diesem Dokument merken?</div>
    <div class="fdl-ki-learn-body">
      <div class="fdl-ki-learn-field full">
        <label>Erkennungs-Stichwort (Absender)</label>
        <input type="text" id="fdl-ki-l-vendor" value="${escHtml(currentSender)}" placeholder="z.B. Stadtwerke Bonn">
        <div class="fdl-ki-pattern-hint" id="fdl-ki-pat-preview">Muster: ${escHtml(suggestedPattern || '—')}</div>
      </div>
      <div class="fdl-ki-learn-field">
        <label>Liegenschaft</label>
        <select id="fdl-ki-l-obj">
          <option value="">— wählen —</option>
          ${objOptions}
        </select>
      </div>
      <div class="fdl-ki-learn-field">
        <label>Absender-Name (im Feld)</label>
        <input type="text" id="fdl-ki-l-sender" value="${escHtml(currentSender)}" placeholder="Wie er im Absender-Feld stehen soll">
      </div>
      <div class="fdl-ki-learn-field">
        <label>Unterordner (optional)</label>
        <input type="text" id="fdl-ki-l-sub" value="${escHtml(currentSub)}" placeholder="z.B. D1, D4">
      </div>
    </div>
    <div class="fdl-ki-learn-actions">
      <button class="fdl-ki-save" id="fdl-ki-save-btn">Regel speichern</button>
      <button class="fdl-ki-dismiss" id="fdl-ki-dismiss-btn">Nicht merken</button>
      <span style="font-size:10.5px;color:var(--muted);margin-left:auto">Gespeichert in Zuordnungsmuster</span>
    </div>
  `;

  const point = bestLearnInsertPoint();
  if (!point) return;

  if (point.before) point.parent.insertBefore(panel, point.before);
  else point.parent.appendChild(panel);

  learnPanelEl = panel;

  q('fdl-ki-l-vendor')?.addEventListener('input', e => {
    const pat = buildPatternFromVendor(e.target.value.trim());
    const prev = q('fdl-ki-pat-preview');
    if (prev) prev.textContent = `Muster: ${pat || '—'}`;
  });

  q('fdl-ki-close-btn')?.addEventListener('click', removeLearnPanel);
  q('fdl-ki-dismiss-btn')?.addEventListener('click', removeLearnPanel);
  q('fdl-ki-save-btn')?.addEventListener('click', saveLearnedRule);
}

async function saveLearnedRule() {
  const vendor = normalizeWs(q('fdl-ki-l-vendor')?.value || '');
  const obj = normalizeWs(q('fdl-ki-l-obj')?.value || '');
  const sender = normalizeWs(q('fdl-ki-l-sender')?.value || '');
  const sub = normalizeWs(q('fdl-ki-l-sub')?.value || '');

  if (!vendor) {
    q('fdl-ki-l-vendor')?.focus();
    fdlToast('Bitte ein Stichwort oder einen Absender eingeben.', 2200);
    return;
  }
  if (!obj) {
    q('fdl-ki-l-obj')?.focus();
    fdlToast('Bitte eine Liegenschaft wählen.', 2200);
    return;
  }

  const pattern = buildPatternFromVendor(vendor);
  if (!pattern) {
    fdlToast('Konnte kein Muster erzeugen.', 2200);
    return;
  }

  try { new RegExp(pattern, 'i'); }
  catch {
    fdlToast('Ungültiges Erkennungs-Muster.', 2500);
    return;
  }

  const newRule = {
    pattern,
    object: obj,
    sender: sender || vendor,
    note: `auto: ${vendor}`
  };
  if (sub) newRule.subfolder = sub;

  try {
    let cfg = null;
    try {
      if (typeof loadJson === 'function') cfg = await loadJson('assignments.json');
    } catch {}

    if (!cfg || !Array.isArray(cfg.patterns)) cfg = { patterns: [] };

    const exists = cfg.patterns.some(r =>
      normalizeForCompare(r.pattern || '') === normalizeForCompare(pattern) &&
      normalizeForCompare(r.object || '') === normalizeForCompare(obj)
    );

    if (exists) {
      fdlToast('Eine ähnliche Regel ist bereits vorhanden.', 2600);
      removeLearnPanel();
      return;
    }

    cfg.patterns.push(newRule);

    if (typeof saveJson === 'function') await saveJson('assignments.json', cfg);
    window.assignmentsCfg = cfg;

    fdlToast(`<strong>Regel gelernt ✓</strong><br>${escHtml(vendor)} → ${escHtml(obj)}`, 3000);
    removeLearnPanel();
  } catch (e) {
    console.error('[FideliorKI] Speichern fehlgeschlagen:', e);
    fdlToast('Regel konnte nicht gespeichert werden.<br><small>Config-Verbindung prüfen.</small>', 4000);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ASSIGNMENTS-DIALOG PATCH
   ══════════════════════════════════════════════════════════════════════════ */

function patchAssignmentsDialog() {
  const observer = new MutationObserver(() => {
    const dlg = q('manageAssignmentsDialog');
    if (!dlg || !dlg.open || dlg._kiPatched) return;
    dlg._kiPatched = true;

    const table = dlg.querySelector('#assignTbody')?.closest('table');
    const theadRow = table?.querySelector('thead tr');

    if (theadRow && !dlg.querySelector('.ki-sender-th')) {
      const th = document.createElement('th');
      th.className = 'ki-sender-th';
      th.textContent = 'Absender (KI)';
      th.title = 'Wird beim Abgleich automatisch ins Absender-Feld eingetragen';
      theadRow.insertBefore(th, theadRow.lastElementChild);
    }

    const extendRow = (tr) => {
      if (!tr || tr.dataset.kiExtended) return;
      tr.dataset.kiExtended = '1';
      const delTd = tr.lastElementChild;
      const td = document.createElement('td');
      td.innerHTML = `<input class="input slim as-sender" placeholder="z.B. Stadtwerke Bonn" style="min-width:130px">`;
      tr.insertBefore(td, delTd);
    };

    dlg.querySelectorAll('#assignTbody tr').forEach(extendRow);

    const tbody = dlg.querySelector('#assignTbody');
    if (tbody && !tbody._kiObserver) {
      const tbodyObs = new MutationObserver(() => {
        tbody.querySelectorAll('tr').forEach(extendRow);
      });
      tbodyObs.observe(tbody, { childList: true });
      tbody._kiObserver = tbodyObs;
    }

    const saveBtn = dlg.querySelector('#assignSave');
    if (saveBtn && !saveBtn._kiSavePatched) {
      saveBtn._kiSavePatched = true;
      saveBtn.addEventListener('click', () => {
        setTimeout(async () => {
          try {
            const cfg = window.assignmentsCfg;
            if (!cfg?.patterns) return;

            const rows = dlg.querySelectorAll('#assignTbody tr');
            rows.forEach((tr, i) => {
              const senderVal = normalizeWs(tr.querySelector('.as-sender')?.value || '');
              if (!cfg.patterns[i]) return;
              if (senderVal) cfg.patterns[i].sender = senderVal;
              else delete cfg.patterns[i].sender;
            });

            if (typeof saveJson === 'function') await saveJson('assignments.json', cfg);
          } catch (e) {
            console.warn('[FideliorKI] sender-Feld Speichern fehlgeschlagen:', e);
          }
        }, 300);
      }, true);
    }

    const patterns = window.assignmentsCfg?.patterns || [];
    dlg.querySelectorAll('#assignTbody tr').forEach((tr, i) => {
      const senderInput = tr.querySelector('.as-sender');
      if (senderInput && patterns[i]?.sender) senderInput.value = patterns[i].sender;
    });
  });

  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open']
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   INPUT-WATCHER
   ══════════════════════════════════════════════════════════════════════════ */

function attachSenderWatcher() {
  const senderEl = getSenderEl();
  if (!senderEl || senderEl._kiWatching) return;
  senderEl._kiWatching = true;

  senderEl.addEventListener('input', () => {
    senderEl.dataset.userTyped = '1';
    delete senderEl.dataset.kiDetected;
    delete senderEl.dataset.kiSource;
    removeSenderBadge();
    setStatus('', '');
  });

  senderEl.addEventListener('change', () => {
    if (senderEl.value.trim()) senderEl.dataset.userTyped = '1';
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   HAUPT-HOOK
   ══════════════════════════════════════════════════════════════════════════ */

async function onOcr(txt, lines, assignmentsCfg) {
  try {
    const senderEl = getSenderEl();
    if (!senderEl) return;

    if (senderEl.dataset.userTyped === '1' && senderEl.value.trim()) return;

    let matchedRule = null;
    if (typeof evaluateAssignmentRules === 'function' && assignmentsCfg) {
      try { matchedRule = evaluateAssignmentRules(txt, assignmentsCfg); } catch {}
    }

    const result = extractSender(txt, lines, matchedRule);
    if (result?.value) {
      const current = normalizeWs(senderEl.value || '');
      const incoming = normalizeWs(result.value);

      const sameSender =
        normalizeForCompare(current) === normalizeForCompare(incoming);

      const mayWrite =
        !current ||
        senderEl.dataset.kiDetected === '1' ||
        sameSender;

      if (mayWrite) {
        if (!current) {
          senderEl.value = incoming;
          senderEl.classList.add('auto');
        }

        senderEl.dataset.kiDetected = '1';
        senderEl.dataset.kiSource = result.source;
        delete senderEl.dataset.userTyped;

        showSenderBadge(result.confidence, result.source);
        setStatus(result.confidence, `Absender erkannt: ${incoming}`);
senderEl.dataset.lastDetectedSender = incoming;

        if (typeof refreshPreview === 'function') {
          try { refreshPreview(); } catch {}
        }

        if (result.confidence !== 'high') {
          setTimeout(() => {
            const objSel = getObjSel();
            if (!learnPanelEl && (incoming || objSel?.value)) showLearnPanel(incoming);
          }, 550);
        }
      }
      return;
    }
    removeSenderBadge();
    setStatus('low', 'Kein sicherer Absender erkannt');

    const objSel = getObjSel();
    if (objSel?.value) {
      setTimeout(() => {
        if (!learnPanelEl) showLearnPanel('');
      }, 700);
    }
  } catch (e) {
    console.warn('[FideliorKI] onOcr Fehler:', e);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */

function init() {
  injectKiCSS();
  attachSenderWatcher();
  patchAssignmentsDialog();

  const origHardReset = window.hardReset;
  if (typeof origHardReset === 'function' && !origHardReset._kiWrapped) {
    const wrapped = function(...args) {
      clearKiUi();
      const senderEl = getSenderEl();
      if (senderEl) {
        delete senderEl.dataset.kiDetected;
        delete senderEl.dataset.kiSource;
        delete senderEl.dataset.userTyped;
      }
      return origHardReset.apply(this, args);
    };
    wrapped._kiWrapped = true;
    window.hardReset = wrapped;
  }

  window.fdlKiOnOcr = onOcr;
  console.info('[FideliorKI v2.0] geladen – robuste Absender-KI aktiv');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();