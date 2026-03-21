/* =========================================================
   Fidelior AI Engine v7
   Zentrale Dokumentanalyse – Single Source of Truth

   Prinzipien:
   - Kandidaten -> Scoring -> Confidence -> Feldwert
   - Supplier Profiles boosten, überschreiben nicht blind
   - UI rendert nur
   - lieber leer als falsch – aber nicht unnötig leer

   v7 Korrekturen:
   - Betrag: Label-Wörterbuch mit Bindestrichen ("Bruttorechnungs-Betrag"),
             Label->Wert-Direktscan, adaptiver minAbsoluteScore in finalizeField
   - Absender: Adressblock-Detektor (Name + Straße + PLZ/Ort) identifiziert
               Empfänger-Blöcke und entwerted diese aktiv
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
        .map(v => (typeof v === "string" ? normalizeWs(v) : normalizeWs(v?.text || "")))
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
        senderZone:     lines.slice(0, 8),
        recipientZone:  [],
        metaZone:       lines.slice(8, 18),
        bodyZone:       lines.slice(18),
        tableZone:      lines.slice(18),
        totalsZone:     lines.slice(-12),
        footerZone:     lines.slice(-10),
        headerTop:      lines.slice(0, 8),
        recipientBlock: [],
        metaBlock:      lines.slice(8, 18),
        body:           lines.slice(18),
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

    if (x.includes(",") && x.includes(".")) {
      x = x.lastIndexOf(".") < x.lastIndexOf(",")
        ? x.replace(/\./g, "").replace(",", ".")
        : x.replace(/,/g, "");
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

    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoFull) {
      const yr = +isoFull[1], mo = +isoFull[2], dy = +isoFull[3];
      if (dy >= 1 && dy <= 31 && mo >= 1 && mo <= 12 && yr >= 2000 && yr <= 2100)
        return `${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
    }

    const isoEmb = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoEmb) {
      const yr = +isoEmb[1], mo = +isoEmb[2], dy = +isoEmb[3];
      if (dy >= 1 && dy <= 31 && mo >= 1 && mo <= 12 && yr >= 2000 && yr <= 2100)
        return `${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
    }

    const m = s.match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/);
    if (!m) return "";

    const dy = +m[1], mo = +m[2];
    const yr = String(m[3]).length === 2
      ? (+m[3] < 50 ? 2000 + +m[3] : 1900 + +m[3])
      : +m[3];

    if (dy < 1 || dy > 31 || mo < 1 || mo > 12 || yr < 2000 || yr > 2100) return "";
    return `${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
  }

  function dedupeCandidates(candidates, keyFn) {
    const map = new Map();
    candidates.forEach(c => {
      const key = keyFn(c);
      if (!key) return;
      const prev = map.get(key);
      if (!prev || (c.score || 0) > (prev.score || 0)) map.set(key, c);
    });
    return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  function mapConfidence(score, margin) {
    if (score >= 24 && margin >= 6) return "high";
    if (score >= 16 && margin >= 4) return "high";
    if (score >= 11 && margin >= 2) return "medium";
    return "low";
  }

  /*
   * finalizeField
   *
   * opts.minAbsoluteScore: wenn der beste Kandidat diesen Score erreicht
   * UND Confidence >= medium, wird er ohne Margin-Anforderung übernommen.
   * Verhindert, dass eindeutige Einzelkandidaten verworfen werden.
   */
  function finalizeField(candidates, opts = {}) {
    const list   = Array.isArray(candidates) ? candidates : [];
    const best   = list[0] || null;
    const second = list[1] || null;

    const margin     = best ? (best.score || 0) - (second?.score || 0) : 0;
    const confidence = best ? mapConfidence(best.score || 0, margin) : "low";

    const minScore         = opts.minScore         ?? 12;
    const minMargin        = opts.minMargin        ?? 3;
    const minAbsoluteScore = opts.minAbsoluteScore ?? Infinity;

    const emptyValue = Object.prototype.hasOwnProperty.call(opts, "emptyValue")
      ? opts.emptyValue : "";

    function result() {
      return {
        value:      best.value,
        confidence,
        score:      best.score || 0,
        margin,
        source:     best.source || "Dokumentanalyse",
        line:       best.line || "",
        candidates: list
      };
    }

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

    if (!best) return empty();

    // Absolut-Pfad: hoher Score, kein Margin nötig
    if ((best.score || 0) >= minAbsoluteScore && confidence !== "low") return result();

    if ((best.score || 0) < minScore) return empty();
    if (margin < minMargin)           return empty();
    if (confidence !== "high")        return empty();

    return result();
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
    if (kind === "reference" && neg?.isBadReferenceCandidate)
      out = out.filter(c => !neg.isBadReferenceCandidate(c, payload?.rawText || ""));
    if (kind === "amount" && neg?.isBadAmountCandidate)
      out = out.filter(c => !neg.isBadAmountCandidate(c));
    return out;
  }

  /* =========================================================
     SEMANTISCHER DOKUMENTTYP
  ========================================================= */

  function detectSemanticType(text) {
    const t   = String(text || "").toLowerCase();
    const neg = window.FideliorNegativeRules || null;

    if (neg?.isDefinitelyNotInvoice && neg.isDefinitelyNotInvoice(t)) return "dokument";
    if (/\b(zahlungserinnerung|mahnung|erste mahnung|zweite mahnung|dritte mahnung|reminder|payment reminder|overdue notice|inkasso|forderungsmanagement)\b/i.test(t)) return "mahnung";
    if (/\b(gutschrift|credit note|refund)\b/i.test(t)) return "gutschrift";
    if (/\b(angebot|offer|quotation)\b/i.test(t)) return "angebot";
    if (/\b(vertragsbestätigung|auftragsbestätigung|bestätigung)\b/i.test(t)) return "vertrag";

    const hasInvoice  = /\b(rechnung|invoice|bill|verbrauchsabrechnung|liquidation)\b/i.test(t);
    const hasTotal    = /\b(gesamt|summe|total|zu zahlen|rechnungsbetrag|invoice total|amount due|zahlbetrag|endbetrag)\b/i.test(t);
    const hasCurrency = /€|\beur\b/i.test(t);

    if (hasInvoice && (hasTotal || hasCurrency)) return "rechnung";
    return "dokument";
  }

  function detectTypeFromSemantic(s) {
    return (s === "rechnung" || s === "gutschrift") ? "rechnung" : "dokument";
  }

  /* =========================================================
     ADRESSBLOCK-DETEKTOR
     Erkennt Empfänger-Sequenzen: Name / Straße / PLZ Ort
     Gibt Menge der absoluten Zeilenindizes zurück die zur
     Empfänger-Adresse gehören.
  ========================================================= */

  function buildRecipientLikeIndices(allLines) {
    const streetRx  = /\b(straße|strasse|str\.)\s*\d|\b(weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive|boulevard|court)\b/i;
    const zipCityRx = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]{2}/;
    const set       = new Set();

    for (let i = 0; i < allLines.length; i++) {
      const l0 = normalizeWs(allLines[i]);
      const l1 = normalizeWs(allLines[i + 1] || "");
      const l2 = normalizeWs(allLines[i + 2] || "");

      // Name + Straße + PLZ/Ort (3-zeilig)
      if (streetRx.test(l1) && zipCityRx.test(l2)) {
        set.add(i); set.add(i + 1); set.add(i + 2);
        continue;
      }

      // Straße + PLZ/Ort (2-zeilig), Zeile davor = Name
      if (streetRx.test(l0) && zipCityRx.test(l1)) {
        if (i > 0) set.add(i - 1);
        set.add(i); set.add(i + 1);
        continue;
      }

      // PLZ/Ort direkt → Straße davor, Name davor
      if (zipCityRx.test(l0) && streetRx.test(normalizeWs(allLines[i - 1] || ""))) {
        if (i >= 2) set.add(i - 2);
        if (i >= 1) set.add(i - 1);
        set.add(i);
      }
    }

    return set;
  }

  /* =========================================================
     ABSENDER
  ========================================================= */

  function detectSenderCandidates(payload) {
    const candidates = [];
    const zones      = payload?.zones || {};
    const allLines   = payload?.lines || [];
    const profile    = payload?.profile || null;

    const recipientLike = buildRecipientLikeIndices(allLines);

    const companyFormRx = /\b(gmbh|ag|kg|ug|ohg|kgaa|mbh|ltd\.?|inc\.?|corp\.?|llc|s\.?a\.?r?\.?l\.?|b\.?v\.?|n\.?v\.?|plc|s\.?p\.?a\.?|s\.?r\.?l\.?|e\.?\s*k\.?|e\.?\s*v\.?|gbr|partg|holding|immobilien|hausverwaltung|verwaltung|management|solutions|services|service|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke|wasser|praxis|apotheke|steuerberatung|steuerberater|notar|rechtsanwalt|online|telecom|telekom|digital|media|group|verlag|vertrieb|handel|technik|systems|system|consulting|consult|partner|netz|netze|netzwerk|infrastruktur|dienstleistung|dienstleistungen|bau|baubetrieb|elektro|sanitär|heizung|dach|maler|versand|logistik|transport|spedition|software|hardware|capital|invest)\b/i;

    const negativeLineRx = /\b(rechnung|invoice|kundennummer|kunden\-?nr|vertragsnummer|vertrag\s*nr|iban|bic|swift|telefon\s*nr|fax|e-?mail|www\.|ust\-?id|mwst|steuer\s*nr|datum|seite|page|tarif|lieferadresse|rechnungsadresse|leistungsempfänger|kontonummer|konto\s*nr)\b/i;
    const greetingRx    = /^(sehr geehrte|guten tag|hallo|dear|liebe[rs]?|hi\b)\b/i;
    const streetRx      = /\b(straße|strasse|str\.)\s*\d|\b(weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive|boulevard|court)\b/i;
    const zipCityRx     = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]/;
    const sentenceRx    = /\b(wir|sie|bitte|danke|hiermit|prüfung|zahlung|überweisen|kontaktieren|informieren|bitten|teilen|stellen|wurden|haben|sind|werden)\b/i;
    const labelPrefixRx = /^(name|firma|absender|rechnungssteller|vendor|lieferant|auftragnehmer)\s*:\s*/i;

    function push(line, baseScore, source, absIdx, zoneTag) {
      const s = normalizeWs(line);
      if (!s || s.length < 3 || s.length > 90) return;
      if (s.split(/\s+/).length > 9) return;
      if (/[!?]/.test(s)) return;
      if (greetingRx.test(s)) return;
      if (sentenceRx.test(s)) return;
      if (zipCityRx.test(s))  return;
      if (streetRx.test(s))   return;

      const hasLabel      = labelPrefixRx.test(s);
      const hasCompany    = companyFormRx.test(s);
      const hasNegative   = negativeLineRx.test(s);
      const isInAddrBlock = Number.isInteger(absIdx) && recipientLike.has(absIdx);

      let score = baseScore;
      if (hasLabel)   score += 8;
      if (hasCompany) score += 14;
      if (!hasNegative) score += 2;
      if (!/\d/.test(s)) score += 1;

      // Adressblock-Malus: sehr stark, damit echter Firmenkopf immer gewinnt
      if (isInAddrBlock) score -= 30;

      switch (zoneTag) {
        case "senderZone":
          score += 8;
          if (Number.isInteger(absIdx) && absIdx <= 1) score += 6; // allererste Zeilen
          else if (Number.isInteger(absIdx) && absIdx <= 3) score += 3;
          break;
        case "recipientZone":
          score -= 28;
          break;
        case "metaZone":
          score -= 2;
          break;
        case "footerZone":
          if (!hasLabel) score -= 8;
          break;
        default:
          break;
      }

      if (score <= 0) return;

      const value = hasLabel ? s.replace(labelPrefixRx, "").trim() : s;
      if (!value) return;

      candidates.push({
        value,
        score,
        line:  s,
        index: Number.isInteger(absIdx) ? absIdx : -1,
        source
      });
    }

    // senderZone: absolute Zeilenindizes
    const senderZoneLines = zones.senderZone || zones.headerTop || [];
    senderZoneLines.forEach((line, localIdx) => {
      push(line, localIdx <= 2 ? 16 : 11, "Absenderzone", localIdx, "senderZone");
    });

    // metaZone
    const metaStart = (zones.indices?.metaStart) ?? 8;
    (zones.metaZone || zones.metaBlock || []).forEach((line, localIdx) => {
      push(line, 4, "Metazone", metaStart + localIdx, "metaZone");
    });

    // recipientZone (explizit vom Extraktor)
    (zones.recipientZone || zones.recipientBlock || []).forEach((line) => {
      push(line, 2, "Empfängerzone", -1, "recipientZone");
    });

    // footerZone: nur explizite Labels
    (zones.footerZone || []).forEach((line) => {
      if (labelPrefixRx.test(normalizeWs(line))) push(line, 14, "Footer-Label", -1, "footerZone");
    });

    // Volltext-Label
    const labelMatch = String(payload?.rawText || "").match(
      /\b(?:rechnungssteller|lieferant|anbieter|auftragnehmer|vendor|supplier)\b[:\s]+([^\n]{3,80})/i
    );
    if (labelMatch?.[1]) push(cleanToken(labelMatch[1]), 22, "Label im Dokument", -1, "metaZone");

    if (profile?.name) {
      candidates.push({
        value:  normalizeWs(profile.name),
        score:  30,
        line:   profile.name,
        index:  -1,
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

    const badPrefixRx = /^(KDNR|KUNDENNR|KUNDENNUMMER|KUNDE|CUSTOMER|ACCOUNT|AUFTRAG|BESTELL|ORDER|VERTRAG|CONTRACT|CLIENT|ACC|BIC|IBAN|SWIFT|DATUM|DATE|SEITE|PAGE|ERSTELLT|KOPIE|COPY|ORIGINAL|TEL|FAX|PLZ|NR)\b/i;
    const ibanRx      = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;
    const dateLikeRx  = /^(\d{1,2}[.\-\/]){2}\d{2,4}$/;
    const phoneLikeRx = /^[\d\s\+\-\/\(\)]{8,}$/;
    const rufnummerRx = /^0\d{5,}$/;

    function isValidToken(token) {
      if (!token || token.length < 3 || token.length > 32) return false;
      if (!/\d/.test(token)) return false;
      if (badPrefixRx.test(token))  return false;
      if (ibanRx.test(token))       return false;
      if (dateLikeRx.test(token))   return false;
      if (phoneLikeRx.test(token) && !/[A-Z]/i.test(token)) return false;
      if (rufnummerRx.test(token))  return false;
      return true;
    }

    const goodCtxRx = /\b(rechnung|invoice|rg-?nr\.?|rechnungs?-?(?:nummer|nr\.?|no\.?)|belegnummer|beleg-?nr\.?|referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?|dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\b/i;
    const badCtxRx  = /\b(kundennummer|kunden-?nr\.?|customer\s*(?:no|number)|iban|bic|swift|vertragskonto|mandatsreferenz|mandats-?ref|rufnummer|telefonnummer|bestellnummer|vertrags-?nr\.?|debitor|kreditinstitut|bankverbindung|kontonummer|konto-?nr\.?)\b/i;

    function push(value, line, baseScore, source, index) {
      const token = cleanToken(value).replace(/\s+/g, "");
      if (!isValidToken(token)) return;

      const lineN = normalizeWs(line);
      let s = baseScore;

      if (goodCtxRx.test(lineN))                                       s += 10;
      if (/\brechnung\s+[A-Z0-9]/i.test(lineN))                        s += 8;
      if (semanticType === "rechnung" || semanticType === "gutschrift")  s += 2;
      if (/^[A-Z]{1,4}[-_\/]\d{4,}$/i.test(token))                     s += 8;
      if (/^[A-Z]{1,4}[-_\/]\d{4}[-_\/]\d+$/i.test(token))             s += 8;
      if (/^\d{2,4}\/\d{3,}$/.test(token))                              s += 6;
      if (/^[A-Z]{1,3}\d{6,}$/i.test(token))                            s += 8;
      if (/^\d{6,}$/.test(token))                                        s += 4;
      if (badCtxRx.test(lineN) && !goodCtxRx.test(lineN))              s -= 16;

      if (s <= 0) return;
      candidates.push({ value: token, score: s, line: lineN, index: Number.isInteger(index) ? index : -1, source });
    }

    const labelDefs = [
      { rx: /\b(rechnungs?(?:nummer|nr\.?|no\.?|#))\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,          base: 28, src: "Rechnungsnummer-Label" },
      { rx: /\b(rechnung)\s+([A-Z0-9][A-Z0-9.\-\/_]{2,})/gi,                                               base: 26, src: "Rechnung-Heading" },
      { rx: /\b(invoice\s*(?:no\.?|nr\.?|number|#)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,          base: 28, src: "Invoice-Label" },
      { rx: /\b(belegnummer|beleg-?nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,                     base: 24, src: "Belegnummer" },
      { rx: /\b(rg\.?\s*nr\.?|rn\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,                         base: 24, src: "RG-Nr-Label" },
      { rx: /\b(referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi, base: 20, src: "Referenz-Label" },
      { rx: /\b(dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,  base: 20, src: "Dokument-Nr-Label" },
      { rx: /\b(r-?nr\.?|doc\.?\s*(?:no|nr)\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,              base: 18, src: "Sonstige-Nr-Label" }
    ];

    function scanZone(lines, zoneBonus) {
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

    scanZone(zones.metaZone || zones.metaBlock || [],                  6);
    scanZone((zones.senderZone || zones.headerTop || []).slice(0, 10), 4);
    scanZone((zones.bodyZone  || zones.body      || []).slice(0, 80),  0);

    for (const def of labelDefs) {
      const rx = new RegExp(def.rx.source, "gi");
      let m;
      while ((m = rx.exec(joined))) {
        if (m[2]) push(m[2], m[0], def.base, def.src + " (Volltext)", -1);
      }
    }

    const labelOnlyRx  = /\b(rechnungs?(?:nummer|nr\.?|no\.?)|rechnung\s*nr\.?|invoice\s*(?:no\.?|nr\.?|number)?|belegnummer|beleg-?nr\.?|rg-?nr\.?|referenz(?:nr\.?)?|dokumenten?(?:nummer|nr\.?)?|r-?nr\.?)\s*[:#\s\-]*$/i;
    const singleTokRx  = /^([A-Z0-9][A-Z0-9.\-\/_]{2,29})\s*$/i;

    allLines.forEach((rawLine, idx) => {
      const line = normalizeWs(rawLine);
      if (!labelOnlyRx.test(line)) return;
      for (let off = 1; off <= 2; off++) {
        const next = normalizeWs(allLines[idx + off] || "");
        if (!next) continue;
        const full = next.match(singleTokRx);
        if (full) { push(full[1], line + " " + next, 28, "Multi-Line-Label", idx); break; }
        const first = next.split(/\s+/)[0] || "";
        if (first.length >= 3 && isValidToken(first)) { push(first, line + " " + next, 26, "Multi-Line-Label", idx); break; }
        break;
      }
    });

    if (Array.isArray(profile?.invoiceNumberPatterns)) {
      for (const rx of profile.invoiceNumberPatterns) {
        if (!(rx instanceof RegExp)) continue;
        const safeRx = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
        let m;
        while ((m = safeRx.exec(joined))) push(m[1] || m[0], m[0], 32, "Lieferantenprofil Rechnungsnummer", -1);
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

    /*
     * TOTAL_LABELS: Wörterbuch für alle bekannten Gesamtbetrags-Labels.
     * Enthält explizit Bindestriche ("Bruttorechnungs-Betrag"),
     * weil \bbruttorechnungsbetrag\b solche Formen nicht trifft.
     */
    const TOTAL_LABELS = [
      { rx: /\bzu\s+zahlen\b/i,                                    score: 30 },
      { rx: /\bzu\s+überweisen\b/i,                                 score: 30 },
      { rx: /\bzu\s+zahlender\s+betrag\b/i,                         score: 30 },
      { rx: /\bzahlbetrag\b/i,                                      score: 28 },
      { rx: /\bgesamtbetrag\b/i,                                    score: 28 },
      { rx: /\brechnungsbetrag\b/i,                                  score: 28 },
      { rx: /\brechnungsendbetrag\b/i,                               score: 30 },
      { rx: /\bendbetrag\b/i,                                       score: 26 },
      { rx: /\bbrutto-?rechnungs-?betrag\b/i,                       score: 28 }, // "Bruttorechnungs-Betrag", "Bruttorechnungsbetrag"
      { rx: /\bbrutto-?betrag\b/i,                                  score: 26 },
      { rx: /\bbrutto-?summe\b/i,                                   score: 26 },
      { rx: /\bgesamt-?summe\b/i,                                   score: 26 },
      { rx: /\bgesamt-?preis\b/i,                                   score: 24 },
      { rx: /\brechnungs-?summe\b/i,                                score: 26 },
      { rx: /\binvoice\s+total\b/i,                                 score: 28 },
      { rx: /\btotal\s+amount\s+(due|payable)\b/i,                  score: 28 },
      { rx: /\bamount\s+(due|payable)\b/i,                          score: 28 },
      { rx: /\boffener?\s+betrag\b/i,                               score: 26 },
      { rx: /\bnoch\s+offen\b/i,                                    score: 26 },
      { rx: /\boffene\s+forderung\b/i,                              score: 26 },
      { rx: /\brestbetrag\b/i,                                      score: 24 },
      { rx: /\bgesamt-?forderung\b/i,                               score: 26 },
      { rx: /\bforderungs-?betrag\b/i,                              score: 24 },
      { rx: /\bbetrag\s+inkl\.?\s*(mwst|ust|mehrwertsteuer)\b/i,    score: 26 },
      { rx: /\binkl\.?\s*(mwst|ust)\s+gesamt\b/i,                  score: 24 },
      { rx: /\binkl\.?\s*(mwst|ust)\b/i,                           score: 18 },
      { rx: /\bsumme\b/i,                                           score: 16 },
      { rx: /\btotal\b/i,                                           score: 14 },
      { rx: /\bgesamt\b/i,                                          score: 14 }
    ];

    const STRONG_THRESHOLD = 18; // Labels ab diesem Score = klares Total-Signal

    const EXCLUDE = [
      /\bzwischensumme\b/i,
      /\bsubtotal\b/i,
      /\bnettobetrag\b/i,
      /\bnetto-?rechnung(?:s-?betrag)?\b/i,
      /\bnetto\b(?!\s*gesamt)/i,
      /\brabatt\b/i,
      /\bdiscount\b/i,
      /\bskonto\b/i,
      /\bversandkosten\b/i,
      /\blieferkosten\b/i,
      /\bporto\b/i,
      /\beinzelpreis\b/i,
      /\bstückpreis\b/i,
      /\babschlag\b/i,
      /\banzahlung\b/i,
      /\bvorauszahlung\b/i,
      /\bteilbetrag\b/i,
      /\bratenzahlung\b/i
    ];

    const TAX_PERCENT_RX = /\b(mwst\.?|ust\.?|mehrwertsteuer|vat)\s+\d{1,2}[,\.]\d{0,2}\s*%/i;

    function getLabelScore(text) {
      let best = 0;
      for (const l of TOTAL_LABELS) {
        if (l.rx.test(text) && l.score > best) best = l.score;
      }
      return best;
    }

    function isExcluded(text) {
      if (getLabelScore(text) >= STRONG_THRESHOLD) return false; // starkes Label hebt Ausschluss auf
      return EXCLUDE.some(rx => rx.test(text));
    }

    // Geldbetrags-Regex: exakt 2 Dezimalstellen
    const MONEY = /-?\d{1,3}(?:[.\u00A0]\d{3})*[,]\d{2}(?!\d)|-?\d{1,3}(?:[,]\d{3})*[.]\d{2}(?!\d)|-?\d+[,]\d{2}(?!\d)|-?\d+[.]\d{2}(?!\d)/g;

    function extractAmounts(text) {
      const seen = new Set();
      const out  = [];
      let m;

      // EUR/€ flankierte Werte zuerst (stärkste Evidenz)
      const currRx = /(?:EUR|€)\s*(-?\d[\d.,\u00A0]*\d|\d+[,\.]\d{2})|(-?\d[\d.,\u00A0]*\d|\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
      while ((m = currRx.exec(text))) {
        const raw = (m[1] || m[2]).replace(/\s/g, "");
        const v   = parseEuro(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (!seen.has(key)) { seen.add(key); out.push({ raw, value: v, hasCurrency: true }); }
      }

      // Geldbeträge ohne Währungszeichen
      const rx2 = new RegExp(MONEY.source, "g");
      while ((m = rx2.exec(text))) {
        const v = parseEuro(m[0]);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (!seen.has(key)) { seen.add(key); out.push({ raw: m[0], value: v, hasCurrency: false }); }
      }

      return out;
    }

    function baseScore(text, value, zoneBonus, lineIdx, totalLines) {
      const lsc      = getLabelScore(text);
      const excl     = isExcluded(text);
      const taxOnly  = TAX_PERCENT_RX.test(text) && lsc < STRONG_THRESHOLD;
      const hasIban  = /\bDE\d{2}\b/i.test(text);

      let s = 2 + zoneBonus;
      if (!excl && lsc > 0)  s += lsc;
      if (excl)              s -= 14;
      if (taxOnly)           s -= 16;
      if (hasIban)           s -= 20;
      if (value < 1)         s -= 12;
      if (value < 0.5)       s -= 8;

      if (lineIdx >= totalLines - 25) s += 4;
      if (lineIdx >= totalLines - 12) s += 6;

      if (semanticType === "rechnung" || semanticType === "gutschrift" || semanticType === "mahnung") s += 2;

      return s;
    }

    /*
     * Label→Wert-Direktscan
     * Nur aktiviert wenn Label-Score >= STRONG_THRESHOLD.
     * Sucht in derselben Zeile ODER in Nachbarzeilen.
     */
    function labelValueScan(lines, zoneBonus, lineOffset) {
      lines.forEach((rawLine, localIdx) => {
        const text = normalizeWs(rawLine);
        const lsc  = getLabelScore(text);
        if (lsc < STRONG_THRESHOLD) return;

        const absIdx = lineOffset + localIdx;
        const amounts = extractAmounts(text);

        if (amounts.length) {
          amounts.forEach(amt => {
            const s = 4 + zoneBonus + lsc + (amt.hasCurrency ? 4 : 0) + (semanticType === "rechnung" ? 2 : 0);
            candidates.push({ value: amt.value, raw: amt.raw, score: s, line: text, index: absIdx, source: "Label-Direktscan" });
          });
          return;
        }

        // Wert steht in Nachbarzeile
        for (const offset of [1, -1, 2]) {
          const nbRaw = normalizeWs(lines[localIdx + offset] || "");
          if (!nbRaw) continue;
          const nbAmts = extractAmounts(nbRaw);
          if (!nbAmts.length) continue;
          nbAmts.forEach(amt => {
            const s = 4 + zoneBonus + lsc + 8 + (amt.hasCurrency ? 4 : 0) + (semanticType === "rechnung" ? 2 : 0);
            candidates.push({ value: amt.value, raw: amt.raw, score: s, line: text + " | " + nbRaw, index: absIdx, source: "Multi-Line-Total" });
          });
          break;
        }
      });
    }

    // Label-Direktscan auf Zonen (höchste Zone-Boni)
    const totLen = zones.totalsZone?.length || 0;
    const fotLen = zones.footerZone?.length || 0;
    labelValueScan(zones.totalsZone || [], 14, allLines.length - totLen);
    labelValueScan(zones.footerZone || [], 10, allLines.length - fotLen);
    labelValueScan(zones.tableZone  || [],  4, 0);
    labelValueScan(allLines,                0, 0);

    // Generischer Zeilen-Scan für alle Zeilen
    allLines.forEach((rawLine, idx) => {
      const text    = normalizeWs(rawLine);
      if (!text) return;
      const amounts = extractAmounts(text);
      amounts.forEach((amt, pos) => {
        const s = baseScore(text, amt.value, 0, idx, allLines.length)
          + (amt.hasCurrency ? 3 : 0)
          + (pos === amounts.length - 1 && amounts.length > 1 ? 2 : 0);
        candidates.push({
          value:  amt.value,
          raw:    amt.raw,
          score:  s,
          line:   text,
          index:  idx,
          source: getLabelScore(text) >= STRONG_THRESHOLD ? "Totalzeile" : "Betrag aus Dokument"
        });
      });
    });

    // Zahlungssatz: "Rechnungsbetrag in Höhe von X,XX EUR"
    const payRx = /(?:rechnungsbetrag|gesamtbetrag|betrag|zahlung|zahlungsbetrag|zahlen\s+sie)\s+(?:in\s+h[öo]he\s+von\s+|von\s+|[üu]ber\s+|i\.?h\.?v\.?\s*)?(-?\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
    let pm;
    while ((pm = payRx.exec(joined))) {
      const v = parseEuro(pm[1]);
      if (Number.isFinite(v) && v > 0) {
        candidates.push({ value: v, raw: pm[1], score: 32, line: normalizeWs(pm[0]), index: -1, source: "Zahlungssatz" });
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

    const labelDefs = [
      { rx: /\b(rechnungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,         score: 28, src: "Rechnungsdatum" },
      { rx: /\b(ausstellungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,       score: 26, src: "Ausstellungsdatum" },
      { rx: /\b(invoice\s*date)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,          score: 26, src: "Invoice-Date" },
      { rx: /\b(belegdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,              score: 24, src: "Belegdatum" },
      { rx: /\b(datum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,                   score: 18, src: "Datum-Label" },
      { rx: /\b(leistungsdatum|lieferdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i, score: 16, src: "Leistungsdatum" }
    ];

    const dueDateRx = /\b(fälligkeits?datum|fällig\s+(?:am|bis|zum)|zahlungsziel|zahlungsfrist|due\s+date|pay\s+by|payment\s+due)\b/i;
    const todayIso  = new Date().toISOString().slice(0, 10);

    function pushDate(iso, line, score, source, index) {
      if (!iso || iso > todayIso) return;
      candidates.push({ value: formatDisplayDate(iso), iso, score, line: normalizeWs(line), index: Number.isInteger(index) ? index : -1, source });
    }

    function scanLine(line, idx, zoneBonus) {
      if (!line) return;
      const isDue = dueDateRx.test(line);
      for (const def of labelDefs) {
        const m = line.match(def.rx);
        if (!m?.[2]) continue;
        const iso = toIsoDate(m[2]);
        if (!iso) continue;
        let s = def.score + zoneBonus;
        if (isDue) s -= 14;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src + (zoneBonus > 0 ? " (Zone)" : ""), idx);
      }
      if (zoneBonus > 0) {
        [...line.matchAll(/\b(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\b/g)].forEach(m => {
          const iso = toIsoDate(m[1]);
          if (!iso) return;
          let s = 6;
          if (/\b(rechnungsdatum|invoice\s*date|belegdatum|ausstellungsdatum)\b/i.test(line)) s = 22;
          else if (/\bdatum\b/i.test(line)) s = 14;
          if (isDue) s -= 10;
          pushDate(iso, line, s + zoneBonus, "Datum in Zone", idx);
        });
      }
    }

    (zones.metaZone || zones.metaBlock || []).forEach((l, i) => scanLine(normalizeWs(l), i, 6));
    (zones.senderZone || zones.headerTop || []).forEach((l, i) => scanLine(normalizeWs(l), i, 4));

    allLines.forEach((rawLine, idx) => {
      const line  = normalizeWs(rawLine);
      if (!line) return;
      const isDue = dueDateRx.test(line);
      for (const def of labelDefs) {
        const m = line.match(def.rx);
        if (!m?.[2]) continue;
        const iso = toIsoDate(m[2]);
        if (!iso) continue;
        let s = def.score;
        if (isDue) s -= 14;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src, idx);
      }
    });

    // Multi-Line-Datum
    const labelOnlyDateRx = /\b(rechnungsdatum|invoice\s*date|belegdatum|ausstellungsdatum|datum)\s*[:#\s\-]*$/i;
    const dateValueOnlyRx = /^\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\s*$/;

    allLines.forEach((rawLine, idx) => {
      const line = normalizeWs(rawLine);
      if (!labelOnlyDateRx.test(line)) return;
      const isDue = dueDateRx.test(line);
      for (let off = 1; off <= 2; off++) {
        const next = normalizeWs(allLines[idx + off] || "");
        if (!next) continue;
        const m = next.match(dateValueOnlyRx);
        if (!m?.[1]) { if (off === 1) continue; break; }
        const iso = toIsoDate(m[1]);
        let s = 26;
        if (isDue) s -= 14;
        pushDate(iso, line + " " + next, s, "Multi-Line-Datum", idx);
        break;
      }
    });

    const supplierApi = window.FideliorSupplierProfiles || null;
    if (supplierApi?.detectDateByProfile) {
      try {
        const pd  = supplierApi.detectDateByProfile(payload, profile);
        if (pd) { const iso = toIsoDate(pd); if (iso) pushDate(iso, pd, 22, "Lieferantenprofil Datum", -1); }
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

    const supplierApi = window.FideliorSupplierProfiles || null;
    if (!payload.profile && supplierApi?.findMatchingProfile) {
      try { payload.profile = supplierApi.findMatchingProfile(textString) || null; } catch (_) {}
    }

    const semanticType = detectSemanticType(textString);
    const type         = detectTypeFromSemantic(semanticType);

    let senderCandidates    = detectSenderCandidates(payload);
    let referenceCandidates = detectReferenceCandidates(payload, semanticType);
    let amountCandidates    = detectAmountCandidates(payload, semanticType);
    let dateCandidates      = detectDateCandidates(payload, semanticType);

    senderCandidates    = applyProfileBoost("sender",    senderCandidates,    payload.profile, payload);
    referenceCandidates = applyProfileBoost("reference", referenceCandidates, payload.profile, payload);
    amountCandidates    = applyProfileBoost("amount",    amountCandidates,    payload.profile, payload);
    dateCandidates      = applyProfileBoost("date",      dateCandidates,      payload.profile, payload);

    referenceCandidates = applyNegativeRules("reference", referenceCandidates, payload);
    amountCandidates    = applyNegativeRules("amount",    amountCandidates,    payload);

    senderCandidates    = dedupeCandidates(senderCandidates,    c => normalizeCompare(c.value));
    referenceCandidates = dedupeCandidates(referenceCandidates, c => normalizeCompare(c.value));
    amountCandidates    = dedupeCandidates(amountCandidates,    c => String(Number(c.value).toFixed(2)));
    dateCandidates      = dedupeCandidates(dateCandidates,      c => c.iso || normalizeCompare(c.value));

    const senderField = finalizeField(senderCandidates, {
      minScore:         14,
      minMargin:        4,
      minAbsoluteScore: 32,
      emptyValue:       ""
    });

    const referenceField = (type === "rechnung")
      ? finalizeField(referenceCandidates, {
          minScore:         14,
          minMargin:        4,
          minAbsoluteScore: 32,
          emptyValue:       ""
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

    /*
     * Betrag: minAbsoluteScore 28
     * Eindeutiger Totalwert ("Bruttorechnungs-Betrag 7,99 EUR") erreicht
     * Label-Direktscan-Score >> 28 → wird ohne Margin-Prüfung übernommen.
     */
    const amountField = finalizeField(amountCandidates, {
      minScore:         16,
      minMargin:        4,
      minAbsoluteScore: 28,
      emptyValue:       NaN
    });

    const dateField = finalizeField(dateCandidates, {
      minScore:         14,
      minMargin:        3,
      minAbsoluteScore: 30,
      emptyValue:       ""
    });

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

  console.info("[FideliorAI] zentrale Analyse-Engine v7 aktiv");
})();
