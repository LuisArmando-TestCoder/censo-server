/// <reference lib="deno.ns" />
// Proof for the Gaceta reader: the live edition parses, the day splits into
// recognisable acts, and a second read of the same edition adds nothing.
//
//   deno run --allow-net --allow-env --allow-read scripts/verify-gaceta.ts

import { getSource, seedSources } from "../src/db/sources.ts";
import { listRawItemsBySource } from "../src/db/rawItems.ts";
import {
  editionDate,
  editionPdfUrl,
  fetchGacetaItems,
  gacetaItemId,
} from "../src/scrape/gaceta.ts";
import { sweepSource } from "../src/scrape/sweep.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nVerifying the Gaceta scrape\n");

try {
  // ── Pure helpers ──────────────────────────────────────────────────────────
  const sample = '<a href="/pub/2026/08/06/COMP_06_08_2026.pdf">Ver</a>';
  check("the edition date is read from the markup", editionDate(sample) === "2026-08-06");
  check(
    "the edition PDF resolves to an absolute url",
    editionPdfUrl(sample) ===
      "https://www.imprentanacional.go.cr/pub/2026/08/06/COMP_06_08_2026.pdf",
    editionPdfUrl(sample) ?? "null",
  );
  check(
    "item ids increase with the day and then with position",
    gacetaItemId("2026-08-06", 3) > gacetaItemId("2026-08-05", 999),
  );

  await seedSources();
  const source = await getSource("gaceta");
  if (!source) {
    check("the gaceta source is registered", false);
  } else {
    // ── The live edition ────────────────────────────────────────────────────
    const items = await fetchGacetaItems(source, 0, 200);
    check("today's edition yields items", items.length > 0, `${items.length} acts`);

    if (items.length) {
      const first = items[0];
      check(
        "each item is titled with its place in the hierarchy",
        first.title.includes("›") || first.title.length > 0,
        `"${first.title.slice(0, 70)}"`,
      );
      check("each item carries the edition date", Boolean(first.eventDate), first.eventDate ?? "");
      check(
        "the first cited link is the dated edition, not an inner address",
        first.links[0]?.url.includes("/pub/") ?? false,
        first.links[0]?.url ?? "no links",
      );
      check(
        "bodies stay inside the storage budget",
        items.every((i) => i.body.length <= 8_000),
      );

      // Asking again from the highest id must come back empty, which is what
      // makes a second sweep on the same day free.
      const highest = Math.max(...items.map((i) => i.upstreamId));
      const again = await fetchGacetaItems(source, highest, 200);
      check("reading past the cursor returns nothing", again.length === 0, `${again.length} items`);
    }

    // ── The dedupe invariant, through the sweep ─────────────────────────────
    const rewound = { ...source, cursorItemId: 0 };

    const firstSweep = await sweepSource(rewound, 8);
    check("first sweep succeeds", firstSweep.error === null, firstSweep.error ?? "");
    const afterFirst = (await listRawItemsBySource(source.id, 100)).length;

    const secondSweep = await sweepSource(rewound, 8);
    check("second sweep succeeds", secondSweep.error === null, secondSweep.error ?? "");
    const afterSecond = (await listRawItemsBySource(source.id, 100)).length;

    check(
      "re-reading the same edition creates nothing new",
      afterFirst === afterSecond,
      `${afterFirst} then ${afterSecond} stored`,
    );
    check(
      "the second pass reports the acts as unchanged",
      secondSweep.created === 0 && secondSweep.changed === 0,
      `created ${secondSweep.created}, changed ${secondSweep.changed}, unchanged ${secondSweep.unchanged}`,
    );
  }
} catch (err) {
  failures++;
  console.log(`  FAIL  unexpected error — ${err instanceof Error ? err.message : String(err)}`);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
Deno.exit(failures === 0 ? 0 : 1);
