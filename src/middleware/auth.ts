// ── Auth middleware ──────────────────────────────────────────────────────────
// Bearer-token gates. Roles are cumulative: an admin passes every check, an
// editor passes the editor and voter checks. The role is re-read from the user
// document on every request, so revoking access takes effect immediately rather
// than waiting for a token to expire.

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context.ts";
import { readSession } from "../lib/jwt.ts";
import { getUser } from "../db/users.ts";
import { fail } from "../lib/validate.ts";
import type { Role } from "../types.ts";

const RANK: Record<Role, number> = { voter: 0, editor: 1, admin: 2 };

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/** Any signed-in user. Attaches `session` and the live `user` document. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token) fail(401, "Sign in to continue.");

  const session = await readSession(token!);
  if (!session) fail(401, "Your session expired. Sign in again.");

  const user = await getUser(session.sub);
  if (!user) fail(401, "This account no longer exists.");

  c.set("session", session);
  c.set("user", user);
  await next();
});

/** Requires at least the given role, reading the CURRENT role from the DB. */
export function requireRole(min: Role) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) fail(401, "Sign in to continue.");
    if (RANK[user.role] < RANK[min]) fail(403, "You do not have access to this.");
    await next();
  });
}

export const requireEditor = requireRole("editor");
export const requireAdmin = requireRole("admin");

/**
 * Reads the session when one is present but never rejects. Public endpoints use
 * this to personalize a response (for example, marking which posts the reader
 * already voted on) without locking anyone out.
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (token) {
    const session = await readSession(token);
    if (session) {
      const user = await getUser(session.sub);
      if (user) {
        c.set("session", session);
        c.set("user", user);
      }
    }
  }
  await next();
});
