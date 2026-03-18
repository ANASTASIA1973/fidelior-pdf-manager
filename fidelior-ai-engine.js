/* =========================================================
   Fidelior AI Engine v2
   Zentrale Dokumentanalyse – eine Quelle der Wahrheit
   Liefert:
   - semanticType / type
   - sender / reference / amount / date
   - fields mit confidence/source
   - candidates / warnings / debug
========================================================= */

(() => {
  'use strict';

  function normalizeWs(s) {
    return String(s || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function normalizeCompare(s) {
    return normalizeWs(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s&.\-\/]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanToken(s) {
    return normalizeWs(s)
      .replace(/^[#:;.,\-\s]+/, '')
      .replace(/[,:;.]+$/, '')
      .trim();
  }

  function linesFromInput(text, lines) {
    if (Array.isArray(lines) && lines.length) {
      return lines
        .map(v => {
          if (typeof v === 'string') return normalizeWs(v);
          return normalizeWs(v?.text || '');
        })
        .filter(Boolean);
    }

    return String(text || '')
      .split(/\r?\n+/)
      .map(normalizeWs)
      .filter(Boolean);
  }
  function getPayload(text, linesInput) {
    const extractor = window.FideliorDocumentExtractor;
    if (extractor?.extractPayload) {
      return extractor.extractPayload(text, linesInput);
    }

    const lines = linesFromInput(text, linesInput);
    return {
      rawText: String(text || ""),
      lines,
      zones: {
        senderZone: lines.slice(0, 8),
        recipientZone: [],
        metaZone: [],
        bodyZone: lines.slice(8),
        tableZone: lines.slice(8),
        totalsZone: [],
        footerZone: [],
        headerTop: lines.slice(0, 8),
        recipientBlock: [],
        metaBlock: [],
        body: lines.slice(8),
        indices: {
          recipientStart: -1,
          recipientEnd: -1,
          metaStart: -1,
          metaEnd: -1,
          bodyStart: 8,
          footerStart: -1
        }
      },
      profile: null
    };
  }
  function mapConfidence(score) {
    if (score >= 14) return 'high';
    if (score >= 9) return 'medium';
    return 'low';
  }

  function scoreToSource(score, primary, fallback) {
    return score >= 9 ? primary : fallback;
  }

  function detectSemanticType(text) {
    const t = String(text || '').toLowerCase();

    if (/\b(zahlungserinnerung|mahnung|erste mahnung|zweite mahnung|dritte mahnung|reminder|payment reminder|overdue notice|inkasso|forderungsmanagement)\b/i.test(t)) {
      return 'mahnung';
    }
    if (/\b(gutschrift|credit note|refund)\b/i.test(t)) {
      return 'gutschrift';
    }
    if (/\b(angebot|offer|quotation)\b/i.test(t)) {
      return 'angebot';
    }
    if (/\b(rechnung|invoice|bill|verbrauchsabrechnung)\b/i.test(t)) {
      return 'rechnung';
    }
    return 'dokument';
  }

  function detectTypeFromSemantic(semanticType) {
    return (semanticType === 'rechnung' || semanticType === 'gutschrift') ? 'rechnung' : 'dokument';
  }

  function parseEuro(raw) {
    let x = String(raw || '')
      .replace(/[€\u00A0 ]/g, '')
      .replace(/−/g, '-');

    if (x.includes(',') && x.includes('.')) x = x.replace(/\./g, '').replace(',', '.');
    else if (x.includes(',')) x = x.replace(',', '.');

    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }

  function formatDisplayDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

function detectInvoiceDate(payload) {
  const zones = payload?.zones || {};
    const anchoredDate = window.FideliorSupplierProfiles?.detectByAnchor
    ? window.FideliorSupplierProfiles.detectByAnchor(payload, "date", payload?.profile || null)
    : "";

  if (anchoredDate) return anchoredDate;
    const profileDate = window.FideliorSupplierProfiles?.detectDateByProfile
    ? window.FideliorSupplierProfiles.detectDateByProfile(payload, payload?.profile || null)
    : "";

  if (profileDate) return profileDate;
  const scopedText = [
    ...(zones.metaZone || zones.metaBlock || []),
    ...(zones.senderZone || zones.headerTop || []),
    String(payload?.rawText || "")
  ].join('\n');

  const labelPatterns = [
    /rechnungsdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
    /invoice\s*date[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
    /datum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i
  ];

  for (const rx of labelPatterns) {
    const m = scopedText.match(rx);
    if (m) return m[1];
  }

  const hits = [];
  for (const m of scopedText.matchAll(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/g)) {
    const d = +m[1];
    const mo = +m[2];
    const y = String(m[3]).length === 2 ? (+m[3] < 50 ? 2000 + +m[3] : 1900 + +m[3]) : +m[3];
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    hits.push(iso);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const valid = hits.filter(v => v <= todayIso).sort();
  return valid.length ? formatDisplayDate(valid[valid.length - 1]) : '';
}

  function detectAmountCandidates(lines) {
    const candidates = [];
      // =====================================================
  // PRIORITÄT 1: echte Total-Zeilen sofort erkennen
  // =====================================================
  const totalLineRx = /(gesamt|summe|total|rechnungsbetrag|endbetrag|zu\s+zahlen|zahlbetrag)/i;
  const totalMoneyRx = /(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+\.\d{2})/g;

  for (let i = 0; i < lines.length; i++) {
    const text = normalizeWs(lines[i]);
    if (!text) continue;

    if (totalLineRx.test(text)) {
      const m = text.match(totalMoneyRx);
      if (m && m.length) {
        const raw = m[m.length - 1];

        // Datumsfragmente wie 04.02 ignorieren
        if (/^\d{1,2}[.\-\/]\d{1,2}$/.test(raw)) continue;

        const value = parseEuro(raw);

        if (Number.isFinite(value) && value > 0) {
          return [{
            value,
            raw,
            score: 50,
            line: text,
            index: i,
            source: 'Totalzeile'
          }];
        }
      }
    }
  }
    const priorityPatterns = [
      /noch\s+offen/i,
      /offener\s+betrag/i,
      /offene\s+forderung/i,
      /restbetrag/i,
      /zu\s+zahlen/i,
      /zu\s+überweisen/i,
      /bitte\s+überweisen/i,
      /gesamtforderung/i,
      /zu\s+zahlender\s+betrag/i,
      /zahlbetrag/i,
      /amount\s+due/i,
      /total\s+amount\s+due/i,
      /gesamtbetrag/i,
      /rechnungsbetrag/i,
      /invoice\s+total/i,
      /\bsumme\b/i,
      /\btotal\b/i
    ];

    const ignorePattern = /zwischensumme|subtotal|netto\b|rabatt|discount|ust|mwst|steuer|versand|skonto|abschlag/i;
    const moneyRx = /(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+\.\d{2})/g;

    lines.forEach((line, index) => {
      const text = normalizeWs(line);
      if (!text) return;

      const matches = [...text.matchAll(moneyRx)].map(m => m[1]).filter(Boolean);
      if (!matches.length) return;

      matches.forEach((raw, pos) => {
        const value = parseEuro(raw);
        if (!Number.isFinite(value) || value <= 0) return;

        let score = 1;
        if (priorityPatterns.some(rx => rx.test(text))) score += 12;
        if (ignorePattern.test(text)) score -= 6;
        if (pos === matches.length - 1) score += 1;
        if (value > 0 && value < 1000000) score += 1;
        // Mini-Beträge stark abwerten (typische OCR-Datumsfragmente)
if (value < 5) score -= 8;

        candidates.push({
          value,
          raw,
          score,
          line: text,
          index,
          source: 'Betrag aus Dokument'
        });
      });
    });

    return candidates.sort((a, b) => b.score - a.score);
  }

function detectSenderCandidates(payload) {
  const candidates = [];
  const lines = payload?.lines || [];
  const zones = payload?.zones || {};

  const companyRx = /\b(gmbh|ag|kg|ug|ohg|mbh|ltd|inc|company|corp|llc|holding|immobilien|hausverwaltung|verwaltung|management|solutions|services|service|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke)\b/i;
  const negativeRx = /\b(rechnung|invoice|kundennummer|kundenummer|vertragsnummer|vertrag|iban|bic|swift|telefon|fax|e-?mail|email|www\.|ust|mwst|steuer|datum|seite|page|tarif)\b/i;
  const zipCityRx = /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{2,}/;
  const streetRx = /\b(straße|str\.|weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive)\b/i;
  const urlRx = /(https?:\/\/|www\.)/i;

  function pushCandidate(s, baseScore, source, index) {
    const line = normalizeWs(s);
    if (!line) return;
    if (line.length < 3 || line.length > 120) return;
    if (urlRx.test(line)) return;
    if (zipCityRx.test(line)) return;
    if (streetRx.test(line)) return;

    let score = baseScore;

    if (companyRx.test(line)) score += 12;
    if (!negativeRx.test(line)) score += 2;
    if (!/\d/.test(line)) score += 1;
    if (/^[A-ZÄÖÜ0-9][A-Za-zÄÖÜäöüß&.\- ]+$/.test(line)) score += 1;
    if (negativeRx.test(line) && !companyRx.test(line)) score -= 10;
    if (/^\b(name|anschrift|adresse)\b[:\s]/i.test(line)) score -= 8;
    if (/^(sehr geehrte|guten tag|hallo)\b/i.test(line)) score -= 10;

    if (score > 0) {
      candidates.push({
        value: line.replace(/^(name|firma)\s*:\s*/i, '').trim(),
        score,
        line,
        index,
        source
      });
    }
  }

  (zones.senderZone || zones.headerTop || []).forEach((line, idx) => {
    let score = 10;
    if (idx <= 2) score += 4;
    pushCandidate(line, score, 'Absenderzone', idx);
  });

  (zones.metaZone || zones.metaBlock || []).forEach((line, idx) => {
    if (companyRx.test(line) && !negativeRx.test(line)) {
      pushCandidate(line, 7, 'Metazone', idx);
    }
  });

  const labelMatch = String(payload?.rawText || '').match(/\b(?:rechnungssteller|lieferant|anbieter|auftragnehmer|firma|vendor|supplier)\b[:\s]+([^\n]+)/i);
  if (labelMatch && labelMatch[1]) {
    const candidate = cleanToken(labelMatch[1]);
    if (candidate) {
      candidates.push({
        value: candidate,
        score: 18,
        line: candidate,
        index: -1,
        source: 'Label im Dokument'
      });
    }
  }

  const profile = payload?.profile || null;
  if (profile?.name) {
    candidates.push({
      value: normalizeWs(profile.name),
      score: 26,
      line: profile.name,
      index: -1,
      source: 'Lieferantenprofil'
    });
  }

  const dedup = new Map();
  candidates.forEach(c => {
    const key = normalizeCompare(c.value);
    if (!key) return;
    const prev = dedup.get(key);
    if (!prev || c.score > prev.score) dedup.set(key, c);
  });

  return [...dedup.values()].sort((a, b) => b.score - a.score);
}
function detectReferenceCandidates(payload) {
  const joined = String(payload?.rawText || '');
  const lines = payload?.lines || [];
  const zones = payload?.zones || {};
  const candidates = [];

  const labelPatterns = [
    /\b(rechnungs?(?:nummer|nr|no)\.?|rechnung\s*#|rg-?nr\.?|rn\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/gi,
    /\b(invoice\s*(?:no|nr|number)?|inv\.?\s*no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/gi
  ];

  const badPrefix = /^(KDNR|KUNDENNR|KUNDENNUMMER|KUNDE|CUSTOMER|ACCOUNT|AUFTRAG|BESTELL|ORDER|VERTRAG|CONTRACT|CLIENT|ACC|BIC|IBAN|SWIFT)\b/i;
  const ibanLike = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;
  const dateLike = /^(\d{1,2}[.\-/]){2}\d{2,4}$/i;

  const addCandidate = (value, line, score, source) => {
    const token = cleanToken(value).replace(/\s+/g, '');
    if (!token) return;
    if (token.length < 4 || token.length > 24) return;
    if (!/\d/.test(token)) return;
    if (dateLike.test(token)) return;
    if (ibanLike.test(token)) return;
    if (badPrefix.test(token)) return;

    candidates.push({
      value: token,
      score,
      line: normalizeWs(line),
      source
    });
  };

  for (const rx of labelPatterns) {
    let m;
    while ((m = rx.exec(joined))) {
      addCandidate(m[2], m[0], 18, 'Label Rechnungsnummer');
    }
  }

  const metaLines = (zones.metaZone || zones.metaBlock || []).length
    ? (zones.metaZone || zones.metaBlock || [])
    : lines.slice(0, 16);

  metaLines.forEach(line => {
    const s = normalizeWs(line);
    if (!s) return;

    const m = s.match(/\b(rechnungs?(?:nummer|nr|no)\.?|invoice\s*(?:no|nr|number)?|inv\.?\s*no\.?)\b[:#\s-]*([A-Z0-9._/-]{4,})/i);
    if (m && m[2]) addCandidate(m[2], s, 22, 'Metazone Rechnungsnummer');

    const km = s.match(/\b(kundennummer|kunden\-?nr|customer\s*(?:no|number))\b[:#\s-]*([A-Z0-9._/-]{4,})/i);
    if (km && km[2]) {
      candidates.push({
        value: cleanToken(km[2]).replace(/\s+/g, ''),
        score: 2,
        line: s,
        source: 'Kundennummer'
      });
    }
  });

  const dedup = new Map();
  candidates.forEach(c => {
    const key = normalizeCompare(c.value);
    if (!key) return;
    const prev = dedup.get(key);
    if (!prev || c.score > prev.score) dedup.set(key, c);
  });

  return [...dedup.values()]
    .filter(c => c.score >= 8)
    .sort((a, b) => b.score - a.score);
}

  function buildField(best, fallbackValue = '') {
    if (!best) {
      return {
        value: fallbackValue || '',
        confidence: 'low',
        source: 'keine sichere Erkennung',
        score: 0
      };
    }

    return {
      value: best.value,
      confidence: mapConfidence(best.score),
      source: best.source || 'Dokumentanalyse',
      score: best.score,
      line: best.line || ''
    };
  }

function analyzeDocument(text, linesInput) {
  const payload = getPayload(text, linesInput);
  const textString = payload.rawText || '';
  const lines = payload.lines || [];
  const zones = payload.zones || {};

  const semanticType = detectSemanticType(textString);
  const type = detectTypeFromSemantic(semanticType);

  const supplierApi = window.FideliorSupplierProfiles || null;

  const senderCandidatesRaw = detectSenderCandidates(payload);
  const referenceCandidatesRaw = detectReferenceCandidates(payload);

  const amountSourceLines = [
    ...(zones.totalsZone || []),
    ...(zones.tableZone || []),
    ...(lines || [])
  ];
  const amountCandidatesRaw = detectAmountCandidates(amountSourceLines);

  let senderCandidates = supplierApi?.boostCandidates
    ? supplierApi.boostCandidates("sender", senderCandidatesRaw, payload.profile, payload)
    : senderCandidatesRaw;

  let referenceCandidates = supplierApi?.boostCandidates
    ? supplierApi.boostCandidates("reference", referenceCandidatesRaw, payload.profile, payload)
    : referenceCandidatesRaw;

  let amountCandidates = supplierApi?.boostCandidates
    ? supplierApi.boostCandidates("amount", amountCandidatesRaw, payload.profile, payload)
    : amountCandidatesRaw;

  if (supplierApi?.boostByAnchors) {
    senderCandidates = supplierApi.boostByAnchors("sender", senderCandidates, payload.profile, payload);
    referenceCandidates = supplierApi.boostByAnchors("reference", referenceCandidates, payload.profile, payload);
    amountCandidates = supplierApi.boostByAnchors("amount", amountCandidates, payload.profile, payload);
  }

   let senderField = buildField(senderCandidates[0]);
  let referenceField = (type === 'rechnung') ? buildField(referenceCandidates[0]) : buildField(null);

  const anchoredSender = supplierApi?.detectByAnchor
    ? supplierApi.detectByAnchor(payload, "sender", payload.profile, payload)
    : "";

  const anchoredReference = supplierApi?.detectByAnchor
    ? supplierApi.detectByAnchor(payload, "reference", payload.profile, payload)
    : "";

  if ((!senderField.value || senderField.confidence === "low") && anchoredSender) {
    senderField = {
      value: anchoredSender,
      confidence: "medium",
      score: 11,
      source: "Gelernter Feldanker"
    };
  }

  if (type === "rechnung" && (!referenceField.value || referenceField.confidence === "low") && anchoredReference) {
    referenceField = {
      value: anchoredReference,
      confidence: "medium",
      score: 11,
      source: "Gelernter Feldanker"
    };
  }
  let bestAmount = amountCandidates[0] || null;

  if (bestAmount && bestAmount.value < 10) {
    const line = (bestAmount.line || '').toLowerCase();
    if (!/(gesamt|summe|total|betrag|zu zahlen|rechnungsbetrag|amount due|invoice total)/.test(line)) {
      bestAmount = null;
    }
  }
  const anchoredAmount = supplierApi?.detectByAnchor
    ? supplierApi.detectByAnchor(payload, "amount", payload.profile, payload)
    : "";

  if (!bestAmount && anchoredAmount) {
    bestAmount = {
      value: anchoredAmount,
      score: 11,
      source: "Gelernter Feldanker",
      line: anchoredAmount
    };
  }
 let amountField;

if (window.FideliorCandidateVoter) {

  const voted = window.FideliorCandidateVoter.pickBestCandidate(amountCandidates);

  amountField = {
    value: voted.value,
    confidence: voted.confidence,
    score: voted.score,
    source: voted.source,
    line: voted.line
  };

} else {

  amountField = buildField(bestAmount);

}
  const dateValue = detectInvoiceDate(payload);

  const warnings = [];
  if (!senderField.value) warnings.push('Absender nicht sicher erkannt');
  if (type === 'rechnung' && !referenceField.value) warnings.push('Rechnungsnummer nicht sicher erkannt');
  if (!Number.isFinite(amountField.value)) warnings.push('Betrag nicht sicher erkannt');
  if (!dateValue) warnings.push('Rechnungsdatum nicht sicher erkannt');

  return {
    type,
    semanticType,

    sender: senderField.value || '',
    reference: referenceField.value || '',
    amount: Number.isFinite(amountField.value) ? amountField.value : NaN,
    date: dateValue || '',

    fields: {
      sender: senderField,
      reference: referenceField,
      amount: {
        value: Number.isFinite(amountField.value) ? amountField.value : NaN,
        confidence: amountField.confidence,
        source: amountField.source,
        score: amountField.score,
        line: amountField.line
      },
      date: {
        value: dateValue || '',
        confidence: dateValue ? 'medium' : 'low',
        source: dateValue ? 'Datumsanalyse' : 'keine sichere Erkennung',
        score: dateValue ? 9 : 0
      }
    },

    candidates: {
      sender: senderCandidates,
      reference: referenceCandidates,
      amount: amountCandidates
    },

    warnings,
    debug: {
      lineCount: lines.length,
      zones: {
        senderZone: (zones.senderZone || []).length,
        recipientZone: (zones.recipientZone || []).length,
        metaZone: (zones.metaZone || []).length,
        tableZone: (zones.tableZone || []).length,
        totalsZone: (zones.totalsZone || []).length,
        footerZone: (zones.footerZone || []).length
      }
    }
  };
}
  window.FideliorAI = {
    analyzeDocument
  };

  console.info('[FideliorAI] zentrale Analyse-Engine aktiv');
})();