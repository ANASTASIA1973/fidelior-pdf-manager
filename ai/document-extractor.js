(function () {
  "use strict";

  function normalizeWs(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function buildLines(text, linesInput) {
    if (Array.isArray(linesInput) && linesInput.length) {
      return linesInput
        .map(v => {
          if (typeof v === "string") return normalizeWs(v);
          return normalizeWs(v?.text || "");
        })
        .filter(Boolean);
    }

    return String(text || "")
      .split(/\r?\n+/)
      .map(normalizeWs)
      .filter(Boolean);
  }

  function uniqueIndices(arr) {
    return [...new Set((arr || []).filter(v => Number.isInteger(v) && v >= 0))].sort((a, b) => a - b);
  }

  function sliceByIndices(lines, indices) {
    return uniqueIndices(indices).map(i => normalizeWs(lines[i] || "")).filter(Boolean);
  }

  function detectRecipientRange(head) {
    let start = -1;
    let end = -1;

    const zipCityRx      = /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{2,}/;
    const streetRx       = /\b(straße|str\.|weg|allee|platz|ring|gasse|ufer|chaussee|pfad|steig|road|street|avenue|lane|drive)\b/i;
    const badNameRx      = /\b(rechnung|invoice|kundennummer|vertragsnummer|datum|tarif|seite)\b/i;
    const nameLikeRx     = /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.,\(\)\- ]{1,}$/;
    const recipientPfxRx = /^(Herr|Frau|Familie|Dr\.?|Prof\.?|z\.?\s*Hd\.?|c\/o)\b/i;

    // Schleife beginnt bei i=2: die ersten beiden Zeilen gehören typischerweise
    // zum Absender-Briefkopf und dürfen nicht als Empfängerblock erkannt werden.
    for (let i = 2; i < head.length - 2; i++) {
      const l1 = normalizeWs(head[i]     || "");
      const l2 = normalizeWs(head[i + 1] || "");
      const l3 = normalizeWs(head[i + 2] || "");
      const l4 = normalizeWs(head[i + 3] || "");

      // Expliziter Empfänger-Präfix als starker Anker
      if (recipientPfxRx.test(l1)) {
        start = i;
        if (streetRx.test(l3) && zipCityRx.test(l4)) {
          end = i + 3; // 4-Zeiler: Präfix → Name → Straße → PLZ
        } else if (streetRx.test(l2) && zipCityRx.test(l3)) {
          end = i + 2; // 3-Zeiler: Präfix → Straße → PLZ
        } else {
          end = i + 1;
        }
        break;
      }

      // 3-Zeiler: l1=Name, l2=Straße, l3=PLZ
      if (zipCityRx.test(l3) && streetRx.test(l2) && nameLikeRx.test(l1) && !badNameRx.test(l1)) {
        start = i;
        end   = i + 2;
        break;
      }

      // 4-Zeiler: l1=Name1, l2=Name2, l3=Straße, l4=PLZ
      if (zipCityRx.test(l4) && streetRx.test(l3) &&
          nameLikeRx.test(l1) && !badNameRx.test(l1) &&
          nameLikeRx.test(l2) && !badNameRx.test(l2) &&
          !streetRx.test(l1)) {
        start = i;
        end   = i + 3;
        break;
      }
    }

    return { start, end };
  }
  function detectMetaIndices(head) {
    const out = [];

    for (let i = 0; i < head.length; i++) {
      const s = normalizeWs(head[i] || "");
      if (!s) continue;

      if (/\b(rechnungs?(nummer|nr|no)|invoice\s*(no|number|nr)|kundennummer|kunden\-?nr|vertragsnummer|vertrag|datum|invoice\s*date|auftragsdatum|customer\s*(no|number)|tarif)\b/i.test(s)) {
        out.push(i);
        continue;
      }

      if (
        /\b\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}\b/.test(s) &&
        /\b[A-Z0-9._\/-]{4,}\b/.test(s)
      ) {
        out.push(i);
      }
    }

    return uniqueIndices(out);
  }

  function detectTotalsIndices(lines) {
    const out = [];
    const totalLineRx = /\b(gesamt|summe|total|rechnungsbetrag|endbetrag|zu\s+zahlen|zahlbetrag|amount\s+due|invoice\s+total)\b/i;
    const moneyRx = /(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+\.\d{2})/;

    for (let i = 0; i < lines.length; i++) {
      const s = normalizeWs(lines[i] || "");
      if (!s) continue;

      if (totalLineRx.test(s) && moneyRx.test(s)) {
        out.push(i - 1, i, i + 1);
      }
    }

    return uniqueIndices(out.filter(i => i >= 0 && i < lines.length));
  }

  function detectFooterStart(lines) {
    for (let i = Math.max(0, lines.length - 20); i < lines.length; i++) {
      const s = normalizeWs(lines[i] || "");
      if (!s) continue;

      if (
        /\b(iban|bic|swift|ust-?id|umsatzsteuer|steuernummer|www\.|http|e-?mail|email|telefon|fax|geschäftsführer|bankverbindung)\b/i.test(s)
      ) {
        return i;
      }
    }
    return -1;
  }

  function extractPayload(text, linesInput) {
    const rawText = String(text || "");
    const lines = buildLines(rawText, linesInput);
    const head = lines.slice(0, 32);

    const recipient = detectRecipientRange(head);
    const metaIndices = detectMetaIndices(head);
    const totalsIndices = detectTotalsIndices(lines);
    const footerStart = detectFooterStart(lines);

    const recipientIndices =
      recipient.start >= 0 && recipient.end >= recipient.start
        ? Array.from({ length: recipient.end - recipient.start + 1 }, (_, k) => recipient.start + k)
        : [];

    const metaStart = metaIndices.length ? Math.max(0, metaIndices[0] - 1) : -1;
    const metaEnd = metaIndices.length ? Math.min(head.length - 1, metaIndices[metaIndices.length - 1] + 1) : -1;

    const metaRange =
      metaStart >= 0 && metaEnd >= metaStart
        ? Array.from({ length: metaEnd - metaStart + 1 }, (_, k) => metaStart + k)
        : [];

    const excludedHeader = new Set([...recipientIndices, ...metaRange]);
    const senderHeaderIndices = [];
    for (let i = 0; i < Math.min(10, head.length); i++) {
      if (!excludedHeader.has(i)) senderHeaderIndices.push(i);
    }

    const bodyStart = Math.max(
      8,
      recipient.end >= 0 ? recipient.end + 1 : 0,
      metaEnd >= 0 ? metaEnd + 1 : 0
    );

    const footerIdx = footerStart >= 0 ? footerStart : lines.length;
    const tableEnd = totalsIndices.length ? Math.max(0, totalsIndices[0] - 1) : footerIdx - 1;

    const bodyIndices = [];
    for (let i = bodyStart; i < footerIdx; i++) bodyIndices.push(i);

    const tableIndices = [];
    for (let i = bodyStart; i <= tableEnd && i < footerIdx; i++) tableIndices.push(i);

    const footerIndices = [];
    if (footerStart >= 0) {
      for (let i = footerStart; i < lines.length; i++) footerIndices.push(i);
    }

    const zones = {
      senderZone: sliceByIndices(lines, senderHeaderIndices),
      recipientZone: sliceByIndices(lines, recipientIndices),
      metaZone: sliceByIndices(lines, metaRange),
      bodyZone: sliceByIndices(lines, bodyIndices),
      tableZone: sliceByIndices(lines, tableIndices),
      totalsZone: sliceByIndices(lines, totalsIndices),
      footerZone: sliceByIndices(lines, footerIndices),

      headerTop: sliceByIndices(lines, senderHeaderIndices),
      recipientBlock: sliceByIndices(lines, recipientIndices),
      metaBlock: sliceByIndices(lines, metaRange),
      body: sliceByIndices(lines, bodyIndices),

      indices: {
        recipientStart: recipient.start,
        recipientEnd: recipient.end,
        metaStart,
        metaEnd,
        bodyStart,
        footerStart
      }
    };

    const profile =
      window.FideliorSupplierProfiles?.findMatchingProfile?.(rawText) || null;

    return {
      rawText,
      lines,
      zones,
      profile
    };
  }

  window.FideliorDocumentExtractor = {
    extractPayload
  };
})();