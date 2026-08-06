// ── Domain types ─────────────────────────────────────────────────────────────
// One place for every shape that crosses a module boundary. The frontend mirrors
// these in censo-web/src/lib/types.ts.

// ── People ───────────────────────────────────────────────────────────────────

/** What a person may do. Roles are cumulative: admin ⊃ editor ⊃ voter. */
export type Role = "voter" | "editor" | "admin";

/** How someone answered the onboarding "who are you" question. */
export type CitizenKind = "votante" | "funcionario" | "extranjero";

export interface User {
  id: string; // sha-256 of the lowercased email
  email: string;
  role: Role;
  displayName: string;
  citizenKind: CitizenKind | null;
  /**
   * Cédula, digits only, format-checked but NOT verified against the padrón.
   * No public API exists to confirm it, so nothing in the product may present
   * this as proof of identity.
   */
  cedula: string | null;
  /**
   * Running ideological position from the quiz, -1 (left) to +1 (right), plus
   * how many answers it is based on. Null until the first answer lands.
   */
  ideologyScore: number | null;
  ideologyAnswers: number;
  /** ISO timestamp of the last quiz prompt, so we don't nag on every login. */
  lastQuizPromptAt: string | null;
  /**
   * Year of birth, self-declared during onboarding. It gates the controversial
   * comments and nothing else, so a year is all we ask for: a full date would
   * be more personal data for no extra certainty, since neither can be checked.
   */
  birthYear: number | null;
  /**
   * Refused comments, and the point after which this person may comment again.
   * Strikes decay, so a bad afternoon does not become a permanent record.
   */
  commentStrikes: number;
  commentBlockedUntil: string | null;
  createdAt: string;
  lastLoginAt: string;
}

export interface SessionClaims {
  sub: string; // user id
  email: string;
  role: Role;
  exp: number;
}

export interface OtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
}

// ── Scraping ─────────────────────────────────────────────────────────────────

/**
 * A configured upstream list. Everything the fetcher needs lives here, so a new
 * source is a document, not a code change.
 */
/**
 * How a source is read. SharePoint lists answer a JSON API; La Gaceta publishes
 * one HTML page a day that has to be cut into items. The reader is chosen from
 * this field, so the rest of the sweep does not care which it is.
 */
export type SourceKind = "sharepoint" | "gaceta";

export interface Source {
  id: string;
  label: string;
  /** Who publishes it, as it should read in an article footnote. */
  institution: string;
  kind: SourceKind;
  /** Site root. SharePoint: https://asamblea.go.cr/p. Gaceta: the daily page. */
  siteUrl: string;

  /** SharePoint list title, e.g. "Noticias" */
  listTitle: string;
  /** Internal field names to request from the list. */
  selectFields: string[];
  /** Which selected field holds the headline. */
  titleField: string;
  /** Fields that may hold the substance, in priority order. The upstream data
   *  is inconsistent about which one is populated, so the extractor tries each. */
  bodyFields: string[];
  /** Field holding the event start, when the source is a calendar. */
  dateField: string | null;
  /** Field that may name a broadcast channel, e.g. "AsambleaCR06 (Youtube)". */
  channelField: string | null;
  enabled: boolean;
  /** Highest upstream item id already ingested. Drives the incremental sweep. */
  cursorItemId: number;
  lastSweepAt: string | null;
  lastError: string | null;
}

/** Where a referenced URL points, which decides how the agents treat it. */
export type LinkKind = "youtube" | "sharepoint" | "document" | "external";

export interface ExtractedLink {
  url: string;
  kind: LinkKind;
}

/** A verbatim upstream item. Never edited, never summarized: the drawer. */
export interface RawItem {
  id: string; // `${sourceId}__${upstreamId}`
  sourceId: string;
  upstreamId: number;
  /** sha-256 of the normalized payload. A changed hash re-opens the pipeline. */
  contentHash: string;
  title: string;
  body: string;
  links: ExtractedLink[];
  eventDate: string | null;
  channel: string | null;
  /** The untouched JSON row as returned upstream. */
  payload: Record<string, unknown>;
  fetchedAt: string;
  /** Set once a post has been generated from this item. */
  postId: string | null;
  status: "pending" | "processing" | "done" | "failed" | "needs_human";
}

// ── The palace: how raw items are filed ──────────────────────────────────────

/** A wing is a long-lived subject: a committee, a recurring topic, a person. */
export interface Wing {
  id: string;
  label: string;
  kind: "committee" | "topic" | "person" | "source";
  createdAt: string;
}

/** A room narrows a wing. Drawers (raw item ids) are filed into rooms. */
export interface Room {
  id: string;
  wingId: string;
  label: string;
  drawerIds: string[];
  createdAt: string;
}

