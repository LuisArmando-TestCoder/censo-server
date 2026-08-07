// ── Posts, reactions, comments ───────────────────────────────────────────────
// A reaction is one document per user per post, so voting twice is a no-op
// rather than a double count. The like/dislike totals on the post are a cached
// derivative maintained with atomic increments, never a read-modify-write.

import {
  fsCount,
  fsDelete,
  fsGet,
  fsList,
  fsQuery,
  fsQuerySorted,
  fsSet,
  fsUpdate,
} from "./firestore.ts";

// Namespaced because `comments` is also a natural local name for a list of
// them, and one of those shadowing the other reads as a bug.
import * as thread from "./comments.ts";
import { publish } from "../lib/events.ts";
import {
  COL,
  commentsCol,
  postCommentParent,
  postDoc,
  reactionDoc,
  reactionsCol,
} from "./paths.ts";
import { randomId } from "../lib/validate.ts";
import { slugify } from "../lib/hash.ts";
import type {
  Citation,
  Comment,
  CommentTone,
  Post,
  PostBlock,
  PostOrigin,
  PostStatus,
  Reaction,
  ReactionKind,
} from "../types.ts";

export async function getPost(id: string): Promise<Post | null> {
  return await fsGet<Post>(postDoc(id));
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const rows = await fsQuery<Post>(COL.posts, {
    where: [{ field: "slug", op: "EQUAL", value: slug }],
    limit: 1,
  });
  return rows[0] ?? null;
}

