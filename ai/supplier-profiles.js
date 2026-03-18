(function () {
  "use strict";

  const STORAGE_KEY = "fdl_learned_supplier_profiles_v1";

  const STATIC_PROFILES = [
    {
      id: "drillisch",
      name: "Drillisch Online GmbH",
      aliases: [
        "drillisch online gmbh",
        "handyvertrag.de",
        "sim.de",
        "winsim",
        "premiumsim",
        "sim24"
      ],
      docTypeHints: ["rechnung"],
      senderPatterns: [
        /drillisch\s+online\s+gmbh/i,
        /handyvertrag\.de/i
      ],
      invoiceNumberPatterns: [
        /\brechnung\s+([A-Z]?\d{6,})\b/i,
        /\b([A-Z]\d{8,})\b/i
      ]
    },
    {
      id: "swb",
      name: "SWB Energie und Wasser",
      aliases: [
        "swb energie und wasser",
        "stadtwerke bonn",
        "swb energie"
      ],
      docTypeHints: ["rechnung", "vertrag", "dokument"],
      senderPatterns: [
        /swb\s+energie\s+und\s+wasser/i,
        /stadtwerke[-\s]bonn/i
      ]
    },
    {
      id: "gothaer",
      name: "GOTHAER Allgemeine Versicherung AG",
      aliases: [
        "gothaer",
        "gothaer allgemeine versicherung ag",
        "barmenia gothaer"
      ],
      docTypeHints: ["versicherung", "vertrag", "dokument"],
      senderPatterns: [
        /gothaer/i,
        /barmenia\s+gothaer/i,
        /allgemeine\s+versicherung\s+ag/i
      ]
    },
    {
      id: "deutsche_post",
      name: "Deutsche Post AG",
      aliases: [
        "deutsche post",
        "deutsche post ag"
      ],
      docTypeHints: ["rechnung"],
      senderPatterns: [
        /deutsche\s+post\s+ag/i
      ]
    },
    {
      id: "steuerberater",
      name: "Steuerberatung",
      aliases: [
        "steuerberatungsgesellschaft",
        "steuerberater"
      ],
      docTypeHints: ["rechnung", "dokument"],
      senderPatterns: [
        /steuerberatungsgesellschaft/i,
        /steuerberater/i
      ]
    }
  ];

  function normalizeWs(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function normalizeCompare(s) {
    return normalizeWs(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s&.\-\/]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function slugify(s) {
    return normalizeCompare(s)
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_äöüß]/gi, "")
      .slice(0, 80);
  }

  function uniq(arr) {
    return [...new Set((arr || []).map(v => normalizeWs(v)).filter(Boolean))];
  }

  function escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function linesFromText(text) {
    return String(text || "")
      .split(/\r?\n+/)
      .map(normalizeWs)
      .filter(Boolean);
  }

  function createLayoutSignature(text) {
    const lines = linesFromText(text)
      .slice(0, 12)
      .map(line => line
        .toLowerCase()
        .replace(/\b\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}\b/g, "{date}")
        .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{8,}\b/gi, "{iban}")
        .replace(/\b\d+[.,]\d{2}\b/g, "{amount}")
        .replace(/\b\d+\b/g, "{n}")
      );

    return lines.join(" | ").slice(0, 500);
  }

  function normalizeAmountString(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    let x = s.replace(/[€\u00A0 ]/g, "").replace(/−/g, "-");
    if (x.includes(",") && x.includes(".")) x = x.replace(/\./g, "").replace(",", ".");
    else if (x.includes(",")) x = x.replace(",", ".");
    const n = Number(x);
    if (!Number.isFinite(n)) return "";
    return n.toFixed(2);
  }

  function loadLearnedProfiles() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveLearnedProfiles(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
    } catch (e) {
      console.warn("[SupplierProfiles] save failed:", e);
    }
  }

  function getAllProfiles() {
    return [...STATIC_PROFILES, ...loadLearnedProfiles()];
  }

  function findBestLearnedProfile(text) {
    const t = String(text || "");
    const tNorm = normalizeCompare(t);
    const signature = createLayoutSignature(t);
    const learned = loadLearnedProfiles();

    let best = null;

    for (const profile of learned) {
      let score = 0;

      const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
      aliases.forEach(a => {
        const key = normalizeCompare(a);
        if (key && tNorm.includes(key)) score += 18;
      });

      const signatures = Array.isArray(profile.signatures) ? profile.signatures : [];
      if (signature && signatures.includes(signature)) score += 26;

      const senderName = normalizeCompare(profile.name);
      if (senderName && tNorm.includes(senderName)) score += 14;

      if (!best || score > best.score) {
        best = { profile, score };
      }
    }

    return best && best.score >= 18 ? best.profile : null;
  }

  function findMatchingProfile(text) {
    const learned = findBestLearnedProfile(text);
    if (learned) return learned;

    const t = String(text || "").toLowerCase();

    for (const profile of STATIC_PROFILES) {
      const hitAlias = (profile.aliases || []).some(a => t.includes(String(a).toLowerCase()));
      const hitPattern = (profile.senderPatterns || []).some(rx => rx.test(text || ""));
      if (hitAlias || hitPattern) return profile;
    }

    return null;
  }

  function extractInvoicePrefix(invoiceNo) {
    const v = normalizeWs(invoiceNo).replace(/\s+/g, "");
    if (!v) return "";
    const m = v.match(/^[A-ZÄÖÜa-zäöüß]{1,8}/);
    return m ? m[0].toUpperCase() : "";
  }

  function extractDateLabel(lines, confirmedDate) {
    const cd = normalizeWs(confirmedDate);
    if (!cd) return "";

    for (const line of lines) {
      if (!line.includes(cd)) continue;
      const label = normalizeWs(
        line
          .replace(cd, "")
          .replace(/[:\-–—]+/g, " ")
          .replace(/\s+/g, " ")
      );

      if (/\b(rechnungsdatum|invoice\s*date|datum|belegdatum|leistungsdatum)\b/i.test(label)) {
        return label.toLowerCase();
      }
    }
    return "";
  }

  function extractAmountLabel(lines, confirmedAmount) {
    const normalized = normalizeAmountString(confirmedAmount);
    if (!normalized) return "";

    const variants = [
      normalized,
      normalized.replace(".", ","),
      Number(normalized).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      Number(normalized).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ];

    for (const line of lines) {
      const l = normalizeWs(line);
      if (!l) continue;

      const hit = variants.some(v => v && l.includes(v));
      if (!hit) continue;

      const label = normalizeWs(
        l
          .replace(/-?\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})/g, " ")
          .replace(/-?\d+\.\d{2}/g, " ")
          .replace(/[€$£]/g, " ")
          .replace(/[:\-–—]+/g, " ")
      ).toLowerCase();

      if (/\b(gesamt|summe|total|rechnungsbetrag|endbetrag|zahlbetrag|zu zahlen|amount due|invoice total)\b/i.test(label)) {
        return label;
      }
    }

    return "";
  }

  function upsertLearnedProfile(profilePatch) {
    const learned = loadLearnedProfiles();
    const id = profilePatch.id;
    const idx = learned.findIndex(p => p && p.id === id);

    if (idx >= 0) {
      const prev = learned[idx] || {};
      learned[idx] = {
        ...prev,
        ...profilePatch,
        aliases: uniq([...(prev.aliases || []), ...(profilePatch.aliases || [])]),
        signatures: uniq([...(prev.signatures || []), ...(profilePatch.signatures || [])]),
        invoicePrefixes: uniq([...(prev.invoicePrefixes || []), ...(profilePatch.invoicePrefixes || [])]),
        invoiceExamples: uniq([...(prev.invoiceExamples || []), ...(profilePatch.invoiceExamples || [])]),
        amountLabels: uniq([...(prev.amountLabels || []), ...(profilePatch.amountLabels || [])]),
        dateLabels: uniq([...(prev.dateLabels || []), ...(profilePatch.dateLabels || [])]),
        docTypeHints: uniq([...(prev.docTypeHints || []), ...(profilePatch.docTypeHints || [])]),
        learned: true,
        updatedAt: new Date().toISOString()
      };
    } else {
      learned.push({
        ...profilePatch,
        aliases: uniq(profilePatch.aliases || []),
        signatures: uniq(profilePatch.signatures || []),
        invoicePrefixes: uniq(profilePatch.invoicePrefixes || []),
        invoiceExamples: uniq(profilePatch.invoiceExamples || []),
        amountLabels: uniq(profilePatch.amountLabels || []),
        dateLabels: uniq(profilePatch.dateLabels || []),
        docTypeHints: uniq(profilePatch.docTypeHints || []),
        learned: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    saveLearnedProfiles(learned);
  }

  function learnFromDocument(input) {
    const text = String(input?.text || "");
    const confirmed = input?.confirmedFields || {};
    const sender = normalizeWs(confirmed.sender);

    if (!text || !sender || sender.length < 3) return null;

    const lines = linesFromText(text);
    const invoiceNo = normalizeWs(confirmed.invoiceNumber).replace(/\s+/g, "");
    const amount = normalizeAmountString(confirmed.amount);
    const invoiceDate = normalizeWs(confirmed.invoiceDate);
    const docType = normalizeWs(confirmed.docType || "dokument").toLowerCase();

    const signature = createLayoutSignature(text);
    const prefix = extractInvoicePrefix(invoiceNo);
    const amountLabel = extractAmountLabel(lines, amount);
    const dateLabel = extractDateLabel(lines, invoiceDate);

    const profile = {
      id: "learned_" + slugify(sender),
      name: sender,
      aliases: [sender],
      signatures: signature ? [signature] : [],
      invoicePrefixes: prefix ? [prefix] : [],
      invoiceExamples: invoiceNo ? [invoiceNo] : [],
      amountLabels: amountLabel ? [amountLabel] : [],
      dateLabels: dateLabel ? [dateLabel] : [],
      docTypeHints: docType ? [docType] : []
    };

    upsertLearnedProfile(profile);
    return profile;
  }

  function boostCandidates(kind, candidates, profile) {
    if (!profile || !Array.isArray(candidates) || !candidates.length) return candidates;

    const aliases = [profile.name, ...(profile.aliases || [])]
      .map(normalizeCompare)
      .filter(Boolean);

    const invoicePrefixes = (profile.invoicePrefixes || []).map(v => String(v || "").toUpperCase()).filter(Boolean);
    const invoiceExamples = (profile.invoiceExamples || []).map(v => normalizeWs(v).replace(/\s+/g, "")).filter(Boolean);
    const amountLabels = (profile.amountLabels || []).map(v => normalizeCompare(v)).filter(Boolean);

    return candidates.map(c => {
      const next = { ...c };
      const valueNorm = normalizeCompare(next.value || "");
      const lineNorm = normalizeCompare(next.line || "");

      if (kind === "sender") {
        if (aliases.some(a => a && valueNorm.includes(a))) {
          next.score += 12;
          next.source = "Lieferantenprofil";
        }
      }

      if (kind === "reference") {
        if (invoiceExamples.some(ex => ex && normalizeWs(next.value).replace(/\s+/g, "") === ex)) {
          next.score += 14;
          next.source = "Gelernte Rechnungsnummer";
        } else if (invoicePrefixes.some(prefix => String(next.value || "").toUpperCase().startsWith(prefix))) {
          next.score += 9;
          next.source = "Gelernter Rechnungspräfix";
        }
      }

      if (kind === "amount") {
        if (amountLabels.some(lbl => lbl && lineNorm.includes(lbl))) {
          next.score += 8;
          next.source = "Gelernte Betragszeile";
        }
      }

      return next;
    }).sort((a, b) => b.score - a.score);
  }

  function detectDateByProfile(payload, profile) {
    if (!profile) return "";

    const labels = (profile.dateLabels || []).map(v => normalizeCompare(v)).filter(Boolean);
    if (!labels.length) return "";

    const zones = payload?.zones || {};
    const lines = [
      ...(zones.metaZone || []),
      ...(zones.senderZone || []),
      ...(zones.bodyZone || []).slice(0, 20)
    ];

    for (const rawLine of lines) {
      const line = normalizeWs(rawLine);
      const lineNorm = normalizeCompare(line);
      if (!lineNorm) continue;

      if (!labels.some(lbl => lineNorm.includes(lbl))) continue;

      const m = line.match(/\b(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\b/);
      if (m && m[1]) return m[1];
    }

    return "";
  }

  window.FideliorSupplierProfiles = {
    getAllProfiles,
    findMatchingProfile,
    learnFromDocument,
    boostCandidates,
    detectDateByProfile
  };
})();