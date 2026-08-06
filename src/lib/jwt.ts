// ── Session tokens ───────────────────────────────────────────────────────────
// Stateless JWT sessions signed with the server secret. Reuses Hono's crypto so
// there is no extra dependency. The short expiry is deliberate: a lapsed session
// is what brings a reader back through the login screen, which is where the
// ideological quiz gets its chance to ask one question.

import { sign, verify } from "hono/jwt";
import { config } from "../config.ts";
import type { Role, SessionClaims } from "../types.ts";

export async function issueSession(id: string, email: string, role: Role): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSec;
  return await sign({ sub: id, email, role, exp }, config.jwtSecret, "HS256");
}

export async function readSession(token: string): Promise<SessionClaims | null> {
  try {
    const payload = await verify(token, config.jwtSecret, "HS256");
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}
