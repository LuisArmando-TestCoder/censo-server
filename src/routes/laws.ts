// ── Reading and voting on the laws ───────────────────────────────────────────
// Reading needs no account. Voting does, and returns 401 so the client can open
// the login view and replay the press.
//
// A law is addressed by its own number throughout, so /api/laws/10964 is both
// the URL a person can read and the key the document is stored under. There is
// no slug to keep in step and no id to look up.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.ts";
import { fail, requireOneOf } from "../lib/validate.ts";
import {
  getLaw,
  lawReactionsForUser,
  listReadyLaws,
  reseedLawReactions,
  searchLaws,
  setLawReaction,
} from "../db/laws.ts";
import { summariseOnDemand, sweepLaws } from "../scrape/lawSweep.ts";
import { listComments, viewComments } from "../db/comments.ts";
import { lawCommentParent, lawDoc } from "../db/paths.ts";
import { recordView } from "../db/views.ts";
import { commentViewer, postComment } from "./commentFlow.ts";

import { config } from "../config.ts";
import { asBackground } from "../lib/budget.ts";
import type { Law, ReactionKind } from "../types.ts";

const laws = new Hono<AppEnv>();

const REACTION_KINDS = ["like", "dislike"] as const;

/**
 * What a reader receives.
 *
 * The crawl bookkeeping (lastError, textCheckedAt) is dropped: it explains our
 * pipeline, not the law, and publishing it would invite readers to interpret an
 * internal retry note as a fact about the legislation.
 */
function publicLaw(law: Law) {
  return {
    number: law.number,
    officialTitle: law.officialTitle,
    headline: law.headline,
    summary: law.summary,
    explanation: law.explanation,
    affects: law.affects ?? [],
    benefits: law.benefits ?? [],
    implications: law.implications ?? [],
    originalMarkdown: law.originalMarkdown,
    sourceUrl: law.sourceUrl,
    documentName: law.documentName,
    inForce: law.inForce,
    publishedAt: law.publishedAt,
    gacetaNumber: law.gacetaNumber,
    alcanceNumber: law.alcanceNumber,
    emittedAt: law.emittedAt,
    sanctionedAt: law.sanctionedAt,
    effectiveAt: law.effectiveAt,
    expedienteNumber: law.expedienteNumber,
    expedienteSubject: law.expedienteSubject,
    procedureType: law.procedureType,
    affectations: law.affectations ?? [],
    flags: law.flags ?? [],
    status: law.status,
    likeCount: Math.max(0, law.likeCount ?? 0),
    dislikeCount: Math.max(0, law.dislikeCount ?? 0),
    commentCount: Math.max(0, law.commentCount ?? 0),
    viewCount: Math.max(0, law.viewCount ?? 0),
  };
}

/**
 * The shorter form used in lists and in the carousel.
 *
 * Flags are reduced to a count and a worst-case severity rather than sent
 * whole. A card only needs to say "there is something here"; the quotes that
 * justify it belong on the page where there is room to read them, and shipping
 * them to the home page would multiply its payload for a badge.
 */
function lawCard(law: Law) {
  const flags = law.flags ?? [];
  const severity = flags.some((f) => f.severity === "high")
    ? "high"
    : flags.some((f) => f.severity === "medium")
    ? "medium"
    : flags.length
    ? "low"
    : null;

  return {
    number: law.number,
    officialTitle: law.officialTitle,
    headline: law.headline,
    summary: law.summary,
    publishedAt: law.publishedAt,
    effectiveAt: law.effectiveAt,
    inForce: law.inForce,
    status: law.status,
    flagCount: flags.length,
    flagSeverity: severity,
    likeCount: Math.max(0, law.likeCount ?? 0),
    dislikeCount: Math.max(0, law.dislikeCount ?? 0),
    commentCount: Math.max(0, law.commentCount ?? 0),
    viewCount: Math.max(0, law.viewCount ?? 0),
  };
}

/** Rejects anything that is not a plain positive law number. */
function readNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(404, "Esa ley no existe.");
  return n;
}

// GET / — the catalogue. Explained laws, newest first, optionally searched.
laws.get("/", optionalAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);
  const query = (c.req.query("q") ?? "").trim();

  const rows = query ? await searchLaws(query, limit) : await listReadyLaws(limit);

  const user = c.get("user");
  const myReactions = user
    ? await lawReactionsForUser(rows.map((l) => String(l.number)), user.id)
    : {};

  return c.json({ laws: rows.map(lawCard), myReactions });
});

/**
 * GET /highlights — what the home page carousel shows.
 *
 * Separate from the list so the carousel can never be handed a law with no
 * headline to display. Kept small: this is the first request the site makes,
 * and it decides how fast the page feels.
 */
