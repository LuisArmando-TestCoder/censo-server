// ── The sweep ────────────────────────────────────────────────────────────────
// Walks every enabled source, files whatever is new, and moves the cursor. One
// source failing never stops the others: its error is recorded on its own
// document and the sweep carries on.

import { listEnabledSources, markSwept } from "../db/sources.ts";
import { storeRawItem } from "../db/rawItems.ts";
import { fetchListItems, type NormalizedItem, normalizeRow } from "./sharepoint.ts";
import { fetchGacetaItems } from "./gaceta.ts";
import type { Source } from "../types.ts";

/** Reads one source with whichever fetcher its kind calls for. */
async function readSource(source: Source, maxItems: number): Promise<NormalizedItem[]> {
  if (source.kind === "gaceta") {
    return await fetchGacetaItems(source, source.cursorItemId, maxItems);
  }
  const rows = await fetchListItems(source, source.cursorItemId, maxItems);
  return rows.map((row) => normalizeRow(source, row));
}

export interface SweepReport {
  sourceId: string;
  created: number;
  changed: number;
  unchanged: number;
  highestItemId: number;
  error: string | null;
}

export async function sweepSource(source: Source, maxItems = 60): Promise<SweepReport> {
  const report: SweepReport = {
    sourceId: source.id,
    created: 0,
    changed: 0,
    unchanged: 0,
    highestItemId: source.cursorItemId,
    error: null,
  };

  try {
    const items = await readSource(source, maxItems);

    // Oldest first, so a crash mid-sweep leaves the cursor on a contiguous run
    // rather than skipping the gap underneath it.
    items.sort((a, b) => a.upstreamId - b.upstreamId);

    for (const item of items) {
      // An item with no title and no body carries nothing to explain.
      if (!item.title && !item.body) continue;

      const { outcome } = await storeRawItem(source.id, item);
      report[outcome]++;
      if (item.upstreamId > report.highestItemId) report.highestItemId = item.upstreamId;
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }

  await markSwept(source.id, report.highestItemId, report.error);
  return report;
}

export async function sweepAll(maxItems = 60): Promise<SweepReport[]> {
  const sources = await listEnabledSources();
  const reports: SweepReport[] = [];
  for (const source of sources) {
    reports.push(await sweepSource(source, maxItems));
  }
  return reports;
}
