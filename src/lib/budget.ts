// ── Spending limits ──────────────────────────────────────────────────────────
// Three things this server uses are metered, and all three run out:
//
//   firestore  50,000 document reads a day on the free tier. Past that every
//              query returns 429 and the site shows nothing at all.
//   model      a Gemini session with a few dollars behind it.
//   asamblea   not metered in money, but it is a public institution's server
//              and we are a guest on it.
//
// When one runs out the failure is total and lasts until midnight, which is the
// worst shape a limit can have: everything works, and then nothing does, for
// hours, with no warning in between. This file exists to turn that cliff into a
// slope.
//
// ── The reservation ──
// The insight that shapes everything here is that not all spending is equal. A
// reader opening a law is why the site exists; the crawler cataloguing law 4,312
// can happen tomorrow just as well as today. Yet the crawler is an eager loop
// and the reader is one request, so left alone the crawler will spend the whole
// day's quota by lunchtime and the reader will meet an error.
//
// So background work is cut off at a fraction of the budget and interactive
// work keeps the rest. The crawler slows down and eventually stops for the day;
// the person reading never notices. That ordering is the entire point, and it
// is why `spend` needs to know who is asking.
//
// ── Why the counter is on disk ──
// The quota is Google's and it resets at midnight Pacific; ours is a memory of
// what we already took from it. A process restart does not give the quota back,
// so a counter that reset on restart would be worse than none — a crash loop at
// 90% consumed would spend the remaining 10% over and over, each restart
// convinced the day was fresh. The file is the only thing that makes the number
// mean anything.

import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.ts";

/** The three metered things. Named as resources, not as vendors. */
export type Resource = "firestore" | "model" | "asamblea";

/**
 * Who is spending.
 *
 * `interactive` is a person waiting for a response. `background` is a timer
 * that could equally run in an hour. The distinction decides who gets turned
 * away first when the day runs short, and nothing else in this file matters
 * more.
 */
export type Priority = "interactive" | "background";

export interface ResourceLimits {
  /** Hard ceiling for a calendar day, across both priorities. */
  perDay: number;
  /** Smallest gap between two calls, so a loop cannot arrive as a burst. */
  minGapMs: number;
  /**
   * The share of the day background work may consume, 0–1.
   *
   * The remainder is held for readers. Set to 1 for a resource only the crawler
   * touches, where holding anything back would mean holding it for nobody.
   */
  backgroundShare: number;
}

const LIMITS: Record<Resource, ResourceLimits> = {
  // Well under the 50,000 free reads so that a miscount, a retry storm, or a
  // page that reads more than we think still lands inside the free tier. The
  // gap is small because a single page view is already several reads and
  // spacing them would be felt.
  firestore: {
    perDay: config.budgetFirestorePerDay,
    minGapMs: 0,
    backgroundShare: 0.5,
  },
  // Counted in calls rather than tokens because a call is what we can observe
  // from here. One law is one call, so this number is "laws explained today".
  model: {
    perDay: config.budgetModelPerDay,
    minGapMs: 1_000,
    backgroundShare: 0.9,
  },
  // A courtesy limit. The Asamblea is not charging us; we simply have no right
  // to be a load on it, and the crawler is the only thing that goes there.
  asamblea: {
    perDay: config.budgetAsambleaPerDay,
    minGapMs: config.lawRequestDelayMs,
    backgroundShare: 1,
  },
};

// ── What is remembered ───────────────────────────────────────────────────────

interface ResourceState {
  /** Calls made today, both priorities together. */
  used: number;
  /** Calls made today by background work alone, against its smaller share. */
  usedBackground: number;
  /** Consecutive refusals from the far end. Drives the backoff. */
  strikes: number;
  /** No call before this time. Set when the far end says it has had enough. */
  pausedUntil: number;
  /** When the last call actually went out, for the minimum gap. */
  lastCallAt: number;
}

interface BudgetState {
  /** The day these counters belong to, in Costa Rica. */
  day: string;
  resources: Record<Resource, ResourceState>;
}

function emptyResource(): ResourceState {
  return { used: 0, usedBackground: 0, strikes: 0, pausedUntil: 0, lastCallAt: 0 };
}

function emptyState(day: string): BudgetState {
  return {
    day,
    resources: {
      firestore: emptyResource(),
      model: emptyResource(),
      asamblea: emptyResource(),
    },
  };
}

