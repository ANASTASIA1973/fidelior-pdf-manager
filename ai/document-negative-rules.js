(function () {
  "use strict";

  function isBadReferenceCandidate(candidate, contextText) {
    const val = String(candidate?.value || "");
    const line = String(candidate?.line || "").toLowerCase();
    const text = String(contextText || "").toLowerCase();

    if (!val) return true;
    if (val.length < 5 || val.length > 25) return true;
    if (!/\d/.test(val)) return true;

    if (
      /\b(kundennummer|kunden\-?nr|kundenummer|customer|account)\b/i.test(line) ||
      /\b(vertrag|vertragsnummer|contract)\b/i.test(line) ||
      /\b(vorgang|vorgangsnummer|referenz|ref)\b/i.test(line)
    ) return true;

    if (!/\b(rechnung|invoice)\b/i.test(text)) {
      return true;
    }

    return false;
  }

  function isBadAmountCandidate(candidate) {
    const val = candidate?.value;
    const line = String(candidate?.line || "").toLowerCase();

    if (!Number.isFinite(val)) return true;

    if (val < 5 && !/(gesamt|summe|total|betrag|zu zahlen|rechnungsbetrag|amount due|invoice total)/.test(line)) {
      return true;
    }

    if (/(rabatt|skonto|ersparnis|gutschrift)/.test(line)) {
      return true;
    }

    return false;
  }

  function isDefinitelyNotInvoice(text) {
    const t = String(text || "").toLowerCase();

    if (/\b(vertragsbestätigung|auftragsbestätigung|bestätigung|willkommen)\b/.test(t)) {
      return true;
    }

    if (
      /\b(krankenversicherung|leistung|bezug|abrechnung|jahresbeitrag|beitragszahlung|versicherungsteuer)\b/.test(t) &&
      !/\b(rechnung|invoice)\b/.test(t)
    ) {
      return true;
    }

    return false;
  }

  window.FideliorNegativeRules = {
    isBadReferenceCandidate,
    isBadAmountCandidate,
    isDefinitelyNotInvoice
  };
})();