import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "email" });

const { host, port, user, pass, fromName } = config.smtp;
const FROM_ADDR = config.smtp.fromAddr || `${fromName} <${user}>`;

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

export function buildBookingConfirmedEmail({ to, ownerName, petName, doctorName, date, time, phone, clinicName }) {
  const subject = `Appointment Confirmed — ${clinicName}`;
  const body = `
Dear ${escapeHtml(ownerName)},

Your appointment has been confirmed! Here are the details:

  Pet Name   : ${escapeHtml(petName)}
  Doctor     : ${escapeHtml(doctorName)}
  Date       : ${escapeHtml(date)}
  Time       : ${escapeHtml(time)}
  Contact    : ${escapeHtml(phone)}

If you need to cancel or reschedule, please contact us at least 24 hours in advance.

Thank you for choosing ${clinicName}!

Best regards,
${clinicName} Team
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
}

export function buildBookingCancelledEmail({ to, ownerName, petName, doctorName, date, time, clinicName }) {
  const subject = `Appointment Cancelled — ${clinicName}`;
  const body = `
Dear ${escapeHtml(ownerName)},

Your appointment has been cancelled. Here are the details of the cancelled booking:

  Pet Name   : ${escapeHtml(petName)}
  Doctor     : ${escapeHtml(doctorName)}
  Date       : ${escapeHtml(date)}
  Time       : ${escapeHtml(time)}

If this was a mistake or you'd like to rebook, please contact us.

Best regards,
${clinicName} Team
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
}

export function buildOrderStatusEmail({ to, customerName, orderId, status, clinicName, total, items }) {
  const subject = `Order ${escapeHtml(orderId)} — Status Updated — ${clinicName}`;
  let statusLine = "";
  switch (status) {
    case "confirmed":
      statusLine = "Your order has been confirmed and is being prepared.";
      break;
    case "completed":
      statusLine = "Your order has been completed and is ready for pickup/delivery.";
      break;
    case "cancelled":
      statusLine = "Your order has been cancelled. If payment was made, a refund will be processed.";
      break;
    case "pending":
      statusLine = "Your order is pending.";
      break;
    default:
      statusLine = `Your order status is now: ${status}.`;
  }
  const itemLines = items
    ? items.map((it) => `  - ${escapeHtml(it.name)} x${it.qty} @ ${it.price}`).join("\n")
    : "";
  const body = `
Dear ${escapeHtml(customerName)},

${statusLine}

Order ID   : ${escapeHtml(orderId)}
${total ? `Total      : ${total}` : ""}
${itemLines ? `\nItems:\n${itemLines}` : ""}

For any questions, reply to this email or call us.

Thank you,
${clinicName} Team
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
}

export function buildPaymentSuccessEmail({ to, customerName, orderId, amount, method, clinicName }) {
  const subject = `Payment Confirmed — Order ${escapeHtml(orderId)} — ${clinicName}`;
  const body = `
Dear ${escapeHtml(customerName)},

We have received your payment for order ${escapeHtml(orderId)}.

  Amount Paid : ${amount}
  Method      : ${escapeHtml(method)}

Your order will now proceed to completion.

Thank you,
${clinicName} Team
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
}

export function buildPaymentFailedEmail({ to, customerName, orderId, method, clinicName, reason = "" }) {
  const subject = `Payment Attention Required — Order ${escapeHtml(orderId)} — ${clinicName}`;
  const body = `
Dear ${escapeHtml(customerName)},

We were unable to process your payment for order ${escapeHtml(orderId)}.

  Method      : ${escapeHtml(method)}
${reason ? `  Reason      : ${escapeHtml(reason)}` : ""}

Please submit a new payment proof or contact us to resolve this.

Best regards,
${clinicName} Team
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
}

export function buildClientVerificationEmail({ to, code, clinicName }) {
  const subject = `Verify your email — ${clinicName}`;
  const body = `
Your ${clinicName} verification code is: ${code}

This code expires in 10 minutes. If you did not request an account, you can ignore this email.
`.trim();
  return { to, from: FROM_ADDR, subject, text: body };
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
