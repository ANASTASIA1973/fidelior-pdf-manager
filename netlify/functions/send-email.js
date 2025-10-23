// netlify/functions/send-email.js
const nodemailer = require("nodemailer");

const JSON_HEADERS = { "content-type": "application/json" };
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

exports.handler = async (event) => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...CORS_HEADERS } };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...CORS_HEADERS }, body: "Method Not Allowed" };
  }

  try {
    // ---------- Body lesen ----------
    const {
      to = [],
      cc = [],
      bcc = [],
      subject = "",
      text = "",
      html = "",
      replyTo = "", // << NEU
      // attachments: [{ filename, contentBase64, contentType }]
      attachments = [],
      from: fromOverride, // optional – wird i. d. R. nicht genutzt
    } = JSON.parse(event.body || "{}");

    // ---------- Hilfen ----------
    const norm = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
      return String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const toList = norm(to);
    const ccList = norm(cc);
    const bccList = norm(bcc);

    if (!toList.length) {
      return {
        statusCode: 400,
        headers: { ...JSON_HEADERS, ...CORS_HEADERS },
        body: JSON.stringify({ ok: false, error: "Missing recipients" }),
      };
    }

    // ---------- Transporter ----------
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, // z.B. smtp.ionos.de
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || "465") === "465", // 465 = TLS
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // ---------- Mail zusammenstellen ----------
    const mail = {
      from: fromOverride || process.env.MAIL_FROM || process.env.SMTP_USER,
      to: toList.join(","),
      cc: ccList.length ? ccList.join(",") : undefined,
      bcc: bccList.length ? bccList.join(",") : undefined,
      subject: subject || "Fidelior DMS",
      text: (text && String(text)) || (html ? String(html).replace(/<[^>]+>/g, " ") : " "),
      html: html || undefined,
      replyTo: replyTo || undefined, // << NEU
      attachments: (attachments || [])
        .map((a) => ({
          filename: a?.filename || "Anhang.pdf",
          content: a?.contentBase64 ? Buffer.from(a.contentBase64, "base64") : undefined,
          contentType: a?.contentType || undefined,
        }))
        .filter((x) => x.content),
    };

    // ---------- Versand ----------
    const info = await transporter.sendMail(mail);

    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS, ...CORS_HEADERS },
      body: JSON.stringify({
        ok: true,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        envelope: info.envelope,
      }),
    };
  } catch (err) {
    console.error("[send-email] error:", err);
    return {
      statusCode: 500,
      headers: { ...JSON_HEADERS, ...CORS_HEADERS },
      body: JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }),
    };
  }
};
