(function () {
  "use strict";

  function amountToDisplay(v) {
    return Number.isFinite(v) ? v.toFixed(2).replace(".", ",") : "";
  }

  function canAutoFill(field, mode) {
    const level = field?.confidence || "low";

    if (mode === "strict") return level === "high";
    if (mode === "semi") return level === "high" || level === "medium";
    return false;
  }

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
        fieldMeta: {
          sender: { confidence: "low", autoFill: false },
          invoiceNumber: { confidence: "low", autoFill: false },
          invoiceDate: { confidence: "low", autoFill: false },
          amount: { confidence: "low", autoFill: false }
        },
        docType: "",
        summary: "",
        warnings: validated?.warnings || [],
        confidence: 0
      };
    }

    const senderField = result.fields?.sender || {};
    const invoiceNumberField = result.fields?.invoiceNumber || {};
    const invoiceDateField = result.fields?.invoiceDate || {};
    const amountField = result.fields?.amount || {};

    return {
      fields: {
        sender: result.sender || "",
        invoiceNumber: result.invoiceNumber || "",
        invoiceDate: result.invoiceDate || "",
        amount: amountToDisplay(result.amount)
      },
      fieldMeta: {
        sender: {
          confidence: senderField.confidence || "low",
          source: senderField.source || "",
          autoFill: canAutoFill(senderField, "strict")
        },
        invoiceNumber: {
          confidence: invoiceNumberField.confidence || "low",
          source: invoiceNumberField.source || "",
          autoFill: canAutoFill(invoiceNumberField, "strict")
        },
        invoiceDate: {
          confidence: invoiceDateField.confidence || "low",
          source: invoiceDateField.source || "",
          autoFill: canAutoFill(invoiceDateField, "semi")
        },
        amount: {
          confidence: amountField.confidence || "low",
          source: amountField.source || "",
          autoFill: canAutoFill(amountField, "strict")
        }
      },
      docType: result.docType || "",
      summary: result.summary || "",
      warnings: validated?.warnings || [],
      confidence: validated?.confidence || 0
    };
  }

  window.FideliorDocumentPresenter = {
    buildUiModel
  };
})();