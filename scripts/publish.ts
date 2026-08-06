/// <reference lib="deno.ns" />
// Lists drafts and publishes the ones you name, from the terminal.
//
// Publishing is normally an editor's job in /admin, and it should stay that way:
// a person reads the draft and takes responsibility for it. This exists for the
// operator who has no mailbox wired up yet and still needs the site to go live,
// and for the first fill of an empty front page.
//
// It refuses to publish everything on a bare command. You pass ids, or you pass
// --all and say so out loud. Approving text you have not read is the one thing
// the pipeline is built to prevent, and a convenient flag should not undo it.
//
//   deno task publish                 # show the drafts and their ids
//   deno task publish <id> [<id>...]  # publish those
//   deno task publish --all           # publish every draft
//
// Drafts marked needs_human failed the output guardrail. They are listed apart
// and are not included by --all: something in them did not match the source.

import { listPosts, updatePost } from "../src/db/posts.ts";
import type { Post } from "../src/types.ts";

const args = Deno.args;
const all = args.includes("--all");
const ids = args.filter((a) => !a.startsWith("--"));

function line(p: Post): string {
  return `  ${p.id}\n     ${p.title}\n     ${p.summary}`;
}

const drafts = await listPosts("draft", 100);
const flagged = await listPosts("needs_human", 100);

// ── Nothing named: show what there is ────────────────────────────────────────

if (!all && ids.length === 0) {
  console.log(`\nBorradores listos para publicar: ${drafts.length}\n`);
  for (const p of drafts) console.log(`${line(p)}\n`);

  if (flagged.length) {
    console.log(`Necesitan revisión humana: ${flagged.length}`);
    console.log("Estos no pasaron el control de calidad. Léalos en /admin.\n");
    for (const p of flagged) console.log(`${line(p)}\n`);
  }

  if (drafts.length) {
    console.log("Para publicar: deno task publish <id> [<id>...]");
    console.log("Para publicar todos: deno task publish --all\n");
  }
  Deno.exit(0);
}

// ── Publish ──────────────────────────────────────────────────────────────────

const chosen = all ? drafts : drafts.filter((p) => ids.includes(p.id));
const missing = ids.filter((id) => !drafts.some((p) => p.id === id));

for (const id of missing) {
  console.log(`  no es un borrador, se omite: ${id}`);
}

if (chosen.length === 0) {
  console.log("\nNo hay nada que publicar.\n");
  Deno.exit(1);
}

console.log(`\nPublicando ${chosen.length} nota(s)\n`);

for (const post of chosen) {
  // Matches what the admin route does, so a note published here is
  // indistinguishable from one published by an editor.
  await updatePost(post.id, {
    status: "published",
    publishedAt: post.publishedAt ?? new Date().toISOString(),
  });
  console.log(`  publicada  /nota/${post.slug}`);
  console.log(`             ${post.title}`);
}

console.log("");
