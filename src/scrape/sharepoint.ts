// ── SharePoint list fetcher ──────────────────────────────────────────────────
// asamblea.go.cr runs on SharePoint, whose list REST API returns clean JSON to
// anonymous callers. Nothing here needs a browser: the calendar page and the
// news page are both thin clients over the same endpoints this file calls.
//
// The payloads are not tidy, though. Colons arrive as `&#58;` so URLs read
// `https&#58;//youtu.be/...`, bodies carry inline-styled HTML, and titles are
// padded with emoji and stray asterisks. Cleaning happens here, once, so every
// consumer downstream sees plain text.

import type { ExtractedLink, LinkKind, Source } from "../types.ts";

const USER_AGENT = "CensoBot/1.0 (+https://elcenso.cr) civic transparency reader";
const REQUEST_TIMEOUT_MS = 20_000;

export interface SharePointRow {
  Id: number;
  [field: string]: unknown;
}

/** Decodes the numeric and named entities SharePoint puts in list text. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** HTML to readable text: block tags become newlines, everything else is dropped. */
export function htmlToText(input: string): string {
  return decodeEntities(
    input
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\u200b/g, "") // zero-width spaces litter the pasted content
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Trims the decoration editors paste into headlines: emoji, asterisks, bullets. */
export function cleanTitle(input: string): string {
  return decodeEntities(input)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[*_#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyLink(url: string): LinkKind {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/.test(u)) return "document";
  if (u.includes("asamblea.go.cr")) return "sharepoint";
  return "external";
}

/**
 * Pulls every URL out of a blob of text and tags what each one points at.
 *
 * The pattern lists the characters a URL may legally contain rather than the
 * few that end one. Editors paste emoji straight against the link, so the text
 * really reads `https://youtu.be/abc123&#128204;Pondrán tobillera...`, and a
 * "everything up to a space" rule swallows the pin and the next word, producing
 * a dead link. Anything outside the ASCII set below ends the match.
 */
export function extractLinks(text: string): ExtractedLink[] {
  const decoded = decodeEntities(text);
  const matches = decoded.match(/https?:\/\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]+/gi) ?? [];

  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: classifyLink(url) });
  }
  return out;
}

/** The body field a source declares is not always the populated one. Take the
 *  longest of the candidates so a truncated fragment never wins. */
export function pickBody(row: SharePointRow, bodyFields: string[]): string {
  let best = "";
  for (const field of bodyFields) {
    const value = row[field];
    if (typeof value !== "string") continue;
    const text = htmlToText(value);
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * asamblea.go.cr serves only its leaf certificate and leaves the GlobalSign
 * intermediate out of the handshake. Browsers and curl paper over this by
 * fetching the missing link over AIA; Deno's TLS stack does not, so the
 * intermediate is committed under certs/ and supplied here. Verification stays
 * fully on: this adds the one certificate the server forgot to send, rather
 * than trusting the connection blindly.
 */
let httpClient: Deno.HttpClient | null = null;

async function client(): Promise<Deno.HttpClient> {
  if (httpClient) return httpClient;
  const url = new URL("../../certs/asamblea-chain.pem", import.meta.url);
  const caCerts = [await Deno.readTextFile(url)];
  httpClient = Deno.createHttpClient({ caCerts });
  return httpClient;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      client: await client(),
      headers: {
        "Accept": "application/json;odata=nometadata",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the newest rows from a list, highest item id first. Ids increase with
 * insertion, so `sinceItemId` turns a full crawl into an incremental one and the
 * loop stops the moment it reaches something already ingested.
 */
export async function fetchListItems(
  source: Source,
  sinceItemId: number,
  maxItems = 60,
): Promise<SharePointRow[]> {
  const select = source.selectFields.join(",");
  const list = encodeURIComponent(source.listTitle);
  const pageSize = Math.min(maxItems, 100);

  let url = `${source.siteUrl}/_api/web/lists/getbytitle('${list}')/items` +
    `?$select=${encodeURIComponent(select)}&$orderby=Id desc&$top=${pageSize}`;

  const rows: SharePointRow[] = [];
  while (url && rows.length < maxItems) {
    const data = await fetchJson(url);
    const page: SharePointRow[] = data?.value ?? [];
    if (!page.length) break;

    for (const row of page) {
      if (Number(row.Id) <= sinceItemId) return rows; // caught up
      rows.push(row);
      if (rows.length >= maxItems) break;
    }
    url = data["odata.nextLink"] ?? "";
  }
  return rows;
}

export interface NormalizedItem {
  upstreamId: number;
  title: string;
  body: string;
  links: ExtractedLink[];
  eventDate: string | null;
  channel: string | null;
  payload: Record<string, unknown>;
}

export function normalizeRow(source: Source, row: SharePointRow): NormalizedItem {
  const rawTitle = typeof row[source.titleField] === "string"
    ? (row[source.titleField] as string)
    : "";
  const body = pickBody(row, source.bodyFields);

  // Links can appear in the title as well as the body, so scan the raw text of
  // both before the HTML is stripped.
  const linkSource = source.bodyFields
    .map((f) => (typeof row[f] === "string" ? (row[f] as string) : ""))
    .concat(rawTitle)
    .join("\n");

  const eventDate = source.dateField && typeof row[source.dateField] === "string"
    ? (row[source.dateField] as string)
    : null;
  const channel = source.channelField && typeof row[source.channelField] === "string"
    ? decodeEntities(row[source.channelField] as string)
    : null;

  return {
    upstreamId: Number(row.Id),
    title: cleanTitle(rawTitle),
    body,
    links: extractLinks(linkSource),
    eventDate,
    channel,
    payload: row as Record<string, unknown>,
  };
}
