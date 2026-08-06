// ── La Gaceta ────────────────────────────────────────────────────────────────
// The official journal. Everything a government does that is legally binding is
// published here first: decrees, appointments, tenders, land registry notices.
// It is where the news comes from before anyone reports it.
//
// Unlike the Asamblea lists there is no API. imprentanacional.go.cr renders the
// whole day as one HTML page, converted from Word, and the only structure it
// carries is the heading tree:
//
//   h1  PODER EJECUTIVO          the branch
//   h2    ACUERDOS               the kind of act
//   h3      PRESIDENCIA          the institution
//           …the text of the act
//
// So an item here is one heading plus the text under it, with the headings above
// it kept as context. That is the smallest unit a reader would recognise as "one
// thing that happened", and it is what the pipeline's reasoner then judges.

import { cleanTitle, extractLinks, htmlToText, type NormalizedItem } from "./sharepoint.ts";
import type { Source } from "../types.ts";

const USER_AGENT = "CensoBot/1.0 (+https://elcenso.cr) civic transparency reader";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How much of one act we keep. The long ones are page after page of boilerplate
 * whose substance is in the opening; a tender notice can run to thousands of
 * words of tables. The verbatim source stays a click away in the citation, so
 * the cost of truncating is bounded and the cost of not truncating is a Firestore
 * document limit and a model bill.
 */
const MAX_BODY_CHARS = 8_000;

/** Below this an item is a stray caption or an empty section header. */
const MIN_BODY_CHARS = 120;

/** Headings that never carry an act, only layout. */
const SKIP_HEADINGS = new Set(["PORTADA", "CONTENIDO", "INDICE", "ÍNDICE"]);

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "Accept": "text/html", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The edition date, taken from the PDF companion link the page always carries
 * (`/pub/2026/08/06/COMP_06_08_2026.pdf`). Reading it from the markup rather
 * than from the clock is what keeps a sweep that runs at 00:05, or a re-run of
 * yesterday's page, from stamping items with the wrong day.
 */
export function editionDate(pageHtml: string): string | null {
  const m = pageHtml.match(/\/pub\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The PDF of the whole edition. This is what a citation points at: /gaceta/
 * always serves today, so a link to it would quietly start describing a
 * different day, while this path keeps naming the day the article was about.
 */
export function editionPdfUrl(pageHtml: string): string | null {
  const m = pageHtml.match(/\/pub\/\d{4}\/\d{2}\/\d{2}\/COMP_[^"']+\.pdf/i);
  return m ? `https://www.imprentanacional.go.cr${m[0]}` : null;
}


/**
 * A stable, increasing id for one item: the date followed by its position in the
 * day. Re-reading the same edition yields the same ids, so the drawer store sees
 * an unchanged item rather than a duplicate, and the source cursor can still be
 * compared with `>`, which is what makes the sweep incremental.
 */
export function gacetaItemId(isoDate: string, index: number): number {
  return Number(isoDate.replaceAll("-", "")) * 1000 + index;
}

interface Heading {
  level: number;
  text: string;
}

/** The body of the page: everything the Word conversion put in the container. */
function contentSlice(pageHtml: string): string {
  const start = pageHtml.indexOf("ContenidoGacetaDiv");
  if (start < 0) return "";
  const end = pageHtml.indexOf("MainContentPlaceHolder$idpagina", start);
  return pageHtml.slice(start, end > start ? end : undefined);
}

export interface GacetaSection {
  /** "PODER EJECUTIVO › ACUERDOS › PRESIDENCIA DE LA REPÚBLICA" */
  breadcrumb: string;
  heading: string;
  body: string;
  html: string;
}

/**
 * Cuts the day into sections. Walks the heading tree keeping the current path,
 * so a section knows which branch and which kind of act it belongs to even
 * though the markup expresses that only by nesting order.
 */
export function splitSections(pageHtml: string): GacetaSection[] {
  const content = contentSlice(pageHtml);
  if (!content) return [];

  const parts = content.split(/(<h[123][^>]*>[\s\S]*?<\/h[123]>)/i);
  const path: Heading[] = [];
  const out: GacetaSection[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const head = part.match(/^<h([123])[^>]*>([\s\S]*?)<\/h[123]>$/i);
    if (!head) continue;

    const level = Number(head[1]);
    const text = cleanTitle(htmlToText(head[2]));
    if (!text) continue;

    while (path.length && path[path.length - 1].level >= level) path.pop();
    path.push({ level, text });

    if (SKIP_HEADINGS.has(text.toUpperCase())) continue;

    const html = parts[i + 1] ?? "";
    const body = htmlToText(html).slice(0, MAX_BODY_CHARS);
    if (body.length < MIN_BODY_CHARS) continue;

    out.push({
      breadcrumb: path.map((p) => p.text).join(" › "),
      heading: text,
      body,
      html,
    });
  }

  return out;
}

/**
 * Reads one edition and returns it as items the rest of the sweep understands.
 *
 * `sinceItemId` is compared against the ids derived from the edition date, so a
 * second sweep on the same day returns nothing rather than re-reading the page
 * into the same drawers.
 */
export async function fetchGacetaItems(
  source: Source,
  sinceItemId: number,
  maxItems = 60,
): Promise<NormalizedItem[]> {
  // The registry stores urls without a trailing slash; this one is a directory,
  // and asking for it without the slash costs a redirect.
  const url = source.siteUrl.endsWith("/") ? source.siteUrl : `${source.siteUrl}/`;
  const pageHtml = await fetchPage(url);


  const date = editionDate(pageHtml);
  if (!date) throw new Error("No edition date on the page; the markup changed.");

  const sections = splitSections(pageHtml);
  if (!sections.length) throw new Error("No sections found; the markup changed.");

  const editionUrl = editionPdfUrl(pageHtml);


  const items: NormalizedItem[] = [];
  for (let i = 0; i < sections.length && items.length < maxItems; i++) {
    const upstreamId = gacetaItemId(date, i);
    if (upstreamId <= sinceItemId) continue;

    const section = sections[i];
    items.push({
      upstreamId,
      // The breadcrumb is the title because "MINISTERIO DE SALUD" alone says
      // nothing: the reader needs to know it was a decree and not a tender.
      title: section.breadcrumb,
      body: section.body,
      // The edition comes first so the footnote cites the day's Gaceta rather
      // than whatever address happened to be printed inside an act.
      links: [
        ...(editionUrl ? [{ url: editionUrl, kind: "document" as const }] : []),
        ...extractLinks(section.html),
      ],

      eventDate: date,
      channel: null,
      payload: {
        editionDate: date,
        breadcrumb: section.breadcrumb,
        heading: section.heading,
        index: i,
      },
    });
  }

  return items;
}
