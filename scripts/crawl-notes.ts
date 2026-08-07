// ── Running the notes pipeline from a machine that can reach the Asamblea ────
// The companion to crawl-laws.ts, for the other half of the site: the calendar
// and news lists on asamblea.go.cr and the daily Gaceta. Same reasons for
// existing — those hosts answer Costa Rican networks and the writing stage
// needs a signed-in browser, so neither can run on the hosted server.
//
// Like the law crawler, this is a loop around the functions the server already
// calls: sweepAll to file what is new, runPipeline to turn a filed item into a
// note somebody can read. It is not a second implementation of either.
//
// Resuming needs no cursor of its own. Each source remembers the last upstream
// id it saw, and every filed item carries a status, so the queue *is* the
// position: whatever was not written up is still pending next time.
//
//   deno task notes                 sweep, then write until the queue is empty
//   deno task notes --sweep-only    just collect; no browser, no model
//   deno task notes --once          one pass, then stop

const once = Deno.args.includes("--once");
const sweepOnly = Deno.args.includes("--sweep-only");

// How many items to write per pass. Small on purpose: each one is several model
// calls through a browser, and a smaller batch means Ctrl-C costs less.
const BATCH = 5;

const { sweepAll } = await import("../src/scrape/sweep.ts");
const { listPendingRawItems } = await import("../src/db/rawItems.ts");
const { runPipeline } = await import("../src/intelligence/pipeline.ts");
const { closeBrowser } = await import("../src/intelligence/scraperLLM.ts");

let stopping = false;
Deno.addSignalListener("SIGINT", () => {
  if (stopping) {
    console.log("\nSaliendo de inmediato.");
    Deno.exit(130);
  }
  stopping = true;
  console.log("\nTerminando lo que está en curso antes de parar… (Ctrl-C otra vez para forzar)");
});

function human(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const startedAt = Date.now();
console.log(`
El Censo — notas
  Modo    ${
  sweepOnly
    ? "solo recolectar (sin navegador ni modelo)"
    : `recolectar y escribir, ${BATCH} por vuelta`
}
`);

let published = 0;
let rejected = 0;
let failed = 0;
let collected = 0;

try {
  while (!stopping) {
    // Sweeping first so a long writing session still picks up anything that
    // appeared while it was working.
    for (const r of await sweepAll()) {
      collected += r.created + r.changed;
      const summary = `${r.created} nuevos, ${r.changed} cambiados, ${r.unchanged} sin cambio`;
      console.log(`  ${r.sourceId}: ${r.error ? `⚠ ${r.error}` : summary}`);
    }

    if (sweepOnly) {
      const waiting = (await listPendingRawItems(200)).length;
      console.log(`\nRecolectado. ${waiting} en cola, esperando a que alguien los escriba.`);
      break;
    }

    const queue = await listPendingRawItems(BATCH);
    if (queue.length === 0) {
      console.log("\nLa cola quedó vacía. No hay nada más que escribir por ahora.");
      break;
    }

    console.log(`\nEscribiendo ${queue.length} de la cola…`);
    for (const item of queue) {
      if (stopping) break;
      try {
        const result = await runPipeline(item);
        // The verdict matters more than the count: an item the pipeline
        // declined is a decision it made on purpose, not a failure, and the two
        // should never be added together.
        if (result.postId) {
          published++;
          console.log(`  ✔ ${item.title?.slice(0, 64) ?? item.id}`);
        } else {
          rejected++;
          console.log(`  – descartado (${result.verdict}): ${result.note.slice(0, 80)}`);
        }
      } catch (err) {
        failed++;
        console.error(`  ✗ ${item.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (once) break;

    // Rest for a few seconds before the next loop pass to protect against 429 rate limits
    if (!stopping) {
      console.log("  Pausando 5 segundos antes de la siguiente vuelta...");
      await sleep(5000);
    }
  }
} finally {
  // The browser is a real process; leaving it behind would hold the profile
  // directory and make the next run fail with a confusing lock error.
  await closeBrowser();
}

console.log(`
Resumen de la sesión
  Duración    ${human(Date.now() - startedAt)}
  Recolectado ${collected}
  Publicado   ${published}
  Descartado  ${rejected}
  Fallido     ${failed}

Los cursores de cada fuente y el estado de cada elemento quedan en Firestore.
Volver a correr este comando sigue donde quedó.
`);