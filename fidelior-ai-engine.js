/* ============================================================
   Fidelior AI Engine
   Robuste Dokumentanalyse (Nevi-ähnliche Logik)
   ============================================================ */

export function analyzeDocument(text) {

  const lines = (text || "")
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  return {
    sender: detectSender(lines),
    invoiceNumber: detectInvoiceNumber(lines),
    amount: detectAmount(lines),
    documentType: detectDocumentType(lines)
  };
}

/* ============================================================
   Dokumenttyp erkennen
   ============================================================ */

function detectDocumentType(lines){

  const txt = lines.join(" ").toLowerCase();

  if (txt.includes("zahlungserinnerung")) return "reminder";
  if (txt.includes("mahnung")) return "reminder";
  if (txt.includes("erinnerung")) return "reminder";
  if (txt.includes("rechnung")) return "invoice";

  return "unknown";
}

/* ============================================================
   Absender erkennen
   ============================================================ */

function detectSender(lines){

  for (let i=0;i<Math.min(lines.length,15);i++){

    const l = lines[i];

    if (
      /gmbh|ag|kg|mbh|versicher|energie|werke|bank|haus|betrieb/i.test(l) &&
      l.length < 80
    ){
      return clean(l);
    }
  }

  return null;
}

/* ============================================================
   Rechnungsnummer erkennen
   ============================================================ */

function detectInvoiceNumber(lines){

  const blacklist = [
    "seite",
    "telefon",
    "fax",
    "iban",
    "bic",
    "hrb",
    "konto",
    "vertrags",
    "kunden",
    "tarif"
  ];

  const labelRegex =
    /(rechnungs.?nr|rechnungsnummer|invoice.?no)/i;

  for (let line of lines){

    if (!labelRegex.test(line)) continue;

    const parts = line.split(/[:#]/);

    if (parts[1]){

      const val = clean(parts[1]);

      if (
        val.length < 20 &&
        !blacklist.some(b=>val.toLowerCase().includes(b))
      ){
        return val;
      }
    }
  }

  return null;
}

/* ============================================================
   Betrag erkennen
   ============================================================ */

function detectAmount(lines){

  const values = [];

  for (let l of lines){

    const matches = l.match(/\d+[.,]\d{2}\s?€/g);

    if (!matches) continue;

    matches.forEach(v=>{
      const n = parseFloat(
        v.replace("€","").replace(",",".")
      );

      if (n > 0.5 && n < 1000000){
        values.push(n);
      }
    });
  }

  if (!values.length) return null;

  return Math.max(...values).toFixed(2);
}

/* ============================================================
   Helpers
   ============================================================ */

function clean(str){
  return (str || "")
    .replace(/[^\w\s\-\/]/g,"")
    .trim();
}