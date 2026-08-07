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

import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.ts";

export type Resource = "firestore" | "model" | "asamblea";
export type Priority = "interactive" | "background";

export interface ResourceLimits {
  perDay: number;
  minGapMs: number;
  backgroundShare: number;
}

const LIMITS: Record<Resource, ResourceLimits> = {
  firestore: {
    perDay: config.budgetFirestorePerDay,
    minGapMs: 1200, // <--- 1.2s entre lecturas (máximo ~50 req/min para no saturar REST en Spark)
    backgroundShare: 0.85,
  },
  model: {
    perDay: config.budgetModelPerDay,
    minGapMs: 1_000,
    backgroundShare: 0.9,
  },
  asamblea: {
    perDay: config.budgetAsambleaPerDay,
    minGapMs: config.lawRequestDelayMs,
    backgroundShare: 1,
  },
};

// ── What is remembered ───────────────────────────────────────────────────────

interface ResourceState {
  used: number;
  usedBackground: number;
  strikes: number;
  pausedUntil: number;
  lastCallAt: number;
}

interface BudgetState {
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

const CR_OFFSET_MS = 6 * 60 * 60 * 1000;

function today(): string {
  return new Date(Date.now() - CR_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Persistence ──────────────────────────────────────────────────────────────

let state: BudgetState = emptyState(today());
let loaded = false;
let saveTimer: number | null = null;

function save(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      Deno.writeTextFileSync(config.budgetStatePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn("[budget] could not save state:", err instanceof Error ? err.message : err);
    }
  }, 2_000);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(config.budgetStatePath)) as BudgetState;
    if (parsed?.day === today() && parsed.resources) {
      state = { day: parsed.day, resources: { ...emptyState(parsed.day).resources } };
      for (const key of Object.keys(state.resources) as Resource[]) {
        if (parsed.resources[key]) {
          state.resources[key] = { ...emptyResource(), ...parsed.resources[key] };
          // If previous process was killed (Ctrl+C), unfreeze long pauses
          state.resources[key].pausedUntil = Math.min(
            state.resources[key].pausedUntil,
            Date.now() + 1_000,
          );
        }
      }
    }
  } catch {
    // Fresh run
  }
}

function rollDay(): void {
  const now = today();
  if (state.day === now) return;
  console.log(`[budget] nuevo día ${now}: contadores en cero`);
  state = emptyState(now);
  save();
}

// ── Who is asking ────────────────────────────────────────────────────────────

const priorityStore = new AsyncLocalStorage<Priority>();

export function asBackground<T>(fn: () => Promise<T>): Promise<T> {
  return priorityStore.run("background", fn);
}

function currentPriority(): Priority {
  return priorityStore.getStore() ?? "interactive";
}

// ── The limit itself ─────────────────────────────────────────────────────────

export class BudgetExhausted extends Error {
  constructor(
    readonly resource: Resource,
    readonly reason: "daily" | "reserved" | "paused",
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

function nextMidnight(): number {
  const now = Date.now() - CR_OFFSET_MS;
  const startOfDay = Math.floor(now / 86_400_000) * 86_400_000;
  return startOfDay + 86_400_000 + CR_OFFSET_MS;
}

function pauseFor(strikes: number): number {
  return Math.min(2_000 * 2 ** (strikes - 1), 20_000);
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

/**
 * Atomic pacing logic: locks the future target timestamp IMMEDIATELY
 * so parallel promises queue sequentially instead of bursting together.
 */
async function pace(resource: Resource): Promise<void> {
  const { minGapMs } = LIMITS[resource];
  if (!minGapMs) return;
  const r = state.resources[resource];
  const now = Date.now();

  const nextAllowed = Math.max(now, r.lastCallAt + minGapMs);
  r.lastCallAt = nextAllowed; // Lock slot immediately for concurrent callers

  const wait = nextAllowed - now;
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

export async function spend<T>(resource: Resource, fn: () => Promise<T>): Promise<T> {
  const priority = currentPriority();
  check(resource, priority);
  await pace(resource);

  const r = state.resources[resource];
  r.used++;
  if (priority === "background") r.usedBackground++;
  save();

  try {
    const result = await fn();
    if (r.strikes) r.strikes = 0;
    return result;
  } catch (err) {
    if (isRefusal(err)) recordRefusal(resource);
    throw err;
  }
}

export function recordRefusal(resource: Resource): void {
  const r = state.resources[resource];
  const now = Date.now();

  // If already paused from a concurrent failure, ignore secondary burst strikes
  if (r.pausedUntil > now) return;

  r.strikes++;
  r.pausedUntil = now + pauseFor(r.strikes);
  save();
  console.warn(
    `[budget] ${resource} rechazó la llamada (${r.strikes}ª vez seguida); ` +
      `pausado ${Math.round(pauseFor(r.strikes) / 1000)}s`,
  );
}

function isRefusal(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(text);
}

export interface ResourceReport {
  used: number;
  perDay: number;
  remaining: number;
  backgroundUsed: number;
  backgroundAllowance: number;
  pausedForSec: number;
}

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

export function canSpend(resource: Resource): boolean {
  try {
    check(resource, currentPriority());
    return true;
  } catch {
    return false;
  }
}