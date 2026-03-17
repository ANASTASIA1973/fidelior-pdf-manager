(function () {
  "use strict";

  function validate(result) {
    const warnings = [];
    let confidence = Number(result?.confidence || 0.7);

    if (!result) {
      return {
        valid: false,
        confidence: 0,
        warnings: ["Keine Analyse vorhanden"],
        result: null
      };
    }

    if (!result.sender) {
      warnings.push("Absender nicht sicher erkannt");
      confidence -= 0.15;
    }

    if (/^(rechnung|gutschrift|mahnung)$/.test(result.docType)) {
      if (!result.invoiceNumber) {
        warnings.push("Rechnungsnummer nicht sicher erkannt");
        confidence -= 0.1;
      }

      if (!result.invoiceDate) {
        warnings.push("Rechnungsdatum nicht sicher erkannt");
        confidence -= 0.1;
      }

      if (!Number.isFinite(result.amount)) {
        warnings.push("Betrag nicht sicher erkannt");
        confidence -= 0.2;
      }
    } else {
      if (Number.isFinite(result.amount)) {
        warnings.push("Nicht-Rechnung mit erkanntem Betrag prüfen");
        confidence -= 0.1;
      }
    }

    confidence = Math.max(0, Math.min(1, confidence));

    return {
      valid: confidence >= 0.4,
      confidence,
      warnings,
      result: {
        ...result,
        confidence
      }
    };
  }

  window.FideliorDocumentValidator = {
    validate
  };
})();