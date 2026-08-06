// ── Counting arrivals ────────────────────────────────────────────────────────
// One increment, on whatever document was opened. Notes and laws share it, the
// way they share their comment thread.
//
// Deliberately not done inside the GET handlers, which is the shorter way and
// the wrong one. A GET is supposed to be safe to repeat: Next.js prefetches
// links on hover, crawlers walk every page, and a proxy may replay a request.
// Counting there would measure our own prefetching more than it measures
// readers. An explicit call is a claim that a person actually arrived.
//
// What this cannot do is count *people*. It counts openings, and says so in the
// name it is shown under — "lecturas", readings — rather than dressing an
// approximate number as an audience.

import { fsIncrement } from "./firestore.ts";

/** Records one arrival. */
export async function recordView(doc: string): Promise<void> {
  await fsIncrement(doc, { viewCount: 1 });
}
