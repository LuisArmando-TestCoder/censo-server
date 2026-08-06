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
import { postCommentParent } from "../db/paths.ts";
import { commentViewer, postComment } from "./commentFlow.ts";
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
  const postId = c.req.param("id");

  // Checked here rather than in the shared flow: only this route knows that an
  // unpublished note is, as far as readers are concerned, not a note at all.
  const post = await getPost(postId);
  if (!post || post.status !== "published") fail(404, "That article does not exist.");

  return await postComment(c, postCommentParent(postId));
});

export default posts;
