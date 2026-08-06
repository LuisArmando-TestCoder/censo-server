// ── Public reading + reacting ────────────────────────────────────────────────
// Reading needs no account. Liking, disliking, and commenting need one, and
// return 401 so the client can open the login view and replay the action.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.ts";
import { fail, requireOneOf, requireString, stripHtml } from "../lib/validate.ts";
import {
  addComment,
  getPost,
  getPostBySlug,
  listComments,
  listPosts,
  reactionsForUser,
  rejectComment,
  setCommentTone,
  setReaction,
  viewComments,
} from "../db/posts.ts";
import { listActiveFields } from "../db/fields.ts";
import { addCommentStrike, commentStanding, getUser, isAdult } from "../db/users.ts";
import { type Screening, screenLocally, screenWithModel } from "../intelligence/moderator.ts";

import type { Post, ReactionKind, User } from "../types.ts";

const posts = new Hono<AppEnv>();

const REACTION_KINDS = ["like", "dislike"] as const;
const MAX_COMMENT = 1200;

/**
 * Strips everything a reader has no business seeing. Editor-only registry
 * fields are filtered by the registry's own visibility flag, so hiding a field
 * is a configuration change rather than a code change.
 */
function publicPost(post: Post, visibleFieldIds: Set<string>) {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(post.fields ?? {})) {
    if (visibleFieldIds.has(k)) fields[k] = v;
  }
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    blocks: post.blocks,
    fields,
    origin: post.origin,
    sourceUrls: post.sourceUrls,
    citations: post.citations ?? [],
    likeCount: post.likeCount,
    dislikeCount: post.dislikeCount,
    commentCount: post.commentCount,
    publishedAt: post.publishedAt,
  };
}

async function visibleFieldIds(): Promise<Set<string>> {
  const defs = await listActiveFields();
  return new Set(defs.filter((f) => f.publicVisible).map((f) => f.id));
}

/**
 * Who this reader is, for the purposes of the comment thread.
 *
 * The session token carries a role but not an age, and it outlives changes to
 * the profile, so eligibility is read from the user record on each request. A
 * token issued before someone entered a birth year must not keep them locked
 * out, and a token cannot be edited to claim adulthood.
 */
async function commentViewer(
  session: { id: string } | null,
): Promise<{ id: string; canSeeControversial: boolean } | null> {
  if (!session) return null;
  const user = await getUser(session.id);
  if (!user) return null;
  return { id: user.id, canSeeControversial: isAdult(user) };
}

/**
 * Runs the model pass after the response has gone out.
 *
 * Deliberately not awaited by the handler. Screening drives a browser and takes
 * about half a minute, and a comment box that hangs that long is a comment box
 * nobody uses. Failure here is logged and dropped: the deterministic verdict
 * already applied, so the worst outcome is that a borderline comment keeps the
 * rating the fast pass gave it.
 */
function rescreenInBackground(
  postId: string,
  commentId: string,
  text: string,
  local: Screening,
): void {
  queueMicrotask(async () => {
    try {
      const final = await screenWithModel(text, local);
      if (final.verdict === local.verdict) return;

      if (final.verdict === "junk") {
        await rejectComment(postId, commentId);
      } else {
        await setCommentTone(postId, commentId, final.verdict);
      }
    } catch (err) {
      console.warn(`[comments] re-screening ${commentId} failed: ${err}`);
    }
  });
}

// GET / — the feed. Published posts only, newest first.
posts.get("/", optionalAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);
  const rows = await listPosts("published", limit);
  const visible = await visibleFieldIds();

  const user = c.get("user");
  const myReactions = user ? await reactionsForUser(rows.map((p) => p.id), user.id) : {};

  return c.json({
    posts: rows.map((p) => publicPost(p, visible)),
    myReactions,
  });
});

// GET /:slug — one article.
posts.get("/:slug", optionalAuth, async (c) => {
  const post = await getPostBySlug(c.req.param("slug"));
  if (!post || post.status !== "published") fail(404, "That article does not exist.");

  const visible = await visibleFieldIds();
  const user = c.get("user");
  const mine = user ? await reactionsForUser([post!.id], user.id) : {};

  return c.json({
    post: publicPost(post!, visible),
    myReaction: mine[post!.id] ?? null,
    comments: viewComments(await listComments(post!.id), await commentViewer(user ?? null)),
  });
});

// POST /:id/reaction — like or dislike. Pressing the same button again undoes it.
posts.post("/:id/reaction", requireAuth, async (c) => {
  const user = c.get("user");
  const postId = c.req.param("id");

  const post = await getPost(postId);
  if (!post || post.status !== "published") fail(404, "That article does not exist.");

  const body = await c.req.json().catch(() => ({}));
  const kind = requireOneOf(body.kind, REACTION_KINDS, "kind") as ReactionKind;

  const result = await setReaction(postId, user.id, kind);
  const fresh = await getPost(postId);

  return c.json({
    myReaction: result.kind,
    likeCount: fresh?.likeCount ?? 0,
    dislikeCount: fresh?.dislikeCount ?? 0,
  });
});

// POST /:id/comments — say something. Markup is stripped, never rendered raw.
posts.post("/:id/comments", requireAuth, async (c) => {
  const user = c.get("user");
  const postId = c.req.param("id");

  const post = await getPost(postId);
  if (!post || post.status !== "published") fail(404, "That article does not exist.");

  const body = await c.req.json().catch(() => ({}));
  const text = stripHtml(requireString(body.body, "body", MAX_COMMENT));
  if (!text) fail(400, "Write something before sending.");

  // A reply names the comment it answers. The parent has to exist in this
  // thread: without the check, any id would be accepted and the reply would
  // vanish from the tree, since a node with no findable parent has nowhere to
  // hang.
  let parentId: string | null = null;
  if (typeof body.parentId === "string" && body.parentId) {
    const thread = await listComments(postId);
    if (!thread.some((x) => x.id === body.parentId)) {
      fail(400, "That comment is no longer here.");
    }
    parentId = body.parentId;
  }


  // Read the stored record rather than trusting the token: strikes accumulate
  // after it was issued, so a blocked person still holds a valid session.
  const record = await getUser(user.id);
  if (!record) fail(401, "Your session is no longer valid. Sign in again.");

  const standing = await commentStanding(record as User);
  if (!standing.allowed) {
    return c.json({
      error: "Su cuenta tiene pausados los comentarios por ahora.",
      blockedUntil: standing.until,
    }, 429);
  }

  const local = screenLocally(text);
  if (local.verdict === "junk") {
    const blockedUntil = await addCommentStrike(record as User);
    // 422 rather than 400: the request was well formed, the content is what
    // failed. The client shows the reason next to the box and keeps the draft.
    return c.json({ error: local.reason, rejected: true, blockedUntil }, 422);
  }

  const comment = await addComment(
    postId,
    user.id,
    user.displayName,
    text,
    local.verdict,
    parentId,
  );

  rescreenInBackground(postId, comment.id, text, local);

  // Authors always see their own words, so this goes back unlocked even when it
  // was filed as controversial. The tone still travels, so the client can say
  // it was marked and explain why other readers will see a blur.
  return c.json({ comment: { ...comment, locked: false } }, 201);
});

export default posts;
