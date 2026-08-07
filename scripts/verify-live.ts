// ── Does the live stream actually deliver? ───────────────────────────────────
// Wiring that looks right on both sides can still fail in the gap between them:
// an event name the client never listens for, a filter that drops everything, a
// listener that is never released when the reader leaves. None of that shows up
// in a type check, because both halves compile perfectly while agreeing on
// nothing.
//
//   deno task verify:live
//
// So this runs the real router over real HTTP, reads the bytes off the wire,
// and asserts on the frames as a browser would see them. Firestore is never
// touched: the stream carries what `publish` is given, and this calls it
// directly, which is the same thing the database layer does after a write.

import { Hono } from "hono";
import liveRouter from "../src/routes/live.ts";
import { listenerCount, publish } from "../src/lib/events.ts";

const app = new Hono();
app.route("/api/live", liveRouter);

const server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
const BASE = `http://localhost:${server.addr.port}`;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Opens a stream and collects frames as text.
 *
 * A real reader, not a mock: the response is consumed through the same chunked
 * body a browser would get, so anything that breaks framing — a missing blank
 * line, a header that makes a proxy buffer — breaks this too.
 */
async function openStream(query: string) {
  const res = await fetch(`${BASE}/api/live?${query}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    res,
    /** Reads until the buffer holds `event: <name>`, or times out. */
    async waitFor(name: string, ms = 2_000): Promise<string | null> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (buffer.includes(`event: ${name}`)) {
          const frame = buffer.split("\n\n").find((f) => f.includes(`event: ${name}`));
          if (frame) return frame;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return null;
    },
    get text() {
      return buffer;
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

/**
 * Waits for the listener count to stop moving, and returns it.
 *
 * Cancelling a stream from this side only tells the server the reader has gone;
 * the `cancel` handler that releases the listener runs a moment later, on its
 * own schedule. Anything that counts listeners has to allow for that, or it
 * measures the shutdown of the previous test rather than the subject of its own.
 */
async function settle(ms = 1_500): Promise<number> {
  const deadline = Date.now() + ms;
  let last = listenerCount();
  let stableFor = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const now = listenerCount();
    if (now === last) {
      stableFor += 50;
      if (stableFor >= 200) return now;
    } else {
      last = now;
      stableFor = 0;
    }
  }
  return last;
}

function dataOf(frame: string): Record<string, unknown> {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
}

// ── 1. The handshake ─────────────────────────────────────────────────────────
// A browser must know it is connected before it trusts anything: the client
// flips `connected` on this frame, and without it the page would sit silent and
// look identical to a stream that is quietly broken.

console.log("\nla conexión");
{
  const bad = await fetch(`${BASE}/api/live?kind=nonsense`);
  check("un kind inválido se rechaza", bad.status === 400, `status ${bad.status}`);
  await bad.body?.cancel();

  const stream = await openStream("kind=law");
  check(
    "la cabecera es text/event-stream",
    (stream.res.headers.get("content-type") ?? "").includes("text/event-stream"),
    stream.res.headers.get("content-type") ?? "ninguna",
  );
  check(
    "el proxy tiene prohibido almacenar en búfer",
    stream.res.headers.get("x-accel-buffering") === "no",
  );

  const ready = await stream.waitFor("ready");
  check("llega el saludo inicial", ready !== null);
  check("y trae el retry para la reconexión", stream.text.includes("retry: 3000"));

  await stream.close();
}

// ── 2. Delivery and filtering ────────────────────────────────────────────────
// The claim the whole design rests on: a detail page that named one law hears
// about that law and nothing else. If the filter were inverted or ignored, a
// phone on battery would wake for every vote cast anywhere on the site.

console.log("\nla entrega");
{
  const everything = await openStream("kind=law");
  const justOne = await openStream("kind=law&id=10964");
  const otherKind = await openStream("kind=post");

  await everything.waitFor("ready");
  await justOne.waitFor("ready");
  await otherKind.waitFor("ready");

  // Published exactly as db/laws.ts does after a vote.
  publish({ kind: "law", id: "10964", deltas: { likeCount: 1 } });

  const wide = await everything.waitFor("change");
  check("quien escucha todo recibe el cambio", wide !== null);
  if (wide) {
    const data = dataOf(wide);
    check("con el sujeto correcto", data.kind === "law" && data.id === "10964");
    check(
      "y sólo el delta, no el total",
      JSON.stringify(data.deltas) === '{"likeCount":1}',
      JSON.stringify(data.deltas),
    );
    check("con la hora del servidor", typeof data.at === "number");
  }

  const narrow = await justOne.waitFor("change");
  check("quien pidió esa ley también lo recibe", narrow !== null);

  // The negative case, which is the one that actually proves the filter works.
  publish({ kind: "law", id: "99999", deltas: { likeCount: 1 } });
  const wrongLaw = await justOne.waitFor("change", 400);
  const alreadySeen = justOne.text.split("event: change").length - 1;
  check(
    "pero no recibe cambios de otra ley",
    alreadySeen === 1,
    `recibió ${alreadySeen} cambio(s)`,
  );
  void wrongLaw;

  const crossed = otherKind.text.includes("event: change");
  check("y una nota no recibe cambios de leyes", !crossed);

  await everything.close();
  await justOne.close();
  await otherKind.close();
}

// ── 3. Comments travel whole ─────────────────────────────────────────────────
// The thread updates from the event itself rather than refetching, so the
// comment has to arrive intact — and in the form a stranger may see.

console.log("\nlos comentarios");
{
  const stream = await openStream("kind=law&id=10964");
  await stream.waitFor("ready");

  publish({
    kind: "law",
    id: "10964",
    deltas: { commentCount: 1 },
    comment: {
      id: "c1",
      postId: "10964",
      userId: "u1",
      displayName: "Ana",
      body: "Muy claro.",
      parentId: null,
      createdAt: new Date().toISOString(),
      hidden: false,
      tone: "clean",
      screened: true,
      locked: false,
    },
  });

  const frame = await stream.waitFor("change");
  check("el comentario llega por el mismo canal", frame !== null);
  if (frame) {
    const data = dataOf(frame) as { comment?: { displayName?: string; body?: string } };
    check("con su autor y su texto", data.comment?.displayName === "Ana");
    check("y el contador acompaña", JSON.stringify(dataOf(frame).deltas).includes("commentCount"));
  }

  await stream.close();
}

// ── 4. Nothing is left behind ────────────────────────────────────────────────
// A listener that outlives its reader is a leak that grows with every visit,
// and it is invisible until the process has been up for a week. This is the
// cheapest possible guard against that.

console.log("\nla limpieza");
{
  // Settle first. Closing a stream from the client is a message to the far end,
  // not an instruction it obeys immediately, so the streams from the sections
  // above are still shutting down as this one starts. Sampling the count
  // straight away measures the previous test, not this one.
  const before = await settle();
  const a = await openStream("kind=law");
  const b = await openStream("kind=post");
  await a.waitFor("ready");
  await b.waitFor("ready");

  check("dos lectores, dos escuchas", listenerCount() === before + 2, `${listenerCount()}`);

  await a.close();
  await b.close();

  const after = await settle();
  check("al irse, no queda ninguna", after === before, `quedaron ${after - before}`);
}

await server.shutdown();

console.log(
  failures === 0
    ? "\ntodo en orden: el flujo entrega, filtra por sujeto y no deja escuchas colgadas.\n"
    : `\n${failures} comprobación(es) fallaron.\n`,
);

if (failures) Deno.exit(1);
