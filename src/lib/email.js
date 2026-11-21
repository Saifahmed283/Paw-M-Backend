import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "email" });

const { host, port, user, pass, fromName } = config.smtp;
const FROM_ADDR = config.smtp.fromAddr || `${fromName} <${user}>`;

// Brand palette (matches the Paw-M site theme: navy + white + amber).
const C_NAVY = "#0E1B2D";
const C_AMBER = "#E8A020";
const C_AMBER_DARK = "#C87B14";
const C_BRASS = "#E8A020";
const C_BG = "#f6f3ea";
const C_CARD = "#ffffff";
const C_TEXT = "#24303f";
const C_MUTED = "#6b7480";

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }
  return transporter;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Wraps rich content in a responsive, email-client-safe HTML shell with inline
 * styles only. `content` is the already-built inner HTML (details card, button,
 * etc.); `heading`, `message` and `notes` are passed in so the shared shell can
 * stay the single source of layout truth.
 */
function htmlShell({ clinicName, preheader, heading, message, notes = "", button, detailsHtml = "" }) {
  const esc = escapeHtml;
  const details = detailsHtml;
  const headerMark = `
    <tr>
      <td align="center" bgcolor="${C_NAVY}" style="background:${C_NAVY};padding:34px 24px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="font-size:0;">
              <span style="display:inline-block;font-size:30px;line-height:1;">🐾</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:10px;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;letter-spacing:2px;color:#E8A020;">
                PAW-M
              </span>
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:400;letter-spacing:2px;color:#f0f4f7;">&nbsp;VETERINARY CLINIC</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:6px;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;color:#9fb3c2;">
                Veterinary care with love
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;

  const buttonHtml = button
    ? `
    <tr>
      <td align="center" style="padding:8px 40px 0;">
        <a href="${esc(button.url)}"
           style="display:inline-block;background:${C_AMBER};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 34px;border-radius:10px;border:none;">
          ${esc(button.label)}
        </a>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:10px 40px 0;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C_MUTED};">Or copy the link into your browser: ${esc(button.url)}</span>
      </td>
    </tr>
    `
    : "";

  const notesHtml = notes
    ? `
    <tr>
      <td style="padding:20px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${C_MUTED};">
        ${notes}
      </td>
    </tr>
    `
    : "";

  const year = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${esc(clinicName)}</title>
</head>
<body style="margin:0;padding:0;background:${C_BG};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ${esc(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C_BG}" style="background:${C_BG};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;margin:0 auto;background:${C_CARD};border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(14,27,45,0.10);">
          ${headerMark}
          <tr>
            <td style="padding:36px 40px 8px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;line-height:1.25;color:${C_NAVY};">${esc(heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 40px 0;">
              <div style="width:44px;height:3px;background:${C_BRASS};border-radius:2px;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:${C_TEXT};">
              ${message}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C_BG};border-radius:12px;">
                ${details}
              </table>
            </td>
          </tr>
          ${buttonHtml}
          ${notesHtml}
          <tr>
            <td style="height:40px;"></td>
          </tr>
        </table>

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;margin:0 auto;padding:18px 12px 8px;">
          <tr>
            <td align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C_MUTED};line-height:1.7;">
              © ${year} ${esc(clinicName)} · All rights reserved
            </td>
          </tr>
          <tr>
            <td align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C_MUTED};padding-top:2px;">
              This is an automated message. Please do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/** Builds the inner "details" card rows from an array of {label, value}. */
function detailsCard(details, accentColor = C_NAVY) {
  if (!details || details.length === 0) return "";
  const esc = escapeHtml;
  const rows = details
    .map(
      (d) => `
    <tr>
      <td style="padding:12px 20px;width:42%;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${C_MUTED};vertical-align:top;border-bottom:1px solid #e6e2d6;">
        ${esc(d.label)}
      </td>
      <td style="padding:12px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:${esc(accentColor)};vertical-align:top;border-bottom:1px solid #e6e2d6;">
        ${esc(d.value)}
      </td>
    </tr>`,
    )
    .join("");
  return rows;
}

function buildMail({ to, subject, preheader, heading, message, details = [], notes = "", button, clinicName }) {
  const textLines = [
    message.replace(/<[^>]+>/g, ""),
    "",
    ...details.map((d) => `${d.label}: ${d.value}`),
  ];
  if (notes) textLines.push("", notes.replace(/<[^>]+>/g, ""));
  if (button) textLines.push("", button.url);

  const html = htmlShell({
    clinicName,
    preheader,
    heading,
    message,
    notes,
    button,
    detailsHtml: detailsCard(details, details[0]?.accent),
  });

  return {
    to,
    from: FROM_ADDR,
    subject,
    text: textLines.join("\n"),
    html,
  };
}

export function buildBookingConfirmedEmail({ to, ownerName, petName, doctorName, date, time, phone, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Your appointment is confirmed 🎉 — ${clinic}`,
    preheader: `See you soon, ${ownerName}! Your visit with Dr. ${doctorName} is booked.`,
    heading: "Appointment Confirmed",
    message: `Hi <strong>${escapeHtml(ownerName)}</strong>,<br/>Great news — your appointment at <strong>${clinic}</strong> has been confirmed. We can't wait to see you and <strong>${escapeHtml(petName)}</strong>!`,
    details: [
      { label: "Pet Name", value: petName, accent: C_AMBER },
      { label: "Doctor", value: doctorName, accent: C_AMBER },
      { label: "Date", value: date, accent: C_AMBER },
      { label: "Time", value: time, accent: C_AMBER },
      { label: "Contact", value: phone, accent: C_AMBER },
    ],
    notes: "If you need to reschedule or cancel, please let us know at least 24 hours before your appointment so we can make the best use of our time.",
    button: { label: "Book Another Visit", url: `${config.frontendUrl}/book` },
  });
}

