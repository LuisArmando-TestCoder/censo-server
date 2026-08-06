// ── Source registry ──────────────────────────────────────────────────────────
// Which upstream lists we watch. Everything the fetcher needs is stored here, so
// adding a source is a document write, not a code change.
//
// The seeds come from probing asamblea.go.cr directly. Two notes worth keeping:
//
//   "Calendario de eventos" is the LIVE agenda (5,958 items, updated daily).
//   "Actividades del día" is the list linked from the public calendar page, but
//   its newest entry is from June 2022 and it was last touched in Feb 2024. It
//   is seeded disabled so the history stays reachable without polling a dead
//   list every half hour.

import { fsGet, fsList, fsSet, fsUpdate } from "./firestore.ts";
import { COL, sourceDoc } from "./paths.ts";
import type { Source } from "../types.ts";

const ASAMBLEA = "https://asamblea.go.cr/p";

const SEED: Source[] = [
  {
    id: "asamblea-noticias",
    label: "Noticias de la Asamblea Legislativa",
    institution: "Asamblea Legislativa",
    kind: "sharepoint",
    siteUrl: ASAMBLEA,


    listTitle: "Noticias",
    selectFields: ["Id", "Title", "Descripcion", "Detalle", "Modified"],
    titleField: "Title",
    // Upstream is inconsistent about which of these holds the substance: some
    // items put the summary in Descripcion and a fragment in Detalle, others do
    // the reverse. The extractor tries each and keeps the longest.
    bodyFields: ["Detalle", "Descripcion"],
    dateField: null,
    channelField: null,
    enabled: true,
    cursorItemId: 0,
    lastSweepAt: null,
    lastError: null,
  },
  {
    id: "asamblea-calendario",
    label: "Calendario de eventos",
    institution: "Asamblea Legislativa",
    kind: "sharepoint",
    siteUrl: ASAMBLEA,
    listTitle: "Calendario de eventos",

    selectFields: ["Id", "Title", "Description", "EventDate", "EndDate", "Location", "Modified"],
    titleField: "Title",
    bodyFields: ["Description"],
    dateField: "EventDate",
    // Holds values like "AsambleaCR06 (Youtube)", which is how we know a
    // session was broadcast rather than only minuted.
    channelField: "Location",
    enabled: true,
    cursorItemId: 0,
    lastSweepAt: null,
    lastError: null,
  },
  {
    id: "asamblea-actividades-dia",
    label: "Actividades del día (histórico, sin mantenimiento desde 2022)",
    institution: "Asamblea Legislativa",
    kind: "sharepoint",
    siteUrl: ASAMBLEA,
    listTitle: "Actividades del día",

    selectFields: ["Id", "Title", "Description", "EventDate", "EndDate", "Modified"],
    titleField: "Title",
    bodyFields: ["Description"],
    dateField: "EventDate",
    channelField: null,
    enabled: false,
    cursorItemId: 0,
    lastSweepAt: null,
    lastError: null,
  },
  {
    id: "gaceta",
    label: "La Gaceta, diario oficial",
    institution: "Imprenta Nacional",
    kind: "gaceta",
    // The path always serves the current edition, so the sweep never has to
    // guess a date.
    siteUrl: "https://www.imprentanacional.go.cr/gaceta/",
    // The SharePoint fields mean nothing here: the Gaceta reader takes its
    // structure from the page's heading tree, not from a list schema.
    listTitle: "",
    selectFields: [],
    titleField: "",
    bodyFields: [],
    dateField: null,
    channelField: null,
    enabled: true,
    cursorItemId: 0,
    lastSweepAt: null,
    lastError: null,
  },
];


function normalize(raw: Partial<Source> & { _id?: string }): Source {
  return {
    id: raw.id ?? raw._id ?? "",
    label: raw.label ?? raw.id ?? "",
    // Sources written before citations existed carry no institution. Falling
    // back to the label keeps the footnote honest instead of blank.
    institution: raw.institution ?? raw.label ?? raw.id ?? "",
    // Sources predating the second reader are all SharePoint lists.
    kind: raw.kind ?? "sharepoint",
    siteUrl: (raw.siteUrl ?? "").replace(/\/$/, ""),

    listTitle: raw.listTitle ?? "",
    selectFields: raw.selectFields ?? [],
    titleField: raw.titleField ?? "Title",
    bodyFields: raw.bodyFields ?? [],
    dateField: raw.dateField ?? null,
    channelField: raw.channelField ?? null,
    enabled: raw.enabled ?? false,
    cursorItemId: raw.cursorItemId ?? 0,
    lastSweepAt: raw.lastSweepAt ?? null,
    lastError: raw.lastError ?? null,
  };
}

export async function getSource(id: string): Promise<Source | null> {
  const raw = await fsGet<Partial<Source>>(sourceDoc(id));
  return raw ? normalize(raw) : null;
}

export async function listSources(): Promise<Source[]> {
  const rows = await fsList<Partial<Source>>(COL.sources);
  return rows.map(normalize);
}

export async function listEnabledSources(): Promise<Source[]> {
  return (await listSources()).filter((s) => s.enabled);
}

export async function upsertSource(input: Partial<Source> & { id: string }): Promise<Source> {
  const src = normalize(input);
  await fsSet(sourceDoc(src.id), src as unknown as Record<string, unknown>);
  return src;
}

export async function markSwept(
  id: string,
  cursorItemId: number,
  error: string | null,
): Promise<void> {
  await fsUpdate(sourceDoc(id), {
    cursorItemId,
    lastSweepAt: new Date().toISOString(),
    lastError: error,
  });
}

/** Idempotent: writes only the sources that are not there yet. */
export async function seedSources(): Promise<number> {
  const existing = new Set((await listSources()).map((s) => s.id));
  let written = 0;
  for (const src of SEED) {
    if (existing.has(src.id)) continue;
    await fsSet(sourceDoc(src.id), src as unknown as Record<string, unknown>);
    written++;
  }
  return written;
}
