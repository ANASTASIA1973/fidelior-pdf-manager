(function () {
  "use strict";

  function normalizeWs(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function detectDocType(text, profile) {
    const t = String(text || "").toLowerCase();

    if (/\b(zahlungserinnerung|mahnung|reminder|overdue)\b/i.test(t)) return "mahnung";
    if (/\b(gutschrift|credit note|refund)\b/i.test(t)) return "gutschrift";
    if (/\b(angebot|offer|quotation)\b/i.test(t)) return "angebot";
    if (/\b(rechnung|invoice|bill|verbrauchsabrechnung)\b/i.test(t)) return "rechnung";
    if (/\b(versicherung|vertragsstand|vertragsdaten|vertragsbestätigung)\b/i.test(t)) return "vertrag";
    if (profile?.docTypeHints?.length) return profile.docTypeHints[0];
    return "dokument";
  }

  function cleanupCompanyLine(line) {
    let s = normalizeWs(line);
    s = s.replace(/^[-–—:\s]+/, "").trim();
    s = s.replace(/\s*[-,]\s*(postfach|straße|str\.|weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig)\b.*$/i, "").trim();
    s = s.replace(/\s*,\s*\d{5}\s+[A-ZÄÖÜ].*$/i, "").trim();
    s = s.replace(/\s*-\s*\d{5}\s+[A-ZÄÖÜ].*$/i, "").trim();
    return s;
  }

  function detectSender(payload) {
    const { rawText, lines, zones, profile } = payload;
    const companyRx = /\b(gmbh|ag|kg|ug|ohg|mbh|ltd|inc|versicherung|energie|steuerberatung|kanzlei|werke|bank)\b/i;
    const negativeRx = /\b(rechnung|invoice|vertragsdaten|für den zeitraum|beitragszahlung|kundennummer|vertragsnummer|datum|seite|tarif|guten tag|sehr geehrte)\b/i;

    if (profile?.name) {
      for (const line of lines.slice(0, 15)) {
        if ((profile.senderPatterns || []).some(rx => rx.test(line))) {
          return cleanupCompanyLine(line);
        }
      }
    }

    for (const line of zones.headerTop || []) {
      const s = normalizeWs(line);
      if (!s) continue;
      if (negativeRx.test(s) && !companyRx.test(s)) continue;
      if (companyRx.test(s)) return cleanupCompanyLine(s);
    }

    for (const line of lines.slice(0, 12)) {
      const s = normalizeWs(line);
      if (!s) continue;
      if (negativeRx.test(s) && !companyRx.test(s)) continue;
      if (companyRx.test(s)) return cleanupCompanyLine(s);
    }

    return "";
  }

  function detectInvoiceNumber(payload, docType) {
    if (!/^(rechnung|gutschrift|mahnung)$/.test(docType)) return "";

    const text = payload.rawText || "";
    const profile = payload.profile || null;

    const basePatterns = [
      /\b(rechnungs?(?:nummer|nr|no)\.?|rechnung\s*#|rg-?nr\.?|rn\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
      /\b(invoice\s*(?:no|nr|number)?|inv\.?\s*no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i
    ];

    for (const rx of basePatterns) {
      const m = text.match(rx);
      if (m?.[2]) return m[2].trim();
    }

    for (const rx of (profile?.invoiceNumberPatterns || [])) {
      const m = text.match(rx);
      if (m?.[1]) return m[1].trim();
    }

    return "";
  }

  function detectInvoiceDate(payload) {
    const text = payload.rawText || "";
    const labelPatterns = [
      /rechnungsdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
      /invoice\s*date[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
      /datum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i
    ];

    for (const rx of labelPatterns) {
      const m = text.match(rx);
      if (m?.[1]) return m[1];
    }

    const plain = text.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/);
    return plain?.[1] || "";
  }

  function parseEuro(raw) {
    let x = String(raw || "")
      .replace(/[€\u00A0 ]/g, "")
      .replace(/−/g, "-");

    if (x.includes(",") && x.includes(".")) x = x.replace(/\./g, "").replace(",", ".");
    else if (x.includes(",")) x = x.replace(",", ".");

    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }

  function detectGrossAmount(payload, docType) {
    if (!/^(rechnung|gutschrift|mahnung)$/.test(docType)) return NaN;

    const lines = payload.lines || [];
    const strongTotalRx = /(gesamtbetrag|rechnungsbetrag|endbetrag|zu\s+zahlen|zahlbetrag|amount\s+due|invoice\s+total|total\s+amount\s+due|bruttobetrag|rechnungsbetrag)/i;
    const mediumTotalRx = /(\bgesamtsumme\b|\bsumme\b|\btotal\b|\bbrutto\b)/i;
    const moneyRx = /(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+\.\d{2})/g;

    for (const line of lines) {
      const text = normalizeWs(line);
      if (!text) continue;
      if (!strongTotalRx.test(text)) continue;

      const matches = [...text.matchAll(moneyRx)].map(m => m[1]).filter(Boolean);
      if (!matches.length) continue;

      const raw = matches[matches.length - 1];
      const value = parseEuro(raw);
      if (Number.isFinite(value) && value > 0) return value;
    }

    const candidates = [];

    for (const line of lines) {
      const text = normalizeWs(line);
      if (!text) continue;
      if (!mediumTotalRx.test(text)) continue;

      const matches = [...text.matchAll(moneyRx)].map(m => m[1]).filter(Boolean);
      if (!matches.length) continue;

      const raw = matches[matches.length - 1];
      const value = parseEuro(raw);
      if (Number.isFinite(value) && value > 0) candidates.push(value);
    }

    return candidates.length ? candidates[candidates.length - 1] : NaN;
  }

  function buildSummary(result) {
    const parts = [];
    if (result.docType === "rechnung") parts.push("Rechnung");
    else if (result.docType) parts.push(result.docType);

    if (result.sender) parts.push(`von ${result.sender}`);
    if (Number.isFinite(result.amount)) parts.push(`über ${result.amount.toFixed(2).replace(".", ",")} EUR`);
    if (result.invoiceDate) parts.push(`vom ${result.invoiceDate}`);

    return parts.join(" ");
  }

  function analyze(text, linesInput) {
    const payload = window.FideliorDocumentExtractor.extractPayload(text, linesInput);
    const docType = detectDocType(payload.rawText, payload.profile);
    const sender = detectSender(payload);
    const invoiceNumber = detectInvoiceNumber(payload, docType);
    const invoiceDate = detectInvoiceDate(payload);
    const amount = detectGrossAmount(payload, docType);

    return {
      payload,
      profile: payload.profile || null,
      docType,
      sender,
      invoiceNumber,
      invoiceDate,
      amount,
      summary: "",
      confidence: 0.7
    };
  }

  window.FideliorDocAnalyzer = {
    analyze,
    buildSummary
  };
})();