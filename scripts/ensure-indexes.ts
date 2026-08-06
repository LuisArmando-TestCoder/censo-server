/// <reference lib="deno.ns" />
// Firestore composite indexes, declared in code and created on demand.
//
// Any query that filters on one field and sorts on another needs a composite
// index. Rather than clicking the link in a 400 error each time, every index the
// app relies on is listed here and created through the Admin API. Running this
// twice is safe: an existing index comes back as ALREADY_EXISTS and is skipped.
//
//   deno run --allow-net --allow-env --allow-read scripts/ensure-indexes.ts

import { authedFetch, databaseResourceName, SCOPE_CLOUD_PLATFORM } from "../src/db/firestore.ts";

interface IndexSpec {
  collection: string;
  why: string;
  fields: Array<{ fieldPath: string; order: "ASCENDING" | "DESCENDING" }>;
}

const INDEXES: IndexSpec[] = [
  {
    collection: "raw_items",
    why: "listRawItemsBySource: filter by sourceId, newest upstream id first",
    fields: [
      { fieldPath: "sourceId", order: "ASCENDING" },
      { fieldPath: "upstreamId", order: "DESCENDING" },
    ],
  },
  {
    collection: "posts",
    why: "listPosts: filter by status, newest first",
    fields: [
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ],
  },
  {
    collection: "posts",
    why: "editor dashboard: an editor's own posts, newest first",
    fields: [
      { fieldPath: "ownerEmail", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ],
  },
];

async function createIndex(spec: IndexSpec): Promise<"created" | "exists" | "failed"> {
  const parent = await databaseResourceName();
  const url =
    `https://firestore.googleapis.com/v1/${parent}/collectionGroups/${spec.collection}/indexes`;

  // Index administration is not covered by the datastore scope the running
  // server uses, so this script asks for the broader cloud-platform scope.
  const res = await authedFetch(
    url,
    {
      method: "POST",
      body: JSON.stringify({
        queryScope: "COLLECTION",
        fields: spec.fields,
      }),
    },
    SCOPE_CLOUD_PLATFORM,
  );

  const text = await res.text();
  if (res.ok) return "created";
  if (text.includes("ALREADY_EXISTS") || text.includes("already exists")) return "exists";
  console.log(`        ${res.status} ${text.slice(0, 220)}`);
  return "failed";
}

console.log("\nEnsuring Firestore composite indexes\n");

let failed = 0;
for (const spec of INDEXES) {
  const outcome = await createIndex(spec);
  if (outcome === "failed") failed++;
  const label = outcome === "created" ? "CREATED" : outcome === "exists" ? "EXISTS " : "FAILED ";
  console.log(`  ${label} ${spec.collection}: ${spec.fields.map((f) => f.fieldPath).join(" + ")}`);
  console.log(`          ${spec.why}`);
}

console.log(
  failed === 0
    ? "\nAll indexes are in place. A freshly created index takes a minute or two to build.\n"
    : `\n${failed} index(es) could not be created.\n`,
);
Deno.exit(failed === 0 ? 0 : 1);
