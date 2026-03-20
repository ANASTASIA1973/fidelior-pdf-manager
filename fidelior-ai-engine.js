/* =========================================================
   Fidelior AI Engine v5
   Zentrale Dokumentanalyse – Single Source of Truth

   Ziele:
   - nur eine fachliche Analysequelle
   - Kandidaten -> Scoring -> Confidence -> Feldwert
   - Supplier Profiles dürfen nur boosten, nicht blind überschreiben
   - UI darf nur noch rendern
   - lieber leer als falsch
========================================================= */

(() => {
  "use strict";

  /* =========================================================
     BASICS
  ========================================================= */

  function normalizeWs(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function normalizeCompare(s) {
    return normalizeWs(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s&.\-\/]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanToken(s) {
    return normalizeWs(s)
      .replace(/^[#:;.,\-\s]+/, "")
      .replace(/[,:;.]+$/, "")
      .trim();
  }

  function linesFromInput(text, lines) {
    if (Array.isArray(lines) && lines.length) {
      return lines
        .map(v => {
          if (typeof v === "string") return normalizeWs(v);
          return normalizeWs(v?.text || "");
        })
        .filter(Boolean);
    }

    return String(text || "")
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
        metaZone: lines.slice(8, 18),
        bodyZone: lines.slice(18),
        tableZone: lines.slice(18),
        totalsZone: lines.slice(-12),
        footerZone: lines.slice(-10),
        headerTop: lines.slice(0, 8),
        recipientBlock: [],
        metaBlock: lines.slice(8, 18),
        body: lines.slice(18),
        indices: {
          recipientStart: -1,
          recipientEnd: -1,
          metaStart: 8,
          metaEnd: 18,
          bodyStart: 18,
          footerStart: Math.max(0, lines.length - 10)
        }
      },
      profile: null
    };
  }

  function parseEuro(raw) {
    let x = String(raw || "")
      .replace(/[€\u00A0 ]/g, "")
      .replace(/−/g, "-");

    if (x.includes(",") && x.includes(".")) {
      x = x.replace(/\./g, "").replace(",", ".");
    } else if (x.includes(",")) {
      x = x.replace(",", ".");
    }

    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }

  function formatDisplayDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function toIsoDate(raw) {
    const m = String(raw || "").match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/);
    if (!m) return "";

    const d = +m[1];
    const mo = +m[2];
    const y = String(m[3]).length === 2
      ? (+m[3] < 50 ? 2000 + +m[3] : 1900 + +m[3])
      : +m[3];

    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2100) return "";
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function dedupeCandidates(candidates, keyFn) {
    const map = new Map();

    candidates.forEach(c => {
      const key = keyFn(c);
      if (!key) return;

      const prev = map.get(key);
      if (!prev || (c.score || 0) > (prev.score || 0)) {
        map.set(key, c);
      }
    });

    return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  function mapConfidence(score, margin) {
    if (score >= 24 && margin >= 6) return "high";
    if (score >= 16 && margin >= 4) return "high";
    if (score >= 11 && margin >= 2) return "medium";
    return "low";
  }

  function finalizeField(candidates, opts = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const best = list[0] || null;
    const second = list[1] || null;

    const margin = best ? (best.score || 0) - (second?.score || 0) : 0;
    const confidence = best ? mapConfidence(best.score || 0, margin) : "low";

    const minScore = opts.minScore ?? 12;
    const minMargin = opts.minMargin ?? 3;
    const emptyValue = Object.prototype.hasOwnProperty.call(opts, "emptyValue")
      ? opts.emptyValue
      : "";

    if (!best) return empty();

    if ((best.score || 0) < minScore) return empty();
    if (margin < minMargin) return empty();
    if (confidence !== "high") return empty();

    return {
      value: best.value,
      confidence,
      score: best.score || 0,
      margin,
      source: best.source || "Dokumentanalyse",
      line: best.line || "",
      candidates: list
    };

    function empty() {
      return {
        value: emptyValue,
        confidence: "low",
        score: 0,
        margin: 0,
        source: "keine sichere Erkennung",
        line: "",
        candidates: list
      };
    }
  }

  function applyProfileBoost(kind, candidates, profile, payload) {
    const api = window.FideliorSupplierProfiles || null;
    let out = Array.isArray(candidates) ? [...candidates] : [];

    if (api?.boostCandidates) {
      try { out = api.boostCandidates(kind, out, profile, payload) || out; } catch {}
    }

    if (api?.boostByAnchors) {
      try { out = api.boostByAnchors(kind, out, profile, payload) || out; } catch {}
    }

    return out.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  function applyNegativeRules(kind, candidates, payload) {
    const neg = window.FideliorNegativeRules || null;
    let out = Array.isArray(candidates) ? [...candidates] : [];

    if (kind === "reference" && neg?.isBadReferenceCandidate) {
      out = out.filter(c => !neg.isBadReferenceCandidate(c, payload?.rawText || ""));
    }

    if (kind === "amount" && neg?.isBadAmountCandidate) {
      out = out.filter(c => !neg.isBadAmountCandidate(c));
    }

    return out;
  }

  /* =========================================================
     SEMANTIC TYPE
  ========================================================= */

  function detectSemanticType(text) {
    const t = String(text || "").toLowerCase();
    const neg = window.FideliorNegativeRules || null;

    if (neg?.isDefinitelyNotInvoice && neg.isDefinitelyNotInvoice(t)) {
      return "dokument";
    }

    if (/\b(zahlungserinnerung|mahnung|erste mahnung|zweite mahnung|dritte mahnung|reminder|payment reminder|overdue notice|inkasso|forderungsmanagement)\b/i.test(t)) {
      return "mahnung";
    }

    if (/\b(gutschrift|credit note|refund)\b/i.test(t)) {
      return "gutschrift";
    }

    if (/\b(angebot|offer|quotation)\b/i.test(t)) {
      return "angebot";
    }

    if (/\b(vertragsbestätigung|auftragsbestätigung|bestätigung)\b/i.test(t)) {
      return "vertrag";
    }

    const hasInvoiceLabel = /\b(rechnung|invoice|bill|verbrauchsabrechnung|liquidation)\b/i.test(t);
    const hasTotal = /\b(gesamt|summe|total|zu zahlen|rechnungsbetrag|invoice total|amount due|zahlbetrag|endbetrag)\b/i.test(t);
    const hasCurrency = /€|\beur\b/i.test(t);

    if (hasInvoiceLabel && (hasTotal || hasCurrency)) {
      return "rechnung";
    }

    return "dokument";
  }

  function detectTypeFromSemantic(semanticType) {
    return (semanticType === "rechnung" || semanticType === "gutschrift") ? "rechnung" : "dokument";
  }

  /* =========================================================
     SENDER
  ========================================================= */

  function detectSenderCandidates(payload) {
    const candidates = [];
    const zones = payload?.zones || {};
    const profile = payload?.profile || null;

    const companyRx = /\b(gmbh|ag|kg|ug|ohg|mbh|ltd|inc|company|corp|llc|holding|immobilien|hausverwaltung|verwaltung|management|solutions|services|service|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke|wasser|praxis|arzt|apotheke|steuerberatung|steuerberater|notar|rechtsanwalt)\b/i;
    const negativeRx = /\b(rechnung|invoice|kundennummer|kundenummer|vertragsnummer|vertrag|iban|bic|swift|telefon|fax|e-?mail|email|www\.|ust|mwst|steuer|datum|seite|page|tarif|lieferadresse|rechnungsadresse|leistungsempfänger)\b/i;
    const greetingRx = /^(sehr geehrte|guten tag|hallo)\b/i;

    function pushCandidate(line, baseScore, source, index, zoneTag) {
      const s = normalizeWs(line);
      if (!s) return;

      if (s.length < 3 || s.length > 80) return;
      if (s.split(/\s+/).length > 6) return;
      if (/[.!?]/.test(s)) return;
      if (greetingRx.test(s)) return;

      if (/\b(wir|sie|bitte|danke|hiermit|prüfung|zahlung|überweisen|kontaktieren)\b/i.test(s)) return;
      if (/\d{5}\s+[A-Za-zÄÖÜäöüß]/.test(s)) return;
      if (/\b(straße|str\.|weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive)\b/i.test(s)) return;

      let score = baseScore;

      if (companyRx.test(s)) score += 12;
      if (!negativeRx.test(s)) score += 2;
      if (!/\d/.test(s)) score += 1;
      if (/^(name|firma)\s*:/i.test(s)) score += 4;

      if (zoneTag === "senderZone") score += 6;
      if (zoneTag === "recipientZone") score -= 20;
      if (zoneTag === "metaZone") score -= 2;

      if (score <= 0) return;

      candidates.push({
        value: s.replace(/^(name|firma)\s*:\s*/i, "").trim(),
        score,
        line: s,
        index: Number.isInteger(index) ? index : -1,
        source
      });
    }

    (zones.senderZone || zones.headerTop || []).forEach((line, idx) => {
      pushCandidate(line, idx <= 2 ? 12 : 9, "Absenderzone", idx, "senderZone");
    });

    (zones.metaZone || zones.metaBlock || []).forEach((line, idx) => {
      pushCandidate(line, 4, "Metazone", idx, "metaZone");
    });

    (zones.recipientZone || zones.recipientBlock || []).forEach((line, idx) => {
      pushCandidate(line, 2, "Empfängerzone", idx, "recipientZone");
    });

    const labelMatch = String(payload?.rawText || "").match(/\b(?:rechnungssteller|lieferant|anbieter|auftragnehmer|firma|vendor|supplier)\b[:\s]+([^\n]+)/i);
    if (labelMatch && labelMatch[1]) {
      pushCandidate(cleanToken(labelMatch[1]), 20, "Label im Dokument", -1, "metaZone");
    }

    if (profile?.name) {
      candidates.push({
        value: normalizeWs(profile.name),
        score: 24,
        line: profile.name,
        index: -1,
        source: "Lieferantenprofil"
      });
    }

    return dedupeCandidates(candidates, c => normalizeCompare(c.value));
  }

  /* =========================================================
     REFERENCE / INVOICE NUMBER
  ========================================================= */

  function detectReferenceCandidates(payload, semanticType) {
    const joined = String(payload?.rawText || "");
    const lines = payload?.lines || [];
    const profile = payload?.profile || null;
    const candidates = [];

    const labelPatterns = [
      /\b(rechnungs?(?:nummer|nr|no)?|rechnung)\b\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/gi,
      /\b(invoice\s*(?:no|nr|number)?|invoice)\b\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/gi,
      /\b(rg-?nr\.?|rn\.?)\b\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,})/gi
    ];

    const genericTokenRx = /\b([A-Z]?\d[A-Z0-9._/-]{5,23})\b/g;
    const badPrefix = /^(KDNR|KUNDENNR|KUNDENNUMMER|KUNDE|CUSTOMER|ACCOUNT|AUFTRAG|BESTELL|ORDER|VERTRAG|CONTRACT|CLIENT|ACC|BIC|IBAN|SWIFT|DATUM|DATE|SEITE|PAGE|ERSTELLT|KOPIE|COPY|ORIGINAL)\b/i;
    const badExact = /^(erstellt|datum|date|seite|page|kopie|copy|original|kunde|customer|vertrag|contract)$/i;
    const badLineRx = /\b(kundennummer|kunden\-?nr|customer\s*(?:no|number)|iban|bic|swift|vertragskonto|mandatsreferenz|mandats\-?ref|rufnummer|telefonnummer|auftragsnummer|bestellnummer|vertrags\-?nr)\b/i;
    const ibanLike = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;
    const dateLike = /^(\d{1,2}[.\-/]){2}\d{2,4}$/i;

    function addCandidate(value, line, score, source, index) {
      const token = cleanToken(value).replace(/\s+/g, "");
      const lineNorm = normalizeWs(line);

      if (!token) return;
      if (token.length < 4 || token.length > 28) return;
      if (!/\d/.test(token)) return;
      if (badPrefix.test(token)) return;
      if (badExact.test(token)) return;
      if (ibanLike.test(token)) return;
      if (dateLike.test(token)) return;
      if (badLineRx.test(lineNorm) && !/\b(rechnung|invoice|rg-?nr|rn\.?)\b/i.test(lineNorm)) return;

      let nextScore = score;

      if (/^(?:[A-Z]{0,3}\d{6,}|[A-Z0-9._/-]*\d[A-Z0-9._/-]*)$/i.test(token)) nextScore += 5;
      if (/\b(rechnung|invoice|rg-?nr|rn\.?)\b/i.test(lineNorm)) nextScore += 12;
      if (/rechnung\s+[A-Z0-9]/i.test(lineNorm)) nextScore += 10;
      if (semanticType === "rechnung" || semanticType === "gutschrift") nextScore += 2;

      candidates.push({
        value: token,
        score: nextScore,
        line: lineNorm,
        index: Number.isInteger(index) ? index : -1,
        source
      });
    }

    for (const rx of labelPatterns) {
      let m;
      const safe = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
      while ((m = safe.exec(joined))) {
        addCandidate(m[2], m[0], 20, "Label im Dokument", -1);
      }
    }

    lines.forEach((s, idx) => {
      const line = normalizeWs(s);
      if (!line) return;

      const lineHasInvoiceLabel = /\b(rechnung|invoice|rg-?nr|rn\.?)\b/i.test(line);
      if (lineHasInvoiceLabel) {
        const m = line.match(/\b([A-Z0-9][A-Z0-9._/-]{3,24})\b/g) || [];
        m.forEach(token => addCandidate(token, line, 14, "Rechnungszeile", idx));
      }

      const km = line.match(/\b(kundennummer|kunden\-?nr|customer\s*(?:no|number))\b[:#\s-]*([A-Z0-9._/-]{4,})/i);
      if (km && km[2]) {
        candidates.push({
          value: cleanToken(km[2]).replace(/\s+/g, ""),
          score: 1,
          line,
          index: idx,
          source: "Kundennummer"
        });
      }

      let m2;
      const safeGeneric = new RegExp(genericTokenRx.source, "g");
      while ((m2 = safeGeneric.exec(line))) {
        addCandidate(
          m2[1],
          line,
          lineHasInvoiceLabel ? 10 : 4,
          lineHasInvoiceLabel ? "Rechnungszeile" : "Generischer Token",
          idx
        );
      }
    });

    if (Array.isArray(profile?.invoiceNumberPatterns)) {
      for (const rx of profile.invoiceNumberPatterns) {
        if (!(rx instanceof RegExp)) continue;

        const safeRx = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
        let m;
        while ((m = safeRx.exec(joined))) {
          addCandidate(m[1] || m[0], m[0], 26, "Lieferantenprofil Rechnungsnummer", -1);
        }
      }
    }

    return dedupeCandidates(candidates, c => normalizeCompare(c.value))
      .filter(c => (c.score || 0) >= 8);
  }

  /* =========================================================
     AMOUNT
  ========================================================= */

  function detectAmountCandidates(payload, semanticType) {
    const totalsZone = payload?.zones?.totalsZone || [];
    const tableZone = payload?.zones?.tableZone || [];
    const allLines = payload?.lines || [];

    const lines = [
      ...totalsZone,
      ...tableZone,
      ...allLines
    ];

    const candidates = [];

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
      /\btotal\b/i,
      /endbetrag/i,
      /bruttorechnungsbetrag/i,
      /bruttobetrag/i,
      /gesamt\s*eur/i,
      /betrag\s+inkl\.?\s*(mwst|mehrwertsteuer|ust)\b/i,
      /\bbruttosumme\b/i,
      /\bgesamtpreis\b/i,
      /\bbetrag\s+eur\s+inkl\.?\s*mwst\b/i,
      /\brechnungsendbetrag\b/i
    ];

   const strongTotalLabels =
      /\b(zu\s+zahlen|gesamtbetrag|rechnungsbetrag|endbetrag|rechnungsendbetrag|amount\s+due|invoice\s+total|bruttorechnungsbetrag|bruttobetrag|betrag\s+inkl\.?\s*(?:mwst|mehrwertsteuer|ust)|betrag\s+eur\s+inkl\.?\s*mwst)\b/i;

const ignorePattern =
      /zwischensumme|subtotal|netto\b|rabatt|discount|versand|skonto|abschlag/i;

    const taxOnlyPattern =
      /\b(mwst|ust|vat|tax|steuer)\b/i;

    const moneyRx =
      /(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+\.\d{2})/g;

    lines.forEach((rawLine, index) => {
      const text = normalizeWs(rawLine);
      if (!text) return;
            const hasInklMwst =
        /\binkl\.?\s*(mwst|mehrwertsteuer|ust)\b/i.test(text) ||
        /\bbetrag\s+eur\s+inkl\.?\s*mwst\b/i.test(text);

      const hasFinalTotalLabel =
        /\b(rechnungsendbetrag|endbetrag|rechnungsbetrag|gesamtbetrag|zahlbetrag|zu\s+zahlen|betrag\s+inkl\.?\s*(?:mwst|mehrwertsteuer|ust)|betrag\s+eur\s+inkl\.?\s*mwst)\b/i.test(text);

      const matches = [...text.matchAll(moneyRx)].map(m => m[1]).filter(Boolean);
      if (!matches.length) return;

 const hasPriorityLabel = priorityPatterns.some(rx => rx.test(text));
const hasStrongTotal = strongTotalLabels.test(text);
const hasIgnore = ignorePattern.test(text) && !hasInklMwst && !hasFinalTotalLabel;
const isTaxOnly = taxOnlyPattern.test(text) && !hasInklMwst && !hasFinalTotalLabel;
      matches.forEach((raw, pos) => {
        const value = parseEuro(raw);
        if (!Number.isFinite(value) || value <= 0) return;

        let score = 2;

        if (hasPriorityLabel) score += 22;
        if (hasStrongTotal) score += 20;

        if (/(gesamt|summe|total|rechnungsbetrag|endbetrag|zu\s+zahlen|zahlbetrag|amount due|invoice total)/i.test(text)) {
          score += 12;
        }

        if (hasIgnore) score -= 8;
        if (isTaxOnly) score -= 10;

        if (pos === matches.length - 1) score += 2;
        if (value < 10) score -= 10;
        if (/de\d{2}/i.test(text)) score -= 14;

        if (semanticType === "rechnung" || semanticType === "gutschrift" || semanticType === "mahnung") {
          score += 2;
        }

        if (index >= lines.length - 12) score += 2;
        if (index > lines.length - 10) score += 8;

        candidates.push({
          value,
          raw,
          score,
          line: text,
          index,
          source: hasPriorityLabel || hasStrongTotal ? "Totalzeile" : "Betrag aus Dokument"
        });
      });
    });

    return dedupeCandidates(
      candidates,
      c => String(Number(c.value).toFixed(2))
    );
  }

  /* =========================================================
     DATE
  ========================================================= */

  function detectDateCandidates(payload, semanticType) {
    const zones = payload?.zones || {};
    const profile = payload?.profile || null;
    const candidates = [];

    const labelPatterns = [
      { rx: /rechnungsdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i, score: 24, source: "Rechnungsdatum-Label" },
      { rx: /invoice\s*date[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i, score: 24, source: "Invoice-Date-Label" },
      { rx: /belegdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i, score: 22, source: "Belegdatum-Label" },
      { rx: /leistungsdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i, score: 18, source: "Leistungsdatum-Label" },
      { rx: /\bdatum[:\s]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i, score: 14, source: "Datum-Label" }
    ];

    const scopedLines = [
      ...(zones.metaZone || zones.metaBlock || []),
      ...(zones.senderZone || zones.headerTop || []),
      ...(zones.bodyZone || []).slice(0, 30)
    ];

    scopedLines.forEach((line, index) => {
      const text = normalizeWs(line);
      if (!text) return;

      labelPatterns.forEach(def => {
        const m = text.match(def.rx);
        if (!m || !m[1]) return;

        const iso = toIsoDate(m[1]);
        if (!iso) return;

        candidates.push({
          value: formatDisplayDate(iso),
          iso,
          score: def.score + ((semanticType === "rechnung" || semanticType === "gutschrift") ? 2 : 0),
          line: text,
          index,
          source: def.source
        });
      });

      const looseHits = [...text.matchAll(/\b(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\b/g)];
      looseHits.forEach(m => {
        const iso = toIsoDate(m[1]);
        if (!iso) return;

        let score = 4;
        if (/\b(rechnungsdatum|invoice\s*date|belegdatum)\b/i.test(text)) score += 10;
        if (/\b(datum|date)\b/i.test(text)) score += 4;
        if (index <= 20) score += 2;

        candidates.push({
          value: formatDisplayDate(iso),
          iso,
          score,
          line: text,
          index,
          source: "Datum im Dokument"
        });
      });
    });

    const supplierApi = window.FideliorSupplierProfiles || null;
    const profileDate = supplierApi?.detectDateByProfile
      ? supplierApi.detectDateByProfile(payload, profile)
      : "";

    if (profileDate) {
      const iso = toIsoDate(profileDate);
      if (iso) {
        candidates.push({
          value: formatDisplayDate(iso),
          iso,
          score: 18,
          line: profileDate,
          index: -1,
          source: "Lieferantenprofil Datumslabel"
        });
      }
    }

    const todayIso = new Date().toISOString().slice(0, 10);

    return dedupeCandidates(
      candidates.filter(c => c.iso && c.iso <= todayIso),
      c => c.iso
    );
  }

  /* =========================================================
     ANALYZE
  ========================================================= */

  function analyzeDocument(text, linesInput) {
    const payload = getPayload(text, linesInput);
    const textString = payload.rawText || "";

    const supplierApi = window.FideliorSupplierProfiles || null;
    if (!payload.profile && supplierApi?.findMatchingProfile) {
      try {
        payload.profile = supplierApi.findMatchingProfile(textString) || null;
      } catch {}
    }

    const semanticType = detectSemanticType(textString);
    const type = detectTypeFromSemantic(semanticType);

    let senderCandidates = detectSenderCandidates(payload);
    let referenceCandidates = detectReferenceCandidates(payload, semanticType);
    let amountCandidates = detectAmountCandidates(payload, semanticType);
    let dateCandidates = detectDateCandidates(payload, semanticType);

    senderCandidates = applyProfileBoost("sender", senderCandidates, payload.profile, payload);
    referenceCandidates = applyProfileBoost("reference", referenceCandidates, payload.profile, payload);
    amountCandidates = applyProfileBoost("amount", amountCandidates, payload.profile, payload);
    dateCandidates = applyProfileBoost("date", dateCandidates, payload.profile, payload);

    referenceCandidates = applyNegativeRules("reference", referenceCandidates, payload);
    amountCandidates = applyNegativeRules("amount", amountCandidates, payload);

    senderCandidates = dedupeCandidates(senderCandidates, c => normalizeCompare(c.value));
    referenceCandidates = dedupeCandidates(referenceCandidates, c => normalizeCompare(c.value));
    amountCandidates = dedupeCandidates(amountCandidates, c => String(Number(c.value).toFixed(2)));
    dateCandidates = dedupeCandidates(dateCandidates, c => c.iso || normalizeCompare(c.value));

    const senderField = finalizeField(senderCandidates, {
      minScore: 14,
      minMargin: 4,
      emptyValue: ""
    });

    const referenceField = (type === "rechnung")
      ? finalizeField(referenceCandidates, {
          minScore: 14,
          minMargin: 4,
          emptyValue: ""
        })
      : {
          value: "",
          confidence: "low",
          score: 0,
          margin: 0,
          source: "für Dokumenttyp nicht relevant",
          line: "",
          candidates: referenceCandidates
        };

    const amountField = finalizeField(amountCandidates, {
      minScore: 16,
      minMargin: 4,
      emptyValue: NaN
    });

    const dateField = finalizeField(dateCandidates, {
      minScore: 14,
      minMargin: 3,
      emptyValue: ""
    });

    const warnings = [];
    if (!senderField.value) warnings.push("Absender nicht sicher erkannt");
    if (type === "rechnung" && !referenceField.value) warnings.push("Rechnungsnummer nicht sicher erkannt");
    if (!Number.isFinite(amountField.value)) warnings.push("Betrag nicht sicher erkannt");
    if (!dateField.value) warnings.push("Rechnungsdatum nicht sicher erkannt");

    return {
      type,
      semanticType,
      profile: payload.profile ? {
        id: payload.profile.id || "",
        name: payload.profile.name || ""
      } : null,

      sender: senderField.value || "",
      reference: referenceField.value || "",
      amount: Number.isFinite(amountField.value) ? amountField.value : NaN,
      date: dateField.value || "",

      fields: {
        sender: {
          value: senderField.value || "",
          confidence: senderField.confidence,
          score: senderField.score,
          margin: senderField.margin,
          source: senderField.source,
          line: senderField.line
        },
        reference: {
          value: referenceField.value || "",
          confidence: referenceField.confidence,
          score: referenceField.score,
          margin: referenceField.margin,
          source: referenceField.source,
          line: referenceField.line
        },
        amount: {
          value: Number.isFinite(amountField.value) ? amountField.value : NaN,
          confidence: amountField.confidence,
          score: amountField.score,
          margin: amountField.margin,
          source: amountField.source,
          line: amountField.line
        },
        date: {
          value: dateField.value || "",
          confidence: dateField.confidence,
          score: dateField.score,
          margin: dateField.margin,
          source: dateField.source,
          line: dateField.line
        }
      },

      candidates: {
        sender: senderCandidates,
        reference: referenceCandidates,
        amount: amountCandidates,
        date: dateCandidates
      },

      warnings,

      debug: {
        lineCount: (payload.lines || []).length,
        semanticType,
        candidateCounts: {
          sender: senderCandidates.length,
          reference: referenceCandidates.length,
          amount: amountCandidates.length,
          date: dateCandidates.length
        },
        zones: {
          senderZone: (payload.zones?.senderZone || []).length,
          recipientZone: (payload.zones?.recipientZone || []).length,
          metaZone: (payload.zones?.metaZone || []).length,
          tableZone: (payload.zones?.tableZone || []).length,
          totalsZone: (payload.zones?.totalsZone || []).length,
          footerZone: (payload.zones?.footerZone || []).length
        }
      }
    };
  }

  window.FideliorAI = {
    analyzeDocument
  };

  console.info("[FideliorAI] zentrale Analyse-Engine aktiv");
})();