// ── Watching the pipeline work ───────────────────────────────────────────────
// A law goes through six shapes on its way from the Asamblea to the site:
//
//   HTTP response → grid row → detail panels → .docx bytes → text → Markdown
//                                                                 → summary
//
// Every one of those is a place where the result can be wrong without anything
// throwing: a date that silently parses to null, a download that returns the
// login page, a model that answers about the wrong law. Reading the database
// afterwards tells you the value is wrong but not which step bent it, and the
// scraper runs on a server where nobody can attach a debugger.
//
// So each transformation announces itself, at one of two volumes:
//
//   normal   one line per law, the shape of the value only — a count, a size,
//            a status. Enough to see the pipeline moving and to spot a stage
//            that returns nothing, cheap enough to leave on in production.
//
//   verbose  the values themselves: what a date said before and after parsing,
//            the first characters of the extracted text, every field the model
//            filled. Turned on when a specific law came out wrong and the
//            question is which step did it.
//
// The distinction is deliberate. Logging every value always would bury the one
// line that matters under a law's worth of text, and a log nobody can read is
// the same as no log. Logging nothing is how a silent corruption survives.

import { config } from "../config.ts";

export type TraceLevel = "quiet" | "normal" | "verbose";

const RANK: Record<TraceLevel, number> = { quiet: 0, normal: 1, verbose: 2 };

function enabled(level: TraceLevel): boolean {
  return RANK[config.lawLogLevel as TraceLevel] >= RANK[level];
}

/** Shortens a value to one line, so a 4,000-character law cannot flood the log. */
export function clip(value: unknown, max = 120): string {
  if (value === null) return "∅";
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(vacío)";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Human byte sizes, because "373452" is harder to sanity-check than "365 KB". */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One stage of the pipeline, for one law.
 *
 * The prefix carries the law number on every line so that concurrent or
 * interleaved runs stay readable, and so a single grep pulls the complete
 * history of one law out of a day of logs.
 */
export class Trace {
  private readonly label: string;
  private readonly startedAt = performance.now();

  constructor(subject: string | number) {
    this.label = `[laws ${subject}]`;
  }

  /** Milliseconds since this trace began. */
  private elapsed(): string {
    return `${Math.round(performance.now() - this.startedAt)}ms`;
  }

  /**
   * A completed transformation, in the economical form: what came in, what came
   * out, and how big the result is. No values.
   */
  step(stage: string, summary: string): void {
    if (!enabled("normal")) return;
    console.log(`${this.label} ${stage}: ${summary}`);
  }

  /**
   * The values themselves. Silent unless the log level is verbose.
   *
   * Takes a thunk rather than a string so that formatting a law's full text
   * costs nothing when the level is normal, which is almost always.
   */
  detail(stage: string, build: () => Record<string, unknown>): void {
    if (!enabled("verbose")) return;
    for (const [key, value] of Object.entries(build())) {
      console.log(`${this.label}   ${stage}.${key} = ${clip(value, 300)}`);
    }
  }

  /**
   * A value that changed shape, shown as before → after.
   *
   * This is the form that catches the failures that do not throw: a date the
   * SIL prints one way and we store another, a title that loses its accents in
   * transit. Seeing both sides on one line is what makes a bad conversion
   * obvious instead of plausible.
   */
  transform(stage: string, from: unknown, to: unknown): void {
    if (!enabled("verbose")) return;
    console.log(`${this.label}   ${stage}: ${clip(from, 90)} → ${clip(to, 90)}`);
  }

  /** The end of a law's journey, with the total time it took. */
  done(outcome: string, summary = ""): void {
    if (!enabled("normal")) return;
    console.log(
      `${this.label} ✔ ${outcome} en ${this.elapsed()}${summary ? ` — ${summary}` : ""}`,
    );
  }

  /** A failure, always logged: a level meant to reduce noise must not hide these. */
  failed(stage: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${this.label} ✖ ${stage} falló tras ${this.elapsed()}: ${message}`);
  }
}

/** A line that belongs to the sweep as a whole rather than to one law. */
export function sweepLog(message: string): void {
  if (RANK[config.lawLogLevel as TraceLevel] >= RANK.normal) console.log(`[laws] ${message}`);
}
