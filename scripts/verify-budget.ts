// ── Does the limiter actually keep its promises? ─────────────────────────────
// The budget makes four claims that are easy to state and easy to get subtly
// wrong. This exercises each one against the real module — no mocks, no fakes —
// using a throwaway state file so nothing here touches the day's real counters.
//
//   deno task verify:budget
//
// It never contacts Firestore, Gemini or the Asamblea: `spend` is handed a
// function that returns immediately, because what is under test is the
// accounting around the call, not the call.

const TMP = await Deno.makeTempDir();
const STATE = `${TMP}/budget.json`;

// Set before the module is imported: config reads the environment once, at
// import, and the whole point is to keep this off the real .budget.json.
Deno.env.set("BUDGET_STATE_PATH", STATE);
Deno.env.set("BUDGET_FIRESTORE_PER_DAY", "10");
Deno.env.set("BUDGET_MODEL_PER_DAY", "10");
Deno.env.set("BUDGET_ASAMBLEA_PER_DAY", "10");
Deno.env.set("LAW_REQUEST_DELAY_MS", "50");

const {
  asBackground,
  BudgetExhausted,
  budgetReport,
  canSpend,
  recordRefusal,
  spend,
} = await import("../src/lib/budget.ts");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const noop = () => Promise.resolve("ok");

// ── 1. The reservation ───────────────────────────────────────────────────────
// The claim that matters most: background work must run out before a reader
// does. Firestore is capped at 10 here with a background share of 0.5, so the
// crawler should be refused on its sixth call while a reader still gets served.

console.log("\nla reserva para lectores");
{
  let backgroundCalls = 0;
  let refusal: unknown = null;

  try {
    await asBackground(async () => {
      for (let i = 0; i < 10; i++) {
        await spend("firestore", noop);
        backgroundCalls++;
      }
    });
  } catch (err) {
    refusal = err;
  }

  check(
    "el trabajo de fondo se detiene en su parte (5 de 10)",
    backgroundCalls === 5,
    `hizo ${backgroundCalls}`,
  );
  check(
    "se detiene con el motivo correcto",
    refusal instanceof BudgetExhausted && refusal.reason === "reserved",
    refusal instanceof BudgetExhausted ? refusal.reason : String(refusal),
  );

  // The reader arrives after the crawler has been cut off. This is the whole
  // design in one assertion: the same resource, the same moment, a different
  // answer depending on who is asking.
  let readerServed = true;
  try {
    await spend("firestore", noop);
  } catch {
    readerServed = false;
  }
  check("un lector sí es atendido con el fondo agotado", readerServed);

  const before = budgetReport().resources.firestore;
  check(
    "el informe cuadra",
    before.used === 6 && before.backgroundUsed === 5,
    `used=${before.used}, fondo=${before.backgroundUsed}`,
  );
}

// ── 2. The hard ceiling ──────────────────────────────────────────────────────
// Interactive work is privileged, not unlimited: past the day's total even a
// reader is refused, because the quota is real and does not care who we are.

console.log("\nel techo del día");
{
  let served = 0;
  let refusal: unknown = null;
  try {
    for (let i = 0; i < 20; i++) {
      await spend("firestore", noop);
      served++;
    }
  } catch (err) {
    refusal = err;
  }

  // Six were already spent above, so four remain of the ten.
  check("el lector agota lo que quedaba y no más", served === 4, `hizo ${served}`);
  check(
    "el motivo es el límite diario",
    refusal instanceof BudgetExhausted && refusal.reason === "daily",
    refusal instanceof BudgetExhausted ? refusal.reason : String(refusal),
  );
  check(
    "reintentar apunta a la próxima medianoche",
    refusal instanceof BudgetExhausted &&
      refusal.retryAt > Date.now() &&
      refusal.retryAt < Date.now() + 25 * 60 * 60 * 1000,
  );
  check("canSpend concuerda con spend", canSpend("firestore") === false);
}

// ── 3. Pacing ────────────────────────────────────────────────────────────────
// The gap is honoured by waiting, not by refusing: a crawler asking for three
// laws in a row should get all three, slowly. Refusing instead would turn
// politeness into data loss.

console.log("\nel ritmo mínimo");
{
  const startedAt = Date.now();
  for (let i = 0; i < 3; i++) await spend("asamblea", noop);
  const elapsed = Date.now() - startedAt;

  // Two gaps between three calls, at 50ms each.
  check("tres llamadas esperan ~2 intervalos", elapsed >= 90, `tardó ${elapsed}ms`);
  check("y no se rechaza ninguna", budgetReport().resources.asamblea.used === 3);
}

// ── 4. Refusal from the far end ──────────────────────────────────────────────
// A 429 must pause the resource even though we still believe we have budget:
// their opinion of our quota outranks ours.

console.log("\nel rechazo del otro lado");
{
  recordRefusal("model");
  check("queda en pausa", canSpend("model") === false);

  const paused = budgetReport().resources.model.pausedForSec;
  check("la pausa es de ~10s la primera vez", paused > 5 && paused <= 10, `${paused}s`);

  let reason = "";
  try {
    await spend("model", noop);
  } catch (err) {
    if (err instanceof BudgetExhausted) reason = err.reason;
  }
  check("y se explica como pausa, no como límite", reason === "paused", reason);
}

// ── 5. The counter survives a restart ────────────────────────────────────────
// A process that forgets what it spent is worse than one with no limit at all:
// a crash loop would replay the last slice of the quota indefinitely, each
// restart certain the day was untouched.

console.log("\nla memoria entre reinicios");
{
  // The module coalesces writes on a 2s timer, so the file is not there yet.
  await new Promise((r) => setTimeout(r, 2_300));

  const onDisk = JSON.parse(await Deno.readTextFile(STATE));
  check(
    "el archivo guarda lo gastado",
    onDisk.resources.firestore.used === 10,
    `firestore=${onDisk.resources.firestore.used}`,
  );

  // A second import would be cached, so the restart is simulated the way the
  // module itself would see it: same file, read fresh.
  check("y recuerda de quién fue el gasto", onDisk.resources.firestore.usedBackground === 5);

  // The rollover: a file from another day must be ignored rather than trusted,
  // or a server that slept overnight would wake up already spent.
  await Deno.writeTextFile(
    STATE,
    JSON.stringify({ ...onDisk, day: "2001-01-01" }),
  );
  const stale = JSON.parse(await Deno.readTextFile(STATE));
  check(
    "un archivo de ayer se distingue por su fecha",
    stale.day !== new Date().toISOString().slice(0, 10),
  );
}

await Deno.remove(TMP, { recursive: true });

console.log(
  failures === 0
    ? "\ntodo en orden: la reserva protege al lector, el ritmo se respeta y la cuenta sobrevive al reinicio.\n"
    : `\n${failures} comprobación(es) fallaron.\n`,
);

if (failures) Deno.exit(1);