export interface CreatePostInput {
  title: string;
  summary: string;
  blocks: PostBlock[];
  fields?: Record<string, unknown>;
  origin: PostOrigin;
  status: PostStatus;
  ownerEmail: string | null;
  rawItemId?: string | null;
  sourceUrls?: string[];
  citations?: Citation[];
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  const id = randomId(12);
  const now = new Date().toISOString();
  const post: Post = {
    id,
    slug: slugify(input.title, id.slice(0, 6)),
    title: input.title,
    summary: input.summary,
    blocks: input.blocks,
    fields: input.fields ?? {},
    origin: input.origin,
    status: input.status,
    ownerEmail: input.ownerEmail,
    rawItemId: input.rawItemId ?? null,
    sourceUrls: input.sourceUrls ?? [],
    citations: input.citations ?? [],
    likeCount: 0,

    dislikeCount: 0,
    commentCount: 0,
    viewCount: 0,
    publishedAt: input.status === "published" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  await fsSet(postDoc(id), post as unknown as Record<string, unknown>);
  return post;
}

export async function updatePost(id: string, patch: Partial<Post>): Promise<void> {
  await fsUpdate(postDoc(id), {
    ...(patch as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

export async function listPosts(
  status: PostStatus | null,
  limit = 50,
): Promise<Post[]> {
  return await fsQuerySorted<Post>(COL.posts, {
    ...(status ? { where: [{ field: "status", op: "EQUAL", value: status }] } : {}),
    sortBy: "createdAt",
    desc: true,
    limit,
  });
}

export async function listPostsByOwner(email: string, limit = 100): Promise<Post[]> {
  return await fsQuerySorted<Post>(COL.posts, {
    where: [{ field: "ownerEmail", op: "EQUAL", value: email }],
    sortBy: "createdAt",
    desc: true,
    limit,
  });
}

// ── Reactions ────────────────────────────────────────────────────────────────

export async function getReaction(postId: string, userId: string): Promise<Reaction | null> {
  return await fsGet<Reaction>(reactionDoc(postId, userId));
}

export interface ReactionResult {
  kind: ReactionKind | null; // where the user ended up; null means they undid it
  likeDelta: number;
  dislikeDelta: number;
  likeCount: number;
  dislikeCount: number;
}

/**
 * Applies a vote and returns how the totals moved. Pressing the same button
 * twice removes the vote; pressing the other one switches it. Because state
 * lives in a per-user document, a replayed request lands on the same result.
 */
export async function setReaction(
  postId: string,
  userId: string,
  kind: ReactionKind,
): Promise<ReactionResult> {
  const existing = await getReaction(postId, userId);

  let result: Omit<ReactionResult, "likeCount" | "dislikeCount">;
  if (!existing) {
    await fsSet(reactionDoc(postId, userId), {
      userId,
      kind,
      createdAt: new Date().toISOString(),
    });
    result = {
      kind,
      likeDelta: kind === "like" ? 1 : 0,
      dislikeDelta: kind === "dislike" ? 1 : 0,
    };
  } else if (existing.kind === kind) {
    await fsDelete(reactionDoc(postId, userId));
    result = {
      kind: null,
      likeDelta: kind === "like" ? -1 : 0,
      dislikeDelta: kind === "dislike" ? -1 : 0,
    };
  } else {
    await fsUpdate(reactionDoc(postId, userId), { kind });
    result = {
      kind,
      likeDelta: kind === "like" ? 1 : -1,
      dislikeDelta: kind === "dislike" ? 1 : -1,
    };
  }

  // Recount on write to prevent drift
  const [likeCount, dislikeCount] = await Promise.all([
    fsCount(reactionsCol(postId), [{ field: "kind", op: "EQUAL", value: "like" }]),
    fsCount(reactionsCol(postId), [{ field: "kind", op: "EQUAL", value: "dislike" }]),
  ]);

  await fsUpdate(postDoc(postId), { likeCount, dislikeCount });
  
  const deltas: Record<string, number> = {};
  if (result.likeDelta) deltas.likeCount = result.likeDelta;
  if (result.dislikeDelta) deltas.dislikeCount = result.dislikeDelta;
  if (Object.keys(deltas).length) {
    // Only the deltas travel, so a reader who is looking at this note sees the
    // bar move by exactly what changed, without anyone re-reading the document.
    publish({ kind: "post", id: postId, deltas });
  }

  return { ...result, likeCount, dislikeCount };
}

/** Which posts, out of the given ids, this reader already voted on. */
export async function reactionsForUser(
  postIds: string[],
  userId: string,
): Promise<Record<string, ReactionKind>> {
  const entries = await Promise.all(
    postIds.map(async (id) => [id, await getReaction(id, userId)] as const),
  );
  const out: Record<string, ReactionKind> = {};
  for (const [id, r] of entries) if (r) out[id] = r.kind;
  return out;
}

// ── Comments ─────────────────────────────────────────────────────────────────
// The thread itself lives in db/comments.ts, because laws carry the same one.
// What remains here is the post-shaped way in: callers keep passing a postId
// and never have to know a path. Re-exported rather than reimplemented, so
// there is exactly one place where a comment is screened, locked or hidden.

export { viewComments } from "./comments.ts";

export function addComment(
  postId: string,
  userId: string,
  displayName: string,
  body: string,
  tone: CommentTone = "clean",
  parentId: string | null = null,
): Promise<Comment> {
  return thread.addComment(
    postCommentParent(postId),
    userId,
    displayName,
    body,
    tone,
    parentId,
  );
}

export function listComments(postId: string): Promise<Comment[]> {
  return thread.listComments(postCommentParent(postId));
}

/** Records the model's verdict on a comment already in the thread. */
export function setCommentTone(
  postId: string,
  commentId: string,
  tone: CommentTone,
): Promise<void> {
  return thread.setCommentTone(postCommentParent(postId), commentId, tone);
}

/** The model found junk after the fact. Hide it and mark it screened. */
export function rejectComment(postId: string, commentId: string): Promise<void> {
  return thread.rejectComment(postCommentParent(postId), commentId);
}

/** Moderation hides a comment rather than deleting it, preserving the record. */
export function hideComment(postId: string, commentId: string): Promise<void> {
  return thread.hideComment(postCommentParent(postId), commentId);
}

/** Recomputes the cached counters from the source of truth. */
export async function recountPost(postId: string): Promise<void> {
  const [reactions, comments] = await Promise.all([
    fsList<Reaction>(reactionsCol(postId)),
    fsList<Comment>(commentsCol(postId)),
  ]);
  await fsUpdate(postDoc(postId), {
    likeCount: reactions.filter((r) => r.kind === "like").length,
    dislikeCount: reactions.filter((r) => r.kind === "dislike").length,
    commentCount: comments.filter((c) => !c.hidden).length,
  });
}
