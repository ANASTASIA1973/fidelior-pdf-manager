(function () {
  "use strict";

  function isBadReferenceCandidate(candidate, contextText) {
    const val = String(candidate?.value || "").trim();
    const line = String(candidate?.line || "").toLowerCase();
    const text = String(contextText || "").toLowerCase();

    if (!val) return true;

    // Länge / Grundform
    if (val.length < 5 || val.length > 25) return true;
    if (!/\d/.test(val)) return true;

    // harte Fake-Werte
    if (/^(kopie|copy|original|erstellt)$/i.test(val)) return true;

    // OCR-Müll / pseudo-token wie "nnasse2"
    if (/^[a-zäöüß]{3,}\d*$/i.test(val) && !/[A-Z]/.test(val)) return true;

    // reine Kleinbuchstaben + Zahl = fast nie Rechnungsnummer
    if (/^[a-zäöüß]+\d+$/i.test(val) && val === val.toLowerCase()) return true;

    // typische Fremdnummern-Kontexte
    if (
      /\b(kundennummer|kunden\-?nr|kundenummer|customer|account)\b/i.test(line) ||
      /\b(vertrag|vertragsnummer|contract|vertragskonto)\b/i.test(line) ||
      /\b(vorgang|vorgangsnummer|referenz|ref)\b/i.test(line) ||
      /\b(versichertennummer|versicherungsnummer|police|policennummer)\b/i.test(line) ||
      /\b(auftragsnummer|bestellnummer|lieferschein)\b/i.test(line)
    ) return true;

    // Rechnungskontext muss im Dokument vorhanden sein
    if (!/\b(rechnung|invoice)\b/i.test(text)) {
      return true;
    }

    return false;
  }

  function isBadAmountCandidate(candidate) {
    const val = candidate?.value;
    const line = String(candidate?.line || "").toLowerCase();

    if (!Number.isFinite(val)) return true;

    // sehr kleine Beträge ohne starken Kontext
    if (val < 5 && !/(gesamt|summe|total|betrag|zu zahlen|rechnungsbetrag|amount due|invoice total)/.test(line)) {
      return true;
    }

    // typische Nebenbeträge
    if (/(rabatt|skonto|ersparnis|gutschrift|bonus|abschlag)/.test(line)) {
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
      /\b(krankenversicherung|leistung|bezug|jahresbeitrag|beitragszahlung|versicherungsteuer)\b/.test(t) &&
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