export function buildBookingCancelledEmail({ to, ownerName, petName, doctorName, date, time, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Your appointment was cancelled — ${clinic}`,
    preheader: `Hi ${ownerName}, your appointment on ${date} has been cancelled.`,
    heading: "Appointment Cancelled",
    message: `Hi <strong>${escapeHtml(ownerName)}</strong>,<br/>Your appointment at <strong>${clinic}</strong> has been cancelled. Here are the details of the cancelled booking:`,
    details: [
      { label: "Pet Name", value: petName, accent: "#b23b3b" },
      { label: "Doctor", value: doctorName, accent: "#b23b3b" },
      { label: "Date", value: date, accent: "#b23b3b" },
      { label: "Time", value: time, accent: "#b23b3b" },
    ],
    notes: "If this was a mistake or you'd like to rebook, just get in touch — we're happy to help.",
    button: { label: "Book Again", url: `${config.frontendUrl}/book` },
  });
}

export function buildOrderStatusEmail({ to, customerName, orderId, status, clinicName, total, items }) {
  const clinic = escapeHtml(clinicName);
  let heading = "Order Status Updated";
  let statusMessage = `Your order is now: <strong>${escapeHtml(status)}</strong>.`;
  const statusTitle = String(status || "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  switch (status) {
    case "confirmed":
      heading = "Order Confirmed";
      statusMessage = "Your order has been <strong>confirmed</strong> and is being prepared with care.";
      break;
    case "completed":
      heading = "Order Ready 🎉";
      statusMessage = "Your order has been <strong>completed</strong> and is ready for pickup or delivery.";
      break;
    case "cancelled":
      heading = "Order Cancelled";
      statusMessage = "Your order has been <strong>cancelled</strong>. If payment was made, a refund will be processed shortly.";
      break;
    default:
      break;
  }

  const itemLines = items
    ? items.map((it) => ({ label: it.name, value: `x${it.qty} — ${it.price}` }))
    : [];

  return buildMail({
    to,
    clinicName,
    subject: `Order ${escapeHtml(orderId)} — ${statusTitle} — ${clinic}`,
    preheader: `Your order ${orderId} is now ${statusTitle}.`,
    heading,
    message: `Hi <strong>${escapeHtml(customerName)}</strong>,<br/>${statusMessage}`,
    details: [
      { label: "Order ID", value: orderId, accent: C_AMBER },
      ...(total ? [{ label: "Total", value: total, accent: C_AMBER }] : []),
      ...itemLines.map((it) => ({ ...it, accent: C_AMBER })),
    ],
    notes: "For any questions, reply to this email or give us a call — we're here to help.",
    button: { label: "View Your Order", url: `${config.frontendUrl}/account` },
  });
}

export function buildOrderPlacedEmail({ to, customerName, orderId, total, paymentMethod, clinicName }) {
  const clinic = escapeHtml(clinicName);
  const methodLabels = { cash: "Cash", fawry: "Fawry", instapay: "InstaPay" };
  const method = escapeHtml(methodLabels[paymentMethod] || paymentMethod || "Cash");
  const pendingNote = paymentMethod === "cash"
    ? "Payment is pending: please pay in cash when you collect your order."
    : paymentMethod === "instapay"
      ? "Payment is pending verification: complete your InstaPay transfer and submit your transfer details to confirm it."
      : paymentMethod === "fawry"
        ? "Payment is pending verification: pay at any Fawry outlet with your reference, then send the receipt on the tracking page."
        : "Payment is pending verification. No payment has been received yet.";
  return buildMail({
    to,
    clinicName,
    subject: `Order ${escapeHtml(orderId)} received — ${clinic}`,
    preheader: `Thanks ${customerName}! We've received your order ${orderId}.`,
    heading: "Order Received",
    message: `Hi <strong>${escapeHtml(customerName)}</strong>,<br/>Thank you for your order. We've received it and will be in touch about the next steps. Payment is not confirmed yet.`,
    details: [
      { label: "Order ID", value: orderId, accent: C_AMBER },
      { label: "Total", value: total, accent: C_AMBER },
      { label: "Payment Method", value: method, accent: C_AMBER },
    ],
    notes: `${pendingNote} You can check your order status any time on the order tracking page.`,
    button: { label: "Track Your Order", url: `${config.frontendUrl}/store/track` },
  });
}