/**
 * Today's date in Costa Rica.
 *
 * Fixed offset rather than a timezone database because Costa Rica has not
 * observed daylight saving since 1992 and has no plans to. The day must be
 * local: a reset at UTC midnight would land at six in the evening here, in the
 * middle of the busiest hours, and hand the crawler a fresh budget exactly when
 * readers need it most.
 */
const CR_OFFSET_MS = 6 * 60 * 60 * 1000;

function today(): string {
  return new Date(Date.now() - CR_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Persistence ──────────────────────────────────────────────────────────────

let state: BudgetState = emptyState(today());
let loaded = false;

/** Writes are coalesced: the counter moves on every call and the disk need not. */
let saveTimer: number | null = null;

function save(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      Deno.writeTextFileSync(config.budgetStatePath, JSON.stringify(state, null, 2));
    } catch (err) {
      // A budget that cannot be written is still a budget that works for as
      // long as this process lives. Worth a line, not worth failing a request.
      console.warn("[budget] could not save state:", err instanceof Error ? err.message : err);
    }
  }, 2_000);
}

/**
 * Reads yesterday's file, or starts fresh.
 *
 * Called once, lazily, so that importing this module has no side effect and a
 * test can point the path somewhere harmless before the first spend.
 */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(config.budgetStatePath)) as BudgetState;
    // A file from another day is history, not state. Reading its counters would
    // start the morning already spent.
    if (parsed?.day === today() && parsed.resources) {
      state = { day: parsed.day, resources: { ...emptyState(parsed.day).resources } };
      for (const key of Object.keys(state.resources) as Resource[]) {
        if (parsed.resources[key]) {
          state.resources[key] = { ...emptyResource(), ...parsed.resources[key] };
        }
      }
    }
  } catch {
    // No file on the first run, and an unreadable one is not worth a crash: the
    // safe failure is to assume nothing has been spent, which at worst repeats
    // one day's allowance once.
  }
}

/** Turns the page at local midnight. Called on the way into every spend. */
function rollDay(): void {
  const now = today();
  if (state.day === now) return;
  console.log(`[budget] nuevo día ${now}: contadores en cero`);
  state = emptyState(now);
  save();
}

// ── Who is asking ────────────────────────────────────────────────────────────

/**
 * The priority of the work currently running.
 *
 * Async-local rather than a parameter because the alternative is threading a
 * flag through every repository function, every scraper and every agent — forty
 * signatures changed to carry one boolean that only two places set and one
 * place reads. Here main.ts marks its timers as background once, and every
 * Firestore read those timers eventually cause inherits it, however deep.
 */
const priorityStore = new AsyncLocalStorage<Priority>();

/**
 * Runs something as background work, along with everything it calls.
 *
 * This is what the crawler and the pipeline are wrapped in. Anything not
 * wrapped is interactive, which is the right default: a request handler is the
 * common case, and forgetting the wrapper should mean a reader is served, not
 * that a reader is throttled.
 */
export function asBackground<T>(fn: () => Promise<T>): Promise<T> {
  return priorityStore.run("background", fn);
}

function currentPriority(): Priority {
  return priorityStore.getStore() ?? "interactive";
}

// ── The limit itself ─────────────────────────────────────────────────────────

