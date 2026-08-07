// ── Consulta de Leyes (SIL) ──────────────────────────────────────────────────
// Reads the laws of the Republic from the Asamblea's own search screen.
//
// The public page at asamblea.go.cr/.../ConsultaLeyes.aspx is a SharePoint
// wrapper whose only real content is an iframe. The application inside it is a
// plain ASP.NET WebForms page, and that is what this file talks to. Going
// straight to it means the SharePoint chrome, its scripts and its 77 KB of
// markup never have to be downloaded or parsed.
//
// WebForms has no URL for anything: every action is a POST of the whole form
// back to the same address, carrying an opaque __VIEWSTATE that encodes what
// the server currently believes is on screen. So a lookup is a short
// conversation, and each reply must be fed into the next request:
//
//   GET                                   → the empty form
//   POST btnBuscar + tbxBuscaLey=10964    → a grid holding that one law
//   POST __EVENTTARGET=grvLey Select$0    → the detail panels appear
//   POST btnDescargaTexto                 → the .docx itself
//
// Nothing here needs a browser. The page ships no client-side rendering: the
// grid and the detail tables are in the HTML the server sends.

import { config } from "../config.ts";
import { BudgetExhausted, spend } from "../lib/budget.ts";
import { bytes as humanBytes, Trace } from "../lib/trace.ts";
import type { LawAffectation } from "../types.ts";

/** The WebForms application, inside the iframe of the public SharePoint page. */
const FORM_URL = "https://consultassil3.asamblea.go.cr/frmConsultaLey.aspx";

/** Where a reader should be sent to check a law: the page a person can use. */
export const PUBLIC_CONSULTA_URL =
  "https://www.asamblea.go.cr/Centro_de_informacion/Consultas_SIL/SitePages/ConsultaLeyes.aspx";

const USER_AGENT = "CensoBot/1.0 (+https://elcenso.cr) civic transparency reader";

// ── Control names ────────────────────────────────────────────────────────────
// Verified against the live page. They are ASP.NET's generated names, so they
// are stable as long as the control tree is, and a change here is exactly what
// should break loudly rather than silently return nothing.

const FIELD_NUMBER = "ctl00$ContentPlaceHolder1$tbxBuscaLey";
const FIELD_TITLE = "ctl00$ContentPlaceHolder1$tbxBuscaDescripcion";
const BUTTON_SEARCH = "ctl00$ContentPlaceHolder1$btnBuscar";
const BUTTON_DOWNLOAD_TEXT = "ctl00$ContentPlaceHolder1$btnDescargaTexto";
const GRID = "ctl00$ContentPlaceHolder1$grvLey";

/** The message the page prints when a number matches no law. */
const NOT_FOUND_MESSAGE = "no existe";

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

  // The SIL answers only to Costa Rican networks. A server hosted abroad has to
  // borrow an egress inside the country, which is what this proxy is for.
  const proxy = config.lawHttpProxy;
  httpClient = proxy
    ? Deno.createHttpClient({ caCerts, proxy: { url: proxy } })
    : Deno.createHttpClient({ caCerts });

  if (proxy) {
    // The host, never the whole URL: a proxy URL can carry credentials.
    console.log(`[laws] saliendo por proxy ${new URL(proxy).host}`);
  }
  return httpClient;
}

// ── The conversation ─────────────────────────────────────────────────────────

/**
 * One visit to the page.
 *
 * It holds the two things WebForms needs to keep believing it is talking to the
 * same browser: the session cookie and the current view state. Both are
 * replaced after every POST, so a session is a moving position in a dialogue,
 * not a reusable handle. Two lookups must never share one.
 */
export interface LeySession {
  cookie: string;
  state: Record<string, string>;
}

/** The hidden inputs that must be echoed back on every postback. */
const STATE_FIELDS = ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"];

function readHidden(html: string, name: string): string {
  const byId = new RegExp(`id="${name}"[^>]*value="([^"]*)"`).exec(html);
  if (byId) return byId[1];
  const byName = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html);
  return byName ? byName[1] : "";
}

function readState(html: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const f of STATE_FIELDS) state[f] = readHidden(html, f);
  return state;
}

