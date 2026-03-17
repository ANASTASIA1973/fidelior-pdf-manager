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

  function detectZones(lines) {
    const head = Array.isArray(lines) ? lines.slice(0, 30) : [];

    let recipientStart = -1;
    let recipientEnd = -1;

    for (let i = 0; i < head.length - 2; i++) {
      const l1 = normalizeWs(head[i] || "");
      const l2 = normalizeWs(head[i + 1] || "");
      const l3 = normalizeWs(head[i + 2] || "");

      const hasZipCity = /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{2,}/.test(l3);
      const hasStreet = /\b(straße|str\.|weg|allee|platz|ring|gasse|ufer|chaussee|pfad|steig|road|street|avenue|lane|drive)\b/i.test(l2);
      const looksLikeName = /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{2,}$/.test(l1);

      if (hasZipCity && hasStreet && looksLikeName) {
        recipientStart = i;
        recipientEnd = i + 2;
        break;
      }
    }

    const headerTop = head.filter((_, i) => i <= 10 && (recipientStart < 0 || (i < recipientStart || i > recipientEnd)));
    const recipientBlock = recipientStart >= 0 ? head.slice(recipientStart, recipientEnd + 1) : [];
    const body = lines.slice(Math.max(8, recipientEnd + 1));

    return {
      headerTop,
      recipientBlock,
      body,
      indices: {
        recipientStart,
        recipientEnd
      }
    };
  }

  function extractPayload(text, linesInput) {
    const rawText = String(text || "");
    const lines = buildLines(rawText, linesInput);
    const zones = detectZones(lines);
    const profile = window.FideliorSupplierProfiles?.findMatchingProfile?.(rawText) || null;

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