// ── The agent pipeline ───────────────────────────────────────────────────────

export type AgentName = "extractor" | "reasoner" | "humanizer";

export interface AgentStep {
  agent: AgentName;
  iteration: number;
  prompt: string;
  output: string;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface ValidationIssue {
  rule: string;
  detail: string;
}

export interface PipelineRun {
  id: string;
  rawItemId: string;
  steps: AgentStep[];
  issues: ValidationIssue[];
  verdict: "published_draft" | "needs_human" | "failed";
  startedAt: string;
  finishedAt: string | null;
}

// ── Content ──────────────────────────────────────────────────────────────────

/** Who wrote it. Drives the admin metrics split. */
export type PostOrigin = "generative" | "organic" | "guide_edited";

export type PostStatus = "draft" | "needs_human" | "published" | "archived";

/** A block in the body. The editor composes these; the reader renders them. */
export type BlockKind = "paragraph" | "heading" | "quote" | "list" | "video" | "source_link";

export interface PostBlock {
  id: string;
  kind: BlockKind;
  /** Plain text for paragraph/heading/quote, the URL for video/source_link. */
  text: string;
  /** Items for a list block. Empty otherwise. */
  items: string[];
}

/**
 * A source, as the reader sees it at the foot of the article: what it was
 * called, who published it, when, and where to check it. A bare URL asks the
 * reader to click before they can judge whether the article rests on anything.
 */
export interface Citation {
  /** The upstream headline or document title. */
  title: string;
  /** The institution, e.g. "Asamblea Legislativa". */
  origin: string;
  /** ISO date of the event or publication. Null when upstream gives none. */
  date: string | null;
  url: string | null;
}

export interface Post {
  id: string;

  slug: string;
  title: string;
  /** One-sentence plain-language summary shown in the feed. */
  summary: string;
  blocks: PostBlock[];
  /** Values for the admin-defined field registry, keyed by field id. */
  fields: Record<string, unknown>;
  origin: PostOrigin;
  status: PostStatus;
  /** Email of the editor who owns this post. Editors may only edit their own. */
  ownerEmail: string | null;
  rawItemId: string | null;
  sourceUrls: string[];
  /** What goes in the footnote. Empty on older posts, which fall back to
   *  sourceUrls. */
  citations: Citation[];

  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReactionKind = "like" | "dislike";

/** One document per user per post, so a vote is idempotent by construction. */
export interface Reaction {
  userId: string;
  kind: ReactionKind;
  createdAt: string;
}

/**
 * How a comment reads, decided by the screening in `intelligence/moderator.ts`.
 * A clean comment sits in the thread. A controversial one is there too, but
 * blurred until a signed-in adult asks to see it. Junk never reaches storage.
 */
export type CommentTone = "clean" | "controversial";

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  displayName: string;
  body: string;
  /**
   * The comment this one answers, or null at the top of the thread. Threads are
   * stored flat and assembled into a tree by the reader: one query still brings
   * the whole conversation, and a reply whose parent was hidden can still be
   * placed rather than disappearing with it.
   */
  parentId: string | null;
  createdAt: string;

  hidden: boolean;
  tone: CommentTone;
  /** True once the model pass has run, so a sweep can skip what it already saw. */
  screened: boolean;
}

/**
 * What a reader receives. The body of a controversial comment is replaced with
 * null unless that reader is allowed to see it, so the text never reaches a
 * browser that has no right to it. Blurring in CSS alone would ship the words
 * and hide them with a filter anyone can turn off.
 */
export interface CommentView extends Omit<Comment, "body"> {
  body: string | null;
  locked: boolean;
}

// ── Admin-configurable field registry ────────────────────────────────────────

export type FieldType = "text" | "longtext" | "number" | "boolean" | "date" | "select" | "tags";

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  /** Options for a select field. Empty otherwise. */
  options: string[];
  required: boolean;
  /** Shown to readers, or editor-only metadata. */
  publicVisible: boolean;
  order: number;
  active: boolean;
}

// ── Ideological quiz ─────────────────────────────────────────────────────────

export interface QuizOption {
  label: string;
  /** Contribution to the ideology score, -1 (left) to +1 (right). */
  weight: number;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: QuizOption[];
  active: boolean;
  order: number;
}

export interface QuizAnswer {
  questionId: string;
  optionIndex: number;
  weight: number;
  answeredAt: string;
}

// ── Legal / CMS documents ────────────────────────────────────────────────────

export interface LegalDoc {
  id: string; // "privacy-votante", "community-guidelines", …
  title: string;
  /** Which reader this document addresses. Null means everyone. */
  audience: CitizenKind | "editor" | null;
  bodyMarkdown: string;
  version: string;
  updatedAt: string;
}
