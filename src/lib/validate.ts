// ── Input validation ─────────────────────────────────────────────────────────
// Small, dependency-free validators. Every route trusts NOTHING from the client.

import { HTTPException } from "hono/http-exception";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function fail(status: number, message: string): never {
  throw new HTTPException(status as any, { message });
}

/** Random cryptographically-strong numeric OTP (default 6 digits). */
export function generateCode(length = 6): string {
  const max = 10 ** length;
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % max;
  return n.toString().padStart(length, "0");
}

/** Opaque URL-safe id for documents and tokens. */
export function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

export function requireString(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    fail(400, `${field} is required.`);
  }
  const s = (v as string).trim();
  if (s.length > max) fail(400, `${field} is too long (max ${max}).`);
  return s;
}

export function requireEmail(v: unknown, field = "email"): string {
  const s = requireString(v, field);
  if (!isEmail(s)) fail(400, `${field} is not a valid email.`);
  return s.toLowerCase();
}

export function optionalString(v: unknown, max = 5000): string {
  if (v == null) return "";
  if (typeof v !== "string") fail(400, "Expected a string.");
  const s = v.trim();
  if (s.length > max) fail(400, `Value is too long (max ${max}).`);
  return s;
}

export function requireOneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const s = requireString(v, field, 60);
  if (!(allowed as readonly string[]).includes(s)) {
    fail(400, `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return s as T;
}

/**
 * Costa Rican cédula, digits only. This checks SHAPE, not identity: no public
 * padrón API exists, so a passing value proves nothing about who someone is and
 * must never be presented as verified.
 */
export function normalizeCedula(v: unknown): string {
  const s = requireString(v, "cedula", 20).replace(/\D/g, "");
  if (s.length < 9 || s.length > 12) {
    fail(400, "The cédula number should have between 9 and 12 digits.");
  }
  return s;
}

/**
 * Strips every HTML tag and decodes the handful of entities that matter, so a
 * comment can never inject markup. Applied to all user-authored text.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
