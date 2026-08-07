// ── The live stream ──────────────────────────────────────────────────────────
// One connection per page, not one per card.
//
// That is the decision the whole design turns on. A stream for every visible
// item would mean thirty sockets on a list of thirty, thirty heartbeats, and
// thirty reconnections when the wifi drops — for payloads of a few dozen bytes
// each. Instead the page opens one stream, says which subjects it cares about,
// and receives a small event whenever one of them moves.
//
// Which items are on screen is then a client-side question, and it stays there.
// The browser knows what is in the viewport far more cheaply than the server
// could be told: an IntersectionObserver costs nothing, whereas keeping the
// server informed would mean a request every time somebody scrolls. So the
// stream is filtered by *interest* here, and by *visibility* there.
//
//   GET /api/live?kind=law&id=10964     one law, for its own page
//   GET /api/live?kind=law              every law, for the list and the hero
//   GET /api/live?kind=post             every note
//
// Filtering by id matters more than it looks: a detail page that subscribed to
// everything would wake up, parse and discard an event for every vote cast
// anywhere on the site, on a phone, on battery.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { listenerCount, type LiveEvent, type LiveKind, subscribe } from "../lib/events.ts";

const live = new Hono<AppEnv>();

/**
 * How often to send a comment line when nothing is happening.
 *
 * Proxies and load balancers close a connection that has been silent for a
 * minute or two, and a browser cannot tell that from a network failure — it
 * simply reconnects, which is a request we pay for. A heartbeat is cheaper than
 * the reconnection it prevents.
 */
const HEARTBEAT_MS = 25_000;

live.get("/", (c) => {
  const kind = c.req.query("kind") as LiveKind | undefined;
  if (kind !== "post" && kind !== "law") {
    return c.json({ error: "kind debe ser post o law" }, 400);
  }

  // A list page sends no ids and hears about everything of its kind; a detail
  // page names one and hears only about that.
  const wanted = (c.req.query("id") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wantedSet = wanted.length ? new Set(wanted) : null;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: number | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The reader is gone and the stream is already closing. Nothing to do
          // and nothing worth logging: browsers close these constantly.
        }
      };

      // Told once, up front: how long the browser should wait before trying
      // again after a drop. EventSource honours this on its own.
      send("retry: 3000\n\n");
      send(`event: ready\ndata: ${JSON.stringify({ kind, ids: wanted })}\n\n`);

      unsubscribe = subscribe((event: LiveEvent) => {
        if (event.kind !== kind) return;
        if (wantedSet && !wantedSet.has(event.id)) return;
        send(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
      });

      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },

    cancel() {
      // Both are torn down here rather than in a finally somewhere: this is the
      // one place that runs whether the reader navigated away, lost signal, or
      // closed the tab, and a listener left behind is a leak that grows with
      // every visit.
      unsubscribe?.();
      if (heartbeat !== null) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx buffers by default, which would hold events until it felt like
      // flushing and make a live feed arrive in clumps.
      "X-Accel-Buffering": "no",
    },
  });
});

/** How many streams are open. Useful when wondering whether a leak is real. */
live.get("/stats", (c) => c.json({ listeners: listenerCount() }));

export default live;
