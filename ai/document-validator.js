(function () {
  "use strict";

  function confidenceToScore(level) {
    if (level === "high") return 1;
    if (level === "medium") return 0.65;
    return 0.2;
  }

  function validate(result) {
    if (!result) {
      return {
        valid: false,
        confidence: 0,
        warnings: ["Keine Analyse vorhanden"],
        result: null
      };
    }

    const warnings = [];
    const fields = result.fields || {};

    const senderScore = confidenceToScore(fields.sender?.confidence);
    const numberScore = confidenceToScore(fields.invoiceNumber?.confidence);
    const dateScore = confidenceToScore(fields.invoiceDate?.confidence);
    const amountScore = confidenceToScore(fields.amount?.confidence);

    if (!fields.sender?.value) warnings.push("Absender nicht sicher erkannt");
    if (/^(rechnung|gutschrift|mahnung)$/.test(result.docType)) {
      if (!fields.invoiceNumber?.value) warnings.push("Rechnungsnummer nicht sicher erkannt");
      if (!fields.invoiceDate?.value) warnings.push("Rechnungsdatum nicht sicher erkannt");
      if (!Number.isFinite(result.amount)) warnings.push("Betrag nicht sicher erkannt");
    }

    const weighted =
      senderScore * 0.30 +
      numberScore * 0.20 +
      dateScore * 0.20 +
      amountScore * 0.30;

    const confidence = Math.max(0, Math.min(1, weighted));

    return {
      valid: confidence >= 0.45,
      confidence,
      warnings,
      result: {
        ...result,
        confidence,
        warnings
      }
    };
  }

  window.FideliorDocumentValidator = {
    validate
  };
})();