/** Keeps only the cookie pairs, dropping Path/HttpOnly/Expires attributes. */
function mergeCookies(previous: string, headers: Headers): string {
  const jar = new Map<string, string>();
  for (const pair of previous.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of headers.getSetCookie()) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * How many times a request is attempted before giving up.
 *
 * The Asamblea's server is occasionally slow enough to pass the timeout, and a
 * single lost request would otherwise end a whole sweep. Retrying here rather
 * than in the caller keeps that failure from ever reaching the crawl logic.
 */
const REQUEST_ATTEMPTS = 3;

/**
 * How long the most recent round trip took.
 *
 * Module-level rather than returned, so that adding timing to the log did not
 * mean changing the signature of every function between here and the caller.
 * Safe because the crawler is strictly sequential: one request is in flight at
 * a time, by design, since the whole point is not to burden the Asamblea.
 */
let lastRequestMs = 0;

/** True for the failures that are worth a second try: timeouts and dropped connections. */
function isTransient(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError" ||
    err instanceof TypeError; // fetch reports a broken connection this way
}

async function request(
  session: LeySession | null,
  body: URLSearchParams | null,
): Promise<{ response: Response; cookie: string }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "es-CR,es;q=0.9",
  };
  if (session?.cookie) headers["Cookie"] = session.cookie;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Referer"] = FORM_URL;
    headers["Origin"] = new URL(FORM_URL).origin;
  }

  // Resolved once, outside the loop: the client is a cached singleton, and
  // reaching for it inside the metered closure only forced that closure to be
  // async for a value that never changes between attempts.
  const http = await client();

  let lastError: unknown;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    try {
      // The body is rebuilt per attempt: a URLSearchParams is consumed once it
      // has been sent, so reusing it would post an empty form on the retry.
      const startedAt = performance.now();
      // Metered here rather than around the retry loop so that each attempt
      // counts as the request it is, and so the limiter's own spacing applies
      // between attempts as well as between laws. The Asamblea cannot tell a
      // retry from a first try, and neither should our ceiling.
      const response = await spend("asamblea", () =>
        fetch(FORM_URL, {
          method: body ? "POST" : "GET",
          headers,
          body: body ? new URLSearchParams(body) : undefined,
          client: http,
          signal: AbortSignal.timeout(config.lawRequestTimeoutMs),
        }));

      // The round trip is timed on every request because latency here is the
      // early warning for the timeouts that used to end a whole sweep: a site
      // drifting from 2s to 20s shows up in these numbers long before it fails.
      lastRequestMs = Math.round(performance.now() - startedAt);

      return { response, cookie: mergeCookies(session?.cookie ?? "", response.headers) };
    } catch (err) {
      lastError = err;
      // Running out of the day's courtesy allowance is a decision, not a fault:
      // retrying it would spend three attempts to be told the same thing.
      if (err instanceof BudgetExhausted) throw err;
      if (!isTransient(err)) throw err;

      // Out of attempts. A bare "aborted due to timeout" sends whoever reads
      // the log hunting for a bug in this file, when the cause is almost always
      // that the host cannot be reached from where the server runs: the SIL
      // answers Costa Rican networks and silently drops everything else, so the
      // connection hangs instead of being refused. Saying so here is the
      // difference between a five-minute fix and an afternoon.
      if (attempt === REQUEST_ATTEMPTS) {
        throw new Error(
          `No se pudo contactar ${new URL(FORM_URL).host} en ${REQUEST_ATTEMPTS} intentos de ` +
            `${config.lawRequestTimeoutMs / 1000}s. El sitio de la Asamblea responde solo desde ` +
            `redes de Costa Rica; desde otro país la conexión no se rechaza, se descarta, y por ` +
            `eso expira. Si este servidor está fuera del país, configure LAW_HTTP_PROXY con una ` +
            `salida costarricense.` +
            (config.lawHttpProxy ? ` Proxy actual: ${new URL(config.lawHttpProxy).host}.` : ""),
          { cause: err },
        );
      }

      // Backing off rather than retrying immediately: if the site is struggling,
      // a tighter loop is the least helpful thing we could do to it.
      const wait = 2_000 * attempt;
      console.warn(
        `[laws] request failed (${(err as Error).name}), ` +
          `retrying in ${wait / 1000}s — attempt ${attempt + 1} of ${REQUEST_ATTEMPTS}`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastError;
}

/** Opens the form and reads its initial view state. */
export async function openSession(): Promise<LeySession> {
  const { response, cookie } = await request(null, null);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ConsultaLey GET failed: ${response.status}`);
  }
  const html = await response.text();
  return { cookie, state: readState(html) };
}

/**
 * Posts the form back and advances the session.
 *
 * The search boxes are resent on every postback because WebForms treats the
 * form as the complete state of the screen: a field left out is a field the
 * user is telling the server they cleared, which would drop the search and
 * with it the selected row.
 */
async function postBack(
  session: LeySession,
  fields: Record<string, string>,
  lawNumber: string,
): Promise<{ html: string; bytes: Uint8Array | null; filename: string | null }> {
  const body = new URLSearchParams();
  for (const f of STATE_FIELDS) body.set(f, session.state[f] ?? "");
  body.set("__EVENTTARGET", "");
  body.set("__EVENTARGUMENT", "");
  body.set(FIELD_NUMBER, lawNumber);
  body.set(FIELD_TITLE, "");
  for (const [k, v] of Object.entries(fields)) body.set(k, v);

  const { response, cookie } = await request(session, body);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ConsultaLey POST failed: ${response.status}`);
  }
  session.cookie = cookie;

  // A file arrives as an attachment; anything else is another render of the page.
  const disposition = response.headers.get("Content-Disposition") ?? "";
  if (disposition.includes("attachment")) {
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
    return {
      html: "",
      bytes: new Uint8Array(await response.arrayBuffer()),
      filename: filename ? decodeURIComponent(filename.trim()) : null,
    };
  }

  const html = await response.text();
  session.state = readState(html);
  return { html, bytes: null, filename: null };
}

