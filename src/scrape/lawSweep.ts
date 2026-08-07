// ── Building and keeping the law catalogue ───────────────────────────────────
// Three jobs, deliberately kept apart so a slow or failing one cannot block the
// others:
//
//   watchTop      looks just above the newest law we know of, to catch what was
//                 published since. A handful of requests, run every tick.
//   descend       walks the numbers downward, one batch at a time, until it
//                 reaches 1. This is the historical seed. It sets a flag when
//                 it finishes and then never runs again.
//   fillSummaries takes the laws that have a number and a title but no
//                 explanation, reads their text and writes one.
//
// The split matters because cataloguing is three cheap HTTP requests while
// summarising drives the model through a browser session. Tying them together
// would mean a slow summary stalls the discovery of new laws, and a model
// outage would leave the catalogue frozen instead of merely unexplained.
//
// Every number is asked about once. A law already in Firestore is skipped
// before any request is made, and a law whose text the Asamblea does not have
// is marked no_text, which is terminal. Between them, nothing loops.

import { config } from "../config.ts";
import {
  catalogueLaw,
  getCrawlState,
  getLaw,
  lawIsKnown,
  listLawsAwaitingSummary,
  updateCrawlState,
  updateLaw,
} from "../db/laws.ts";
import {
  fetchLaw,
  findCeiling,
  type LawDetail,
  lawExists,
  PUBLIC_CONSULTA_URL,
} from "./consultaLey.ts";
import { docxToText, lawTextToMarkdown, looksLikeDocx } from "../lib/docx.ts";
import { explainLaw, lawSummaryIssues } from "../intelligence/lawAgent.ts";
import { BudgetExhausted } from "../lib/budget.ts";
import { bytes as humanBytes, sweepLog, Trace } from "../lib/trace.ts";
import type { Law } from "../types.ts";

