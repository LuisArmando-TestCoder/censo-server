// ── The occasional question ──────────────────────────────────────────────────
// The client asks whether there is a question pending. Most of the time the
// answer is no, which is deliberate: this is a small interruption now and then,
// not a gate in front of the content.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { requireAuth } from "../middleware/auth.ts";
import { fail } from "../lib/validate.ts";
import { listAnswers, markPrompted, nextQuestionFor, recordAnswer } from "../db/quiz.ts";
import { listQuestions } from "../db/quiz.ts";

const quiz = new Hono<AppEnv>();

// GET /next — the pending question, or null.
quiz.get("/next", requireAuth, async (c) => {
  const user = c.get("user");
  const question = await nextQuestionFor(user);
  if (!question) return c.json({ question: null });

  // The cooldown starts as soon as we ask, so dismissing it is respected.
  await markPrompted(user.id);

  return c.json({
    question: {
      id: question.id,
      prompt: question.prompt,
      // Weights stay on the server. Showing them would tell people how to
      // score themselves and turn the answers into noise.
      options: question.options.map((o) => o.label),
    },
  });
});

// POST /answer — record one answer and return the updated position.
quiz.post("/answer", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const questionId = String(body.questionId ?? "");
  const optionIndex = Number(body.optionIndex);

  const question = (await listQuestions()).find((q) => q.id === questionId);
  if (!question) fail(404, "That question does not exist.");
  if (
    !Number.isInteger(optionIndex) || optionIndex < 0 ||
    optionIndex >= question!.options.length
  ) {
    fail(400, "Pick one of the given options.");
  }

  const score = await recordAnswer(user, question!, optionIndex);
  return c.json({ ok: true, ...score });
});

// GET /me — what this person has answered so far.
quiz.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const answers = await listAnswers(user.id);
  return c.json({
    ideologyScore: user.ideologyScore,
    ideologyAnswers: user.ideologyAnswers,
    answered: answers.map((a) => a.questionId),
  });
});

export default quiz;
