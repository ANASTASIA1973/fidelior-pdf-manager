(function () {

"use strict";

function pickBestCandidate(candidates) {

  if (!Array.isArray(candidates) || !candidates.length) {
    return { value: "", confidence: "low", score: 0, source: "keine Kandidaten" };
  }

  const sorted = [...candidates].sort((a,b)=>b.score-a.score);

  const best = sorted[0];
  const second = sorted[1];

  if (!best) {
    return { value:"", confidence:"low", score:0, source:"kein Ergebnis" };
  }

  let confidence = "low";

  if (!second) {
    confidence = best.score >= 16 ? "high" : "medium";
  } else {

    const gap = best.score - second.score;

    if (gap >= 8 && best.score >= 16) confidence = "high";
    else if (gap >= 4 && best.score >= 12) confidence = "medium";
    else confidence = "low";
  }

  return {
    value: best.value || "",
    confidence,
    score: best.score || 0,
    source: best.source || ""
  };
}

function boostBySupplierProfile(candidates, profile) {

  if (!profile || !Array.isArray(candidates)) return candidates;

  const boosted = candidates.map(c=>({...c}));

  boosted.forEach(c=>{

    if (profile.name && c.value && c.value.toLowerCase().includes(profile.name.toLowerCase())) {
      c.score += 10;
      c.source = "Lieferantenprofil";
    }

    if (profile.invoicePattern) {

      const rx = new RegExp(profile.invoicePattern,"i");

      if (rx.test(c.value)) {
        c.score += 8;
        c.source = "Pattern Lieferant";
      }
    }

  });

  return boosted;
}

window.FideliorCandidateVoter = {
  pickBestCandidate,
  boostBySupplierProfile
};

})();