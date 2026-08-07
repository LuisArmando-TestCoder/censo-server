// ── Laws, and how people vote on them ────────────────────────────────────────
// A law's document id is its own number, which makes the question the nightly
// crawler asks most often — "do I already have 10964?" — a single key read
// rather than a query. Nothing has to be scanned to avoid a duplicate, and a
// duplicate cannot be written even if two crawlers run at once.
//
// Reactions work exactly as they do for posts: one document per person per law,
// with the totals kept by atomic increment. See db/posts.ts for the reasoning.

import {
  fsCount,
  fsCreate,
  fsDelete,
  fsGet,
  fsQuery,
  fsQuerySorted,
  fsSet,
  fsUpdate,
} from "./firestore.ts";
import { COL, crawlStateDoc, lawDoc, lawReactionDoc, lawReactionsCol } from "./paths.ts";
import type { Law, LawCrawlState, LawStatus, Reaction, ReactionKind } from "../types.ts";
import type { ReactionResult } from "./posts.ts";
import { publish } from "../lib/events.ts";

export async function getLaw(number: string): Promise<Law | null> {
  return await fsGet<Law>(lawDoc(number));
}

/** True when this number is already catalogued, whatever state it is in. */
export async function lawIsKnown(number: number): Promise<boolean> {
  return (await getLaw(String(number))) !== null;
}

export interface CatalogueLawInput {
  number: number;
  officialTitle: string;
  sourceUrl: string;
}

/**
 * Records a law's existence without reading its text.
 *
 * Uses a create rather than a write so a law that is already known is left
 * exactly as it was: the summary, the vote counts and the reactions of a law we
 * have already processed must survive the crawler passing over it again.
 * Returns false when the law was already there.
 */
