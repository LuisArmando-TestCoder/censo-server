// ── Auth routes ──────────────────────────────────────────────────────────────
// Passwordless email OTP. Ask for a code, read it in your inbox, type it in.
// There is no password to steal and no social login to depend on.

import { Hono } from "hono";
import { config } from "../config.ts";
import type { AppEnv } from "../context.ts";
import {
  fail,
  generateCode,
  normalizeCedula,
  requireEmail,
  requireOneOf,
  requireString,
} from "../lib/validate.ts";
import { sendEmail } from "../lib/email.ts";
import { otpEmail } from "../lib/emailTemplates.ts";
import { issueSession } from "../lib/jwt.ts";
import {
  consumeOtp,
  ensureUser,
  isAdult,
  saveOtp,
  setCitizenKind,
  updateUser,
} from "../db/users.ts";

import { requireAuth } from "../middleware/auth.ts";
import type { CitizenKind } from "../types.ts";

const auth = new Hono<AppEnv>();

const CITIZEN_KINDS = ["votante", "funcionario", "extranjero"] as const;

/** Public shape of a user. Never leaks the cédula back over the wire. */
function publicUser(u: {
  id: string;
  email: string;
  role: string;
  displayName: string;
  citizenKind: CitizenKind | null;
  ideologyScore: number | null;
  ideologyAnswers: number;
  birthYear?: number | null;
}) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    displayName: u.displayName,
    citizenKind: u.citizenKind,
    ideologyScore: u.ideologyScore,
    ideologyAnswers: u.ideologyAnswers,
    birthYear: u.birthYear ?? null,
    // Whether the controversial comments are unlocked. Sent as a plain answer
    // so the client never has to do date arithmetic to decide what to render.
    isAdult: isAdult({ birthYear: u.birthYear ?? null }),
  };
}

// POST /request-code — mail a fresh sign-in code.
//
// The response is the same whether or not the address has an account, so this
// endpoint cannot be used to discover who is registered.
auth.post("/request-code", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = requireEmail(body.email);

  const code = generateCode(6);
  await saveOtp(email, code, config.otpTtlMs);

  const minutes = Math.round(config.otpTtlMs / 60000);
  const { subject, html, text } = otpEmail(code, minutes);
  try {
    await sendEmail({ to: email, subject, html, text });
  } catch (err) {
    console.error("[auth] send failed", err);
    fail(502, "We could not send the code right now. Try again in a moment.");
  }

  return c.json({ ok: true, email, expiresInMinutes: minutes });
});

// POST /verify — trade a valid code for a session token.
auth.post("/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = requireEmail(body.email);
  const code = requireString(body.code, "code", 6);

  const ok = await consumeOtp(email, code);
  if (!ok) fail(401, "That code is wrong or expired. Ask for a new one.");

  const user = await ensureUser(email);
  const token = await issueSession(user.id, user.email, user.role);

  return c.json({
    token,
    user: publicUser(user),
    // The onboarding question is still pending until they answer it.
    needsOnboarding: user.citizenKind === null,
  });
});

// GET /me — who the current token belongs to.
auth.get("/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ user: publicUser(user), needsOnboarding: user.citizenKind === null });
});

// POST /onboarding — the one-question "who are you" step.
//
// A voter or public official may supply a cédula. It is format-checked only:
// there is no public padrón API, so nothing here proves identity and the app
// never presents it as verified.
auth.post("/onboarding", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const kind = requireOneOf(body.citizenKind, CITIZEN_KINDS, "citizenKind");

  let cedula: string | null = null;
  if (kind !== "extranjero" && body.cedula != null && String(body.cedula).trim() !== "") {
    cedula = normalizeCedula(body.cedula);
  }

  await setCitizenKind(user.id, kind, cedula);
  return c.json({ ok: true, citizenKind: kind });
});

// POST /age — declare a birth year, which unlocks the controversial comments.
//
// Asked at the moment someone tries to read one, not during signup. Most people
// never open that part of a thread, and there is no reason to collect a birth
// year from someone who never asks for it.
auth.post("/age", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const year = Number(body.birthYear);
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < thisYear - 120 || year > thisYear) {
    fail(400, "Escriba su año de nacimiento con cuatro dígitos.");
  }

  await updateUser(user.id, { birthYear: year });
  return c.json({ ok: true, birthYear: year, isAdult: isAdult({ birthYear: year }) });
});

// PATCH /me — the only profile field a reader controls.

auth.patch("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const displayName = requireString(body.displayName, "displayName", 60);
  await updateUser(user.id, { displayName });
  return c.json({ ok: true, displayName });
});

export default auth;
