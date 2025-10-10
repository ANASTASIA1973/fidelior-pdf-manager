// CJS-Variante (kompatibel mit Netlify Functions)
const nodemailer = require("nodemailer");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    // --- Eingaben: GET ?to=...&subject=...&text=... ODER POST JSON {to,subject,text}
    let to, subject, text;
    if (event.httpMethod === "GET") {
      const p = new URLSearchParams(event.rawQuery || "");
      to = p.get("to") || "";
      subject = p.get("subject") || "Test: Fidelior DMS";
      text = p.get("text") || "Hallo! SMTP-Test von Netlify/IONOS.";
    } else {
      const body = JSON.parse(event.body || "{}");
      to = (body.to || "").toString();
      subject = body.subject || "Test: Fidelior DMS";
      text = body.text || "Hallo! SMTP-Test von Netlify/IONOS.";
    }

    if (!to) {
      return { statusCode: 400, body: "Missing 'to' recipient" };
    }

    // --- Transporter aus Netlify-Env
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,              // smtp.ionos.de
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || "465") === "465", // 465 = TLS
      auth: {
        user: process.env.SMTP_USER,           // documents@fidelior.de
        pass: process.env.SMTP_PASS
      }
    });

    // --- Versand
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,                                     // mehrere mit Komma möglich
      subject,
      text
    });

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, messageId: info.messageId })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(err) })
    };
  }
};