/** A courtesy pause, so a batch does not arrive as a burst. */
function breathe(): Promise<void> {
  return new Promise((r) => setTimeout(r, config.lawRequestDelayMs));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything the detail panels say, mapped onto the stored shape. */
function detailPatch(detail: LawDetail): Partial<Law> {
  return {
    officialTitle: detail.title,
    inForce: detail.inForce,
    publishedAt: detail.publishedAt,
    gacetaNumber: detail.gacetaNumber,
    alcanceNumber: detail.alcanceNumber,
    emittedAt: detail.emittedAt,
    sanctionedAt: detail.sanctionedAt,
    effectiveAt: detail.effectiveAt,
    expedienteNumber: detail.expedienteNumber,
    expedienteSubject: detail.expedienteSubject,
    procedureType: detail.procedureType,
    affectations: detail.affectations,
  };
}

export interface LawSweepReport {
  /** Numbers newly added to the catalogue. */
  catalogued: number;
  /** Laws that gained an explanation. */
  summarised: number;
  /** Laws the Asamblea has no text for. */
  withoutText: number;
  /** Numbers asked about that turned out not to exist. */
  missing: number;
  failed: number;
  /** Where the historical descent has reached. */
  nextNumber: number;
  complete: boolean;
}

// ── Watching the top ─────────────────────────────────────────────────────────

/**
 * Catches laws published since the last run.
 *
 * Rather than reading the Asamblea's paginated list, this asks about the
 * numbers just above the highest one we hold. Laws are numbered in an unbroken
 * sequence, so "what is new" and "what comes after the last one" are the same
 * question, and asking it by number costs one request per candidate instead of
 * parsing a page of ten rows to find the one that changed.
 */
export async function watchTop(): Promise<{ catalogued: number; ceiling: number }> {
  const state = await getCrawlState();
  const ceiling = await findCeiling(state.ceiling);

  // The ceiling moving is the single most meaningful event in the whole system:
  // it means the Republic has a new law. It gets its own line even when nothing
  // else happens this tick.
  sweepLog(
    ceiling > state.ceiling
      ? `techo ${state.ceiling} → ${ceiling}: ${ceiling - state.ceiling} ley(es) nueva(s)`
      : `techo sin cambios en ${ceiling}`,
  );

  let catalogued = 0;

  for (let n = state.ceiling + 1; n <= ceiling; n++) {
    if (await lawIsKnown(n)) continue;
    const row = await lawExists(n);
    await breathe();
    if (!row) continue;
    if (
      await catalogueLaw({
        number: row.number,
        officialTitle: row.title,
        sourceUrl: PUBLIC_CONSULTA_URL,
      })
    ) catalogued++;
  }

  if (ceiling !== state.ceiling) await updateCrawlState({ ceiling });
  return { catalogued, ceiling };
}

// ── The historical descent ───────────────────────────────────────────────────

/**
 * Walks one batch of numbers downward.
 *
 * The position is stored after every batch, so an interrupted run resumes where
 * it stopped rather than starting over. Numbers already held are stepped over
 * without a request, which is what makes re-running this cheap and safe.
 */
export async function descend(): Promise<
  { catalogued: number; missing: number; state: { nextNumber: number; complete: boolean } }
> {
  const state = await getCrawlState();
  if (state.complete) {
    return { catalogued: 0, missing: 0, state: { nextNumber: state.nextNumber, complete: true } };
  }

  let n = Math.min(state.nextNumber, state.ceiling);
  let catalogued = 0;
  let missing = 0;
  let asked = 0;

  while (n >= 1 && asked < config.lawSeedBatch) {
    if (await lawIsKnown(n)) {
      n--;
      continue;
    }

    asked++;
    try {
      const row = await lawExists(n);
      await breathe();
      if (!row) {
        missing++;
      } else if (
        await catalogueLaw({
          number: row.number,
          officialTitle: row.title,
          sourceUrl: PUBLIC_CONSULTA_URL,
        })
      ) {
        catalogued++;
      }
    } catch (err) {
      // Leave the cursor on this number so the next tick retries it, and stop
      // the batch: one failure here usually means the site is unreachable, and
      // hammering it with the rest of the batch would not help.
      await updateCrawlState({
        nextNumber: n,
        lastError: errorText(err),
        lastRunAt: new Date().toISOString(),
      });
      return { catalogued, missing, state: { nextNumber: n, complete: false } };
    }
    n--;
  }

  const complete = n < 1;
  await updateCrawlState({
    nextNumber: complete ? 1 : n,
    complete,
    lastError: null,
    lastRunAt: new Date().toISOString(),
  });

  return { catalogued, missing, state: { nextNumber: complete ? 1 : n, complete } };
}

// ── Reading and explaining one law ───────────────────────────────────────────

/**
 * Fetches a law's text and writes its explanation.
 *
 * Returns what happened so the caller can count it. A law with no downloadable
 * text becomes no_text and is never asked about again; a law that breaks
 * becomes failed, which is retried.
 */
export async function summariseLaw(
  number: number,
): Promise<"ready" | "no_text" | "failed" | "missing"> {
  const id = String(number);
  const trace = new Trace(number);
  try {
    const found = await fetchLaw(number);
    if (!found) {
      await updateLaw(id, {
        status: "no_text",
        lastError: "la ley no existe en el SIL",
        textCheckedAt: new Date().toISOString(),
      });
      trace.done("missing", "no existe en el SIL");
      return "missing";
    }

    const { detail, document } = found;
    const checkedAt = new Date().toISOString();

    // Store the official record first. It is worth having even when the text is
    // missing, and it means a later model failure does not cost the fetch.
    await updateLaw(id, { ...detailPatch(detail), textCheckedAt: checkedAt });
    trace.step(
      "guardar.detalle",
      `${Object.keys(detailPatch(detail)).length} campo(s) → Firestore`,
    );

    if (!document || !looksLikeDocx(document.bytes)) {
      await updateLaw(id, {
        status: "no_text",
        lastError: "la Asamblea no publica el texto de esta ley",
      });
      trace.done("no_text", document ? "el archivo no es un .docx" : "sin archivo");
      return "no_text";
    }

    // The two conversions the reader ultimately sees. Their sizes are logged as
    // a ratio because that is what exposes a bad extraction: a 365 KB Word file
    // that yields 200 characters parsed as a document rather than failing as one.
    const text = await docxToText(document.bytes);
    trace.step(
      "docx→texto",
      `${humanBytes(document.bytes.length)} → ${text.length} caracteres, ` +
        `${text.split("\n").length} línea(s)`,
    );
    trace.detail("docx→texto", () => ({ inicio: text.slice(0, 300) }));

    if (text.trim().length < 200) {
      await updateLaw(id, { status: "no_text", lastError: "el documento vino vacío" });
      trace.done("no_text", `sólo ${text.trim().length} caracteres`);
      return "no_text";
    }

    const markdown = lawTextToMarkdown(text);
    trace.step(
      "texto→markdown",
      `${text.length} → ${markdown.length} caracteres, ` +
        `${(markdown.match(/^#{2,3} /gm) ?? []).length} encabezado(s)`,
    );

    // The model is the one stage whose output nobody can check by looking at a
    // size. What it returned is therefore summarised field by field, and shown
    // in full when verbose, because this is the text that will be published in
    // our name over a law we did not write.
    const summary = await explainLaw(detail, text);
    const issues = lawSummaryIssues(summary, detail);

    trace.step(
      "agente",
      `titular ${summary.headline?.length ?? 0}c, resumen ${summary.summary?.length ?? 0}c, ` +
        `explicación ${summary.explanation?.length ?? 0}c, ` +
        `${summary.flags?.length ?? 0} hallazgo(s)` +
        (issues.length ? ` ⚠ ${issues.length} objeción(es) de validación` : ""),
    );
    trace.detail("agente", () => ({
      titular: summary.headline,
      resumen: summary.summary,
      afecta: summary.affects,
      beneficia: summary.benefits,
      implicaciones: summary.implications,
      hallazgos: (summary.flags ?? []).map((f) => `[${f.severity}] ${f.title}`),
      objeciones: issues,
    }));

    await updateLaw(id, {
      headline: summary.headline || detail.title,
      summary: summary.summary,
      explanation: summary.explanation,
      affects: summary.affects,
      benefits: summary.benefits,
      implications: summary.implications,
      // Already checked against the law's own text by the agent: anything left
      // here quotes a clause that really exists.
      flags: summary.flags,

      originalMarkdown: markdown,
      documentName: document.filename,
      status: "ready",
      lastError: issues.length ? issues.join("; ") : null,
    });

    trace.done("ready", `"${(summary.headline || detail.title).slice(0, 60)}"`);
    return "ready";
  } catch (err) {
    // A law we ran out of budget for has nothing wrong with it, and marking it
    // failed would be a lie that outlives the day: the queue reads that status,
    // so one exhausted afternoon would push good laws to the back of the line
    // for good. It is left exactly as it was and rethrown, to stop the batch.
    if (err instanceof BudgetExhausted) {
      trace.done("pausado", err.message);
      throw err;
    }

    await updateLaw(id, { status: "failed", lastError: errorText(err) });
    trace.failed("resumir", err);
    return "failed";
  }
}

/**
 * Explains a law on demand, for a reader who opened one that was only
 * catalogued. Returns the finished law, or null when there is nothing to show.
 */
export async function summariseOnDemand(number: number): Promise<Law | null> {
  const existing = await getLaw(String(number));
  if (!existing) return null;
  if (existing.status === "ready" || existing.status === "no_text") return existing;

  // A reader is waiting, so running out of budget must not become a 503 on a
  // law we already hold. They get the catalogued record — number, title, dates,
  // and the link to the Asamblea — which is less than we would like to show and
  // considerably more than an error page.
  try {
    await summariseLaw(number);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    sweepLog(`explicación en vivo de ${number} pospuesta: ${err.message}`);
    return existing;
  }

  return await getLaw(String(number));
}

/** Works through the queue of catalogued-but-unexplained laws. */
export async function fillSummaries(): Promise<
  { summarised: number; withoutText: number; failed: number }
> {
  const queue = await listLawsAwaitingSummary(config.lawSummaryFloor, config.lawSummaryBatch);
  if (queue.length) {
    sweepLog(`por explicar: ${queue.map((l) => l.number).join(", ")}`);
  }

  let summarised = 0;

  let withoutText = 0;
  let failed = 0;

  // Sequential: the model is driven through a single browser session, so
  // running these in parallel would only make them queue somewhere less visible.
  for (const law of queue) {
    const outcome = await summariseLaw(law.number);
    if (outcome === "ready") summarised++;
    else if (outcome === "no_text" || outcome === "missing") withoutText++;
    else failed++;
    await breathe();
  }

  return { summarised, withoutText, failed };
}

// ── The tick ─────────────────────────────────────────────────────────────────

/**
 * Runs one phase, turning a failure into a logged miss.
 *
 * The three phases are independent pieces of work, and the Asamblea's server is
 * intermittently slow enough that any one of them can still fail after its
 * retries. Letting that end the tick would mean an unlucky minute costs the
 * whole hour, and — because the descent saves its position only at the end of a
 * batch — could keep the catalogue from ever moving past a bad patch.
 */
async function phase<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    sweepLog(`${name} ok en ${Math.round(performance.now() - startedAt)}ms`);
    return result;
  } catch (err) {
    // Running out of the day's allowance is not a failure of this phase, it is
    // the limiter doing its job, so it is reported as a stop rather than as an
    // error. Logging it as a fault would train whoever reads these logs to
    // ignore the line that actually means something is broken.
    if (err instanceof BudgetExhausted) {
      sweepLog(`${name} se detuvo: ${err.message}`);
      return fallback;
    }

    // Timed even when it fails: how long a phase ran before giving up separates
    // "the site refused us immediately" from "it hung until the timeout".
    console.error(
      `[laws] ${name} falló tras ${Math.round(performance.now() - startedAt)}ms:`,
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}

/**
 * One pass of everything, in the order that keeps the site freshest: new laws
 * first, then explanations for what is already known, then a slice of history.
 *
 * Each phase is isolated, so a tick reports what it managed rather than
 * throwing away the work that succeeded before something went wrong.
 */
export async function sweepLaws(): Promise<LawSweepReport> {
  const top = await phase("watchTop", watchTop, { catalogued: 0, ceiling: 0 });
  const filled = await phase("fillSummaries", fillSummaries, {
    summarised: 0,
    withoutText: 0,
    failed: 0,
  });
  const walked = await phase("descend", descend, {
    catalogued: 0,
    missing: 0,
    state: { nextNumber: 0, complete: false },
  });

  return {
    catalogued: top.catalogued + walked.catalogued,
    summarised: filled.summarised,
    withoutText: filled.withoutText,
    missing: walked.missing,
    failed: filled.failed,
    nextNumber: walked.state.nextNumber,
    complete: walked.state.complete,
  };
}
