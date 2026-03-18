(function () {
  "use strict";

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

    if (result?.docType === "rechnung") parts.push("Rechnung");
    else if (result?.docType === "gutschrift") parts.push("Gutschrift");
    else if (result?.docType) parts.push(result.docType);

    if (result?.sender) parts.push(`von ${result.sender}`);
    if (Number.isFinite(result?.amount)) parts.push(`über ${result.amount.toFixed(2).replace(".", ",")} EUR`);
    if (result?.invoiceDate) parts.push(`vom ${result.invoiceDate}`);

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
          sender: { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          invoiceNumber: { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          invoiceDate: { value: "", confidence: "low", source: "Engine nicht verfügbar", score: 0 },
          amount: { value: NaN, confidence: "low", source: "Engine nicht verfügbar", score: 0 }
        },
        warnings: ["Zentrale Analyse-Engine nicht verfügbar"]
      };
    }

    const senderField = engine.fields?.sender || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const refField = engine.fields?.reference || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const dateField = engine.fields?.date || { value: "", confidence: "low", source: "keine sichere Erkennung", score: 0 };
    const amountField = engine.fields?.amount || { value: NaN, confidence: "low", source: "keine sichere Erkennung", score: 0 };

    const normalized = {
      payload: null,
      profile: null,
      docType: engine.semanticType || engine.type || "dokument",
      sender: senderField.value || "",
      invoiceNumber: refField.value || "",
      invoiceDate: dateField.value || "",
      amount: parseUiAmount(amountField.value),
      summary: "",
      confidence: 0,
      fields: {
        sender: senderField,
        invoiceNumber: refField,
        invoiceDate: dateField,
        amount: amountField
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