/** Raised when a call was not made, with a reason a human can act on. */
export class BudgetExhausted extends Error {
  constructor(
    readonly resource: Resource,
    readonly reason: "daily" | "reserved" | "paused",
    message: string,
    /** When it is worth trying again, as a timestamp. */
    readonly retryAt: number,
  ) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

/** Tomorrow at local midnight: when a daily counter next means something else. */
function nextMidnight(): number {
  const now = Date.now() - CR_OFFSET_MS;
  const startOfDay = Math.floor(now / 86_400_000) * 86_400_000;
  return startOfDay + 86_400_000 + CR_OFFSET_MS;
}

/**
 * How long to wait after the far end refuses.
 *
 * Doubling, from ten seconds to an hour. The ceiling matters more than the
 * growth: a quota that resets at midnight will refuse everything until then, so
 * an uncapped backoff would keep doubling into days, and a process that came
 * back at 00:01 would still be waiting at noon. An hour is long enough to stop
 * hammering and short enough to notice the day turned.
 */
function pauseFor(strikes: number): number {
  return Math.min(10_000 * 2 ** (strikes - 1), 60 * 60 * 1000);
}

function check(resource: Resource, priority: Priority): void {
  load();
  rollDay();

  const limits = LIMITS[resource];
  const r = state.resources[resource];
  const now = Date.now();

  if (now < r.pausedUntil) {
    throw new BudgetExhausted(
      resource,
      "paused",
      `${resource} rechazó la última llamada; esperando ${
        Math.ceil((r.pausedUntil - now) / 1000)
      }s antes de reintentar.`,
      r.pausedUntil,
    );
  }

  if (r.used >= limits.perDay) {
    throw new BudgetExhausted(
      resource,
      "daily",
      `${resource} llegó al límite del día (${limits.perDay}). Se reanuda a medianoche.`,
      nextMidnight(),
    );
  }

  // The reservation. Background work stops early so that what is left belongs
  // to whoever is actually reading the site.
  if (priority === "background") {
    const share = Math.floor(limits.perDay * limits.backgroundShare);
    if (r.usedBackground >= share) {
      throw new BudgetExhausted(
        resource,
        "reserved",
        `${resource}: el trabajo de fondo ya usó su parte del día (${share} de ${limits.perDay}). ` +
          `El resto queda para quien esté leyendo.`,
        nextMidnight(),
      );
    }
  }
}

/** Honours the minimum gap by waiting, not by refusing. */
async function pace(resource: Resource): Promise<void> {
  const { minGapMs } = LIMITS[resource];
  if (!minGapMs) return;
  const r = state.resources[resource];
  const due = r.lastCallAt + minGapMs;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

/**
 * Runs one metered call, or refuses to.
 *
 * The call is counted before it runs rather than after, because the thing being
 * limited is contact with the far end, and a call that fails has still been
 * made. Counting successes only would let a failing loop spend a quota it never
 * got an answer from.
 */
export async function spend<T>(resource: Resource, fn: () => Promise<T>): Promise<T> {
  const priority = currentPriority();
  check(resource, priority);
  await pace(resource);

  const r = state.resources[resource];
  r.used++;
  if (priority === "background") r.usedBackground++;
  r.lastCallAt = Date.now();
  save();

  try {
    const result = await fn();
    // A call that came back is evidence the far end is willing again, so the
    // backoff is forgotten rather than decayed: half-remembering a fault that
    // has passed only slows down the recovery.
    if (r.strikes) r.strikes = 0;
    return result;
  } catch (err) {
    if (isRefusal(err)) recordRefusal(resource);
    throw err;
  }
}

/**
 * Tells the limiter the far end said no.
 *
 * Called from the Firestore wrapper, where a refusal arrives as a 429 response
 * rather than as a thrown error, and so cannot be detected by `spend` alone.
 */
export function recordRefusal(resource: Resource): void {
  const r = state.resources[resource];
  r.strikes++;
  r.pausedUntil = Date.now() + pauseFor(r.strikes);
  save();
  console.warn(
    `[budget] ${resource} rechazó la llamada (${r.strikes}ª vez seguida); ` +
      `pausado ${Math.round(pauseFor(r.strikes) / 1000)}s`,
  );
}

/** True for the errors that mean "you have had enough", not "that was wrong". */
function isRefusal(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(text);
}

// ── Looking at it ────────────────────────────────────────────────────────────

export interface ResourceReport {
  used: number;
  perDay: number;
  remaining: number;
  backgroundUsed: number;
  backgroundAllowance: number;
  pausedForSec: number;
}

/** The whole picture, for the health endpoint and for the startup line. */
export function budgetReport(): { day: string; resources: Record<Resource, ResourceReport> } {
  load();
  rollDay();
  const now = Date.now();
  const out = {} as Record<Resource, ResourceReport>;

  for (const key of Object.keys(LIMITS) as Resource[]) {
    const limits = LIMITS[key];
    const r = state.resources[key];
    out[key] = {
      used: r.used,
      perDay: limits.perDay,
      remaining: Math.max(0, limits.perDay - r.used),
      backgroundUsed: r.usedBackground,
      backgroundAllowance: Math.floor(limits.perDay * limits.backgroundShare),
      pausedForSec: r.pausedUntil > now ? Math.ceil((r.pausedUntil - now) / 1000) : 0,
    };
  }

  return { day: state.day, resources: out };
}

/**
 * Whether a call would be allowed, without making one.
 *
 * For the loops that would rather stop cleanly than catch an exception per
 * iteration: a crawler that has run out should log one line and end its tick,
 * not throw its way through the remaining two hundred numbers.
 */
export function canSpend(resource: Resource): boolean {
  try {
    check(resource, currentPriority());
    return true;
  } catch {
    return false;
  }
}
