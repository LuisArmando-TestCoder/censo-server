// ── Ideological quiz ─────────────────────────────────────────────────────────
// One question at a time, shown occasionally rather than as a wall of a form.
// The score is a running average of the weights a person picked, from -1 (left)
// to +1 (right), so it sharpens as they answer more without ever being final.

import { fsList, fsSet, fsUpdate } from "./firestore.ts";
import { COL, quizAnswerDoc, quizAnswersCol, quizQuestionDoc, userDoc } from "./paths.ts";
import type { QuizAnswer, QuizQuestion, User } from "../types.ts";

/** How long to wait before asking the same person another question. */
export const QUIZ_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const SEED: QuizQuestion[] = [
  {
    id: "impuestos-servicios",
    prompt: "¿Qué prefiere para el país?",
    options: [
      { label: "Pagar más impuestos y tener más servicios públicos", weight: -1 },
      { label: "Pagar menos impuestos aunque haya menos servicios", weight: 1 },
      { label: "Dejar las cosas como están", weight: 0 },
    ],
    active: true,
    order: 10,
  },
  {
    id: "empresas-estado",
    prompt: "¿Quién debería manejar servicios como la electricidad y el agua?",
    options: [
      { label: "El Estado", weight: -1 },
      { label: "Empresas privadas", weight: 1 },
      { label: "Los dos, compitiendo", weight: 0 },
    ],
    active: true,
    order: 20,
  },
  {
    id: "seguridad-penas",
    prompt: "Para bajar la delincuencia, ¿qué funciona mejor?",
    options: [
      { label: "Penas más duras y más policía", weight: 1 },
      { label: "Empleo y educación en los barrios", weight: -1 },
      { label: "Las dos cosas por igual", weight: 0 },
    ],
    active: true,
    order: 30,
  },
  {
    id: "gasto-publico",
    prompt: "Si sobra plata en el presupuesto, ¿en qué se debería gastar primero?",
    options: [
      { label: "Salud y educación", weight: -1 },
      { label: "Bajar la deuda del país", weight: 1 },
      { label: "Infraestructura y carreteras", weight: 0 },
    ],
    active: true,
    order: 40,
  },
  {
    id: "migracion",
    prompt: "Sobre las personas que llegan a vivir a Costa Rica:",
    options: [
      { label: "Deberían poder trabajar y estudiar aquí más fácil", weight: -1 },
      { label: "Deberían tener más requisitos para entrar", weight: 1 },
      { label: "Las reglas actuales están bien", weight: 0 },
    ],
    active: true,
    order: 50,
  },
];

function normalize(raw: Partial<QuizQuestion> & { _id?: string }): QuizQuestion {
  return {
    id: raw.id ?? raw._id ?? "",
    prompt: raw.prompt ?? "",
    options: Array.isArray(raw.options) ? raw.options : [],
    active: raw.active ?? true,
    order: raw.order ?? 999,
  };
}

export async function listQuestions(): Promise<QuizQuestion[]> {
  const rows = await fsList<Partial<QuizQuestion>>(COL.quizQuestions);
  return rows.map(normalize).sort((a, b) => a.order - b.order);
}

export async function upsertQuestion(
  input: Partial<QuizQuestion> & { id: string },
): Promise<QuizQuestion> {
  const q = normalize(input);
  await fsSet(quizQuestionDoc(q.id), q as unknown as Record<string, unknown>);
  return q;
}

export async function listAnswers(userId: string): Promise<QuizAnswer[]> {
  return await fsList<QuizAnswer>(quizAnswersCol(userId));
}

/**
 * The next active question this person has not answered, or null when they have
 * answered them all or were asked recently. Returning null is the normal case:
 * the modal should be a rare interruption, not a toll gate.
 */
export async function nextQuestionFor(user: User): Promise<QuizQuestion | null> {
  if (user.lastQuizPromptAt) {
    const since = Date.now() - new Date(user.lastQuizPromptAt).getTime();
    if (since < QUIZ_COOLDOWN_MS) return null;
  }

  const [questions, answers] = await Promise.all([listQuestions(), listAnswers(user.id)]);
  const answered = new Set(answers.map((a) => a.questionId));
  return questions.find((q) => q.active && !answered.has(q.id)) ?? null;
}

export interface ScoreUpdate {
  ideologyScore: number;
  ideologyAnswers: number;
}

/**
 * Records an answer and returns the person's new position. Re-answering the
 * same question overwrites rather than double counting, so the average stays
 * honest even if a request is replayed.
 */
export async function recordAnswer(
  user: User,
  question: QuizQuestion,
  optionIndex: number,
): Promise<ScoreUpdate> {
  const weight = question.options[optionIndex].weight;

  const answer: QuizAnswer = {
    questionId: question.id,
    optionIndex,
    weight,
    answeredAt: new Date().toISOString(),
  };
  await fsSet(
    quizAnswerDoc(user.id, question.id),
    answer as unknown as Record<string, unknown>,
  );

  const all = await listAnswers(user.id);
  const total = all.reduce((sum, a) => sum + (a.weight ?? 0), 0);
  const update: ScoreUpdate = {
    ideologyScore: all.length ? total / all.length : 0,
    ideologyAnswers: all.length,
  };

  await fsUpdate(userDoc(user.id), update as unknown as Record<string, unknown>);
  return update;
}

/** Notes that we asked, so the cooldown starts even if the person dismisses it. */
export async function markPrompted(userId: string): Promise<void> {
  await fsUpdate(userDoc(userId), { lastQuizPromptAt: new Date().toISOString() });
}

/** Idempotent: writes only the questions that are not there yet. */
export async function seedQuestions(): Promise<number> {
  const existing = new Set((await listQuestions()).map((q) => q.id));
  let written = 0;
  for (const q of SEED) {
    if (existing.has(q.id)) continue;
    await fsSet(quizQuestionDoc(q.id), q as unknown as Record<string, unknown>);
    written++;
  }
  return written;
}
