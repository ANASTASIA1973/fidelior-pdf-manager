/* =========================================================
   Fidelior AI Engine v9
   Zentrale Dokumentanalyse – Single Source of Truth

   Prinzipien:
   - Kandidaten -> Scoring -> Confidence -> Feldwert
   - Supplier Profiles boosten, überschreiben nicht blind
   - UI rendert nur
   - lieber leer als falsch – aber nicht unnötig leer

   v9 Fixes:
   - finalizeField: Confidence-Gate entfernt – minScore + minMargin
     sind die einzigen Qualitätstore; Confidence ist rein informativ.
     Verhindert, dass valide Medium-Kandidaten still verworfen werden.
   - Sender: partyBlocks.bestSenderBlock wieder aktiviert (war in v8
     auskommentiert); Score gedeckelt auf 36.
   - buildRecipientLikeIndices: "An Herrn/Frau/die Firma" explizit als
     Empfänger-Anker → verhindert Empfängernamen als Absender.
   - detectDateCandidates: "Druckdatum", "Erstellt am", "Erstellungsdatum",
     "Leistungszeitraum" / "Abrechnungszeitraum" erhalten Negativ-Score;
     Fälligkeits-Penalty auf -18 erhöht.
   - detectAmountCandidates: MwSt-Prozentzeilenmalus stabilisiert;
     "Monatsprämie" / "monatlich" in EXCLUDE ergänzt.
   - detectSenderCandidates: "Empfänger", "An die Firma" als harte
     Ausschlüsse; companyFormRx um Branchen erweitert.
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

  /*
   * Entfernt OCR-Artefakte am Anfang eines Strings.
   * Betrifft kurze, rein-kleingeschriebene Fragmente wie "iy", "1y", "dy".
   * Lässt legitime Präfixe wie "e.K.", "AG" oder "Dr." unangetastet.
   */
 function stripOcrJunk(value) {
    let v = String(value || "");
    // Führende 1-3-Zeichen Kleinbuchstaben/Ziffern-Kombinationen (z. B. "iy", "1y", "ab2")
    v = v.replace(/^([a-z]{1,3}|\d[a-z]{1,2}|[a-z]{1,2}\d)\s+/, "").trim();
    // Führende einzelne Ziffer vor Großbuchstaben (OCR-Fragment wie "1 Stadtwerke")
    v = v.replace(/^\d\s+(?=[A-ZÄÖÜ])/, "").trim();
    // Führende Sonderzeichen oder Pipes
    v = v.replace(/^[|\\\/~`'"^*_=+<>]+\s*/, "").trim();
    // Führender Punkt oder Bindestrich vor Großbuchstaben (OCR-Artefakt ". ABC GmbH")
    v = v.replace(/^[.\-]\s+(?=[A-ZÄÖÜ])/, "").trim();
    return v;
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
   * opts.minAbsoluteScore:
   *   Wenn der beste Kandidat diesen Score erreicht, wird er ohne
   *   Margin-Prüfung übernommen. Verhindert, dass eindeutige Kandidaten
   *   (z. B. klarer Total-Label-Treffer) wegen niedriger Margin verworfen werden.
   *   Kein Confidence-Check beim Absolut-Pfad (v8: Confidence-Sperre entfernt).
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

    // Absolut-Pfad: hoher Score genügt, keine weitere Prüfung
    if ((best.score || 0) >= minAbsoluteScore) return result();

    // Qualitäts-Tore: Score und Abstand zum zweitbesten Kandidaten.
    // Confidence ist rein informativ – kein eigenes Gate hier.
    // (v9: Confidence-Gate entfernt; medium-Kandidaten mit gutem Score/Margin passieren)
    if ((best.score || 0) < minScore) return empty();
    if (margin < minMargin)           return empty();

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
    const hasTotal    = /\b(gesamt|summe|total|zu zahlen|rechnungsbetrag|invoice total|amount due|zahlbetrag|endbetrag|jahresbetrag|jahresprämie|beitrag)\b/i.test(t);
    const hasCurrency = /€|\beur\b/i.test(t);

    if (hasInvoice && (hasTotal || hasCurrency)) return "rechnung";
    // Dokument hat klaren Finanzbezug aber kein "Rechnung"-Label → trotzdem Rechnung
    if (hasTotal && hasCurrency && /\b(versicherung|telekom|energie|wasser|gas|strom|internet|mobilfunk|handy|tarif)\b/i.test(t)) return "rechnung";
    return "dokument";
  }

  function detectTypeFromSemantic(s) {
    return (s === "rechnung" || s === "gutschrift") ? "rechnung" : "dokument";
  }

  /* =========================================================
     ADRESSBLOCK-DETEKTOR
     Erkennt Empfänger-Sequenzen: Name → Straße → PLZ/Ort
     Gibt Set der absoluten Zeilenindizes zurück.
  ========================================================= */
  function buildRecipientLikeIndices(allLines) {
    const streetRx        = /\b(straße|strasse|str\.)\s*\d|\b(weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive|boulevard|court)\b/i;
    const zipCityRx       = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]{2}/;
    // Explizite Empfänger-Präfixe: persönliche Anreden + "An Herrn/Frau/die Firma"
    const recipientPfxRx  = /^(Herr|Frau|Familie|Dr\.?|Prof\.?|z\.?\s*Hd\.?|c\/o|An\s+(Herrn?|Frau|die\s+Firma|den)|Empfänger(?:in)?)\b/i;
    const set             = new Set();

    for (let i = 0; i < allLines.length; i++) {
      const l0 = normalizeWs(allLines[i]);
      const l1 = normalizeWs(allLines[i + 1] || "");
      const l2 = normalizeWs(allLines[i + 2] || "");
      const l3 = normalizeWs(allLines[i + 3] || "");

      // 3-Zeiler: i=Name, i+1=Straße, i+2=PLZ
      if (streetRx.test(l1) && zipCityRx.test(l2)) {
        set.add(i); set.add(i + 1); set.add(i + 2);
        continue;
      }
      // 3-Zeiler ab Straße: i=Straße, i+1=PLZ
      if (streetRx.test(l0) && zipCityRx.test(l1)) {
        if (i > 0) set.add(i - 1);
        set.add(i); set.add(i + 1);
        continue;
      }
      // 4-Zeiler: i=Name1, i+1=Name2, i+2=Straße, i+3=PLZ
      if (streetRx.test(l2) && zipCityRx.test(l3) && !streetRx.test(l0)) {
        set.add(i); set.add(i + 1); set.add(i + 2); set.add(i + 3);
        continue;
      }
      // Expliziter Empfänger-Präfix (Herr/Frau/Familie/c.o) als Anker
      if (recipientPfxRx.test(l0)) {
        set.add(i);
        if (streetRx.test(l2) && zipCityRx.test(l3)) {
          set.add(i + 1); set.add(i + 2); set.add(i + 3);
        } else if (streetRx.test(l1) && zipCityRx.test(l2)) {
          set.add(i + 1); set.add(i + 2);
        }
        continue;
      }
      // PLZ-first: ZIP an i, Straße an i-1
      if (zipCityRx.test(l0) && i >= 1 && streetRx.test(normalizeWs(allLines[i - 1] || ""))) {
        if (i >= 2) set.add(i - 2);
        set.add(i - 1);
        set.add(i);
      }
    }

    return set;
  }

  /* =========================================================
     PARTEIEN-BLÖCKE
     Erkennt zusammenhängende Zeilen als Blöcke (Absender /
     Empfänger / Kontakt) – inhaltsbasiert, ohne Index-Abhängigkeit.
     Gibt zurück:
       bestSenderBlock   – { value, score } oder null
       recipientLineKeys – Set normalisierter Zeileninhalt
       contactLineKeys   – Set normalisierter Zeileninhalt
  ========================================================= */

  function detectPartyBlocks(lines) {
    const N = Math.min(lines.length, 40);

    const streetRx2       = /\b(straße|strasse|str\.)\s*\d|\b(weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive)\b/i;
    const zipCityRx2      = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]{2}/;
    const recipientPfxRx2 = /^(Herr|Frau|Familie|z\.?\s*Hd\.?|c\/o)\b/i;
    const contactRx2      = /\b(tel\.?(?:efon)?|fax|mobil|e-?mail|www\.|http|ihre\s+fragen|hotline|kundenservice|service-?center)\b/i;
    const companyRx2      = /\b(gmbh|ag|kg|ug|ohg|kgaa|se|mbh|ltd\.?|inc\.?|corp\.?|llc|gbr|partg|holding|immobilien|hausverwaltung|verwaltung|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke|wasser|telecom|telekom|digital|media|group|verlag|vertrieb)\b/i;

    const recipientLineKeys = new Set();
    const contactLineKeys   = new Set();

    // --- Schritt 1: Empfänger-Adressblock finden ---
    // Gleiche Logik wie detectRecipientRange, aber auf allLines statt head.
    // Schleife startet bei i=2: erste zwei Zeilen gehören zum Absender-Briefkopf.
    let recipientStart = -1;
    let recipientEnd   = -1;

    for (let i = 2; i < N - 1; i++) {
      const l0 = normalizeWs(lines[i]     || "");
      const l1 = normalizeWs(lines[i + 1] || "");
      const l2 = normalizeWs(lines[i + 2] || "");
      const l3 = normalizeWs(lines[i + 3] || "");

      // Starker Anker: expliziter Empfänger-Präfix
      if (recipientPfxRx2.test(l0)) {
        recipientStart = i;
        if (streetRx2.test(l2) && zipCityRx2.test(l3)) recipientEnd = i + 3;
        else if (streetRx2.test(l1) && zipCityRx2.test(l2)) recipientEnd = i + 2;
        else recipientEnd = i + 1;
        break;
      }

      // 3-Zeiler: l0=Name, l1=Straße, l2=PLZ
      if (streetRx2.test(l1) && zipCityRx2.test(l2)) {
        recipientStart = i;
        recipientEnd   = i + 2;
        break;
      }

      // 4-Zeiler: l0=Name1, l1=Name2, l2=Straße, l3=PLZ
      if (streetRx2.test(l2) && zipCityRx2.test(l3) && !streetRx2.test(l0)) {
        recipientStart = i;
        recipientEnd   = i + 3;
        break;
      }
    }

    // Empfänger-Zeilen in Set aufnehmen
    if (recipientStart >= 0) {
      for (let i = recipientStart; i <= Math.min(recipientEnd, N - 1); i++) {
        const l = normalizeWs(lines[i] || "");
        if (l) recipientLineKeys.add(normalizeCompare(l));
      }
    }

    // --- Schritt 2: Kontaktzeilen markieren (gesamtes Header-Fenster) ---
    for (let i = 0; i < N; i++) {
      const l = normalizeWs(lines[i] || "");
      if (contactRx2.test(l) && !companyRx2.test(l)) {
        contactLineKeys.add(normalizeCompare(l));
      }
    }

    // --- Schritt 3: Besten Absender-Kandidaten vor dem Empfängerblock finden ---
    const senderSearchEnd = recipientStart > 0 ? recipientStart : Math.min(10, N);
    let bestSenderBlock = null;
    let bestScore       = -Infinity;

    for (let i = 0; i < senderSearchEnd; i++) {
      const l = normalizeWs(lines[i] || "");
      if (!l || l.length < 3) continue;
      if (streetRx2.test(l) || zipCityRx2.test(l) || contactRx2.test(l)) continue;
      if (recipientPfxRx2.test(l)) continue;

      const hasCompany = companyRx2.test(l);

      let s = 0;
      if (i <= 1)      s += 12;
      else if (i <= 3) s += 7;
      else             s += 3;
      if (hasCompany)  s += 14;

      if (s > bestScore) {
        bestScore       = s;
        bestSenderBlock = { value: stripOcrJunk(l), score: s };
      }
    }

    return { bestSenderBlock, recipientLineKeys, contactLineKeys };
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

    // Inhaltsbasierter Empfänger-Check: Fängt Fälle ab, in denen recipientLike
    // wegen lokalem vs. absolutem Zeilenindex nicht greift (senderZone-Scan
    // übergibt localIdx, recipientLike enthält aber absolute Indizes).
   const recipientContentSet = new Set(
      (zones.recipientZone || zones.recipientBlock || [])
        .map(l => normalizeCompare(normalizeWs(l)))
        .filter(Boolean)
    );

    // Block-basierte Parteien-Erkennung: arbeitet auf allLines, kein Index-Problem.
    const partyBlocks = detectPartyBlocks(allLines);

    const companyFormRx = /\b(gmbh|ag|kg|ug|ohg|kgaa|mbh|ltd\.?|inc\.?|corp\.?|llc|s\.?a\.?r?\.?l\.?|b\.?v\.?|n\.?v\.?|plc|s\.?p\.?a\.?|s\.?r\.?l\.?|e\.?\s*k\.?|e\.?\s*v\.?|gbr|partg|holding|immobilien|hausverwaltung|verwaltung|management|solutions|services|service|energie|versorgung|versicherung|kanzlei|bank|sparkasse|werke|wasser|praxis|apotheke|steuerberatung|steuerberater|notar|rechtsanwalt|online|telecom|telekom|digital|media|group|verlag|vertrieb|handel|technik|systems|system|consulting|consult|partner|netz|netze|netzwerk|infrastruktur|dienstleistung|dienstleistungen|bau|baubetrieb|elektro|sanitär|heizung|dach|maler|versand|logistik|transport|spedition|software|hardware|capital|invest|strom|gas|wärme|mobilfunk|internet|kommunikation)\b/i;

    const negativeLineRx = /\b(rechnung|invoice|kundennummer|kunden\-?nr|vertragsnummer|vertrag\s*nr|iban|bic|swift|telefon\s*nr|fax|e-?mail|www\.|ust\-?id|mwst|steuer\s*nr|datum|seite|page|tarif|lieferadresse|rechnungsadresse|leistungsempfänger|kontonummer|konto\s*nr)\b/i;
    const greetingRx    = /^(sehr geehrte|guten tag|hallo|dear|liebe[rs]?|hi\b)\b/i;
    const streetRx      = /\b(postfach|straße|strasse|str\.)\s*\d|\b(weg|allee|platz|gasse|ufer|chaussee|ring|damm|pfad|steig|road|street|avenue|lane|drive|boulevard|court)\b/i;
    const zipCityRx     = /\b\d{4,5}\s+[A-Za-zÄÖÜäöüß]/;
    const sentenceRx    = /\b(wir|sie|bitte|danke|hiermit|prüfung|zahlung|überweisen|kontaktieren|informieren|bitten|teilen|stellen|wurden|haben|sind|werden)\b/i;
    const labelPrefixRx = /^(name|firma|absender|rechnungssteller|vendor|lieferant|auftragnehmer)\s*:\s*/i;

    function push(line, baseScore, source, absIdx, zoneTag) {
      const raw = normalizeWs(line);
            // Harte Ausschlüsse: diese Zeilen dürfen nie Absender-Kandidaten werden
      if (/^(herr|frau|familie)\b/i.test(raw)) return;
      if (/^(an\s+(herrn?|frau|die\s+firma|den))\b/i.test(raw)) return;
      if (/^(empfänger(?:in)?)\b/i.test(raw)) return;
      if (/^(c\/o|z\.?\s*hd\.?)\b/i.test(raw)) return;
      if (/^(ihre fragen|bei fragen|für fragen|kontakt|kundenservice)\b/i.test(raw)) return;
      if (/^(sehr geehrte|guten tag|liebe|hallo)\b/i.test(raw)) return;
      if (!raw || raw.length < 3 || raw.length > 90) return;
      if (raw.split(/\s+/).length > 9) return;
      if (/[!?]/.test(raw)) return;
      if (greetingRx.test(raw)) return;
      if (sentenceRx.test(raw)) return;
      if (zipCityRx.test(raw))  return;
      if (streetRx.test(raw))   return;

        const hasLabel      = labelPrefixRx.test(raw);
      const hasCompany    = companyFormRx.test(raw);
      const hasNegative   = negativeLineRx.test(raw);
      const isInAddrBlock = Number.isInteger(absIdx) && recipientLike.has(absIdx);
      // Inhaltsbasierter Empfänger-Check (zonenunabhängig, kein Index-Problem)
      const isInRecipientContent = recipientContentSet.has(normalizeCompare(raw));
      // Rein zweiteiliger Personenname ohne Firmensignal: "Max Mustermann"
      // Zwei Wörter, beide groß, keine Ziffer, kein companyFormRx-Treffer
        const isPersonNameOnly = !hasCompany && !/\d/.test(raw) &&
        /^[A-ZÄÖÜ][a-zäöüß]{1,25}\s+[A-ZÄÖÜ][a-zäöüß]{2,30}$/.test(raw);
      // Block-basierte Checks: inhaltsbasiert, kein Index-Problem
      const isInBlockRecipient = partyBlocks.recipientLineKeys.has(normalizeCompare(raw));
      const isInBlockContact   = partyBlocks.contactLineKeys.has(normalizeCompare(raw));

      // Zusätzliche harte Negativsignale
      const isContactLine =
        /(service|kundenservice|fragen|kontakt|hotline|support|erreichen|mail|telefon|fax)/i.test(raw);

      const isAddressLikeName =
        !hasCompany &&
        /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{2,}$/.test(raw) &&
        (isInRecipientContent || isInBlockRecipient);

      let score = baseScore;
      if (hasLabel)              score += 8;
      if (hasCompany)            score += 14;
      if (!hasNegative)          score += 2;
      if (!/\d/.test(raw))       score += 1;

      // Härtere Strafen, damit Empfänger/Kontakt wirklich rausfallen
      if (isInAddrBlock)         score -= 40;
      if (isInRecipientContent)  score -= 40;
      if (isInBlockRecipient)    score -= 40;
      if (isInBlockContact)      score -= 25;
      if (isContactLine)         score -= 20;
     if (isPersonNameOnly)      score -= 18;
      if (isAddressLikeName)     score -= 12;

      switch (zoneTag) {
        case "senderZone":
          score += 8;
          if (Number.isInteger(absIdx) && absIdx <= 1) score += 6;
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

      let value = hasLabel ? raw.replace(labelPrefixRx, "").trim() : raw;
      value = stripOcrJunk(value); // OCR-Schmutz am Anfang entfernen
      if (!value || value.length < 3) return;

      candidates.push({
        value,
        score,
        line:  raw,
        index: Number.isInteger(absIdx) ? absIdx : -1,
        source
      });
    }

    // senderZone (absoluter Zeilenindex = localIdx, Zone beginnt bei 0)
    const senderLines = zones.senderZone || zones.headerTop || [];
    senderLines.forEach((line, localIdx) => {
      push(line, localIdx <= 2 ? 16 : 11, "Absenderzone", localIdx, "senderZone");
    });

    // metaZone
    const metaStart = (zones.indices?.metaStart) ?? 8;
    (zones.metaZone || zones.metaBlock || []).forEach((line, localIdx) => {
      push(line, 4, "Metazone", metaStart + localIdx, "metaZone");
    });

    // explizite recipientZone (vom Extraktor)
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

    // Parteienblock: bester Absender-Kandidat aus block-basierter Erkennung.
    // Wird direkt als Kandidat eingefügt – gedeckelt auf Score 36, damit kein
    // schwacher Block über starke Label-Kandidaten hinaus bubbelt.
    if (partyBlocks.bestSenderBlock?.value) {
      const bv    = partyBlocks.bestSenderBlock.value;
      const bsc   = partyBlocks.bestSenderBlock.score;
      if (bv && bv.length >= 3 && bsc >= 8) {
        candidates.push({
          value:  bv,
          score:  Math.min(bsc + 10, 36),
          line:   bv,
          index:  -1,
          source: "Parteienblock"
        });
      }
    }
    if (profile?.name) {
      candidates.push({
        value:  stripOcrJunk(normalizeWs(profile.name)),
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
    // Mandats-/Gläubiger-Referenzen (30+ Zeichen alphanumerisch = kein Rechnungsnr.)
    const creditorRx  = /^[A-Z]{2}\d{2}[A-Z]{3}\d{14,}$/i;

    function isValidToken(token) {
      if (!token || token.length < 3 || token.length > 32) return false;
      if (!/\d/.test(token)) return false;
      if (badPrefixRx.test(token))                               return false;
      if (ibanRx.test(token))                                    return false;
      if (creditorRx.test(token))                                return false;
      if (dateLikeRx.test(token))                                return false;
      if (phoneLikeRx.test(token) && !/[A-Z]/i.test(token))     return false;
      if (rufnummerRx.test(token))                               return false;
      return true;
    }

    const goodCtxRx = /\b(rechnung|invoice|rg-?nr\.?|rechnungs?-?(?:nummer|nr\.?|no\.?)|belegnummer|beleg-?nr\.?|referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?|dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\b/i;
    const badCtxRx  = /\b(kundennummer|kunden-?nr\.?|customer\s*(?:no|number)|iban|bic|swift|vertragskonto|mandatsreferenz|mandats-?ref|rufnummer|telefonnummer|bestellnummer|vertrags-?nr\.?|debitor|kreditinstitut|bankverbindung|kontonummer|konto-?nr\.?|gläubiger-?id)\b/i;

    function push(value, line, baseScore, source, index) {
      const token = cleanToken(value).replace(/\s+/g, "");
      if (!isValidToken(token)) return;

      const lineN = normalizeWs(line);
      let s = baseScore;

      if (goodCtxRx.test(lineN))                                       s += 10;
      if (/\brechnung\s+[A-Z0-9]/i.test(lineN))                        s += 8;
      if (semanticType === "rechnung" || semanticType === "gutschrift")  s += 2;

      // Format-Boni
      if (/^[A-Z]{1,4}[-_\/]\d{4,}$/i.test(token))                     s += 8;  // RE-20240001
      if (/^[A-Z]{1,4}[-_\/]\d{4}[-_\/]\d+$/i.test(token))             s += 8;  // RE-2024-1234
      if (/^\d{2,4}\/\d{3,}$/.test(token))                              s += 6;  // 2024/12345
      if (/^[A-Z]{1,3}\d{6,}$/i.test(token))                            s += 8;  // B898301796
      if (/^\d{6,}$/.test(token))                                        s += 4;  // rein numerisch 6+

      if (badCtxRx.test(lineN) && !goodCtxRx.test(lineN))              s -= 16;

      if (s <= 0) return;
      candidates.push({
        value:  token,
        score:  s,
        line:   lineN,
        index:  Number.isInteger(index) ? index : -1,
        source
      });
    }

    const labelDefs = [
      { rx: /\b(rechnungs?(?:nummer|nr\.?|no\.?|#))\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,           base: 28, src: "Rechnungsnummer-Label" },
      { rx: /\b(rechnung)\s+([A-Z0-9][A-Z0-9.\-\/_]{2,})/gi,                                                base: 26, src: "Rechnung-Heading" },
      { rx: /\b(invoice\s*(?:no\.?|nr\.?|number|#)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,           base: 28, src: "Invoice-Label" },
      { rx: /\b(belegnummer|beleg-?nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,                      base: 24, src: "Belegnummer" },
      { rx: /\b(rg\.?\s*nr\.?|rn\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,                          base: 24, src: "RG-Nr-Label" },
      { rx: /\b(referenz(?:nummer)?|ref\.?\s*(?:nr\.?|no\.?)?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi, base: 20, src: "Referenz-Label" },
      { rx: /\b(dokumenten?(?:nummer|nr\.?)?|dok\.?\s*nr\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,   base: 20, src: "Dokument-Nr-Label" },
      { rx: /\b(r-?nr\.?|doc\.?\s*(?:no|nr)\.?)\s*[:#\s\-]*([A-Z0-9][A-Z0-9.\-\/_]{1,})/gi,               base: 18, src: "Sonstige-Nr-Label" }
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

    // Zonen-Scan
    scanZone(zones.metaZone || zones.metaBlock || [],                  6);
    scanZone((zones.senderZone || zones.headerTop || []).slice(0, 10), 4);
    scanZone((zones.bodyZone  || zones.body      || []).slice(0, 80),  0);

    // Volltext-Scan (fängt Zeilenumbruch-Formate)
    for (const def of labelDefs) {
      const rx = new RegExp(def.rx.source, "gi");
      let m;
      while ((m = rx.exec(joined))) {
        if (m[2]) push(m[2], m[0], def.base, def.src + " (Volltext)", -1);
      }
    }

    // Multi-Line: Label-Zeile ohne Wert → nächste Zeile(n)
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

    // Lieferantenprofil
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
     * TOTAL_LABELS: vollständiges Wörterbuch aller Gesamtbetrags-Labels.
     * Bindestriche explizit aufgenommen ("Bruttorechnungs-Betrag").
     * v8: Jahresbetrag, Jahresprämie, Beitrag, Versicherungsbetrag,
     *     Abschlussbetrag, Zahllast, Zahlungsbetrag ergänzt.
     */
    const TOTAL_LABELS = [
      // Stärkste Zahlungs-Signale
      { rx: /\bzu\s+zahlen\b/i,                                         score: 32 },
      { rx: /\bzu\s+überweisen\b/i,                                      score: 32 },
      { rx: /\bzu\s+zahlender\s+betrag\b/i,                              score: 32 },
      { rx: /\bzahlbetrag\b/i,                                           score: 30 },
      { rx: /\bzahlungs-?betrag\b/i,                                     score: 30 },
      { rx: /\brechnungsendbetrag\b/i,                                   score: 32 },
      { rx: /\brechnungsbetrag\b/i,                                      score: 30 },
      { rx: /\bgesamtbetrag\b/i,                                         score: 30 },
      // Jahres-/Versicherungsbeträge
      { rx: /\bjahres-?betrag\b/i,                                       score: 28 },
      { rx: /\bjahres-?pr[äa]mie\b/i,                                   score: 28 },
      { rx: /\bjahresbeitrag\b/i,                                        score: 28 },
      { rx: /\bversicherungs-?betrag\b/i,                                score: 28 },
      { rx: /\bbeitrags-?betrag\b/i,                                     score: 26 },
      { rx: /\babschluss-?betrag\b/i,                                    score: 26 },
      { rx: /\bzahllast\b/i,                                             score: 28 },
      // Endbeträge
      { rx: /\bendbetrag\b/i,                                            score: 28 },
      { rx: /\bbrutto-?rechnungs-?betrag\b/i,                            score: 30 },
      { rx: /\bbrutto-?betrag\b/i,                                       score: 28 },
      { rx: /\bbrutto-?summe\b/i,                                        score: 28 },
      { rx: /\bgesamt-?summe\b/i,                                        score: 28 },
      { rx: /\bgesamt-?preis\b/i,                                        score: 26 },
      { rx: /\brechnungs-?summe\b/i,                                     score: 28 },
      // International
      { rx: /\binvoice\s+total\b/i,                                      score: 30 },
      { rx: /\btotal\s+amount\s+(due|payable)\b/i,                       score: 30 },
      { rx: /\bamount\s+(due|payable)\b/i,                               score: 30 },
      // Offene Forderungen
      { rx: /\boffener?\s+betrag\b/i,                                    score: 28 },
      { rx: /\bnoch\s+offen\b/i,                                         score: 28 },
      { rx: /\boffene\s+forderung\b/i,                                   score: 28 },
      { rx: /\brestbetrag\b/i,                                           score: 26 },
      { rx: /\bgesamt-?forderung\b/i,                                    score: 28 },
      { rx: /\bforderungs-?betrag\b/i,                                   score: 26 },
      // inkl. MwSt.-Varianten
      { rx: /\bbetrag\s+inkl\.?\s*(mwst|ust|mehrwertsteuer)\b/i,         score: 28 },
      { rx: /\binkl\.?\s*(mwst|ust)\s+gesamt\b/i,                       score: 26 },
      { rx: /\binkl\.?\s*(mwst|ust)\b/i,                                score: 18 },
      // Allgemeine Summen-Label (niedrigerer Score)
      { rx: /\bsumme\b/i,                                                score: 16 },
      { rx: /\btotal\b/i,                                                score: 14 },
      { rx: /\bgesamt\b/i,                                               score: 14 },
      // Beitrag allgemein (nur wenn kein stärkerer trifft)
      { rx: /\bbeitrag\b/i,                                              score: 16 }
    ];

    // Score-Schwelle für "klares Total-Label"
    const STRONG_THRESHOLD = 18;

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
      /\bratenzahlung\b/i,
      /\bmonats-?beitrag\b/i,   // Monatsbeitrag ist Einzelrate, nicht Jahresgesamt
      /\bmonatlich\b/i,
      /\bmonats-?pr[äa]mie\b/i, // Monatsprämie = Einzelrate
      /\bkwh-?preis\b/i,        // Energieeinheitspreis
      /\bgrundpreis\b/i,        // Grundgebühr, nicht Gesamtbetrag
      /\barbeitspreis\b/i,
      /\beinheits-?preis\b/i,
      /\bpos(?:ition)?\b/i      // Tabellenpositionswert
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
      // Starkes Total-Label hebt Ausschluss auf
      if (getLabelScore(text) >= STRONG_THRESHOLD) return false;
      return EXCLUDE.some(rx => rx.test(text));
    }

    // Geldbetrags-Regex: exakt 2 Dezimalstellen
    const MONEY_SOURCE = "-?\\d{1,3}(?:[.\\u00A0]\\d{3})*[,]\\d{2}(?!\\d)|-?\\d{1,3}(?:[,]\\d{3})*[.]\\d{2}(?!\\d)|-?\\d+[,]\\d{2}(?!\\d)|-?\\d+[.]\\d{2}(?!\\d)";

    function extractAmounts(text) {
      const seen = new Set();
      const out  = [];
      let m;

      // EUR/€ flankierte Werte (stärkste Evidenz)
      const currRx = /(?:EUR|€)\s*(-?\d[\d.,\u00A0]*\d|\d+[,\.]\d{2})|(-?\d[\d.,\u00A0]*\d|\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
      while ((m = currRx.exec(text))) {
        const raw = (m[1] || m[2]).replace(/[\s\u00A0]/g, "");
        const v   = parseEuro(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (!seen.has(key)) { seen.add(key); out.push({ raw, value: v, hasCurrency: true }); }
      }

      // Geldbeträge ohne Währungszeichen
      const rx2 = new RegExp(MONEY_SOURCE, "g");
      while ((m = rx2.exec(text))) {
        const v = parseEuro(m[0]);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = v.toFixed(2);
        if (!seen.has(key)) { seen.add(key); out.push({ raw: m[0], value: v, hasCurrency: false }); }
      }

      return out;
    }

    function computeScore(lsc, excl, taxOnly, hasIban, value, hasCurrency, zoneBonus, lineIdx) {
      let s = 2 + zoneBonus;
      if (!excl && lsc > 0)  s += lsc;
      if (excl)              s -= 14;
      if (taxOnly)           s -= 16;
      if (hasIban)           s -= 22;
      if (hasCurrency)       s += 3;
      if (value < 1)         s -= 12;
      if (value < 0.5)       s -= 8;

      // Positions-Bonus: Totalbeträge stehen oft am Dokumentende / auf letzter Seite
      const n = allLines.length;
      if (lineIdx >= n - 50) s += 2;
      if (lineIdx >= n - 25) s += 4;
      if (lineIdx >= n - 12) s += 6;

      if (semanticType === "rechnung" || semanticType === "gutschrift" || semanticType === "mahnung") s += 2;

      return s;
    }

    /*
     * labelValueScan (v8-Fix):
     * Nachbar-Lookup erfolgt immer über GLOBALE allLines (nicht Zone-Array).
     * Dadurch werden Split-Line-Totals auch erkannt, wenn Label und Wert
     * an Zonengrenzen liegen (z. B. letzte Zeile totalsZone / erste Zeile footer).
     *
     * Parameter:
     *   zoneLines   – Array der Zone-Zeilen (oder allLines)
     *   zoneBonus   – zusätzlicher Score-Bonus für diese Zone
     *   lineOffset  – absoluter Index der ersten Zone-Zeile in allLines
     */
    function labelValueScan(zoneLines, zoneBonus, lineOffset) {
      zoneLines.forEach((rawLine, localIdx) => {
        const text = normalizeWs(rawLine);
        const lsc  = getLabelScore(text);
        if (lsc < STRONG_THRESHOLD) return;

        const absIdx = lineOffset + localIdx;
        const amounts = extractAmounts(text);

        if (amounts.length) {
          amounts.forEach(amt => {
            const excl    = isExcluded(text);
            const taxOnly = TAX_PERCENT_RX.test(text) && lsc < STRONG_THRESHOLD;
            const hasIban = /\bDE\d{2}\b/i.test(text);
            const s = computeScore(lsc, excl, taxOnly, hasIban, amt.value, amt.hasCurrency, zoneBonus, absIdx);
            candidates.push({ value: amt.value, raw: amt.raw, score: s, line: text, index: absIdx, source: "Label-Direktscan" });
          });
          return;
        }

        // Kein Wert in derselben Zeile → globale Nachbarzeilen prüfen
        for (const offset of [1, -1, 2, -2]) {
          const nbIdx  = absIdx + offset;
          if (nbIdx < 0 || nbIdx >= allLines.length) continue;
          const nbLine = normalizeWs(allLines[nbIdx] || "");
          if (!nbLine) continue;
          const nbAmts = extractAmounts(nbLine);
          if (!nbAmts.length) continue;

          nbAmts.forEach(amt => {
            const excl    = isExcluded(nbLine);
            const taxOnly = TAX_PERCENT_RX.test(nbLine) && lsc < STRONG_THRESHOLD;
            const hasIban = /\bDE\d{2}\b/i.test(nbLine);
            const s = computeScore(lsc, excl, taxOnly, hasIban, amt.value, amt.hasCurrency, zoneBonus + 6, nbIdx) + 4;
            candidates.push({ value: amt.value, raw: amt.raw, score: s, line: text + " | " + nbLine, index: absIdx, source: "Multi-Line-Total" });
          });
          break;
        }
      });
    }

    // Zonen-Offsets berechnen
    const totLen    = zones.totalsZone?.length || 0;
    const fotLen    = zones.footerZone?.length || 0;
    const tableLen  = zones.tableZone?.length  || 0;

    labelValueScan(zones.totalsZone || [], 14, Math.max(0, allLines.length - totLen));
    labelValueScan(zones.footerZone || [], 10, Math.max(0, allLines.length - fotLen));
    labelValueScan(zones.tableZone  || [],  4, 0);
    labelValueScan(allLines,               0, 0);

    // Generischer Zeilen-Scan (fängt alle Beträge ohne starke Labels mit)
    allLines.forEach((rawLine, idx) => {
      const text    = normalizeWs(rawLine);
      if (!text) return;
      const lsc     = getLabelScore(text);
      const excl    = isExcluded(text);
      const taxOnly = TAX_PERCENT_RX.test(text) && lsc < STRONG_THRESHOLD;
      const hasIban = /\bDE\d{2}\b/i.test(text);

      extractAmounts(text).forEach((amt, pos) => {
        const s = computeScore(lsc, excl, taxOnly, hasIban, amt.value, amt.hasCurrency, 0, idx)
          + (pos === 0 && lsc >= STRONG_THRESHOLD ? 2 : 0); // Erster Wert auf Label-Zeile leicht bevorzugen
        candidates.push({
          value:  amt.value,
          raw:    amt.raw,
          score:  s,
          line:   text,
          index:  idx,
          source: lsc >= STRONG_THRESHOLD ? "Totalzeile" : "Betrag aus Dokument"
        });
      });
    });

    // Zahlungssatz-Pattern: "... in Höhe von X,XX EUR" / "buchen ... X,XX EUR"
    const payRx = /(?:rechnungsbetrag|gesamtbetrag|jahresbetrag|jahresprämie|beitrag|betrag|zahlung|zahlungsbetrag|zahlen\s+sie)\s+(?:in\s+h[öo]he\s+von\s+|von\s+|[üu]ber\s+|i\.?h\.?v\.?\s*)?(-?\d[\d.,]*\d|\d+[,\.]\d{2})\s*(?:EUR|€)/gi;
    let pm;
    while ((pm = payRx.exec(joined))) {
      const v = parseEuro(pm[1]);
      if (Number.isFinite(v) && v > 0) {
        candidates.push({ value: v, raw: pm[1], score: 34, line: normalizeWs(pm[0]), index: -1, source: "Zahlungssatz" });
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
      { rx: /\b(rechnungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,          score: 30, src: "Rechnungsdatum" },
      { rx: /\b(ausstellungsdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,        score: 28, src: "Ausstellungsdatum" },
      { rx: /\b(invoice\s*date)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,           score: 28, src: "Invoice-Date" },
      { rx: /\b(belegdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,               score: 26, src: "Belegdatum" },
      { rx: /\b(datum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i,                    score: 20, src: "Datum-Label" },
      { rx: /\b(leistungsdatum|lieferdatum)\s*[:#\s\-]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i, score: 16, src: "Leistungsdatum" }
    ];

    // Fälligkeitsdatum und sonstige Nicht-Rechnungsdaten aktiv bestrafen
    const dueDateRx = /\b(fälligkeits?datum|fällig\s+(?:am|bis|zum)|zahlungsziel|zahlungsfrist|due\s+date|pay\s+by|payment\s+due|fällig\s+bei|zahlbar\s+bis|druckdatum|erstellt\s+am|erstellungsdatum|printed\s+on|created\s+on|drucktag|abrechnungszeitraum|leistungszeitraum|lieferzeitraum|buchungsdatum|valuta)\b/i;
    const todayIso  = new Date().toISOString().slice(0, 10);

    function pushDate(iso, line, score, source, index) {
      if (!iso || iso > todayIso) return;
      candidates.push({
        value:  formatDisplayDate(iso),
        iso,
        score,
        line:   normalizeWs(line),
        index:  Number.isInteger(index) ? index : -1,
        source
      });
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
        if (isDue) s -= 18;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src + (zoneBonus > 0 ? " (Zone)" : ""), idx);
      }

      // Lose Datumserkennung nur in Zonen (nicht global)
      if (zoneBonus > 0) {
        [...line.matchAll(/\b(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\b/g)].forEach(m => {
          const iso = toIsoDate(m[1]);
          if (!iso) return;
          let s = 6;
          if (/\b(rechnungsdatum|invoice\s*date|belegdatum|ausstellungsdatum)\b/i.test(line)) s = 22;
          else if (/\bdatum\b/i.test(line)) s = 14;
          if (isDue) s -= 12;
          pushDate(iso, line, s + zoneBonus, "Datum in Zone", idx);
        });
      }
    }

    // Zonen-Scan
    (zones.metaZone || zones.metaBlock || []).forEach((l, i)   => scanLine(normalizeWs(l), i, 6));
    (zones.senderZone || zones.headerTop || []).forEach((l, i) => scanLine(normalizeWs(l), i, 4));

    // Volltext-Scan für alle Label-Muster
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
        if (isDue) s -= 18;
        if (semanticType === "rechnung" || semanticType === "gutschrift") s += 2;
        pushDate(iso, line, s, def.src, idx);
      }
    });

    // Multi-Line-Datum: "Rechnungsdatum:" auf Zeile N, Datum auf N+1
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
        let s = 28;
        if (isDue) s -= 18;
        pushDate(iso, line + " " + next, s, "Multi-Line-Datum", idx);
        break;
      }
    });

    // Lieferantenprofil
    const supplierApi = window.FideliorSupplierProfiles || null;
    if (supplierApi?.detectDateByProfile) {
      try {
        const pd = supplierApi.detectDateByProfile(payload, profile);
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
     * Betrag: minAbsoluteScore = 24
     * Ein klarer Total-Label-Treffer (z. B. "Rechnungsbetrag 39,00 €" Score ~36)
     * gewinnt ohne Margin-Prüfung.
     * minScore = 14 (statt 16) für robustere Erkennung bei schwachen Labels.
     */
    const amountField = finalizeField(amountCandidates, {
      minScore:         14,
      minMargin:        4,
      minAbsoluteScore: 24,
      emptyValue:       NaN
    });

    const dateField = finalizeField(dateCandidates, {
      minScore:         14,
      minMargin:        3,
      minAbsoluteScore: 28,
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

  console.info("[FideliorAI] zentrale Analyse-Engine v8 aktiv");
})();