// ── Reading the HTML ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Tag soup to plain text: strip markup, decode entities, collapse whitespace. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Isolates one table by its id, so sibling tables cannot bleed into a parse. */
function tableById(html: string, id: string): string | null {
  const open = html.indexOf(`id="${id}"`);
  if (open < 0) return null;
  const start = html.lastIndexOf("<table", open);
  const end = html.indexOf("</table>", open);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end + 8);
}

/** Splits a table into rows of already-cleaned cells. */
function tableRows(table: string): string[][] {
  const rows: string[][] = [];
  for (const [, tr] of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells: string[] = [];
    for (const [, td] of tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) cells.push(cellText(td));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Reads a two-column "label, value" panel into a lookup.
 *
 * ASP.NET DetailsView renders these as one row per field, which is why the
 * result is keyed by the label the Asamblea prints rather than by position:
 * a new field appearing upstream then shifts nothing.
 */
function detailPairs(html: string, id: string): Record<string, string> {
  const table = tableById(html, id);
  if (!table) return {};
  const pairs: Record<string, string> = {};
  for (const row of tableRows(table)) {
    if (row.length >= 2 && row[0]) pairs[row[0]] = row[1];
  }
  return pairs;
}

/** Normalises a label so accents and case cannot break a lookup. */
function foldLabel(label: string): string {
  return label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function pick(pairs: Record<string, string>, label: string): string | null {
  const wanted = foldLabel(label);
  for (const [k, v] of Object.entries(pairs)) {
    if (foldLabel(k) === wanted) return v.trim() || null;
  }
  return null;
}

/** Spanish month abbreviations as the SIL prints them, e.g. "24-jun.-2026". */
const MONTHS: Record<string, string> = {
  ene: "01",
  feb: "02",
  mar: "03",
  abr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  ago: "08",
  set: "09",
  sep: "09",
  oct: "10",
  nov: "11",
  dic: "12",
};

/**
 * Turns "24-jun.-2026" into "2026-06-24".
 *
 * Returns null rather than a guess when the shape is unfamiliar: a wrong date
 * on a law is worse than a missing one, because a reader cannot tell it is wrong.
 */
export function parseSilDate(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{1,2})-([a-zA-Záéíóú]+)\.?-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[foldLabel(m[2]).slice(0, 3)];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** One row of the results grid: the identity of a law, without its detail. */
export interface LawRow {
  number: number;
  title: string;
}

/** Everything the detail panels say once a row has been selected. */
export interface LawDetail extends LawRow {
  inForce: boolean;
  publishedAt: string | null;
  gacetaNumber: string | null;
  alcanceNumber: string | null;
  emittedAt: string | null;
  sanctionedAt: string | null;
  effectiveAt: string | null;
  expedienteNumber: string | null;
  expedienteSubject: string | null;
  procedureType: string | null;
  affectations: LawAffectation[];
}

/** Reads the results grid, ignoring its header and pager rows. */
function parseGrid(html: string): LawRow[] {
  const table = tableById(html, "ContentPlaceHolder1_grvLey");
  if (!table) return [];
  const rows: LawRow[] = [];
  for (const cells of tableRows(table)) {
    // Column 0 is the Seleccionar button, 1 the number, 2 the title.
    if (cells.length < 3) continue;
    if (!/^\d+$/.test(cells[1])) continue;
    rows.push({ number: Number(cells[1]), title: cells[2] });
  }
  return rows;
}

function parseAffectations(html: string): LawAffectation[] {
  const table = tableById(html, "ContentPlaceHolder1_grvAfectaciones");
  if (!table) return [];
  const out: LawAffectation[] = [];
  for (const cells of tableRows(table)) {
    if (cells.length < 4) continue;
    if (foldLabel(cells[0]) === "ley afectada") continue; // header
    out.push({
      lawNumber: cells[0],
      affectingArticle: cells[1],
      affectedLawTitle: cells[2],
      affectedArticle: cells[3],
    });
  }
  return out;
}

/** Searches by law number. Returns the matching row, or null when none exists. */
export async function searchLaw(
  session: LeySession,
  number: number,
): Promise<LawRow | null> {
  const trace = new Trace(number);
  const { html } = await postBack(session, { [BUTTON_SEARCH]: "Buscar" }, String(number));

  if (decodeEntities(html).toLowerCase().includes(NOT_FOUND_MESSAGE)) {
    trace.step("buscar", `sin resultados (${lastRequestMs}ms)`);
    return null;
  }

  const rows = parseGrid(html);
  const match = rows.find((r) => r.number === number) ?? null;

  trace.step(
    "buscar",
    `HTML ${humanBytes(html.length)} → ${rows.length} fila(s) → ` +
      `${match ? `ley ${match.number}` : "ninguna coincide"} (${lastRequestMs}ms)`,
  );
  // The whole grid, not just the match: when the parse goes wrong it is usually
  // because the page returned rows we did not expect, and the count alone does
  // not say which ones.
  trace.detail("buscar", () => ({
    filas: rows.map((r) => `${r.number}: ${r.title}`),
    coincidencia: match?.title ?? null,
  }));

  return match;
}

/**
 * Presses "Seleccionar" on the first result and reads the panels it reveals.
 *
 * Must follow searchLaw on the same session: the row index is meaningful only
 * against the grid the server last rendered.
 */
export async function selectLaw(
  session: LeySession,
  row: LawRow,
): Promise<LawDetail> {
  const { html } = await postBack(session, {
    __EVENTTARGET: GRID,
    __EVENTARGUMENT: "Select$0",
  }, String(row.number));

  const trace = new Trace(row.number);
  const detail = detailPairs(html, "ContentPlaceHolder1_dvDetalleLey");
  const project = detailPairs(html, "ContentPlaceHolder1_dvProyectoLey");

  // Each date is read raw and converted separately so the log can show both
  // sides. This is the stage that fails quietly: an unfamiliar date format
  // becomes null, the law still saves, and the site shows a law with no date
  // rather than an error anybody would notice.
  const rawDates = {
    publicación: pick(detail, "Fecha de Publicación"),
    emisión: pick(detail, "Emitido Asamblea Legislativa"),
    sanción: pick(detail, "Sancionado Poder Ejecutivo"),
    rige: pick(detail, "Rige"),
  };
  const dates = {
    publishedAt: parseSilDate(rawDates.publicación),
    emittedAt: parseSilDate(rawDates.emisión),
    sanctionedAt: parseSilDate(rawDates.sanción),
    effectiveAt: parseSilDate(rawDates.rige),
  };

  const affectations = parseAffectations(html);
  const vigente = pick(detail, "Vigente");

  // A date the SIL printed but we could not read is worth a line at normal
  // volume: it is the difference between "the Asamblea left it blank" and "our
  // parser does not know this format", and only the second is our bug.
  const dropped = Object.entries(rawDates)
    .filter(([k, v]) =>
      v && !dates[
        ({
          publicación: "publishedAt",
          emisión: "emittedAt",
          sanción: "sanctionedAt",
          rige: "effectiveAt",
        } as const)[k as keyof typeof rawDates]
      ]
    )
    .map(([k, v]) => `${k}="${v}"`);

  trace.step(
    "detalle",
    `${Object.keys(detail).length + Object.keys(project).length} campo(s) → ` +
      `vigente=${vigente === "1"}, ${Object.values(dates).filter(Boolean).length}/4 fecha(s), ` +
      `${affectations.length} afectación(es) (${lastRequestMs}ms)` +
      (dropped.length ? ` ⚠ sin convertir: ${dropped.join(", ")}` : ""),
  );

  trace.transform("detalle.publicación", rawDates.publicación, dates.publishedAt);
  trace.transform("detalle.rige", rawDates.rige, dates.effectiveAt);
  trace.detail("detalle", () => ({
    vigente: `${vigente} → ${vigente === "1"}`,
    gaceta: pick(detail, "Número de Gaceta"),
    expediente: pick(project, "Número Expediente Legislativo"),
    asunto: pick(project, "Asunto Expediente Legislativo"),
    afectaciones: affectations.map((a) => `${a.lawNumber} ${a.affectedArticle}`),
  }));

  return {
    ...row,
    // The Asamblea prints "1" for a law in force and "0" for one repealed.
    inForce: vigente === "1",
    ...dates,
    gacetaNumber: pick(detail, "Número de Gaceta"),
    alcanceNumber: pick(detail, "Número de Alcance"),
    expedienteNumber: pick(project, "Número Expediente Legislativo"),
    expedienteSubject: pick(project, "Asunto Expediente Legislativo"),
    procedureType: pick(project, "Descripcion Tipo"),
    affectations,
  };
}

/** A downloaded law text. */
export interface LawDocument {
  bytes: Uint8Array;
  filename: string;
}

/**
 * Presses "Descargar" under "Texto de Ley".
 *
 * Returns null when the Asamblea has no file for this law. It answers that by
 * re-rendering the page instead of sending an attachment, which is why the
 * absence is detected from the response headers rather than from an error.
 * Callers must treat null as final and stop asking: many older laws have no
 * digitised text and never will.
 */
export async function downloadLawText(
  session: LeySession,
  row: LawRow,
): Promise<LawDocument | null> {
  const trace = new Trace(row.number);
  const { bytes, filename } = await postBack(
    session,
    { [BUTTON_DOWNLOAD_TEXT]: "Descargar" },
    String(row.number),
  );

  if (!bytes || bytes.length === 0) {
    trace.step("descargar", `sin archivo — la Asamblea no lo publica (${lastRequestMs}ms)`);
    return null;
  }

  const name = filename ?? `${row.number}.docx`;
  // The magic number is reported next to the size because the failure this
  // catches is a download that "worked": a few hundred bytes of HTML, which
  // only looks wrong once you notice it does not start with PK.
  const magic = Array.from(bytes.slice(0, 2))
    .map((b) => String.fromCharCode(b))
    .join("");

  trace.step(
    "descargar",
    `${name} → ${humanBytes(bytes.length)}, firma "${magic}"` +
      `${magic === "PK" ? " (zip/docx)" : " ⚠ no es un .docx"} (${lastRequestMs}ms)`,
  );

  return { bytes, filename: name };
}

/**
 * The whole conversation for one law, in a fresh session.
 *
 * Sessions are not shared between laws on purpose: the view state carries the
 * selected row, so reusing one would risk downloading the previous law's text
 * under this law's number.
 */
export async function fetchLaw(
  number: number,
): Promise<{ detail: LawDetail; document: LawDocument | null } | null> {
  const session = await openSession();
  const row = await searchLaw(session, number);
  if (!row) return null;
  const detail = await selectLaw(session, row);
  const document = await downloadLawText(session, row);
  return { detail, document };
}

/** Confirms a law number exists, without reading its detail or text. */
export async function lawExists(number: number): Promise<LawRow | null> {
  return await searchLaw(await openSession(), number);
}

/**
 * Finds the newest law number by walking upward from a known one.
 *
 * The Asamblea publishes laws in an unbroken sequence, so the top is the first
 * number that does not answer. A few misses in a row are required before
 * stopping, because a number can be reserved slightly before its record
 * appears, and giving up on the first gap would freeze the catalogue.
 */
export async function findCeiling(from: number, tolerance = 3): Promise<number> {
  let highest = from;
  let misses = 0;
  let candidate = from + 1;

  while (misses < tolerance && candidate < from + config.lawCeilingScanLimit) {
    if (await lawExists(candidate)) {
      highest = candidate;
      misses = 0;
    } else {
      misses++;
    }
    candidate++;
  }

  return highest;
}
