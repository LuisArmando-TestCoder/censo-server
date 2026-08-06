// ── Collection paths ─────────────────────────────────────────────────────────
// Every Firestore path in the app is built here, so a rename is one edit and
// no route can invent a stray collection.

export const COL = {
  users: "users",
  otps: "otps",
  sources: "sources",
  rawItems: "raw_items",
  wings: "wings",
  pipelineRuns: "pipeline_runs",
  posts: "posts",
  fieldRegistry: "field_registry",
  quizQuestions: "quiz_questions",
  legalDocs: "legal_docs",
} as const;

export const userDoc = (id: string) => `${COL.users}/${id}`;
export const otpDoc = (email: string) => `${COL.otps}/${encodeURIComponent(email)}`;
export const sourceDoc = (id: string) => `${COL.sources}/${id}`;
export const rawItemDoc = (id: string) => `${COL.rawItems}/${id}`;
export const wingDoc = (id: string) => `${COL.wings}/${id}`;
export const roomsCol = (wingId: string) => `${wingDoc(wingId)}/rooms`;
export const roomDoc = (wingId: string, roomId: string) => `${roomsCol(wingId)}/${roomId}`;
export const pipelineRunDoc = (id: string) => `${COL.pipelineRuns}/${id}`;
export const postDoc = (id: string) => `${COL.posts}/${id}`;
export const reactionsCol = (postId: string) => `${postDoc(postId)}/reactions`;
export const reactionDoc = (postId: string, userId: string) => `${reactionsCol(postId)}/${userId}`;
export const commentsCol = (postId: string) => `${postDoc(postId)}/comments`;
export const commentDoc = (postId: string, commentId: string) =>
  `${commentsCol(postId)}/${commentId}`;
export const fieldDoc = (id: string) => `${COL.fieldRegistry}/${id}`;
export const quizQuestionDoc = (id: string) => `${COL.quizQuestions}/${id}`;
export const quizAnswersCol = (userId: string) => `${userDoc(userId)}/quiz_answers`;
export const quizAnswerDoc = (userId: string, questionId: string) =>
  `${quizAnswersCol(userId)}/${questionId}`;
export const legalDoc = (id: string) => `${COL.legalDocs}/${id}`;