export function buildPaymentSuccessEmail({ to, customerName, orderId, amount, method, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Payment received — Order ${escapeHtml(orderId)} ✓ — ${clinic}`,
    preheader: `We've received your ${amount} payment for order ${orderId}.`,
    heading: "Payment Confirmed",
    message: `Hi <strong>${escapeHtml(customerName)}</strong>,<br/>Thank you! We've successfully received your payment for order <strong>${escapeHtml(orderId)}</strong>. Your order will now proceed to completion.`,
    details: [
      { label: "Amount Paid", value: amount, accent: C_AMBER },
      { label: "Method", value: method, accent: C_AMBER },
      { label: "Order ID", value: orderId, accent: C_AMBER },
    ],
    notes: "A receipt is also available in your account. Thank you for choosing us!",
    button: { label: "Track Your Order", url: `${config.frontendUrl}/account` },
  });
}

export function buildPaymentFailedEmail({ to, customerName, orderId, method, clinicName, reason = "" }) {
  const clinic = escapeHtml(clinicName);
  const reasonRow = reason ? [{ label: "Reason", value: reason, accent: "#b23b3b" }] : [];
  return buildMail({
    to,
    clinicName,
    subject: `Action needed — payment for Order ${escapeHtml(orderId)} — ${clinic}`,
    preheader: `We couldn't process your ${method} payment for order ${orderId}.`,
    heading: "Payment Attention Required",
    message: `Hi <strong>${escapeHtml(customerName)}</strong>,<br/>We were unable to process your payment for order <strong>${escapeHtml(orderId)}</strong>. Please review the details below and try again.`,
    details: [
      { label: "Method", value: method, accent: "#b23b3b" },
      ...reasonRow,
      { label: "Order ID", value: orderId, accent: "#b23b3b" },
    ],
    notes: "No worries — this happens. Please submit a new payment proof or contact us and we'll get it sorted right away.",
    button: { label: "Try Again", url: `${config.frontendUrl}/account` },
  });
}

