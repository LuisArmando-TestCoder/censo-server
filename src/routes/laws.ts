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
    likeCount: law.likeCount,
    dislikeCount: law.dislikeCount,
    commentCount: law.commentCount ?? 0,
    viewCount: law.viewCount ?? 0,
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
    likeCount: law.likeCount,
    dislikeCount: law.dislikeCount,
    commentCount: law.commentCount ?? 0,
    viewCount: law.viewCount ?? 0,
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

  let law = await getLaw(String(number));
  if (!law) fail(404, "Esa ley no existe.");

  if (law!.status === "catalogued" && config.lawsEnabled) {
    law = (await summariseOnDemand(number)) ?? law;
  }

  const user = c.get("user");
  const mine = user ? await lawReactionsForUser([String(number)], user.id) : {};

  // The thread ships with the law, the way a note ships with its own. One
  // request rather than two, so the discussion is on screen when the page is
  // rather than appearing a moment later underneath it.
  const thread = await listComments(lawCommentParent(String(number)));

  return c.json({
    law: publicLaw(law!),
    myReaction: mine[String(number)] ?? null,
    comments: viewComments(thread, await commentViewer(user ?? null)),
  });
});

/**
 * POST /:number/comments — say something about a law.
 *
 * Every rule about who may comment and what survives screening lives in
 * commentFlow, shared with notes. A law only has to exist to be discussed: a
 * catalogued one whose explanation has not been written yet is still a real law
 * that a person may have an opinion about, and refusing them would be refusing
 * the very thing the site is for.
 */
laws.post("/:number/comments", requireAuth, async (c) => {
  const number = readNumber(c.req.param("number"));
  if (!await getLaw(String(number))) fail(404, "Esa ley no existe.");

  return await postComment(c, lawCommentParent(String(number)));
});

/**
 * POST /:number/view — one person opened this law.
 *
 * Open to anyone, because most readers have no account and counting only the
 * signed-in ones would report a number that means something quite different
 * from what it says. Failing quietly: a lost count is not worth an error
 * message over somebody's reading.
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

  const result = await setLawReaction(String(number), user.id, kind);
  const fresh = await getLaw(String(number));

  return c.json({
    myReaction: result.kind,
    likeCount: fresh?.likeCount ?? 0,
    dislikeCount: fresh?.dislikeCount ?? 0,
  });
});

/**
 * POST /sweep — runs one pass of the crawler on demand.
 *
 * The in-process timer only exists while the process does. On a host that
 * sleeps an idle container, recycles it between deploys, or runs more than one
 * instance, that timer is either dead or duplicated. This endpoint is the way
 * out: point any external scheduler at it and the catalogue advances on a clock
 * that does not depend on ours.
 *
 * It is guarded by a shared secret rather than a session, because the caller is
 * a machine with no account. Without LAW_SWEEP_TOKEN set the route stays shut —
 * an unauthenticated endpoint that makes the server crawl another site on
 * request is a way to be used as a weapon against the Asamblea.
 *
 * The work is awaited rather than backgrounded so the scheduler's own log shows
 * what happened, and so a host that freezes the process after the response
 * cannot cut a sweep in half.
 */
laws.post("/sweep", async (c) => {
  const token = config.lawSweepToken;
  if (!token) fail(404, "No existe esa ruta.");

  const offered = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.header("x-sweep-token") ?? "";

  // Length-independent comparison is not worth the ceremony here, but bailing
  // on an empty token is: a missing header must never match.
  if (!offered || offered !== token) fail(401, "Token inválido.");

  // Marked as background even though it arrived as a request: what matters to
  // the budget is the nature of the work, not how it was triggered. A scheduler
  // crawling eleven thousand laws must yield to readers exactly as the internal
  // timer does, or this endpoint becomes the hole in the reservation.
  const report = await asBackground(sweepLaws);
  console.log(
    `[laws] sweep on demand: +${report.catalogued} catalogued, ` +
      `${report.summarised} explained, ${report.failed} failed`,
  );
  return c.json(report);
});

export default laws;
