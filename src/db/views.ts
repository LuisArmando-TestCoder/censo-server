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
import { publish, subjectFromDoc } from "../lib/events.ts";

/** Records one arrival, and tells anyone watching. */
export async function recordView(doc: string): Promise<void> {
  await fsIncrement(doc, { viewCount: 1 });

  // Announced from here rather than from the route, so that every path which
  // records a view — this one, and any added later — is live without having to
  // remember to be.
  const subject = subjectFromDoc(doc);
  if (subject) publish({ ...subject, deltas: { viewCount: 1 } });
}
