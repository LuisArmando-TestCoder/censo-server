// ── Editor and admin surface ─────────────────────────────────────────────────
// Two levels of access. An editor works on the articles assigned to them; an
// admin also manages people, fields, sources, and the legal documents.
//
// The ownership rule is enforced here, on every write, rather than by hiding
// buttons in the interface.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { requireAdmin, requireAuth, requireEditor } from "../middleware/auth.ts";
import { fail, randomId, requireEmail, requireOneOf, requireString } from "../lib/validate.ts";
import {
  createPost,
  getPost,
  hideComment,
  listComments,
  listPosts,
  listPostsByOwner,
  updatePost,
} from "../db/posts.ts";
import { deactivateField, listFields, upsertField, validateFieldValues } from "../db/fields.ts";
import { listSources, upsertSource } from "../db/sources.ts";
import { listPendingRawItems } from "../db/rawItems.ts";
import { listLegalDocs, upsertLegalDoc } from "../db/legal.ts";
import { listQuestions, upsertQuestion } from "../db/quiz.ts";
import { ensureUser, getUserByEmail, listByRole, setRole } from "../db/users.ts";
import { sendEmail } from "../lib/email.ts";
import { editorInviteEmail } from "../lib/emailTemplates.ts";
import { sweepAll } from "../scrape/sweep.ts";
import { fsList } from "../db/firestore.ts";
import { COL } from "../db/paths.ts";
import type { Post, PostBlock, PostStatus, Role } from "../types.ts";

const admin = new Hono<AppEnv>();

const POST_STATUSES = ["draft", "needs_human", "published", "archived"] as const;
const BLOCK_KINDS = ["paragraph", "heading", "quote", "list", "video", "source_link"] as const;
const FIELD_TYPES = ["text", "longtext", "number", "boolean", "date", "select", "tags"] as const;

// Everything below needs at least an editor.
admin.use("*", requireAuth);

/** An editor may only touch their own work; an admin may touch anything. */
function assertMayEdit(post: Post, email: string, role: Role): void {
  if (role === "admin") return;
  // An unclaimed generated draft is fair game: claiming it is how an editor
  // picks up work from the queue.
  if (post.ownerEmail === null || post.ownerEmail === email) return;
  fail(403, "That article belongs to another editor.");
}

/** Rejects anything the block editor should not be able to produce. */
function normalizeBlocks(input: unknown): PostBlock[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((raw) => {
    const b = raw as Partial<PostBlock>;
    const kind = (BLOCK_KINDS as readonly string[]).includes(String(b.kind))
      ? b.kind as PostBlock["kind"]
      : "paragraph";
    return {
      id: typeof b.id === "string" && b.id ? b.id : randomId(6),
      kind,
      text: String(b.text ?? "").slice(0, 8000),
      items: Array.isArray(b.items) ? b.items.map((i) => String(i).slice(0, 500)).slice(0, 50) : [],
    };
  });
}

// ── Articles ─────────────────────────────────────────────────────────────────

// GET /posts — an admin sees everything; an editor sees their own plus the
// unclaimed generated drafts waiting to be picked up.
admin.get("/posts", requireEditor, async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") as PostStatus | undefined;

  if (user.role === "admin") {
    return c.json({ posts: await listPosts(status ?? null, 200) });
  }

  const [mine, queue] = await Promise.all([
    listPostsByOwner(user.email, 200),
    listPosts(null, 200),
  ]);
  const unclaimed = queue.filter((p) => p.ownerEmail === null && p.origin === "generative");
  const byId = new Map([...mine, ...unclaimed].map((p) => [p.id, p]));

  return c.json({
    posts: [...byId.values()].filter((p) => !status || p.status === status),
  });
});

admin.get("/posts/:id", requireEditor, async (c) => {
  const post = await getPost(c.req.param("id"));
  if (!post) fail(404, "That article does not exist.");
  const user = c.get("user");
  assertMayEdit(post!, user.email, user.role);
  return c.json({ post: post!, comments: await listComments(post!.id) });
});