laws.get("/highlights", optionalAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 8) || 8, 20);
  const rows = (await listReadyLaws(limit * 2))
    .filter((l) => l.headline && l.summary)
    .slice(0, limit);

  const user = c.get("user");
  const myReactions = user
    ? await lawReactionsForUser(rows.map((l) => String(l.number)), user.id)
    : {};

  return c.json({ laws: rows.map(lawCard), myReactions });
});

/**
 * GET /:number — one law.
 *
 * A law that was catalogued but never explained is explained here, on the first
 * request for it. Only the newest laws are summarised ahead of time, because
 * doing that for all eleven thousand would spend the model's budget on laws
 * nobody has asked to read. This is where the rest earn theirs.
 */
laws.get("/:number", optionalAuth, async (c) => {
  const number = readNumber(c.req.param("number"));
  const numberStr = String(number);
  const user = c.get("user");

  // FIRE ALL QUERIES CONCURRENTLY AT THE VERY TOP
  const lawPromise = getLaw(numberStr);
  const minePromise = user
    ? lawReactionsForUser([numberStr], user.id)
    : Promise.resolve({} as Record<string, any>);
  const threadPromise = listComments(lawCommentParent(numberStr));
  const viewerPromise = commentViewer(user ?? null);

  // Now we await the law
  let law = await lawPromise;
  if (!law) fail(404, "Esa ley no existe.");

  // If we need to summarize, the LLM will block, but at least our DB queries are already done/running
  if (law.status === "catalogued" && config.lawsEnabled) {
    law = (await summariseOnDemand(number)) ?? law;
  }

  // Await the remaining background queries (which are likely already finished by now)
  const mine = await minePromise;
  const thread = await threadPromise;
  const viewer = await viewerPromise;

  return c.json({
    law: publicLaw(law),
    myReaction: mine[numberStr] ?? null,
    comments: viewComments(thread, viewer),
  });
});

/**
 * POST /:number/comments — say something about a law.
 */
laws.post("/:number/comments", requireAuth, async (c) => {
  const number = readNumber(c.req.param("number"));
  if (!(await getLaw(String(number)))) fail(404, "Esa ley no existe.");

  return await postComment(c, lawCommentParent(String(number)));
});

/**
 * POST /:number/view — one person opened this law.
 */
laws.post("/:number/view", async (c) => {
  const number = readNumber(c.req.param("number"));
  await recordView(lawDoc(String(number))).catch(() => {});
  return c.body(null, 204);
});

// POST /:number/reaction — like or dislike. Pressing the same button undoes it.
laws.post("/:number/reaction", requireAuth, async (c) => {
  const user = c.get("user");
  const number = readNumber(c.req.param("number"));

  const law = await getLaw(String(number));
  if (!law) fail(404, "Esa ley no existe.");

  const body = await c.req.json().catch(() => ({}));
  const kind = requireOneOf(body.kind, REACTION_KINDS, "kind") as ReactionKind;

  // setLawReaction persists the user vote AND recounts total votes directly from the reactions collection/table
  const result = await setLawReaction(
    String(number),
    user.id,
    kind
  );

  // Re-fetch the law to get the updated counters since ReactionResult 
  // does not return them.
  const fresh = await getLaw(String(number));

  return c.json({
    myReaction: result.kind,
    likeCount: fresh?.likeCount ?? 0,
    dislikeCount: fresh?.dislikeCount ?? 0,
  });
});

/**
 * POST /reseed — Recalculates and repairs reaction counts directly from individual reaction entries.
 *
 * Can target a single law via `?number=10964` or reseed all laws if omitted.
 * Guarded by LAW_SWEEP_TOKEN.
 */
laws.post("/reseed", async (c) => {
  const token = config.lawSweepToken;
  if (!token) fail(404, "No existe esa ruta.");

  const offered =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.header("x-sweep-token") ??
    "";

  if (!offered || offered !== token) fail(401, "Token inválido.");

  const rawNumber = c.req.query("number");
  const lawNumber = rawNumber ? String(readNumber(rawNumber)) : undefined;

  const reseededCount = await reseedLawReactions(lawNumber);

  return c.json({
    ok: true,
    reseededCount,
  });
});

/**
 * POST /sweep — runs one pass of the crawler on demand.
 */
laws.post("/sweep", async (c) => {
  const token = config.lawSweepToken;
  if (!token) fail(404, "No existe esa ruta.");

  const offered =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.header("x-sweep-token") ??
    "";

  if (!offered || offered !== token) fail(401, "Token inválido.");

  const report = await asBackground(sweepLaws);
  console.log(
    `[laws] sweep on demand: +${report.catalogued} catalogued, ` +
      `${report.summarised} explained, ${report.failed} failed`
  );
  return c.json(report);
});

export default laws;