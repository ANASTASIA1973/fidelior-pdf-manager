(function () {
  "use strict";

  function buildUiModel(validated) {
    const result = validated?.result || null;

    if (!result) {
      return {
        fields: {
          sender: "",
          invoiceNumber: "",
          invoiceDate: "",
          amount: ""
        },
        docType: "",
        summary: "",
        warnings: validated?.warnings || []
      };
    }

    const summary = window.FideliorDocAnalyzer?.buildSummary
      ? window.FideliorDocAnalyzer.buildSummary(result)
      : "";

    return {
      fields: {
        sender: result.sender || "",
        invoiceNumber: result.invoiceNumber || "",
        invoiceDate: result.invoiceDate || "",
        amount: Number.isFinite(result.amount)
          ? result.amount.toFixed(2).replace(".", ",")
          : ""
      },
      docType: result.docType || "",
      summary,
      warnings: validated?.warnings || [],
      confidence: validated?.confidence || 0
    };
  }

  window.FideliorDocumentPresenter = {
    buildUiModel
  };
})();