// ── Request context ──────────────────────────────────────────────────────────
// Typed Hono variables shared by every handler. `session` and `user` are set by
// the auth middleware; `user` is present whenever `session` is.

import type { SessionClaims, User } from "./types.ts";

export interface AppEnv {
  Variables: {
    session: SessionClaims;
    user: User;
  };
}
