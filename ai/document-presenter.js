(function () {
  "use strict";

  /* =====================================================================
     Fidelior Document Presenter v2

     Änderungen v2:
     - canAutoFill: Absender-Feld auf "semi"-Modus → medium-Confidence
       füllt vor statt leer zu lassen.
     - buildUiModel: liest jetzt auch "invoiceDate" als Field-Schlüssel
       (documentAnalyzer.js v2 benennt das Datumsfeld so).
     - Kompatibilität: fällt auf "date" zurück falls invoiceDate fehlt.
  ===================================================================== */

  function amountToDisplay(v) {
    return Number.isFinite(v) ? v.toFixed(2).replace(".", ",") : "";
  }

  function canAutoFill(field, mode) {
    const level = field?.confidence || "low";

    if (mode === "strict") return level === "high";
    if (mode === "semi")   return level === "high" || level === "medium";
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
          sender:        { confidence: "low", autoFill: false },
          invoiceNumber: { confidence: "low", autoFill: false },
          invoiceDate:   { confidence: "low", autoFill: false },
          amount:        { confidence: "low", autoFill: false }
        },
        docType: "",
        summary: "",
        warnings: validated?.warnings || [],
        confidence: 0
      };
    }

    const senderField        = result.fields?.sender        || {};
    const invoiceNumberField = result.fields?.invoiceNumber || {};
    // Datumsfeld: documentAnalyzer benennt es "invoiceDate", Engine nennt es "date"
    const invoiceDateField   = result.fields?.invoiceDate   || result.fields?.date || {};
    const amountField        = result.fields?.amount        || {};

    return {
      fields: {
        sender:        result.sender        || "",
        invoiceNumber: result.invoiceNumber || "",
        invoiceDate:   result.invoiceDate   || "",
        amount:        amountToDisplay(result.amount)
      },
      fieldMeta: {
        sender: {
          confidence: senderField.confidence || "low",
          source:     senderField.source     || "",
          // v2: "semi" – Absender füllt bei medium-Confidence vor
          autoFill:   canAutoFill(senderField, "semi")
        },
        invoiceNumber: {
          confidence: invoiceNumberField.confidence || "low",
          source:     invoiceNumberField.source     || "",
          // Rechnungsnummer bleibt "strict": lieber leer als falsch
          autoFill:   canAutoFill(invoiceNumberField, "strict")
        },
        invoiceDate: {
          confidence: invoiceDateField.confidence || "low",
          source:     invoiceDateField.source     || "",
          // Datum auf "semi": medium-Confidence ausreichend
          autoFill:   canAutoFill(invoiceDateField, "semi")
        },
        amount: {
          confidence: amountField.confidence || "low",
          source:     amountField.source     || "",
          // Betrag auf "semi": medium-Confidence ausreichend
          autoFill:   canAutoFill(amountField, "semi")
        }
      },
      docType:    result.docType    || "",
      summary:    result.summary    || "",
      warnings:   validated?.warnings  || [],
      confidence: validated?.confidence || 0
    };
  }

  window.FideliorDocumentPresenter = {
    buildUiModel
  };
})();
