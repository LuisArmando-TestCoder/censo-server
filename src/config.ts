// ── Runtime configuration ────────────────────────────────────────────────────
// Reads env once at startup and fails fast if a required secret is missing.
// Auto-loads `.env` from the CWD so the server works whether it's launched with
// `deno task start` (which also passes --env-file) or a bare `deno run -A
// main.ts`. Real environment variables always win (load never overrides them).
import "@std/dotenv/load";

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`FATAL: environment variable ${name} is not set.`);
    Deno.exit(1);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = Deno.env.get(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// The platform's Gmail / Google Workspace sender (App Password auth). Sends
// every OTP login code. Whitespace in the App Password is stripped.
function appEmailFromEnv(): { user: string; pass: string } | null {
  const user = Deno.env.get("APP_GMAIL_USER")?.trim();
  const pass = (Deno.env.get("APP_GMAIL_PASS") ?? "").replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

export const config = {
  jwtSecret: required("JWT_SECRET"),
  port: int("PORT", 8010),
  appBaseUrl: (Deno.env.get("APP_BASE_URL") ?? "http://localhost:3002").replace(/\/$/, ""),
  appName: Deno.env.get("APP_NAME") ?? "El Censo",
  appEmail: appEmailFromEnv(),
  serviceAccountPath: Deno.env.get("SERVICE_ACCOUNT_PATH") || "./service-account.json",
  firestoreDatabase: Deno.env.get("FIRESTORE_DATABASE") || "(default)",
  otpTtlMs: int("OTP_TTL_MINUTES", 10) * 60 * 1000,
  sessionTtlSec: int("SESSION_TTL_DAYS", 7) * 24 * 60 * 60,
  // Seed admin: the first email allowed to grant editor access. Everyone else
  // starts as a plain voter until an admin promotes them.
  seedAdminEmail: (Deno.env.get("SEED_ADMIN_EMAIL") ?? "").trim().toLowerCase(),
  // How often the scraper sweeps the Asamblea sources, in minutes.
  scrapeIntervalMin: int("SCRAPE_INTERVAL_MINUTES", 30),
  // Master switch for the background scrape + agent pipeline.
  pipelineEnabled: (Deno.env.get("PIPELINE_ENABLED") ?? "false") === "true",

  // ── Laws ───────────────────────────────────────────────────────────────────
  // Master switch for the law catalogue, separate from the article pipeline so
  // one can be paused without the other.
  lawsEnabled: (Deno.env.get("LAWS_ENABLED") ?? "false") === "true",
  // How often the law crawler runs, in minutes.
  lawIntervalMin: int("LAW_INTERVAL_MINUTES", 60),
  // Law numbers catalogued per tick during the historical descent. The Asamblea
  // is a public service and this is a courtesy limit as much as a cost one.
  lawSeedBatch: int("LAW_SEED_BATCH", 25),
  // Laws summarised per tick. Far smaller than the seed batch: cataloguing is
  // three cheap requests, whereas summarising drives the model.
  lawSummaryBatch: int("LAW_SUMMARY_BATCH", 3),
  // Below this number a law is catalogued but not summarised up front. It gets
  // its summary the first time somebody actually opens it, which keeps the
  // backlog from spending thousands of model calls on laws nobody reads.
  lawSummaryFloor: int("LAW_SUMMARY_FLOOR", 10466),
  // How far above the known ceiling to keep probing for newly published laws.
  lawCeilingScanLimit: int("LAW_CEILING_SCAN_LIMIT", 25),
  // Pause between requests to the Asamblea, in milliseconds.
  lawRequestDelayMs: int("LAW_REQUEST_DELAY_MS", 750),
  // Shared secret that lets an external scheduler drive the sweep over HTTP,
  // for hosts where an in-process timer will not survive. Blank keeps the
  // endpoint closed.
  lawSweepToken: Deno.env.get("LAW_SWEEP_TOKEN") ?? "",
} as const;
