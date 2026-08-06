// ── Email transport ──────────────────────────────────────────────────────────
// One sender for the whole platform: the Gmail/Workspace account in config.
// Transporters are cached by sender so we don't open a new SMTP connection on
// every login code.

import nodemailer from "nodemailer";
import { config } from "../config.ts";

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  /**
   * Plain-text alternative. ALWAYS pass this: without it nodemailer emits an
   * HTML-only message, which spam filters treat much more harshly. Providing
   * text produces a standard multipart/alternative.
   */
  text: string;
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  response: string;
  messageId: string;
}

const transporters = new Map<string, ReturnType<typeof nodemailer.createTransport>>();

/**
 * Gmail displays App Passwords as four space-separated groups, but the secret
 * is the 16 characters with no spaces. Strip whitespace at the single point
 * where it reaches SMTP so every caller is safe.
 */
const normalizePass = (pass: string) => pass.replace(/\s+/g, "");

function transporterFor(user: string, rawPass: string) {
  const pass = normalizePass(rawPass);
  const key = `${user}:${pass}`;
  let t = transporters.get(key);
  if (!t) {
    t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    transporters.set(key, t);
  }
  return t;
}

/** Opens an SMTP connection to confirm the configured credentials work. */
export async function verifySender(): Promise<boolean> {
  if (!config.appEmail) return false;
  try {
    await transporterFor(config.appEmail.user, config.appEmail.pass).verify();
    return true;
  } catch {
    return false;
  }
}

export async function sendEmail({ to, subject, html, text }: SendArgs): Promise<SendResult> {
  if (!config.appEmail) {
    throw new Error("No email sender configured. Set APP_GMAIL_USER and APP_GMAIL_PASS.");
  }
  const { user, pass } = config.appEmail;
  const info = await transporterFor(user, pass).sendMail({
    from: `"${config.appName}" <${user}>`,
    replyTo: user,
    to,
    subject,
    html,
    text,
  });
  return info as unknown as SendResult;
}
