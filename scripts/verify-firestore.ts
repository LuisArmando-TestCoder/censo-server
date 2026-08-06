/// <reference lib="deno.ns" />
// Slice 0 + 2 proof: the `elcenso` Firestore is reachable in Native mode, and
// fsIncrement is genuinely atomic under concurrent writers.
//
//   deno run --allow-net --allow-env --allow-read scripts/verify-firestore.ts

import {
  fsCount,
  fsCreate,
  fsDelete,
  fsGet,
  fsIncrement,
  fsQuery,
  fsSet,
  fsUpdate,
} from "../src/db/firestore.ts";

const SCRATCH = "_verify";
const id = `run_${Date.now()}`;
const path = `${SCRATCH}/${id}`;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nVerifying Firestore against project `elcenso`\n");

try {
  // 1. Write + read round trip. A Datastore-mode database rejects this outright,
  //    so a pass here also proves the database is in Native mode.
  await fsSet(path, { label: "scratch", n: 0, nested: { a: 1 }, list: ["x", "y"] });
  const read = await fsGet<Record<string, unknown>>(path);
  check("write + read round trip", read?.label === "scratch");
  check(
    "nested map + array survive the codec",
    JSON.stringify(read?.nested) === '{"a":1}' && JSON.stringify(read?.list) === '["x","y"]',
  );

  // 2. Merge update must not clobber untouched fields.
  await fsUpdate(path, { label: "updated" });
  const merged = await fsGet<Record<string, unknown>>(path);
  check(
    "fsUpdate merges without clobbering",
    merged?.label === "updated" && JSON.stringify(merged?.list) === '["x","y"]',
  );

  // 3. Create-if-absent must refuse a second create on the same id.
  const dupe = await fsCreate(SCRATCH, id, { label: "dupe" });
  check("fsCreate refuses an existing id", dupe === false);

  // 4. The one that matters for vote counters: 50 concurrent +1s must all land.
  const CONCURRENCY = 50;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => fsIncrement(path, { n: 1 })),
  );
  const counted = await fsGet<{ n: number }>(path);
  check(
    `fsIncrement is atomic under ${CONCURRENCY} parallel writers`,
    counted?.n === CONCURRENCY,
    `n = ${counted?.n}, expected ${CONCURRENCY}`,
  );

  // 5. Negative delta (undoing a vote).
  await fsIncrement(path, { n: -1 });
  const decremented = await fsGet<{ n: number }>(path);
  check("fsIncrement accepts negative deltas", decremented?.n === CONCURRENCY - 1);

  // 6. Structured query + aggregation count.
  const found = await fsQuery<{ label: string }>(SCRATCH, {
    where: [{ field: "label", op: "EQUAL", value: "updated" }],
    limit: 5,
  });
  check("fsQuery finds the scratch doc", found.some((d) => d._id === id));

  const n = await fsCount(SCRATCH, [{ field: "label", op: "EQUAL", value: "updated" }]);
  check("fsCount returns an aggregate", n >= 1, `count = ${n}`);
} catch (err) {
  failures++;
  console.log(`  FAIL  unexpected error — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await fsDelete(path).catch(() => {});
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
Deno.exit(failures === 0 ? 0 : 1);
