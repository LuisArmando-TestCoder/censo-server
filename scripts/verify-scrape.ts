/// <reference lib="deno.ns" />
// Slice 4 + 5 proof: the live Asamblea lists respond, the payload cleaners fix
// what upstream actually sends, and running the sweep twice never duplicates.
//
//   deno run --allow-net --allow-env --allow-read scripts/verify-scrape.ts

import { getSource, seedSources } from "../src/db/sources.ts";
import { listRawItemsBySource } from "../src/db/rawItems.ts";
import {
  cleanTitle,
  decodeEntities,
  extractLinks,
  fetchListItems,
  normalizeRow,
} from "../src/scrape/sharepoint.ts";
import { sweepSource } from "../src/scrape/sweep.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nVerifying the Asamblea scrape\n");

try {
  // ── Pure cleaners, against the exact malformations upstream produces ───────
  const encoded = "Vea el video https&#58;//youtu.be/CsT2YsBz3kc y el detalle";
  check(
    "entity decoding repairs the colon in URLs",
    decodeEntities(encoded).includes("https://youtu.be/CsT2YsBz3kc"),
  );
  const links = extractLinks(encoded);
  check(
    "a repaired YouTube URL is classified as video",
    links.length === 1 && links[0].kind === "youtube",
    links.map((l) => `${l.kind}:${l.url}`).join(", "),
  );
  check(
    "titles lose their emoji and stray asterisks",
    cleanTitle("**\ud83d\udce3 MEGÁFONO LEGISLATIVO\ud83d\udce3*") === "MEGÁFONO LEGISLATIVO",
    `got "${cleanTitle("**\ud83d\udce3 MEGÁFONO LEGISLATIVO\ud83d\udce3*")}"`,
  );

  // ── Seed, then read the two live lists ────────────────────────────────────
  await seedSources();

  for (const id of ["asamblea-noticias", "asamblea-calendario"]) {
    const source = await getSource(id);
    if (!source) {
      check(`${id} is registered`, false);
      continue;
    }

    const rows = await fetchListItems(source, 0, 3);
    check(`${id} returns live rows`, rows.length > 0, `${rows.length} rows`);
    if (!rows.length) continue;

    const item = normalizeRow(source, rows[0]);
    check(
      `${id} normalizes into title or body`,
      Boolean(item.title || item.body),
      `"${item.title.slice(0, 58)}"`,
    );
    check(
      `${id} carries no leftover entities`,
      !item.body.includes("&#") && !item.title.includes("&#"),
    );
  }

  // ── The dedupe invariant ──────────────────────────────────────────────────
  const source = await getSource("asamblea-noticias");
  if (source) {
    // Rewind the cursor so the same window is read twice on purpose.
    const rewound = { ...source, cursorItemId: 0 };

    const first = await sweepSource(rewound, 5);
    check("first sweep succeeds", first.error === null, first.error ?? "");
    const afterFirst = (await listRawItemsBySource(source.id, 50)).length;

    const second = await sweepSource(rewound, 5);
    check("second sweep succeeds", second.error === null, second.error ?? "");
    const afterSecond = (await listRawItemsBySource(source.id, 50)).length;

    check(
      "re-reading the same window creates nothing new",
      afterFirst === afterSecond,
      `${afterFirst} then ${afterSecond} stored`,
    );
    check(
      "the second pass reports the items as unchanged",
      second.created === 0 && second.changed === 0,
      `created ${second.created}, changed ${second.changed}, unchanged ${second.unchanged}`,
    );
  }
} catch (err) {
  failures++;
  console.log(`  FAIL  unexpected error — ${err instanceof Error ? err.message : String(err)}`);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
Deno.exit(failures === 0 ? 0 : 1);
