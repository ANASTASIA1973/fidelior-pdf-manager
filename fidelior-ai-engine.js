/* =========================================================
   Fidelior AI Engine v6
   Zentrale Dokumentanalyse – Single Source of Truth

   Ziele:
   - nur eine fachliche Analysequelle
   - Kandidaten -> Scoring -> Confidence -> Feldwert
   - Supplier Profiles dürfen nur boosten, nicht blind überschreiben
   - UI darf nur noch rendern
   - lieber leer als falsch

   v6 Verbesserungen:
   - Multi-Line Context Scanning für alle Felder
   - Erweiterte Label-Varianten (Belegnummer, Referenz, Dok.-Nr. usw.)
   - Verbesserte Zonen-Priorisierung mit Zone-Bonus-Matrix
   - Robustere Betragserkennung: Zahlungssatz-Extraktion, Multi-Line-Total
   - ISO-Datumsformat (YYYY-MM-DD) + Fälligkeitsdatum-Abgrenzung
   - Erweitertes Unternehmensform-Wörterbuch im Absender
   - Schärfere Negativfilter für Rufnummer / IBAN / Kundennummer
========================================================= */

(() => {
  "use strict";

  /* =========================================================
     HILFSFUNKTIONEN
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
        senderZone:    lines.slice(0, 8),
        recipientZone: [],
        metaZone:      lines.slice(8, 18),
        bodyZone:      lines.slice(18),
        tableZone:     lines.slice(18),
        totalsZone:    lines.slice(-12),
        footerZone:    lines.slice(-10),
        headerTop:     lines.slice(0, 8),
        recipientBlock: [],
        metaBlock:     lines.slice(8, 18),
        body:          lines.slice(18),
        indices: {
          recipientStart: -1,
          recipientEnd:   -1,
          metaStart:      8,
          metaEnd:        18,
          bodyStart:      18,
          footerStart:    Math.max(0, lines.length - 10)
        }
      },
      profile: null
    };
  }

  function parseEuro(raw) {
    let x = String(raw || "")
      .replace(/[€$£\u00A0]/g, "")
      .replace(/\bEUR\b/gi, "")
      .replace(/−/g, "-")
      .trim();

    // German: 1.234,56  →  thousands dot, decimal comma
    if (x.includes(",") && x.includes(".")) {
      if (x.lastIndexOf(".") < x.lastIndexOf(",")) {
        x = x.replace(/\./g, "").replace(",", ".");
      } else {
        // US style: 1,234.56
        x = x.replace(/,/g, "");
      }
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
    const s = String(raw || "").trim();

    // ISO: YYYY-MM-DD (exact full-string match to avoid mis-parsing)
    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoFull) {
      const y = +isoFull[1], mo = +isoFull[2], d = +isoFull[3];
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) {
        return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }

    // ISO embedded in text
    const isoEmbedded = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoEmbedded) {
      const y = +isoEmbedded[1], mo = +isoEmbedded[2], d = +isoEmbedded[3];
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) {
        return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }

    // DD.MM.YYYY | DD/MM/YYYY | DD-MM-YYYY
    const m = s.match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/);
    if (!m) return "";

    const d  = +m[1];
    const mo = +m[2];
    const y  = String(m[3]).length === 2
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
    const best   = list[0] || null;
    const second = list[1] || null;

    const margin     = best ? (best.score || 0) - (second?.score || 0) : 0;
    const confidence = best ? mapConfidence(best.score || 0, margin) : "low";

    const minScore   = opts.minScore ?? 12;
    const minMargin  = opts.minMargin ?? 3;
    const emptyValue = Object.prototype.hasOwnProperty.call(opts, "emptyValue")
      ? opts.emptyValue
      : "";

    if (!best)                       return empty();
    if ((best.score || 0) < minScore) return empty();
    if (margin < minMargin)           return empty();
    if (confidence !== "high")        return empty();

    return {
      value:      best.value,
      confidence,
      score:      best.score || 0,
      margin,
      source:     best.source || "Dokumentanalyse",
      line:       best.line || "",
      candidates: list
    };

    function empty() {
      return {
        value:      emptyValue,
        confidence: "low",
        score:      0,
        margin:     0,
        source:     "keine sichere Erkennung",
        line:       "",
        candidates: list
      };
    }
  }

  function applyProfileBoost(kind, candidates, profile, payload) {
    const api = window.FideliorSupplierProfiles || null;
    let out = Array.isArray(candidates) ? [...candidates] : [];

    if (api?.boostCandidates) {
      try { out = api.boostCandidates(kind, out, profile, payload) || out; } catch (_) {}
    }
    if (api?.boostByAnchors) {
      try { out = api.boostByAnchors(kind, out, profile, payload) || out; } catch (_) {}
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
     SEMANTISCHER DOKUMENTTYP
  ========================================================= */

  function detectSemanticType(text) {
    const t  = String(text || "").toLowerCase();
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
    const hasTotal        = /\b(gesamt|summe|total|zu zahlen|rechnungsbetrag|invoice total|amount due|zahlbetrag|endbetrag)\b/i.test(t);
    const hasCurrency     = /€|\beur\b/i.test(t);

    if (hasInvoiceLabel && (hasTotal || hasCurrency)) {
      return "rechnung";
    }

    return "dokument";
  }

  function detectTypeFromSemantic(semanticType) {
    return (semanticType === "rechnung" || semanticType === "gutschrift")
      ? "rechnung"
      : "dokument";
  }

  /* =========================================================
     ABSENDER
  ========================================================= */

  function detectSenderCandidates(payload) {
    const candidates = [];
    const zones   = payload?.zones || {};
    const profile = payload?.profile || null;

    // Rechtsformen und Unternehmens-Keywords
    const companyFormRx = /\b(gmbh|ag|kg|ug|ohg|kgaa|mbh|ltd\.?|inc\.?|corp\.?|llc|s\.?a\.?r?\.?l\.?|b\.?v\.?|n\.?v\.?|plc|s\.?p\.?a\.?|s\.?r\.?l\.?|e\.?\s*k\.?|e\.?\s*v\.?|gbr|partg|holding|immobilien|hausverwaltung|verwaltung|management|solutions|services|service|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke|wasser|praxis|apotheke|steuerberatung|steuerberater|notar|rechtsanwalt|online|telecom|telekom|digital|media|group|verlag|vertrieb|handel|technik|systems|system|consulting|consult|partner|netz|netze|netzwerk|infrastruktur|dienstleistung|dienstleistungen|bau|baubetrieb|elektro|sanitär|heizung|dach|maler)\b/i;

    const negativeLineRx = /\b(rechnung|invoice|kundennummer|kunden\-?nr|vertragsnummer|vertrag\s*nr|iban|bic|swift|telefon\s*nr|fax|e-?mail|www\.|ust\-?id|mwst|steuer\s*nr|datum|seite|page|tarif|lieferadresse|rechnungsadresse|leistungsempfänger|kontonummer|konto\s*nr)\b/i;

    const greetingRx = /^(sehr geehrte|guten tag|hallo|dear|liebe[rs]?|hi\b)\b/i;

    const streetRx   = /\b(straße|str\.|weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive|boulevard|court)\b/i;
    const zipCityRx  = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]/;
    const sentenceRx = /\b(wir|sie|bitte|danke|hiermit|prüfung|zahlung|überweisen|kontaktieren|informieren|bitten|teilen|stellen|wurden|haben|sind|werden)\b/i;

    const labelPrefixRx = /^(name|firma|absender|rechnungssteller|vendor|lieferant|auftragnehmer)\s*:\s*/i;

    function scoreAndPush(line, baseScore, source, index, zoneTag) {
      const s = normalizeWs(line);
      if (!s || s.length < 3 || s.length > 90) return;
      if (s.split(/\s+/).length > 8) return;
      if (/[!?]/.test(s)) return;
      if (greetingRx.test(s))  return;
      if (sentenceRx.test(s))  return;
      if (zipCityRx.test(s))   return;
      if (streetRx.test(s))    return;

      let score = baseScore;

      const hasLabelPrefix = labelPrefixRx.test(s);
      const hasCompanyForm = companyFormRx.test(s);
      const hasNegative    = negativeLineRx.test(s);
      const hasDigits      = /\d/.test(s);

      if (hasLabelPrefix) score += 8;
      if (hasCompanyForm) score += 14;
      if (!hasNegative)   score += 2;
      if (!hasDigits)     score += 1;

      // Zonen-Boni / Malus
      switch (zoneTag) {
        case "senderZone":
          score += 6;
          if (index <= 1) score += 4; // allererste Zeilen = Absender
          break;
        case "recipientZone":
          score -= 22;
          break;
        case "metaZone":
          score -= 2;
          break;
        case "footerZone":
          if (!hasLabelPrefix) score -= 8;
          break;
        default:
          break;
      }

      if (score <= 0) return;

      const value = hasLabelPrefix
        ? s.replace(labelPrefixRx, "").trim()
        : s;

      if (!value) return;

      candidates.push({
        value,
        score,
        line: s,
        index: Number.isInteger(index) ? index : -1,
        source
      });
    }

    // Primär: senderZone / headerTop
    (zones.senderZone || zones.headerTop || []).forEach((line, idx) => {
      scoreAndPush(line, idx <= 2 ? 14 : 10, "Absenderzone", idx, "senderZone");
    });

    // Sekundär: metaZone
    (zones.metaZone || zones.metaBlock || []).forEach((line, idx) => {
      scoreAndPush(line, 4, "Metazone", idx, "metaZone");
    });

    // Tertiär: recipientZone (soll fast nie gewinnen)
    (zones.recipientZone || zones.recipientBlock || []).forEach((line, idx) => {
      scoreAndPush(line, 2, "Empfängerzone", idx, "recipientZone");
    });

    // Footer nur bei explizitem Label
    (zones.footerZone || []).forEach((line, idx) => {
      if (labelPrefixRx.test(normalizeWs(line))) {
        scoreAndPush(line, 14, "Footer-Label", idx, "footerZone");
      }
    });

    // Explizites Label im Volltext
    const labelMatch = String(payload?.rawText || "").match(
      /\b(?:rechnungssteller|lieferant|anbieter|auftragnehmer|vendor|supplier)\b[:\s]+([^\n]{3,80})/i
    );
    if (labelMatch?.[1]) {
      scoreAndPush(cleanToken(labelMatch[1]), 22, "Label im Dokument", -1, "metaZone");
    }

    // Lieferantenprofil überschreibt (höchste Priorität)
    if (profile?.name) {
      candidates.push({
        value: normalizeWs(profile.name),
        score: 30,
        line:  profile.name,
        index: -1,
        source: "Lieferantenprofil"
      });
    }

    return dedupeCandidates(candidates, c => normalizeCompare(c.value));
  }

  /* =========================================================
     RECHNUNGSNUMMER / REFERENZ
  ========================================================= */

  function detectReferenceCandidates(payload, semanticType) {
    const zones    = payload?.zones || {};
    const allLines = payload?.lines || [];
    const joined   = String(payload?.rawText || "");
    const profile  = payload?.profile || null;
    const candidates = [];

    // --- Token-Validierung ---
    const badPrefixRx  = /^(KDNR|KUNDENNR|KUNDENNUMMER|KUNDE|CUSTOMER|ACCOUNT|AUFTRAG|BESTELL|ORDER|VERTRAG|CONTRACT|CLIENT|ACC|BIC|IBAN|SWIFT|DATUM|DATE|SEITE|PAGE|ERSTELLT|KOPIE|COPY|ORIGINAL|TEL|FAX|PLZ|NR)\b/i;
    const ibanRx       = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;
    const dateLikeRx   = /^(\d{1,2}[.\-\/]){2}\d{2,4}$/;
    const phoneLikeRx  = /^[\d\s\+\-\/\(\)]{8,}$/;
    // Rufnummer-Muster: beginnt mit 0 und hat 6+ Ziffern ohne Buchstaben
    const rufnummerRx  = /^0\d{5,}$/;

    function isValidToken(token) {
      if (!token || token.length < 3 || token.length > 32) return false;
      if (!/\d/.test(token)) return false;
      if (badPrefixRx.test(token)) return false;
      if (ibanRx.test(token)) return false;
      if (dateLikeRx.test(token)) return false;
      if (phoneLikeRx.test(token) && !/[A-Z]/i.test(token)) return false;
      if (rufnummerRx.test(token)) return false;
      return true;
    }

    // Zeilen-Kontext-Classifier
    const goodContextRx = /\b(rechnung|invoice|rg-?nr\.?|rechnungs?-?(?:nummer|nr\.?|no\.?)|belegnummer|beleg-?nr\.?|referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?|dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\b/i;
    const badContextRx  = /\b(kundennummer|kunden-?nr\.?|customer\s*(?:no|number)|iban|bic|swift|vertragskonto|mandatsreferenz|mandats-?ref|rufnummer|telefonnummer|bestellnummer|vertrags-?nr\.?|debitor|kreditinstitut|bankverbindung|kontonummer|konto-?nr\.?)\b/i;

    function push(value, line, baseScore, source, index) {
      const token = cleanToken(value).replace(/\s+/g, "");
      if (!isValidToken(token)) return;

      const lineNorm = normalizeWs(line);
      let s = baseScore;

      // Kontext-Boni
      if (goodContextRx.test(lineNorm))               s += 10;
      if (/\brechnung\s+[A-Z0-9]/i.test(lineNorm))    s += 8;
      if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;

      // Muster-Qualitätsboni
      if (/^[A-Z]{1,4}[-_\/]\d{4,}$/i.test(token))   s += 8;  // RE-2024-001
      if (/^[A-Z]{1,4}[-_\/]\d{4}[-_\/]\d+$/i.test(token)) s += 8; // RE-2024-1234
      if (/^\d{2,4}\/\d{3,}$/.test(token))            s += 6;  // 2024/12345
      if (/^[A-Z]{1,3}\d{6,}$/i.test(token))          s += 8;  // B898301796
      if (/^\d{6,}$/.test(token))                      s += 4;  // rein numerisch 6+

      // Kontext-Malus
      if (badContextRx.test(lineNorm) && !goodContextRx.test(lineNorm)) s -= 16;

      if (s <= 0) return;

      candidates.push({
        value:  token,
        score:  s,
        line:   lineNorm,
        index:  Number.isInteger(index) ? index : -1,
        source
      });
    }

    // --- Label-Definitionen ---
    const labelDefs = [
      {
        rx:   /\b(rechnungs?(?:nummer|nr\.?|no\.?|#))\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 28,
        src:  "Rechnungsnummer-Label"
      },
      {
        rx:   /\b(rechnung)\s+([A-Z0-9][A-Z0-9.\-\/_]{2,})/gi,
        base: 26,
        src:  "Rechnung-Heading"
      },
      {
        rx:   /\b(invoice\s*(?:no\.?|nr\.?|number|#)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 28,
        src:  "Invoice-Label"
      },
      {
        rx:   /\b(belegnummer|beleg-?nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 24,
        src:  "Belegnummer"
      },
      {
        rx:   /\b(rg\.?\s*nr\.?|rn\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 24,
        src:  "RG-Nr-Label"
      },
      {
        rx:   /\b(referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 20,
        src:  "Referenz-Label"
      },
      {
        rx:   /\b(dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 20,
        src:  "Dokument-Nr-Label"
      },
      {
        rx:   /\b(r-?nr\.?|doc\.?\s*(?:no|nr)\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,
        base: 18,
        src:  "Sonstige-Nr-Label"
      }
    ];

    function scanZoneLines(lines, zoneBonus) {
      lines.forEach((rawLine, idx) => {
        const line = normalizeWs(rawLine);
        if (!line) return;

        for (const def of labelDefs) {
          const rx = new RegExp(def.rx.source, "gi");
          let m;
          while ((m = rx.exec(line))) {
            if (m[2]) push(m[2], line, def.base + zoneBonus, def.src, idx);
          }
        }
      });
    }

    // Zone-basiert scannen
    const metaLines    = zones.metaZone || zones.metaBlock || [];
    const senderLines  = (zones.senderZone || zones.headerTop || []).slice(0, 10);
    const bodyLines    = (zones.bodyZone || zones.body || []).slice(0, 80);

    scanZoneLines(metaLines,   6);   // metaZone: stärkster Bonus
    scanZoneLines(senderLines, 4);   // senderZone: guter Bonus
    scanZoneLines(bodyLines,   0);   // body: kein Bonus

    // Volltext-Scan für alle Label-Muster (fängt Zeilenumbruchformate)
    for (const def of labelDefs) {
      const rx = new RegExp(def.rx.source, "gi");
      let m;
      while ((m = rx.exec(joined))) {
        if (m[2]) push(m[2], m[0], def.base, def.src + " (Volltext)", -1);
      }
    }

    // Multi-Line-Scanning: Label-Zeile ohne Wert → nächste Zeile(n) prüfen
    const labelOnlyRx  = /\b(rechnungs?(?:nummer|nr\.?|no\.?)|rechnung\s*nr\.?|invoice\s*(?:no\.?|nr\.?|number)?|belegnummer|beleg-?nr\.?|rg-?nr\.?|referenz(?:nr\.?)?|dokumenten?(?:nummer|nr\.?)?|r-?nr\.?)\s*[:#\s\-]*$/i;
    const singleTokenRx = /^([A-Z0-9][A-Z0-9.\-\/_]{2,29})\s*$/i;

    allLines.forEach((rawLine, idx) => {
      const line = normalizeWs(rawLine);
      if (!labelOnlyRx.test(line)) return;

      for (let offset = 1; offset <= 2; offset++) {
        const nextLine = normalizeWs(allLines[idx + offset] || "");
        if (!nextLine) continue;

        // Gesamte nächste Zeile als Token versuchen
        const fullMatch = nextLine.match(singleTokenRx);
        if (fullMatch) {
          push(fullMatch[1], line + " " + nextLine, 28, "Multi-Line-Label", idx);
          break;
        }

        // Erstes Token der nächsten Zeile prüfen
        const firstToken = nextLine.split(/\s+/)[0] || "";
        if (firstToken.length >= 3 && isValidToken(firstToken)) {
          push(firstToken, line + " " + nextLine, 26, "Multi-Line-Label", idx);
          break;
        }
        break;
      }
    });

    // Lieferantenprofil-Muster (höchste Priorität)
    if (Array.isArray(profile?.invoiceNumberPatterns)) {
      for (const rx of profile.invoiceNumberPatterns) {
        if (!(rx instanceof RegExp)) continue;
        const safeRx = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
        let m;
        while ((m = safeRx.exec(joined))) {
          push(m[1] || m[0], m[0], 32, "Lieferantenprofil Rechnungsnummer", -1);
        }
      }
    }

    return dedupeCandidates(candidates, c => normalizeCompare(c.value))
      .filter(c => (c.score || 0) >= 8);
  }

  /* =========================================================
     BETRAG
  ========================================================= */

  function detectAmountCandidates(payload, semanticType) {
    const zones    = payload?.zones || {};
    const allLines = payload?.lines || [];
    const joined   = String(payload?.rawText || "");
    const candidates = [];

    // Labels → Gesamtbetrag / Zahlbetrag
    const strongTotalRx = /\b(zu\s+zahlen|zu\s+überweisen|zu\s+zahlender\s+betrag|zahlbetrag|gesamtbetrag|rechnungsbetrag|rechnungsendbetrag|endbetrag|bruttorechnungsbetrag|bruttobetrag|bruttosumme|gesamtsumme|gesamtpreis|rechnungs\s*summe|invoice\s+total|total\s+amount\s+(?:due|payable)|amount\s+due|amount\s+payable|offener\s+betrag|noch\s+offen|offene\s+forderung|restbetrag|gesamtforderung|forderungsbetrag|betrag\s+inkl\.?\s*(?:mwst|ust|mehrwertsteuer)|inkl\.?\s*(?:mwst|ust)\s+gesamt|inkl\.?\s*(?:mwst|ust))\b/i;

    // Mittlere Labels
    const mediumTotalRx = /\b(summe|total|gesamt(?!\s*mwst|\s*ust))\b/i;

    // Ausschlusslabels (keine Positionsbeträge, Steuer, Rabatt)
    const ignoreRx = /\b(zwischensumme|subtotal|nettobetrag\b|netto\b(?!\s*gesamt)|netto\s*summe(?!\s*gesamt)|rabatt|discount|skonto|versandkosten|versand|lieferkosten|porto|einzelpreis|stückpreis|grundgebühr(?!\s*gesamt)|abschlag|anzahlung|vorauszahlung|teilbetrag|rate\b|ratenzahlung)\b/i;

    // Nur-Steuer (wenn kein inkl. mwst Kontext)
    const taxLineRx = /^[\s\d,.]*(mwst\.?|ust\.?|mehrwertsteuer|vat)\s+\d/i;
    const taxContextRx = /\b(mwst\.?|ust\.?|mehrwertsteuer|vat)\s+\d{1,2}[,\.]\d{0,2}\s*%/i;

    // Geldbetrags-Pattern (deutsch + international)
    const amountRx = /-?\d{1,3}(?:[.\u00A0]\d{3})*[,]\d{2}|-?\d{1,3}(?:[,]\d{3})*[.]\d{2}|-?\d+[,]\d{2}|-?\d+[.]\d{2}/g;

    // Einzel-Betrag aus Zeile extrahieren
    function extractAmountsFromLine(text) {
      const results = [];
      const seen = new Set();
      let m;

      const rx = new RegExp(amountRx.source, "g");
      while ((m = rx.exec(text))) {
        const v = parseEuro(m[0]);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ raw: m[0], value: v, pos: m.index });
      }

      // EUR-begleitete Beträge (z. B. "EUR 7,55" / "7,55 EUR")
      const currRx = /(?:EUR|€)\s*(-?\d+[,\.]\d{2})|(-?\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
      while ((m = currRx.exec(text))) {
        const raw = m[1] || m[2];
        const v   = parseEuro(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ raw, value: v, pos: m.index, hasCurrencyMarker: true });
      }

      return results;
    }

    function computeLineScore(text, value, zoneBonus, lineIndex, totalLines) {
      let score = 2 + zoneBonus;

      const hasStrong    = strongTotalRx.test(text);
      const hasMedium    = mediumTotalRx.test(text);
      const hasIgnore    = ignoreRx.test(text);
      const hasTaxLine   = taxLineRx.test(text) || taxContextRx.test(text);
      const hasInklMwst  = /\binkl\.?\s*(?:mwst|ust|mehrwertsteuer)\b/i.test(text);
      const hasFinalTag  = /\b(rechnungsendbetrag|endbetrag|rechnungsbetrag|gesamtbetrag|zahlbetrag|zu\s+zahlen)\b/i.test(text);

      if (hasStrong)                          score += 26;
      if (hasMedium && !hasStrong)            score += 10;
      if (hasInklMwst && !hasIgnore)          score += 8;
      if (hasFinalTag)                        score += 4;

      // Abzüge
      if (hasIgnore && !hasStrong && !hasInklMwst && !hasFinalTag) score -= 12;
      if (hasTaxLine && !hasStrong && !hasInklMwst)                 score -= 14;

      // IBAN-Zeile vermeiden
      if (/DE\d{2}/i.test(text)) score -= 18;

      // Betrag-Plausibilität
      if (value < 1)   score -= 14;
      if (value < 0.5) score -= 8;

      // Positions-Bonus (Totalbeträge stehen meist am Dokumentende)
      if (lineIndex >= totalLines - 25) score += 4;
      if (lineIndex >= totalLines - 12) score += 6;

      if (semanticType === "rechnung" || semanticType === "gutschrift" || semanticType === "mahnung") {
        score += 2;
      }

      return score;
    }

    function processLineArray(lines, zoneBonus) {
      lines.forEach((rawLine, idx) => {
        const text = normalizeWs(rawLine);
        if (!text) return;

        const amounts = extractAmountsFromLine(text);
        if (!amounts.length) return;

        amounts.forEach((amt, posInLine) => {
          let s = computeLineScore(text, amt.value, zoneBonus, idx, allLines.length);
          // Letzter Betrag auf Zeile = oft Gesamt in Tabellenlayout
          if (posInLine === amounts.length - 1 && amounts.length > 1) s += 2;
          if (amt.hasCurrencyMarker) s += 3;

          candidates.push({
            value:  amt.value,
            raw:    amt.raw,
            score:  s,
            line:   text,
            index:  idx,
            source: strongTotalRx.test(text) ? "Totalzeile" : "Betrag aus Dokument"
          });
        });
      });
    }

    // Zonen in Priorität verarbeiten
    processLineArray(zones.totalsZone || [],  12);
    processLineArray(zones.footerZone || [],   8);
    processLineArray(zones.tableZone  || [],   4);
    processLineArray(allLines,                 0);

    // Multi-Line-Total: Label auf Zeile N, Betrag auf Zeile N±1
    allLines.forEach((rawLine, idx) => {
      const text = normalizeWs(rawLine);
      if (!strongTotalRx.test(text) && !mediumTotalRx.test(text)) return;

      const thisAmounts = extractAmountsFromLine(text);
      if (thisAmounts.length) return; // schon oben verarbeitet

      for (const offset of [1, -1, 2]) {
        const neighborLine = normalizeWs(allLines[idx + offset] || "");
        if (!neighborLine) continue;

        const neighborAmounts = extractAmountsFromLine(neighborLine);
        if (!neighborAmounts.length) continue;

        neighborAmounts.forEach(amt => {
          const combinedText = text + " " + neighborLine;
          const s = computeLineScore(combinedText, amt.value, 10, idx, allLines.length) + 8;
          candidates.push({
            value:  amt.value,
            raw:    amt.raw,
            score:  s,
            line:   text + " | " + neighborLine,
            index:  idx,
            source: "Multi-Line-Total"
          });
        });
        break;
      }
    });

    // Zahlungssätze: "Rechnungsbetrag in Höhe von X,XX EUR" / "buchen ... X,XX EUR"
    const paymentSentenceRx = /(?:rechnungsbetrag|gesamtbetrag|betrag|zahlung|zahlungsbetrag|zahlen\s+sie)\s+(?:in\s+höhe\s+von\s+|von\s+|über\s+|i\.?h\.?v\.?\s*)?(-?\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
    let pm;
    while ((pm = paymentSentenceRx.exec(joined))) {
      const v = parseEuro(pm[1]);
      if (Number.isFinite(v) && v > 0) {
        candidates.push({
          value:  v,
          raw:    pm[1],
          score:  30,
          line:   normalizeWs(pm[0]),
          index:  -1,
          source: "Zahlungssatz"
        });
      }
    }

    return dedupeCandidates(candidates, c => String(Number(c.value).toFixed(2)));
  }

  /* =========================================================
     DATUM
  ========================================================= */

  function detectDateCandidates(payload, semanticType) {
    const zones    = payload?.zones || {};
    const allLines = payload?.lines || [];
    const profile  = payload?.profile || null;
    const candidates = [];

    // Primärlabels (Rechnungsdatum zuerst)
    const labelDefs = [
      {
        rx:    /\b(rechnungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 28,
        src:   "Rechnungsdatum"
      },
      {
        rx:    /\b(ausstellungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 26,
        src:   "Ausstellungsdatum"
      },
      {
        rx:    /\b(invoice\s*date)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 26,
        src:   "Invoice-Date"
      },
      {
        rx:    /\b(belegdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 24,
        src:   "Belegdatum"
      },
      {
        rx:    /\b(datum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 18,
        src:   "Datum-Label"
      },
      {
        rx:    /\b(leistungsdatum|lieferdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,
        score: 16,
        src:   "Leistungsdatum"
      }
    ];

    // Fälligkeitsdatum → Score senken
    const dueDateRx = /\b(fälligkeits?datum|fällig\s+(?:am|bis|zum)|zahlungsziel|zahlungsfrist|due\s+date|pay\s+by|payment\s+due)\b/i;

    const todayIso = new Date().toISOString().slice(0, 10);

    function pushDate(iso, line, score, source, index) {
      if (!iso) return;
      if (iso > todayIso) return; // Zukunftsdaten sind keine Rechnungsdaten

      candidates.push({
        value: formatDisplayDate(iso),
        iso,
        score,
        line:  normalizeWs(line),
        index: Number.isInteger(index) ? index : -1,
        source
      });
    }

    function scanLineForLabels(line, idx, zoneBonus) {
      if (!line) return;
      const isDueDateLine = dueDateRx.test(line);

      for (const def of labelDefs) {
        const m = line.match(def.rx);
        if (!m?.[2]) continue;
        const iso = toIsoDate(m[2]);
        if (!iso) continue;

        let s = def.score + zoneBonus;
        if (isDueDateLine) s -= 14;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src + (zoneBonus > 0 ? " (Zone)" : ""), idx);
      }

      // Lose Datumserkennung nur in Meta/Sender-Zone
      if (zoneBonus > 0) {
        const looseDates = [...line.matchAll(/\b(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\b/g)];
        looseDates.forEach(m => {
          const iso = toIsoDate(m[1]);
          if (!iso) return;

          let s = 6;
          if (/\b(rechnungsdatum|invoice\s*date|belegdatum|ausstellungsdatum)\b/i.test(line)) s = 22;
          else if (/\bdatum\b/i.test(line)) s = 14;

          if (isDueDateLine) s -= 10;
          pushDate(iso, line, s + zoneBonus, "Datum in Zone", idx);
        });
      }
    }

    // Primäre Zonen (höchster Bonus)
    const metaLines   = zones.metaZone || zones.metaBlock || [];
    const senderLines = zones.senderZone || zones.headerTop || [];

    metaLines.forEach((line, idx)   => scanLineForLabels(normalizeWs(line), idx, 6));
    senderLines.forEach((line, idx) => scanLineForLabels(normalizeWs(line), idx, 4));

    // Alle Zeilen mit Label-Mustern (niedriger Basis-Bonus)
    allLines.forEach((rawLine, idx) => {
      const line = normalizeWs(rawLine);
      if (!line) return;
      const isDueDateLine = dueDateRx.test(line);

      for (const def of labelDefs) {
        const m = line.match(def.rx);
        if (!m?.[2]) continue;
        const iso = toIsoDate(m[2]);
        if (!iso) continue;

        let s = def.score;
        if (isDueDateLine) s -= 14;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src, idx);
      }
    });

    // Multi-Line-Datum: Label-Zeile → nächste Zeile enthält Datum
    const labelOnlyDateRx = /\b(rechnungsdatum|invoice\s*date|belegdatum|ausstellungsdatum|datum)\s*[:#\s\-]*$/i;
    const dateValueOnlyRx = /^\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\s*$/;

    allLines.forEach((rawLine, idx) => {
      const line = normalizeWs(rawLine);
      if (!labelOnlyDateRx.test(line)) return;

      const isDueDateLine = dueDateRx.test(line);

      for (let offset = 1; offset <= 2; offset++) {
        const nextLine = normalizeWs(allLines[idx + offset] || "");
        if (!nextLine) continue;

        const m = nextLine.match(dateValueOnlyRx);
        if (!m?.[1]) { if (offset === 1) continue; break; }

        const iso = toIsoDate(m[1]);
        let s = 26;
        if (isDueDateLine) s -= 14;
        pushDate(iso, line + " " + nextLine, s, "Multi-Line-Datum", idx);
        break;
      }
    });

    // Lieferantenprofil
    const supplierApi = window.FideliorSupplierProfiles || null;
    if (supplierApi?.detectDateByProfile) {
      try {
        const profileDate = supplierApi.detectDateByProfile(payload, profile);
        if (profileDate) {
          const iso = toIsoDate(profileDate);
          if (iso) pushDate(iso, profileDate, 22, "Lieferantenprofil Datum", -1);
        }
      } catch (_) {}
    }

    return dedupeCandidates(
      candidates.filter(c => c.iso && c.iso <= todayIso),
      c => c.iso
    );
  }

  /* =========================================================
     ANALYSE
  ========================================================= */

  function analyzeDocument(text, linesInput) {
    const payload    = getPayload(text, linesInput);
    const textString = payload.rawText || "";

    // Lieferantenprofil ermitteln
    const supplierApi = window.FideliorSupplierProfiles || null;
    if (!payload.profile && supplierApi?.findMatchingProfile) {
      try {
        payload.profile = supplierApi.findMatchingProfile(textString) || null;
      } catch (_) {}
    }

    const semanticType = detectSemanticType(textString);
    const type         = detectTypeFromSemantic(semanticType);

    // Kandidaten-Erkennung
    let senderCandidates    = detectSenderCandidates(payload);
    let referenceCandidates = detectReferenceCandidates(payload, semanticType);
    let amountCandidates    = detectAmountCandidates(payload, semanticType);
    let dateCandidates      = detectDateCandidates(payload, semanticType);

    // Profil-Boost
    senderCandidates    = applyProfileBoost("sender",    senderCandidates,    payload.profile, payload);
    referenceCandidates = applyProfileBoost("reference", referenceCandidates, payload.profile, payload);
    amountCandidates    = applyProfileBoost("amount",    amountCandidates,    payload.profile, payload);
    dateCandidates      = applyProfileBoost("date",      dateCandidates,      payload.profile, payload);

    // Negativfilter
    referenceCandidates = applyNegativeRules("reference", referenceCandidates, payload);
    amountCandidates    = applyNegativeRules("amount",    amountCandidates,    payload);

    // Deduplizierung
    senderCandidates    = dedupeCandidates(senderCandidates,    c => normalizeCompare(c.value));
    referenceCandidates = dedupeCandidates(referenceCandidates, c => normalizeCompare(c.value));
    amountCandidates    = dedupeCandidates(amountCandidates,    c => String(Number(c.value).toFixed(2)));
    dateCandidates      = dedupeCandidates(dateCandidates,      c => c.iso || normalizeCompare(c.value));

    // Feldfinalisierung
    const senderField = finalizeField(senderCandidates, {
      minScore:   14,
      minMargin:  4,
      emptyValue: ""
    });

    const referenceField = (type === "rechnung")
      ? finalizeField(referenceCandidates, {
          minScore:   14,
          minMargin:  4,
          emptyValue: ""
        })
      : {
          value:      "",
          confidence: "low",
          score:      0,
          margin:     0,
          source:     "für Dokumenttyp nicht relevant",
          line:       "",
          candidates: referenceCandidates
        };

    const amountField = finalizeField(amountCandidates, {
      minScore:   16,
      minMargin:  4,
      emptyValue: NaN
    });

    const dateField = finalizeField(dateCandidates, {
      minScore:   14,
      minMargin:  3,
      emptyValue: ""
    });

    // Warnungen
    const warnings = [];
    if (!senderField.value)                           warnings.push("Absender nicht sicher erkannt");
    if (type === "rechnung" && !referenceField.value) warnings.push("Rechnungsnummer nicht sicher erkannt");
    if (!Number.isFinite(amountField.value))          warnings.push("Betrag nicht sicher erkannt");
    if (!dateField.value)                             warnings.push("Rechnungsdatum nicht sicher erkannt");

    return {
      type,
      semanticType,
      profile: payload.profile
        ? { id: payload.profile.id || "", name: payload.profile.name || "" }
        : null,

      sender:    senderField.value    || "",
      reference: referenceField.value || "",
      amount:    Number.isFinite(amountField.value) ? amountField.value : NaN,
      date:      dateField.value      || "",

      fields: {
        sender: {
          value:      senderField.value || "",
          confidence: senderField.confidence,
          score:      senderField.score,
          margin:     senderField.margin,
          source:     senderField.source,
          line:       senderField.line
        },
        reference: {
          value:      referenceField.value || "",
          confidence: referenceField.confidence,
          score:      referenceField.score,
          margin:     referenceField.margin,
          source:     referenceField.source,
          line:       referenceField.line
        },
        amount: {
          value:      Number.isFinite(amountField.value) ? amountField.value : NaN,
          confidence: amountField.confidence,
          score:      amountField.score,
          margin:     amountField.margin,
          source:     amountField.source,
          line:       amountField.line
        },
        date: {
          value:      dateField.value || "",
          confidence: dateField.confidence,
          score:      dateField.score,
          margin:     dateField.margin,
          source:     dateField.source,
          line:       dateField.line
        }
      },

      candidates: {
        sender:    senderCandidates,
        reference: referenceCandidates,
        amount:    amountCandidates,
        date:      dateCandidates
      },

      warnings,

      debug: {
        lineCount:       (payload.lines || []).length,
        semanticType,
        candidateCounts: {
          sender:    senderCandidates.length,
          reference: referenceCandidates.length,
          amount:    amountCandidates.length,
          date:      dateCandidates.length
        },
        zones: {
          senderZone:    (payload.zones?.senderZone    || []).length,
          recipientZone: (payload.zones?.recipientZone || []).length,
          metaZone:      (payload.zones?.metaZone      || []).length,
          tableZone:     (payload.zones?.tableZone     || []).length,
          totalsZone:    (payload.zones?.totalsZone    || []).length,
          footerZone:    (payload.zones?.footerZone    || []).length
        }
      }
    };
  }

  /* =========================================================
     EXPORT
  ========================================================= */

  window.FideliorAI = {
    analyzeDocument
  };

  console.info("[FideliorAI] zentrale Analyse-Engine v6 aktiv");
})();