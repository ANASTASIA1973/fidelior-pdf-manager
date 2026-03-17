(function () {
  "use strict";

  const PROFILES = [
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
        /\b([A-Z]\d{8,})\b/
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

  function getAllProfiles() {
    return PROFILES.slice();
  }

  function findMatchingProfile(text) {
    const t = String(text || "").toLowerCase();

    for (const profile of PROFILES) {
      const hitAlias = (profile.aliases || []).some(a => t.includes(String(a).toLowerCase()));
      const hitPattern = (profile.senderPatterns || []).some(rx => rx.test(text || ""));
      if (hitAlias || hitPattern) return profile;
    }

    return null;
  }

  window.FideliorSupplierProfiles = {
    getAllProfiles,
    findMatchingProfile
  };
})();