// POST /posts — an editor writes something from scratch. It is theirs.
admin.post("/posts", requireEditor, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const defs = await listFields();
  const { values, missing } = validateFieldValues(
    defs,
    (body.fields ?? {}) as Record<string, unknown>,
  );
  if (missing.length) fail(400, `These fields are required: ${missing.join(", ")}.`);

  const post = await createPost({
    title: requireString(body.title, "title", 200),
    summary: requireString(body.summary, "summary", 500),
    blocks: normalizeBlocks(body.blocks),
    fields: values,
    origin: "organic",
    status: "draft",
    ownerEmail: user.email,
  });

  return c.json({ post }, 201);
});

// PATCH /posts/:id — edit, claim, or publish.
admin.patch("/posts/:id", requireEditor, async (c) => {
  const user = c.get("user");
  const post = await getPost(c.req.param("id"));
  if (!post) fail(404, "That article does not exist.");
  assertMayEdit(post!, user.email, user.role);

  const body = await c.req.json().catch(() => ({}));
  const patch: Partial<Post> = {};

  if (body.title != null) patch.title = requireString(body.title, "title", 200);
  if (body.summary != null) patch.summary = requireString(body.summary, "summary", 500);
  if (body.blocks != null) patch.blocks = normalizeBlocks(body.blocks);

  if (body.fields != null) {
    const defs = await listFields();
    const { values, missing } = validateFieldValues(defs, body.fields as Record<string, unknown>);
    if (missing.length) fail(400, `These fields are required: ${missing.join(", ")}.`);
    patch.fields = values;
  }

  if (body.status != null) {
    const status = requireOneOf(body.status, POST_STATUSES, "status");
    patch.status = status;
    if (status === "published" && !post!.publishedAt) {
      patch.publishedAt = new Date().toISOString();
    }
  }

  // Editing a generated draft makes it guide-edited, which is what the metrics
  // split is measuring: how much human work each article needed.
  if (post!.origin === "generative" && (patch.blocks || patch.title || patch.summary)) {
    patch.origin = "guide_edited";
  }

  // Working on an unclaimed draft claims it.
  if (post!.ownerEmail === null) patch.ownerEmail = user.email;

  await updatePost(post!.id, patch);
  return c.json({ post: await getPost(post!.id) });
});

// DELETE /posts/:id/comments/:commentId — moderation hides, never erases.
admin.delete("/posts/:id/comments/:commentId", requireEditor, async (c) => {
  const user = c.get("user");
  const post = await getPost(c.req.param("id"));
  if (!post) fail(404, "That article does not exist.");
  assertMayEdit(post!, user.email, user.role);

  await hideComment(post!.id, c.req.param("commentId"));
  return c.json({ ok: true });
});

// ── People ───────────────────────────────────────────────────────────────────

admin.get("/users", requireAdmin, async (c) => {
  const [editors, admins] = await Promise.all([listByRole("editor"), listByRole("admin")]);
  return c.json({
    staff: [...admins, ...editors].map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      displayName: u.displayName,
      lastLoginAt: u.lastLoginAt,
    })),
  });
});

// POST /users/role — grant or revoke editor access.
admin.post("/users/role", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const email = requireEmail(body.email);
  const role = requireOneOf(body.role, ["voter", "editor", "admin"] as const, "role");

  if (email === actor.email && role !== "admin") {
    fail(400, "You cannot remove your own admin access.");
  }

  // Creates the account if this person has never signed in, so access can be
  // granted before their first visit.
  const target = (await getUserByEmail(email)) ?? (await ensureUser(email));
  await setRole(target.id, role);

  if (role === "editor" && target.role !== "editor") {
    const { subject, html, text } = editorInviteEmail(actor.displayName || actor.email);
    // A failed invitation must not undo a granted permission.
    await sendEmail({ to: email, subject, html, text }).catch((err) => {
      console.error("[admin] invite email failed", err);
    });
  }

  return c.json({ ok: true, email, role });
});

// ── Field registry ───────────────────────────────────────────────────────────

admin.get("/fields", requireEditor, async (c) => c.json({ fields: await listFields(true) }));

admin.put("/fields/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const field = await upsertField({
    id,
    label: requireString(body.label, "label", 80),
    type: requireOneOf(body.type, FIELD_TYPES, "type"),
    options: Array.isArray(body.options) ? body.options.map((o: unknown) => String(o)) : [],
    required: body.required === true,
    publicVisible: body.publicVisible !== false,
    order: Number(body.order) || 999,
    active: body.active !== false,
  });

  return c.json({ field });
});

