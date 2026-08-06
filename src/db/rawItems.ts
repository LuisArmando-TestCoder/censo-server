// ── Raw item store (the drawers) ─────────────────────────────────────────────
// Upstream content lands here verbatim and is never rewritten. Everything the
// agents produce lives elsewhere, so an article can always be traced back to
// exactly what the Asamblea published.
//
// The id is `${sourceId}__${upstreamId}`, so re-reading the same list item lands
// on the same document. A content hash decides whether a re-read is a genuine
// change worth re-running the pipeline for, or just noise.

import { fsGet, fsQuery, fsQuerySorted, fsSet, fsUpdate } from "./firestore.ts";

import { COL, rawItemDoc } from "./paths.ts";
import { listEnabledSources } from "./sources.ts";
import { sha256Hex } from "../lib/hash.ts";

import type { NormalizedItem } from "../scrape/sharepoint.ts";
import type { RawItem } from "../types.ts";

export function rawItemId(sourceId: string, upstreamId: number): string {
  return `${sourceId}__${upstreamId}`;
}

export async function getRawItem(id: string): Promise<RawItem | null> {
  return await fsGet<RawItem>(rawItemDoc(id));
}

export type StoreOutcome = "created" | "changed" | "unchanged";

/**
 * Files one upstream item. Returns what actually happened so the sweep can
 * report honest numbers rather than counting every read as new.
 */
export async function storeRawItem(
  sourceId: string,
  item: NormalizedItem,
): Promise<{ id: string; outcome: StoreOutcome }> {
  const id = rawItemId(sourceId, item.upstreamId);
  const contentHash = await sha256Hex(`${item.title}\n${item.body}`);
  const existing = await getRawItem(id);

  if (existing && existing.contentHash === contentHash) {
    return { id, outcome: "unchanged" };
  }

  const record: RawItem = {
    id,
    sourceId,
    upstreamId: item.upstreamId,
    contentHash,
    title: item.title,
    body: item.body,
    links: item.links,
    eventDate: item.eventDate,
    channel: item.channel,
    payload: item.payload,
    fetchedAt: new Date().toISOString(),
    // An edit upstream re-opens the pipeline but keeps the article it produced,
    // so an editor's work is never silently orphaned.
    postId: existing?.postId ?? null,
    status: "pending",
  };

  await fsSet(rawItemDoc(id), record as unknown as Record<string, unknown>);
  return { id, outcome: existing ? "changed" : "created" };
}

export async function setRawItemStatus(
  id: string,
  status: RawItem["status"],
  postId?: string | null,
): Promise<void> {
  await fsUpdate(rawItemDoc(id), {
    status,
    ...(postId !== undefined ? { postId } : {}),
  });
}

/**
 * The queue the agent pipeline drains, taken in turns across the sources.
 *
 * A single flat query starves the small source. The calendar publishes dozens of
 * bare agenda rows a day and the news list publishes a handful of actual
 * stories, so draining in document order spends every tick on committee names
 * while the stories wait days for their turn. Each item costs about thirty
 * seconds of browser and model time, which makes that ordering expensive as well
 * as wrong.
 *
 * Taking turns means a slow source cannot block a fast one. Within a source the
 * oldest item still goes first, so nothing is skipped, only reordered.
 */
export async function listPendingRawItems(limit = 10): Promise<RawItem[]> {
  const sources = await listEnabledSources();

  // No sources configured yet: fall back to a flat read rather than returning
  // nothing, so a manually inserted item is still processed.
  if (sources.length === 0) {
    return await fsQuery<RawItem>(COL.rawItems, {
      where: [{ field: "status", op: "EQUAL", value: "pending" }],
      limit,
    });
  }

  const queues = await Promise.all(
    sources.map((s) =>
      fsQuery<RawItem>(COL.rawItems, {
        where: [
          { field: "status", op: "EQUAL", value: "pending" },
          { field: "sourceId", op: "EQUAL", value: s.id },
        ],
        limit,
      }).then((items) => items.sort((a, b) => a.upstreamId - b.upstreamId))
    ),
  );

  const picked: RawItem[] = [];
  for (let round = 0; picked.length < limit; round++) {
    const before = picked.length;
    for (const queue of queues) {
      if (picked.length >= limit) break;
      const item = queue[round];
      if (item) picked.push(item);
    }
    if (picked.length === before) break; // every queue is exhausted
  }

  return picked;
}

export async function listRawItemsBySource(sourceId: string, limit = 50): Promise<RawItem[]> {
  return await fsQuerySorted<RawItem>(COL.rawItems, {
    where: [{ field: "sourceId", op: "EQUAL", value: sourceId }],
    sortBy: "upstreamId",
    desc: true,
    limit,
  });
}