export function buildClientVerificationEmail({ to, code, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Verify your email — ${clinic}`,
    preheader: `Your ${clinic} verification code is ${code}.`,
    heading: "Verify Your Email",
    message: `Welcome to <strong>${clinic}</strong>! Please use the code below to confirm your email address and finish creating your account.`,
    details: [{ label: "Verification Code", value: code, accent: C_BRASS }],
    notes: "This code expires in <strong>15 minutes</strong>. If you didn't request an account, you can safely ignore this email.",
  });
}

export function buildPasswordResetEmail({ to, code, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Password reset code — ${clinic}`,
    preheader: `Use this one-time code to reset your ${clinic} password.`,
    heading: "Reset Your Password",
    message: `Hi,<br/>You asked to reset your <strong>${clinic}</strong> password. Use the one-time code below to continue.`,
    details: [{ label: "Reset Code", value: code, accent: C_BRASS }],
    notes: "This code expires in <strong>15 minutes</strong>. If you didn't request it, you can ignore this email.",
  });
}

export function buildContactEmail({ to, name, email, phone, subject, message, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `Contact Form: ${escapeHtml(subject)} — ${clinic}`,
    preheader: `New message from ${escapeHtml(name)} (${escapeHtml(email)}).`,
    heading: "New Contact Message",
    message: `You received a new message via the contact form on <strong>${clinic}</strong> website.`,
    details: [
      { label: "Name", value: name, accent: C_AMBER },
      { label: "Email", value: email, accent: C_AMBER },
      { label: "Phone", value: phone || "—", accent: C_AMBER },
      { label: "Subject", value: subject, accent: C_AMBER },
    ],
    notes: `<div style="padding:12px 16px;background:#fff8ec;border-radius:10px;border:1px solid #f0e0b8;white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${C_TEXT};">${escapeHtml(message).replace(/\n/g, "<br/>")}</div>`,
    button: { label: "Reply to ${name}", url: `mailto:${email}` },
  });
}

export function buildClientNotifyEmail({ to, clientName, title, body, clinicName }) {
  const clinic = escapeHtml(clinicName);
  return buildMail({
    to,
    clinicName,
    subject: `${escapeHtml(title)} — ${clinic}`,
    preheader: `${escapeHtml(title)} — a message from ${clinic}.`,
    heading: "A Message From the Clinic",
    message: `Hi <strong>${escapeHtml(clientName)}</strong>,<br/><strong>${escapeHtml(title)}</strong><br/><div style="padding:12px 16px;background:#fff8ec;border-radius:10px;border:1px solid #f0e0b8;">${escapeHtml(body).replace(/\n/g, "<br/>")}</div>`,
    notes: "You can view this message any time in your account. For questions, reply to this email or call the clinic.",
    button: { label: "Open My Account", url: `${config.frontendUrl}/account` },
  });
}

export async function sendMail(mailOptions) {
  if (!pass) {
    log.warn({ subject: mailOptions.subject, to: mailOptions.to }, "SMTP_PASS not set — email not sent");
    return { skipped: true, reason: "SMTP not configured" };
  }
  try {
    const transport = getTransporter();
    const result = await transport.sendMail(mailOptions);
    log.info({ subject: mailOptions.subject, to: mailOptions.to }, "email sent");
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    log.error({ err: err.message }, "failed to send email");
    return { ok: false, error: err.message };
  }
}