// Deactivate rather than delete, so published articles keep their values.
admin.delete("/fields/:id", requireAdmin, async (c) => {
  await deactivateField(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Sources and the pipeline ─────────────────────────────────────────────────

admin.get("/sources", requireAdmin, async (c) => c.json({ sources: await listSources() }));

admin.put("/sources/:id", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source = await upsertSource({ ...body, id: c.req.param("id") });
  return c.json({ source });
});

// POST /sweep — read the sources now instead of waiting for the timer.
admin.post("/sweep", requireAdmin, async (c) => c.json({ reports: await sweepAll() }));

admin.get("/queue", requireAdmin, async (c) => {
  const pending = await listPendingRawItems(50);
  return c.json({
    pending: pending.map((i) => ({
      id: i.id,
      sourceId: i.sourceId,
      title: i.title,
      fetchedAt: i.fetchedAt,
      status: i.status,
    })),
  });
});

// ── Quiz questions ───────────────────────────────────────────────────────────

admin.get("/quiz", requireAdmin, async (c) => c.json({ questions: await listQuestions() }));

admin.put("/quiz/:id", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const options = Array.isArray(body.options) ? body.options : [];
  if (options.length < 2) fail(400, "A question needs at least two options.");

  const question = await upsertQuestion({
    id: c.req.param("id"),
    prompt: requireString(body.prompt, "prompt", 300),
    options: options.slice(0, 6).map((o: any) => ({
      label: String(o.label ?? "").slice(0, 200),
      // Clamped: a weight outside this range would distort every average.
      weight: Math.max(-1, Math.min(1, Number(o.weight) || 0)),
    })),
    active: body.active !== false,
    order: Number(body.order) || 999,
  });

  return c.json({ question });
});

// ── Legal documents ──────────────────────────────────────────────────────────

admin.get("/legal", requireAdmin, async (c) => c.json({ docs: await listLegalDocs() }));

admin.put("/legal/:id", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const doc = await upsertLegalDoc({
    id: c.req.param("id"),
    title: requireString(body.title, "title", 200),
    audience: body.audience ?? null,
    bodyMarkdown: requireString(body.bodyMarkdown, "bodyMarkdown", 50_000),
    version: String(body.version ?? new Date().toISOString().slice(0, 10)),
  });
  return c.json({ doc });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

// GET /metrics — how much of the site is machine-written, how much is human,
// and how much engagement each kind actually earns.
admin.get("/metrics", requireAdmin, async (c) => {
  const posts = await listPosts(null, 1000);

  const blank = () => ({ count: 0, published: 0, likes: 0, dislikes: 0, comments: 0 });
  const byOrigin = {
    generative: blank(),
    organic: blank(),
    guide_edited: blank(),
  };

  for (const p of posts) {
    const bucket = byOrigin[p.origin] ?? byOrigin.organic;
    bucket.count++;
    if (p.status === "published") bucket.published++;
    bucket.likes += p.likeCount ?? 0;
    bucket.dislikes += p.dislikeCount ?? 0;
    bucket.comments += p.commentCount ?? 0;
  }

  const byStatus: Record<string, number> = {};
  for (const p of posts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

  // Reading the users collection directly: the ideology split is the whole
  // point of the quiz and there is no cheaper aggregate for it.
  const users = await fsList<{ ideologyScore: number | null; citizenKind: string | null }>(
    COL.users,
  );
  const scored = users.filter((u) => typeof u.ideologyScore === "number");

  return c.json({
    posts: { total: posts.length, byOrigin, byStatus },
    people: {
      total: users.length,
      byKind: users.reduce<Record<string, number>>((acc, u) => {
        const k = u.citizenKind ?? "sin_responder";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      ideology: {
        answered: scored.length,
        left: scored.filter((u) => (u.ideologyScore ?? 0) < -0.2).length,
        centre: scored.filter((u) => Math.abs(u.ideologyScore ?? 0) <= 0.2).length,
        right: scored.filter((u) => (u.ideologyScore ?? 0) > 0.2).length,
      },
    },
  });
});

export default admin;
