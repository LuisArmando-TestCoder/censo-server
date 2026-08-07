// ── Live updates ─────────────────────────────────────────────────────────────
// A tally that moves while you are looking at it is the whole point here: the
// site's subject is disagreement, and a split that shifts under your eyes says
// something a static number cannot.
//
// ── Why not WebSockets ──
// The requirement is one-way. The server has news; the browser has nothing to
// say back that an ordinary request cannot carry. A WebSocket would buy
// bidirectionality we would not use and cost a protocol upgrade, sticky
// sessions, and our own reconnection and heartbeat logic. Server-Sent Events
// are plain HTTP: they survive proxies, reconnect on their own with EventSource,
// and need no client library. When something genuinely needs to travel upward —
// a vote, a comment — it goes as a POST, which is already written, already
// authenticated, and already validated.
//
// ── Why deltas rather than totals ──
// Publishing the new absolute count would mean reading the document back after
// every increment, doubling the cost of the cheapest and most frequent write on
// the site. So an event carries what changed, not what it now is, and clients
// add it to the number they already hold. The risk is drift, if an event is
// missed; the answer is that a client refetches on every reconnect, which is
// exactly when it might have missed one.
//
// ── The known limit ──
// This bus lives inside one process. Two instances of the API would each hear
// only their own writes, and a reader on instance A would not see a vote cast
// on instance B until they reloaded. That is acceptable now — there is one
// instance — and the fix when there are two is to replace the innards of
// publish() and subscribe() with a shared channel, without touching a caller.

import type { CommentView } from "../types.ts";

/** What kind of thing changed. */
export type LiveKind = "post" | "law";

export interface LiveEvent {
  kind: LiveKind;
  /** A note's id, or a law's number as a string. */
  id: string;
  /**
   * Numeric fields that moved, by how much.
   *
   * Deliberately not an enumeration. Anything that increments a counter can
   * publish here and every client will apply it, so a field added later needs
   * no change on either side of the wire.
   */
  deltas?: Record<string, number>;
  /** A comment that just arrived, in the form a stranger is allowed to see. */
  comment?: CommentView;
  /** Server clock, so a client can discard anything it has already applied. */
  at: number;
}

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();

/**
 * Announces a change. Never throws: a broken listener must not be able to fail
 * the write that produced the news.
 */
export function publish(event: Omit<LiveEvent, "at">): void {
  const full: LiveEvent = { ...event, at: Date.now() };
  for (const listener of listeners) {
    try {
      listener(full);
    } catch (err) {
      console.warn("[live] listener failed:", err);
    }
  }
}

/** Starts listening. Returns the function that stops. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many streams are currently open, for the health endpoint. */
export function listenerCount(): number {
  return listeners.size;
}

/**
 * Reads a subject out of a Firestore path, so callers that already hold a
 * document path do not have to repeat themselves.
 *
 * Returns null for anything that is not a note or a law, which is how a write
 * to some other collection stays off the wire rather than leaking our internals
 * to every open browser.
 */
export function subjectFromDoc(path: string): { kind: LiveKind; id: string } | null {
  const [collection, id] = path.split("/");
  if (!id) return null;
  if (collection === "posts") return { kind: "post", id };
  if (collection === "laws") return { kind: "law", id };
  return null;
}
