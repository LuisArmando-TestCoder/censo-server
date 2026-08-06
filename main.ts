// ── El Censo API ─────────────────────────────────────────────────────────────
// A civic transparency service for Costa Rica. It reads what the Asamblea
// Legislativa publishes, turns it into plain language, and lets people react to
// it. Reading needs no account; reacting does.
//
// Deno + Hono + Firestore, with no framework magic and no ORM.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { config } from "./src/config.ts";
import type { AppEnv } from "./src/context.ts";

import authRouter from "./src/routes/auth.ts";
import postsRouter from "./src/routes/posts.ts";
import quizRouter from "./src/routes/quiz.ts";
import legalRouter from "./src/routes/legal.ts";
import adminRouter from "./src/routes/admin.ts";

import { seedFields } from "./src/db/fields.ts";
import { seedSources } from "./src/db/sources.ts";
import { seedQuestions } from "./src/db/quiz.ts";
import { seedLegalDocs } from "./src/db/legal.ts";
import { sweepAll } from "./src/scrape/sweep.ts";
import { listPendingRawItems } from "./src/db/rawItems.ts";
import { runPipeline } from "./src/intelligence/pipeline.ts";

const app = new Hono<AppEnv>();

// CORS is fully open because auth is a stateless Bearer token, never a cookie,
// so a hostile origin gains nothing from being allowed to make the request.
// Written by hand rather than with hono/cors so a reverse proxy cannot swallow
// the preflight: OPTIONS gets its own complete response.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  await next();
  for (const [k, v] of Object.entries(CORS_HEADERS)) c.header(k, v);
});

app.get("/", (c) => c.json({ service: "censo-api", ok: true }));

app.route("/api/auth", authRouter);
app.route("/api/posts", postsRouter);
app.route("/api/quiz", quizRouter);
app.route("/api/legal", legalRouter);
app.route("/api/admin", adminRouter);

// One shape for every error, with CORS headers set explicitly so the browser
// can actually read a 401 or a 500 rather than seeing an opaque failure.
app.onError((err, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("[unhandled]", err);
  return c.json({ error: "Something went wrong on our side." }, 500);
});

app.notFound((c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ error: "Not found." }, 404);
});

// ── Startup ──────────────────────────────────────────────────────────────────

/** Writes the default configuration, skipping anything already there. */
async function seed(): Promise<void> {
  try {
    const [fields, sources, questions, docs] = await Promise.all([
      seedFields(),
      seedSources(),
      seedQuestions(),
      seedLegalDocs(),
    ]);
    if (fields || sources || questions || docs) {
      console.log(
        `seeded: ${fields} field(s), ${sources} source(s), ${questions} question(s), ${docs} document(s)`,
      );
    }
  } catch (err) {
    // A seeding failure must not stop the API from serving what already exists.
    console.error("[seed] failed", err);
  }
}

/**
 * Reads the sources, then walks the queue one item at a time.
 *
 * Sequential on purpose: the pipeline drives a single browser session, so
 * parallelism here would fight itself. A failed item is already recorded as
 * failed by the pipeline, so the loop keeps going.
 */
async function pipelineTick(): Promise<void> {
  try {
    const reports = await sweepAll();
    const found = reports.reduce((n, r) => n + r.created + r.changed, 0);
    if (found) console.log(`[sweep] ${found} new or changed item(s)`);

    const pending = await listPendingRawItems(5);
    for (const item of pending) {
      const result = await runPipeline(item);
      console.log(`[pipeline] ${item.id}: ${result.verdict} — ${result.note}`);
    }
  } catch (err) {
    console.error("[pipeline] tick failed", err);
  }
}

await seed();

if (config.pipelineEnabled) {
  const everyMs = config.scrapeIntervalMin * 60 * 1000;
  console.log(`pipeline on, every ${config.scrapeIntervalMin} min`);
  setTimeout(pipelineTick, 10_000); // let the server finish starting first
  setInterval(pipelineTick, everyMs);
} else {
  console.log("pipeline off (PIPELINE_ENABLED is not true). Sweep manually: POST /api/admin/sweep");
}

Deno.serve(
  { port: config.port, onListen: ({ port }) => console.log(`censo-api on :${port}`) },
  app.fetch,
);
