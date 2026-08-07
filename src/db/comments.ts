// ── Comment threads, wherever they hang ──────────────────────────────────────
// Notes and laws both carry a discussion, and they carry the same one: same
// shape, same screening, same rules about who may read what. Only the parent
// document differs.
//
// So the parent is a parameter. This was lifted out of db/posts.ts when laws
// gained comments, rather than copied into db/laws.ts, because the alternative
// is two implementations of a moderation rule that must never disagree — and
// the one that gets forgotten is always the one that leaks. A locked comment
// staying locked is not a detail worth risking to a second copy.

import { fsCreate, fsIncrement, fsList, fsUpdate } from "./firestore.ts";
import { randomId } from "../lib/validate.ts";
import { publish, subjectFromDoc } from "../lib/events.ts";

import type { Comment, CommentTone, CommentView } from "../types.ts";

/**
 * Where a thread lives: the collection its comments sit in, and the document
 * whose counter moves when one is added or hidden.
 */
export interface CommentParent {
  col: string;
  doc: string;
  /** Names the id stored on each comment, for callers reading raw documents. */
  subjectId: string;
}

export async function addComment(
  parent: CommentParent,
  userId: string,
  displayName: string,
  body: string,
  tone: CommentTone = "clean",
  parentId: string | null = null,
): Promise<Comment> {
  const id = randomId(10);
  const comment: Comment = {
    id,
    postId: parent.subjectId,
    userId,
    displayName,
    body,
    parentId,
    createdAt: new Date().toISOString(),

    hidden: false,
    tone,
    screened: false,
  };
  await fsCreate(parent.col, id, comment as unknown as Record<string, unknown>);
  await fsIncrement(parent.doc, { commentCount: 1 });

  // The comment goes out in the form a stranger may see, which for anything
  // marked controversial means its words are withheld and only the fact of it
  // travels. Broadcasting the text and letting each client decide whether to
  // render it would put those words on every open connection, where a blur is
  // the only thing standing between them and a reader we deliberately gated.
  const subject = subjectFromDoc(parent.doc);
  if (subject) {
    publish({
      ...subject,
      deltas: { commentCount: 1 },
      comment: viewComments([comment], null)[0],
    });
  }

  return comment;
}

export async function listComments(parent: CommentParent): Promise<Comment[]> {
  const rows = await fsList<Comment>(parent.col);
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
  parent: CommentParent,
  commentId: string,
  tone: CommentTone,
): Promise<void> {
  await fsUpdate(`${parent.col}/${commentId}`, { tone, screened: true });
}

/** The model found junk after the fact. Hide it and mark it screened. */
export async function rejectComment(
  parent: CommentParent,
  commentId: string,
): Promise<void> {
  await fsUpdate(`${parent.col}/${commentId}`, { hidden: true, screened: true });
  await fsIncrement(parent.doc, { commentCount: -1 });
}

/** Moderation hides a comment rather than deleting it, preserving the record. */
export async function hideComment(
  parent: CommentParent,
  commentId: string,
): Promise<void> {
  await fsUpdate(`${parent.col}/${commentId}`, { hidden: true });
  await fsIncrement(parent.doc, { commentCount: -1 });
}
