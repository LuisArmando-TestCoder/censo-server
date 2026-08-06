// ── Users + OTP repository ───────────────────────────────────────────────────
// Email is the identity key; the document id is a derived hash of it. Everyone
// starts as a voter. The seed admin from config is promoted on first login, and
// only an admin can promote anyone else.

import { fsCreate, fsDelete, fsGet, fsQuery, fsSet, fsUpdate } from "./firestore.ts";

import { otpDoc, userDoc } from "./paths.ts";
import { COL } from "./paths.ts";
import { userId } from "../lib/hash.ts";
import { config } from "../config.ts";
import type { CitizenKind, OtpRecord, Role, User } from "../types.ts";

const MAX_OTP_ATTEMPTS = 5;

export async function getUser(id: string): Promise<User | null> {
  return await fsGet<User>(userDoc(id));
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return await getUser(await userId(email));
}

/**
 * Returns the user for this email, creating one on first sight. The seed admin
 * is promoted here so the very first operator can get in without a migration.
 */
export async function ensureUser(email: string): Promise<User> {
  const id = await userId(email);
  const existing = await getUser(id);
  const now = new Date().toISOString();

  if (existing) {
    const promote = config.seedAdminEmail && email === config.seedAdminEmail &&
      existing.role !== "admin";
    await fsUpdate(userDoc(id), {
      lastLoginAt: now,
      ...(promote ? { role: "admin" } : {}),
    });
    return { ...existing, lastLoginAt: now, ...(promote ? { role: "admin" as Role } : {}) };
  }

  const user: User = {
    id,
    email,
    role: config.seedAdminEmail && email === config.seedAdminEmail ? "admin" : "voter",
    displayName: email.split("@")[0],
    citizenKind: null,
    cedula: null,
    ideologyScore: null,
    ideologyAnswers: 0,
    lastQuizPromptAt: null,
    birthYear: null,
    commentStrikes: 0,
    commentBlockedUntil: null,
    createdAt: now,
    lastLoginAt: now,
  };

  await fsCreate(COL.users, id, user as unknown as Record<string, unknown>);
  return user;
}

export async function updateUser(id: string, patch: Partial<User>): Promise<void> {
  await fsUpdate(userDoc(id), patch as Record<string, unknown>);
}

export async function setRole(id: string, role: Role): Promise<void> {
  await fsUpdate(userDoc(id), { role });
}

export async function listByRole(role: Role): Promise<User[]> {
  return await fsQuery<User>(COL.users, {
    where: [{ field: "role", op: "EQUAL", value: role }],
  });
}

/** Onboarding answer: voter, public official, or foreigner. */
export async function setCitizenKind(
  id: string,
  kind: CitizenKind,
  cedula: string | null,
): Promise<void> {
  await fsUpdate(userDoc(id), { citizenKind: kind, cedula });
}

// ── Comment standing ─────────────────────────────────────────────────────────

/** Refusals allowed before commenting pauses, and how long the pause lasts. */
const STRIKE_LIMIT = 3;
const BLOCK_HOURS = 24;
const LEGAL_AGE = 18;

/**
 * Whether this person may see comments marked controversial.
 *
 * The birth year is self-declared and unverifiable, which is the honest
 * position: no free registry exists to check it against. It still does real
 * work. It forces a deliberate claim of adulthood instead of letting the words
 * appear by default, and it records who made that claim.
 */
export function isAdult(user: Pick<User, "birthYear">): boolean {
  if (!user.birthYear) return false;
  return new Date().getUTCFullYear() - user.birthYear >= LEGAL_AGE;
}

export interface CommentStanding {
  allowed: boolean;
  /** When the pause lifts, for the message shown to the writer. */
  until: string | null;
}

/** Whether this person may post right now, expiring a pause that has run out. */
export async function commentStanding(user: User): Promise<CommentStanding> {
  if (!user.commentBlockedUntil) return { allowed: true, until: null };

  if (Date.parse(user.commentBlockedUntil) > Date.now()) {
    return { allowed: false, until: user.commentBlockedUntil };
  }

  // The pause has expired. Clear it and forgive the strikes that caused it, so
  // the next refusal starts a fresh count rather than an instant re-block.
  await fsUpdate(userDoc(user.id), { commentBlockedUntil: null, commentStrikes: 0 });
  return { allowed: true, until: null };
}

/**
 * Records a refused comment. Three of them pause commenting for a day.
 *
 * Returns the pause end when this strike triggered one, so the caller can say
 * so in the same response rather than letting the writer discover it later.
 */
export async function addCommentStrike(user: User): Promise<string | null> {
  const strikes = (user.commentStrikes ?? 0) + 1;

  if (strikes < STRIKE_LIMIT) {
    await fsUpdate(userDoc(user.id), { commentStrikes: strikes });
    return null;
  }

  const until = new Date(Date.now() + BLOCK_HOURS * 60 * 60 * 1000).toISOString();
  await fsUpdate(userDoc(user.id), { commentStrikes: strikes, commentBlockedUntil: until });
  return until;
}

// ── One-time codes ───────────────────────────────────────────────────────────

/** Issuing a new code replaces any previous one, resetting the attempt count. */
export async function saveOtp(email: string, code: string, ttlMs: number): Promise<void> {
  const rec: OtpRecord = { code, expiresAt: Date.now() + ttlMs, attempts: 0 };
  await fsSet(otpDoc(email), rec as unknown as Record<string, unknown>);
}

/**
 * Checks a submitted code and burns it on success. A wrong code costs an
 * attempt; running out of attempts deletes the code, so brute force gets one
 * short window rather than unlimited tries.
 */
export async function consumeOtp(email: string, code: string): Promise<boolean> {
  const rec = await fsGet<OtpRecord>(otpDoc(email));
  if (!rec) return false;

  if (Date.now() > rec.expiresAt) {
    await fsDelete(otpDoc(email));
    return false;
  }

  if (rec.code !== code) {
    const attempts = (rec.attempts ?? 0) + 1;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await fsDelete(otpDoc(email));
    } else {
      await fsUpdate(otpDoc(email), { attempts });
    }
    return false;
  }

  await fsDelete(otpDoc(email));
  return true;
}
