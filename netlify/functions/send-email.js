// netlify/functions/send-email.js
const nodemailer = require("nodemailer");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const {
      to = [],
      cc = [],
      bcc = [],
      subject = "",
      text = "",
      html = "",
      // attachments: [{ filename, contentBase64, contentType }]
      attachments = []
    } = JSON.parse(event.body || "{}");

    const norm = (v) =>
      Array.isArray(v) ? v.filter(Boolean) : String(v || "").split(",").map(s => s.trim()).filter(Boolean);

    const toList = norm(to);
    if (!toList.length) {
      return { statusCode: 400, body: "Missing recipients" };
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || "465") === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const mail = {
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: toList.join(","),
      cc: norm(cc).join(",") || undefined,
      bcc: norm(bcc).join(",") || undefined,
      subject: subject || "Fidelior DMS",
      text: text || (html ? html.replace(/<[^>]+>/g, " ") : ""),
      html: html || undefined,
      attachments: attachments.map(a => ({
        filename: a.filename || "Anhang",
        content: a.contentBase64 ? Buffer.from(a.contentBase64, "base64") : undefined,
        contentType: a.contentType || undefined
      })).filter(x => x.content)
    };

    const info = await transporter.sendMail(mail);

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
