/// <reference lib="deno.ns" />
// Runs the scrape-and-write pipeline once, from the terminal.
//
// The server runs this same work on a timer when PIPELINE_ENABLED is true. This
// script exists for the cases where a timer is the wrong tool: the first fill of
// an empty site, a rerun after fixing a prompt, or watching a single item go
// through when something looks wrong. Nothing here is a second implementation.
// It calls sweepAll() and runPipeline(), exactly as the server does.
//
// Sequential by design. The pipeline drives one headless Chrome session, so a
// second item in flight would fight the first for the same browser.
//
//   deno task pipeline           # sweep, then write up to 5 items
//   deno task pipeline 20        # same, up to 20 items
//   deno task pipeline --no-sweep
//
// Drafts land as `draft` or `needs_human`. Neither is visible to readers: a
// person still has to publish from /admin. That is a promise made in the
// privacy policy, so this script does not offer a flag to skip it.

import { sweepAll } from "../src/scrape/sweep.ts";
import { runPipeline } from "../src/intelligence/pipeline.ts";
import { listPendingRawItems } from "../src/db/rawItems.ts";

const args = Deno.args.filter((a) => a !== "--no-sweep");
const skipSweep = Deno.args.includes("--no-sweep");
const limit = Number(args[0] ?? 5);

if (!Number.isFinite(limit) || limit < 1) {
  console.error("El límite debe ser un número mayor que cero.");
  Deno.exit(1);
}

function elapsed(from: number): string {
  return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

const started = Date.now();

// ── Sweep ────────────────────────────────────────────────────────────────────

if (skipSweep) {
  console.log("\nSaltando el barrido. Solo se procesa lo que ya está en cola.\n");
} else {
  console.log("\nBuscando publicaciones nuevas en la Asamblea Legislativa\n");
  const reports = await sweepAll();
  for (const r of reports) {
    const line = `  ${r.sourceId}: ${r.created} nueva(s), ${r.changed} cambiada(s)`;
    console.log(r.error ? `${line} — ERROR: ${r.error}` : line);
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

const pending = await listPendingRawItems(limit);

if (pending.length === 0) {
  console.log("\nNo hay nada en cola. Todo lo encontrado ya se procesó.\n");
  Deno.exit(0);
}

console.log(`\nEscribiendo ${pending.length} nota(s), una por una\n`);

const tally: Record<string, number> = {};

for (const [i, item] of pending.entries()) {
  const at = Date.now();
  console.log(`  [${i + 1}/${pending.length}] ${item.title.slice(0, 68)}`);

  // One bad item must not end the run: the pipeline already records the failure
  // against the item, and the next one is probably fine.
  try {
    const result = await runPipeline(item);
    tally[result.verdict] = (tally[result.verdict] ?? 0) + 1;
    console.log(`          ${result.verdict} en ${elapsed(at)} — ${result.note}`);
  } catch (err) {
    tally.crashed = (tally.crashed ?? 0) + 1;
    console.log(`          se cayó en ${elapsed(at)} — ${err}`);
  }
}

// ── What happened ────────────────────────────────────────────────────────────

console.log(`\nListo en ${elapsed(started)}`);
for (const [verdict, n] of Object.entries(tally)) console.log(`  ${verdict}: ${n}`);

const written = (tally.published_draft ?? 0) + (tally.needs_human ?? 0);
if (written > 0) {
  console.log(
    `\n${written} borrador(es) esperando revisión en /admin. Nada se publica solo.\n`,
  );
} else {
  console.log("");
}
