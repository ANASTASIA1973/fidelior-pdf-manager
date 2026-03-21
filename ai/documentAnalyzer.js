(function () {
  "use strict";

  /* =====================================================================
     Fidelior Document Analyzer – Bridge v2
     Normalisiert das Roh-Ergebnis der zentralen Engine (FideliorAI) in
     ein stabiles UI-Modell.

     Änderungen v2:
     - docType: semanticType hat Vorrang vor type – verhindert, dass
       "rechnung" / "gutschrift" im UI als "dokument" erscheint.
     - amount: parseUiAmount sicherer; NaN-Propagation explizit.
     - fields.date: engine gibt "date" zurück, nicht "invoiceDate" →
       Mapping in Normalized-Objekt sauber als "invoiceDate" exponiert.
     - buildSummary: behandelt gutschrift und mahnung separat.
  ===================================================================== */

  function normalizeWs(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function parseUiAmount(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    let x = String(v || "")
      .replace(/[€\u00A0 ]/g, "")
      .replace(/−/g, "-");

    if (x.includes(",") && x.includes(".")) x = x.replace(/\./g, "").replace(",", ".");
    else if (x.includes(",")) x = x.replace(",", ".");

    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }

  function buildSummary(result) {
    const parts = [];

    if (result?.docType === "rechnung")       parts.push("Rechnung");
    else if (result?.docType === "gutschrift") parts.push("Gutschrift");
    else if (result?.docType === "mahnung")    parts.push("Mahnung");
    else if (result?.docType)                 parts.push(result.docType);

    if (result?.sender)                  parts.push("von " + result.sender);
    if (Number.isFinite(result?.amount)) parts.push("über " + result.amount.toFixed(2).replace(".", ",") + " EUR");
    if (result?.invoiceDate)             parts.push("vom " + result.invoiceDate);

    return parts.join(" ");
  }

  function analyze(text, linesInput) {
    const engine = window.FideliorAI?.analyzeDocument?.(text, linesInput);

    if (!engine) {
      return {
        payload: null,
        profile: null,
        docType: "dokument",
        sender: "",
        invoiceNumber: "",
        invoiceDate: "",
        amount: NaN,
        summary: "",
        confidence: 0,
        fields: {
          sender:        { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          invoiceNumber: { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          invoiceDate:   { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          amount:        { value: NaN, confidence: "low", source: "Engine nicht verfügbar", score: 0 }
        },
        warnings: ["Zentrale Analyse-Engine nicht verfügbar"]
      };
    }

    // Engine-Felder abrufen.
    // WICHTIG: engine.fields.date (nicht invoiceDate) ist der korrekte Engine-Schlüssel.
    const senderField  = engine.fields?.sender    || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const refField     = engine.fields?.reference || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const dateField    = engine.fields?.date      || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const amountField  = engine.fields?.amount    || { value: NaN, confidence: "low", source: "keine sichere Erkennung", score: 0 };

    // docType: semanticType hat Vorrang (präziser als type)
    const rawSemantic = normalizeWs(engine.semanticType || engine.type || "").toLowerCase();
    const docType     = rawSemantic || "dokument";

    const normalized = {
      payload: null,
      profile: engine.profile || null,
      docType,
      sender:        senderField.value  || "",
      invoiceNumber: refField.value     || "",
      invoiceDate:   dateField.value    || "",
      amount:        parseUiAmount(amountField.value),
      summary:       "",
      confidence:    0,
      fields: {
        // "sender" und "invoiceNumber" bleiben für Legacy-Kompatibilität
        sender: {
          value:      senderField.value      || "",
          confidence: senderField.confidence || "low",
          source:     senderField.source     || "",
          score:      senderField.score      || 0
        },
        invoiceNumber: {
          value:      refField.value      || "",
          confidence: refField.confidence || "low",
          source:     refField.source     || "",
          score:      refField.score      || 0
        },
        // "invoiceDate" ist der UI-Schlüssel, intern mapped auf engine.fields.date
        invoiceDate: {
          value:      dateField.value      || "",
          confidence: dateField.confidence || "low",
          source:     dateField.source     || "",
          score:      dateField.score      || 0
        },
        amount: {
          value:      parseUiAmount(amountField.value),
          confidence: amountField.confidence || "low",
          source:     amountField.source     || "",
          score:      amountField.score      || 0
        }
      },
      warnings: Array.isArray(engine.warnings) ? engine.warnings.slice() : []
    };

    normalized.summary = buildSummary(normalized);
    return normalized;
  }

  window.FideliorDocAnalyzer = {
    analyze,
    buildSummary
  };
})();
