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
import { postCommentParent, postDoc } from "../db/paths.ts";
import { recordView } from "../db/views.ts";
import { commentViewer, postComment } from "./commentFlow.ts";
import { type Screening, screenLocally, screenWithModel } from "../intelligence/moderator.ts";

import type { Post, ReactionKind, User } from "../types.ts";

const posts = new Hono<AppEnv>();

const REACTION_KINDS = ["like", "dislike"] as const;
const MAX_COMMENT = 1200;

// --- Cache variables for visible fields ---
let cachedVisibleFields: Set<string> | null = null;
let fieldsCacheTime = 0;
const FIELDS_CACHE_TTL_MS = 60 * 1000; // 1 minute TTL

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
    likeCount: Math.max(0, post.likeCount ?? 0),
    dislikeCount: Math.max(0, post.dislikeCount ?? 0),
    commentCount: Math.max(0, post.commentCount ?? 0),
    viewCount: Math.max(0, post.viewCount ?? 0),
    publishedAt: post.publishedAt,
  };
}

/**
 * Cached version of visibleFieldIds to prevent hitting the database 
 * for configuration fields on every single feed/article request.
 */
async function visibleFieldIds(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedVisibleFields && now - fieldsCacheTime < FIELDS_CACHE_TTL_MS) {
    return cachedVisibleFields;
  }

  const defs = await listActiveFields();
  cachedVisibleFields = new Set(defs.filter((f) => f.publicVisible).map((f) => f.id));
  fieldsCacheTime = now;
  
  return cachedVisibleFields;
}

// GET / — the feed. Published posts only, newest first.
posts.get("/", optionalAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);
  
  // Fetch posts and visible fields concurrently
  const [rows, visible] = await Promise.all([
    listPosts("published", limit),
    visibleFieldIds()
  ]);

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

  const user = c.get("user");

  // Fetch all secondary data completely in parallel
  const [visible, mine, comments, viewer] = await Promise.all([
    visibleFieldIds(),
    user ? reactionsForUser([post.id], user.id) : Promise.resolve({} as Record<string, any>),
    listComments(post.id),
    commentViewer(user ?? null)
  ]);

  return c.json({
    post: publicPost(post, visible),
    myReaction: mine[post.id] ?? null,
    comments: viewComments(comments, viewer),
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
  
  // Re-fetch the post to get the updated counters since ReactionResult 
  // does not return them.
  const fresh = await getPost(postId);

  return c.json({
    myReaction: result.kind,
    likeCount: Math.max(0, fresh?.likeCount ?? 0),
    dislikeCount: Math.max(0, fresh?.dislikeCount ?? 0),
  });
});

// POST /:id/view — one person opened this note. Anonymous on purpose; see
// db/views.ts for why this is not folded into the GET.
posts.post("/:id/view", async (c) => {
  const viewPromise = recordView(postDoc(c.req.param("id"))).catch(() => {});
  
  // Non-blocking analytics: uses standard serverless WaitUntil if available, 
  // otherwise just fires-and-forgets in standard Node.js
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(viewPromise);
  } else {
    viewPromise;
  }
  
  return c.body(null, 204);
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