export async function catalogueLaw(input: CatalogueLawInput): Promise<boolean> {
  const now = new Date().toISOString();
  const law: Law = {
    id: String(input.number),
    number: input.number,
    officialTitle: input.officialTitle,
    headline: null,
    summary: null,
    explanation: null,
    affects: [],
    benefits: [],
    implications: [],
    flags: [],
    originalMarkdown: null,

    sourceUrl: input.sourceUrl,
    documentName: null,
    inForce: true,
    publishedAt: null,
    gacetaNumber: null,
    alcanceNumber: null,
    emittedAt: null,
    sanctionedAt: null,
    effectiveAt: null,
    expedienteNumber: null,
    expedienteSubject: null,
    procedureType: null,
    affectations: [],
    status: "catalogued",
    lastError: null,
    likeCount: 0,
    dislikeCount: 0,
    commentCount: 0,
    viewCount: 0,
    textCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return await fsCreate(COL.laws, law.id, law as unknown as Record<string, unknown>);
}

/**
 * Merges new facts into a law.
 *
 * A field mask write, so the vote counters are never carried along in a patch
 * and cannot be rolled back to a stale value read moments earlier.
 */
export async function updateLaw(number: string, patch: Partial<Law>): Promise<void> {
  await fsUpdate(lawDoc(number), {
    ...(patch as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

/** Writes a law in full. Used only when seeding a document that has no history. */
export async function putLaw(law: Law): Promise<void> {
  await fsSet(lawDoc(law.id), law as unknown as Record<string, unknown>);
}

/** Laws fit to show a reader, newest first. */
export async function listReadyLaws(limit = 30): Promise<Law[]> {
  return await fsQuerySorted<Law>(COL.laws, {
    where: [{ field: "status", op: "EQUAL", value: "ready" }],
    sortBy: "number",
    desc: true,
    limit,
  });
}

/** Laws in a given state, newest first. Used by the crawler and the admin. */
export async function listLawsByStatus(status: LawStatus, limit = 50): Promise<Law[]> {
  return await fsQuerySorted<Law>(COL.laws, {
    where: [{ field: "status", op: "EQUAL", value: status }],
    sortBy: "number",
    desc: true,
    limit,
  });
}

/**
 * The next laws waiting for a summary.
 *
 * Only laws at or above the floor are returned. Everything older is catalogued
 * and searchable but summarised on demand, so the backlog cannot swallow the
 * model's whole budget before a reader has asked for any of it.
 */
export async function listLawsAwaitingSummary(floor: number, limit: number): Promise<Law[]> {
  const rows = await fsQuery<Law>(COL.laws, {
    where: [{ field: "status", op: "EQUAL", value: "catalogued" }],
    limit: 500,
  });
  return rows
    .filter((l) => l.number >= floor)
    .sort((a, b) => b.number - a.number)
    .slice(0, limit);
}

/** Full-text-ish search over the catalogue, done in memory over a bounded scan. */
export async function searchLaws(query: string, limit = 30): Promise<Law[]> {
  const needle = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (!needle) return await listReadyLaws(limit);

  const rows = await fsQuery<Law>(COL.laws, { limit: 500 });
  const fold = (s: string | null) =>
    (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  return rows
    .filter((l) =>
      String(l.number).includes(needle) ||
      fold(l.officialTitle).includes(needle) ||
      fold(l.headline).includes(needle) ||
      fold(l.summary).includes(needle)
    )
    .sort((a, b) => b.number - a.number)
    .slice(0, limit);
}

/** How many laws are in each state. Powers the admin view of crawl progress. */
export async function countLawsByStatus(): Promise<Record<LawStatus, number>> {
  const rows = await fsQuery<Law>(COL.laws, { limit: 20_000 });
  const out: Record<LawStatus, number> = {
    catalogued: 0,
    ready: 0,
    no_text: 0,
    failed: 0,
  };
  for (const r of rows) if (r.status in out) out[r.status]++;
  return out;
}

// ── Reactions ────────────────────────────────────────────────────────────────

export async function getLawReaction(
  number: string,
  userId: string,
): Promise<Reaction | null> {
  return await fsGet<Reaction>(lawReactionDoc(number, userId));
}

/**
 * Applies a vote on a law. Pressing the same button twice removes the vote;
 * pressing the other switches it. Identical in behaviour to setReaction for
 * posts, because a reader should not have to learn two rules.
 */
export async function setLawReaction(
  number: string,
  userId: string,
  kind: ReactionKind,
): Promise<ReactionResult> {
  const existing = await getLawReaction(number, userId);

  let result: ReactionResult;
  if (!existing) {
    await fsSet(lawReactionDoc(number, userId), {
      userId,
      kind,
      createdAt: new Date().toISOString(),
    });
    result = {
      kind,
      likeDelta: kind === "like" ? 1 : 0,
      dislikeDelta: kind === "dislike" ? 1 : 0,
    };
  } else if (existing.kind === kind) {
    await fsDelete(lawReactionDoc(number, userId));
    result = {
      kind: null,
      likeDelta: kind === "like" ? -1 : 0,
      dislikeDelta: kind === "dislike" ? -1 : 0,
    };
  } else {
    await fsUpdate(lawReactionDoc(number, userId), { kind });
    result = {
      kind,
      likeDelta: kind === "like" ? 1 : -1,
      dislikeDelta: kind === "dislike" ? 1 : -1,
    };
  }

  // Recount on write to prevent drift
  const [likeCount, dislikeCount] = await Promise.all([
    fsCount(lawReactionsCol(number), [{ field: "kind", op: "EQUAL", value: "like" }]),
    fsCount(lawReactionsCol(number), [{ field: "kind", op: "EQUAL", value: "dislike" }]),
  ]);

  await fsUpdate(lawDoc(number), { likeCount, dislikeCount });
  
  const deltas: Record<string, number> = {};
  if (result.likeDelta) deltas.likeCount = result.likeDelta;
  if (result.dislikeDelta) deltas.dislikeCount = result.dislikeDelta;
  if (Object.keys(deltas).length) {
    publish({ kind: "law", id: number, deltas });
  }

  return result;
}

/** Which of the given laws this reader already voted on. */
export async function lawReactionsForUser(
  numbers: string[],
  userId: string,
): Promise<Record<string, ReactionKind>> {
  const entries = await Promise.all(
    numbers.map(async (n) => [n, await getLawReaction(n, userId)] as const),
  );
  const out: Record<string, ReactionKind> = {};
  for (const [n, r] of entries) if (r) out[n] = r.kind;
  return out;
}

// ── Crawl state ──────────────────────────────────────────────────────────────

const CRAWL_ID = "laws";

/** The starting ceiling, used only when no state has ever been written. */
const INITIAL_CEILING = 10966;

export async function getCrawlState(): Promise<LawCrawlState> {
  const existing = await fsGet<LawCrawlState>(crawlStateDoc(CRAWL_ID));
  if (existing) return existing;

  const fresh: LawCrawlState = {
    id: CRAWL_ID,
    ceiling: INITIAL_CEILING,
    nextNumber: INITIAL_CEILING,
    complete: false,
    lastRunAt: null,
    lastError: null,
  };
  await fsSet(crawlStateDoc(CRAWL_ID), fresh as unknown as Record<string, unknown>);
  return fresh;
}

export async function updateCrawlState(patch: Partial<LawCrawlState>): Promise<void> {
  await fsUpdate(crawlStateDoc(CRAWL_ID), patch as Record<string, unknown>);
}
