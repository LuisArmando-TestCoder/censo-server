// ── Running the catalogue from a machine that can reach the Asamblea ─────────
// The SIL only answers Costa Rican networks, so the crawl cannot run from the
// hosted server. This drives the same sweep from a laptop inside the country
// and writes to the same Firestore, which means the catalogue can be built now
// and the deployment question settled later.
//
// Nothing here is a second implementation. It calls sweepLaws, the identical
// function the hourly tick calls; the only thing this adds is a loop, a clock
// and a way to stop. Anything else would be a fork that drifts.
//
// Resuming is not this script's doing either — the cursor lives in Firestore,
// written after every batch. Closing the lid, losing wifi, or pressing Ctrl-C
// costs at most the batch in flight. Run it again tomorrow and it continues
// from the number it reached, on this machine or any other.
//
//   deno task crawl                 catalogue until the history is complete
//   deno task crawl --summaries     also write explanations (needs the browser)
//   deno task crawl --once          a single pass, then stop

const once = Deno.args.includes("--once");
const withSummaries = Deno.args.includes("--summaries");

// Summarising drives a signed-in browser. Cataloguing is pure HTTP and always
// safe to run. Keeping them separable matters because the browser half is the
// fragile half, and a model outage should not stop the catalogue from growing.
//
// This has to happen before config.ts is evaluated, because config reads the
// environment once at import and never looks again. Static imports are hoisted
// above statements, so the modules below are pulled in dynamically — otherwise
// this assignment would run after the value it is trying to set was already read.
if (!withSummaries) Deno.env.set("LAW_SUMMARY_BATCH", "0");

const { config } = await import("../src/config.ts");
const { sweepLaws } = await import("../src/scrape/lawSweep.ts");
const { countLawsByStatus, getCrawlState } = await import("../src/db/laws.ts");

/** Total laws held, across every status. */
async function countLaws(): Promise<number> {
  const byStatus = await countLawsByStatus();
  return Object.values(byStatus).reduce((n, c) => n + c, 0);
}

/** Pretty elapsed time, for a run that is expected to last hours. */
function human(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Ctrl-C sets a flag rather than killing the process, so the batch in flight
// finishes and writes its cursor. Killing mid-batch would not corrupt anything
// — the cursor simply would not advance — but finishing cleanly means the work
// already paid for is not repeated on the next run.
let stopping = false;
Deno.addSignalListener("SIGINT", () => {
  if (stopping) {
    console.log("\nSaliendo de inmediato.");
    Deno.exit(130);
  }
  stopping = true;
  console.log("\nTerminando el lote actual antes de parar… (Ctrl-C otra vez para forzar)");
});

const startedAt = Date.now();
const before = await getCrawlState();
const heldBefore = await countLaws();

console.log(`
El Censo — catálogo de leyes
  Firestore     ${config.firestoreDatabase}
  Techo         ${before.ceiling}
  Reanudando en ${before.nextNumber}${before.complete ? " (historia completa)" : ""}
  Leyes         ${heldBefore}
  Resúmenes     ${withSummaries ? `sí, ${config.lawSummaryBatch} por lote` : "no (solo catálogo)"}
  Última vez    ${before.lastRunAt ?? "nunca"}${
  before.lastError ? `\n  Último error  ${before.lastError}` : ""
}
`);

let passes = 0;
let catalogued = 0;
let summarised = 0;
let failures = 0;

while (!stopping) {
  passes++;
  const report = await sweepLaws();

  catalogued += report.catalogued;
  summarised += report.summarised;
  failures += report.failed;

  const done = before.nextNumber - report.nextNumber;
  const rate = done > 0 ? (Date.now() - startedAt) / done : 0;
  const remaining = rate > 0 ? human(rate * report.nextNumber) : "desconocido";

  console.log(
    `— lote ${passes}: +${report.catalogued} catalogadas, ${report.summarised} explicadas, ` +
      `${report.missing} inexistentes` +
      (report.complete
        ? " — historia completa"
        : `, va en ${report.nextNumber}, faltan ~${report.nextNumber} (≈${remaining})`),
  );

  if (report.complete) {
    console.log("\nLa historia quedó completa. A partir de ahora solo hacen falta leyes nuevas.");
    break;
  }

  if (once) break;

  // A pass that catalogued nothing and found nothing missing did no work at
  // all: every number in the batch was already held. That is normal while
  // stepping over a stretch we have, but if it keeps happening the run is
  // spinning, and it is better to say so than to look busy.
  if (report.catalogued === 0 && report.missing === 0 && report.summarised === 0) {
    console.log("  (nada nuevo en este lote; el cursor sigue bajando)");
  }
}

const after = await getCrawlState();
const heldAfter = await countLaws();

console.log(`
Resumen de la sesión
  Duración      ${human(Date.now() - startedAt)}
  Lotes         ${passes}
  Catalogadas   +${catalogued}
  Explicadas    +${summarised}
  Fallidas      ${failures}
  Leyes totales ${heldBefore} → ${heldAfter}
  Cursor        ${before.nextNumber} → ${after.nextNumber}${after.complete ? " (completa)" : ""}

El avance queda guardado en Firestore. Volver a correr este comando continúa
desde ${after.nextNumber}.
`);
