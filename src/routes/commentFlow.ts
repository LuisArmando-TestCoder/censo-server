// ── Posting a comment ────────────────────────────────────────────────────────
// The rules a comment passes on its way in — length, replies pointing at a real
// parent, whether this account is currently allowed to speak, the fast screen,
// the strike, and the model's slower second opinion — are the same whether the
// comment hangs off a note or a law.
//
// They live here for one reason: they must not be able to disagree. Copied into
// a second route, the copy that nobody remembers to update becomes the way
// around the rule, and the failure is silent — a blocked account commenting
// freely somewhere else on the site.

import type { Context } from "hono";
import type { CommentParent } from "../db/comments.ts";
import { addComment, listComments, rejectComment, setCommentTone } from "../db/comments.ts";
import { addCommentStrike, commentStanding, getUser, isAdult } from "../db/users.ts";
import { type Screening, screenLocally, screenWithModel } from "../intelligence/moderator.ts";
import { fail, requireString, stripHtml } from "../lib/validate.ts";
import type { User } from "../types.ts";

/**
 * Who this reader is, for the purposes of the comment thread.
 *
 * The session token carries a role but not an age, and it outlives changes to
 * the profile, so eligibility is read from the user record on each request. A
 * token issued before someone entered a birth year must not keep them locked
 * out, and a token cannot be edited to claim adulthood.
 */
export async function commentViewer(
  session: { id: string } | null,
): Promise<{ id: string; canSeeControversial: boolean } | null> {
  if (!session) return null;
  const user = await getUser(session.id);
  if (!user) return null;
  return { id: user.id, canSeeControversial: isAdult(user) };
}

/** The longest a comment may be. */
export const MAX_COMMENT = 1200;

/**
 * Runs the model pass after the response has gone out.
 *
 * Deliberately not awaited by the handler. Screening drives a browser and takes
 * about half a minute, and a comment box that hangs that long is a comment box
 * nobody uses. Failure here is logged and dropped: the deterministic verdict
 * already applied, so the worst outcome is that a borderline comment keeps the
 * rating the fast pass gave it.
 */
export function rescreenInBackground(
  parent: CommentParent,
  commentId: string,
  text: string,
  local: Screening,
): void {
  queueMicrotask(async () => {
    try {
      const final = await screenWithModel(text, local);
      if (final.verdict === local.verdict) return;

      if (final.verdict === "junk") {
        await rejectComment(parent, commentId);
      } else {
        await setCommentTone(parent, commentId, final.verdict);
      }
    } catch (err) {
      console.warn(`[comments] re-screening ${commentId} failed: ${err}`);
    }
  });
}

/**
 * Takes one comment for a subject that has already been confirmed to exist.
 *
 * The caller checks the subject first, because only it knows what "exists"
 * means: a note has to be published, a law only has to be in the catalogue.
 */
export async function postComment(
  c: Context,
  parent: CommentParent,
): Promise<Response> {
  const user = c.get("user");

  const body = await c.req.json().catch(() => ({}));
  const text = stripHtml(requireString(body.body, "body", MAX_COMMENT));
  if (!text) fail(400, "Write something before sending.");

  // A reply names the comment it answers. The parent has to exist in this
  // thread: without the check, any id would be accepted and the reply would
  // vanish from the tree, since a node with no findable parent has nowhere to
  // hang.
  let parentId: string | null = null;
  if (typeof body.parentId === "string" && body.parentId) {
    const existing = await listComments(parent);
    if (!existing.some((x) => x.id === body.parentId)) {
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
    parent,
    user.id,
    user.displayName,
    text,
    local.verdict,
    parentId,
  );

  rescreenInBackground(parent, comment.id, text, local);

  // Authors always see their own words, so this goes back unlocked even when it
  // was filed as controversial. The tone still travels, so the client can say
  // it was marked and explain why other readers will see a blur.
  return c.json({ comment: { ...comment, locked: false } }, 201);
}
