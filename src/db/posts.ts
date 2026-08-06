// ── Posts, reactions, comments ───────────────────────────────────────────────
// A reaction is one document per user per post, so voting twice is a no-op
// rather than a double count. The like/dislike totals on the post are a cached
// derivative maintained with atomic increments, never a read-modify-write.

import {
  fsCreate,
  fsDelete,
  fsGet,
  fsIncrement,
  fsList,
  fsQuery,
  fsQuerySorted,
  fsSet,
  fsUpdate,
} from "./firestore.ts";

import { COL, commentDoc, commentsCol, postDoc, reactionDoc, reactionsCol } from "./paths.ts";
import { randomId } from "../lib/validate.ts";
import { slugify } from "../lib/hash.ts";
import type {
  Citation,
  Comment,
  CommentTone,
  CommentView,
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

  let result: ReactionResult;
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

  const deltas: Record<string, number> = {};
  if (result.likeDelta) deltas.likeCount = result.likeDelta;
  if (result.dislikeDelta) deltas.dislikeCount = result.dislikeDelta;
  if (Object.keys(deltas).length) await fsIncrement(postDoc(postId), deltas);

  return result;
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

export async function addComment(
  postId: string,
  userId: string,
  displayName: string,
  body: string,
  tone: CommentTone = "clean",
  parentId: string | null = null,
): Promise<Comment> {
  const id = randomId(10);
  const comment: Comment = {
    id,
    postId,
    userId,
    displayName,
    body,
    parentId,
    createdAt: new Date().toISOString(),

    hidden: false,
    tone,
    screened: false,
  };
  await fsCreate(commentsCol(postId), id, comment as unknown as Record<string, unknown>);
  await fsIncrement(postDoc(postId), { commentCount: 1 });
  return comment;
}

export async function listComments(postId: string): Promise<Comment[]> {
  const rows = await fsList<Comment>(commentsCol(postId));
  return rows
    .filter((r) => !r.hidden)
    // Comments written before screening existed have no tone. Treat them as
    // clean rather than blurring a thread nobody flagged.
    // Comments written before replies existed sit at the top of the thread.
    .map((r) => ({
      ...r,
      tone: r.tone ?? "clean",
      screened: r.screened ?? false,
      parentId: r.parentId ?? null,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Prepares comments for a specific reader.
 *
 * A locked comment goes out with `body: null`. The words never leave the server
 * for someone who has not passed the gate, which is the difference between a
 * real restriction and a CSS blur that any reader can remove with devtools.
 * People always see their own comments, whatever tone they were given.
 */
export function viewComments(
  comments: Comment[],
  viewer: { id: string; canSeeControversial: boolean } | null,
): CommentView[] {
  return comments.map((c) => {
    const allowed = c.tone === "clean" ||
      (viewer !== null && (viewer.canSeeControversial || viewer.id === c.userId));

    const { body: _body, ...rest } = c;
    return { ...rest, body: allowed ? c.body : null, locked: !allowed };
  });
}

/** Records the model's verdict on a comment already in the thread. */
export async function setCommentTone(
  postId: string,
  commentId: string,
  tone: CommentTone,
): Promise<void> {
  await fsUpdate(commentDoc(postId, commentId), { tone, screened: true });
}

/** The model found junk after the fact. Hide it and mark it screened. */
export async function rejectComment(postId: string, commentId: string): Promise<void> {
  await fsUpdate(commentDoc(postId, commentId), { hidden: true, screened: true });
  await fsIncrement(postDoc(postId), { commentCount: -1 });
}

/** Moderation hides a comment rather than deleting it, preserving the record. */
export async function hideComment(postId: string, commentId: string): Promise<void> {
  await fsUpdate(commentDoc(postId, commentId), { hidden: true });
  await fsIncrement(postDoc(postId), { commentCount: -1 });
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
