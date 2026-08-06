/// <reference lib="deno.ns" />
// Slice 3 + 8 proof, against a running server.
//
// Confirms the access rules hold end to end: reading is open, reacting is not,
// a bad code is refused, a good one issues a session, a voter cannot reach the
// admin surface, and a vote is idempotent rather than double counted.
//
//   deno task start                       # in one terminal
//   deno run --allow-net --allow-env --allow-read scripts/verify-api.ts
//
// The OTP is read straight from Firestore, which is how this avoids needing a
// real inbox.

import { config } from "../src/config.ts";
import { fsGet } from "../src/db/firestore.ts";
import { otpDoc } from "../src/db/paths.ts";
import { createPost, updatePost } from "../src/db/posts.ts";
import { fsDelete } from "../src/db/firestore.ts";
import { postDoc, userDoc } from "../src/db/paths.ts";
import { userId } from "../src/lib/hash.ts";
import type { OtpRecord } from "../src/types.ts";

const BASE = `http://localhost:${config.port}`;
const EMAIL = `verify+${Date.now()}@example.com`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

console.log(`\nVerifying the API at ${BASE}\n`);

const health = await call("/").catch(() => null);
if (!health || health.status !== 200) {
  console.log("  FAIL  the server is not running. Start it with `deno task start`.\n");
  Deno.exit(1);
}
check("the server answers", health.body?.ok === true);

// A published article to act on.
const post = await createPost({
  title: "Artículo de prueba para verificación",
  summary: "Este artículo existe solo para comprobar el control de acceso.",
  blocks: [{ id: "b1", kind: "paragraph", text: "Contenido de prueba.", items: [] }],
  origin: "organic",
  status: "published",
  ownerEmail: null,
});

try {
  // ── Reading is open ────────────────────────────────────────────────────────
  const feed = await call("/api/posts");
  check("anyone can read the feed", feed.status === 200 && Array.isArray(feed.body.posts));

  const article = await call(`/api/posts/${post.slug}`);
  check("anyone can read one article", article.status === 200 && !!article.body.post);

  const docs = await call("/api/legal");
  check("anyone can read the policies", docs.status === 200 && docs.body.docs.length > 0);

  // ── Acting is not ──────────────────────────────────────────────────────────
  const anonLike = await call(`/api/posts/${post.id}/reaction`, {
    method: "POST",
    body: JSON.stringify({ kind: "like" }),
  });
  check("liking without an account returns 401", anonLike.status === 401, `got ${anonLike.status}`);

  const anonComment = await call(`/api/posts/${post.id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "hola" }),
  });
  check(
    "commenting without an account returns 401",
    anonComment.status === 401,
    `got ${anonComment.status}`,
  );

  // ── Signing in ─────────────────────────────────────────────────────────────
  const requested = await call("/api/auth/request-code", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL }),
  });
  // A 502 means SMTP refused the send. The code is still stored, so the rest of
  // the run is still meaningful; the delivery path is simply not covered here.
  check(
    "a code can be requested",
    requested.status === 200 || requested.status === 502,
    `got ${requested.status}`,
  );

  const stored = await fsGet<OtpRecord>(otpDoc(EMAIL));
  check("the code is stored", !!stored?.code);

  const wrong = await call("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, code: "000000" }),
  });
  check("a wrong code is refused", wrong.status === 401, `got ${wrong.status}`);

  const verified = await call("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, code: stored!.code }),
  });
  check("the right code issues a session", verified.status === 200 && !!verified.body.token);
  check("a new account is asked to say who they are", verified.body.needsOnboarding === true);

  const token: string = verified.body.token;

  const me = await call("/api/auth/me", {}, token);
  check("the session identifies the account", me.body?.user?.email === EMAIL);
  check("a new account starts as a voter", me.body?.user?.role === "voter");

  // ── Roles ──────────────────────────────────────────────────────────────────
  const adminTry = await call("/api/admin/posts", {}, token);
  check(
    "a voter cannot reach the admin surface",
    adminTry.status === 403,
    `got ${adminTry.status}`,
  );

  const metricsTry = await call("/api/admin/metrics", {}, token);
  check("a voter cannot read the metrics", metricsTry.status === 403, `got ${metricsTry.status}`);

  // ── Voting ─────────────────────────────────────────────────────────────────
  const like1 = await call(`/api/posts/${post.id}/reaction`, {
    method: "POST",
    body: JSON.stringify({ kind: "like" }),
  }, token);
  check(
    "a signed-in reader can like",
    like1.status === 200 && like1.body.likeCount === 1,
    `likes = ${like1.body?.likeCount}`,
  );

  const like2 = await call(`/api/posts/${post.id}/reaction`, {
    method: "POST",
    body: JSON.stringify({ kind: "like" }),
  }, token);
  check(
    "liking twice removes the like rather than doubling it",
    like2.body.likeCount === 0 && like2.body.myReaction === null,
    `likes = ${like2.body?.likeCount}`,
  );

  await call(`/api/posts/${post.id}/reaction`, {
    method: "POST",
    body: JSON.stringify({ kind: "like" }),
  }, token);
  const switched = await call(`/api/posts/${post.id}/reaction`, {
    method: "POST",
    body: JSON.stringify({ kind: "dislike" }),
  }, token);
  check(
    "switching moves the vote across",
    switched.body.likeCount === 0 && switched.body.dislikeCount === 1,
    `likes ${switched.body?.likeCount}, dislikes ${switched.body?.dislikeCount}`,
  );

  // ── Comments ───────────────────────────────────────────────────────────────
  const comment = await call(`/api/posts/${post.id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "<script>alert(1)</script> Buen resumen." }),
  }, token);
  check("a signed-in reader can comment", comment.status === 201);
  check(
    "markup is stripped out of a comment",
    !String(comment.body?.comment?.body ?? "").includes("<script"),
    comment.body?.comment?.body,
  );

  // ── Onboarding ─────────────────────────────────────────────────────────────
  const onboarded = await call("/api/auth/onboarding", {
    method: "POST",
    body: JSON.stringify({ citizenKind: "votante", cedula: "1-1234-5678" }),
  }, token);
  check("the onboarding answer is accepted", onboarded.status === 200);

  const afterOnboarding = await call("/api/auth/me", {}, token);
  check("onboarding is not asked again", afterOnboarding.body?.needsOnboarding === false);
  check(
    "the cédula is never sent back to the client",
    !JSON.stringify(afterOnboarding.body).includes("1234"),
  );

  const badCedula = await call("/api/auth/onboarding", {
    method: "POST",
    body: JSON.stringify({ citizenKind: "votante", cedula: "12" }),
  }, token);
  check("a malformed cédula is refused", badCedula.status === 400, `got ${badCedula.status}`);
} finally {
  // Clean up so repeated runs do not litter the database.
  await updatePost(post.id, { status: "archived" }).catch(() => {});
  await fsDelete(postDoc(post.id)).catch(() => {});
  await fsDelete(userDoc(await userId(EMAIL))).catch(() => {});
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
Deno.exit(failures === 0 ? 0 : 1);
