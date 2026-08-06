// ── Output guardrail ─────────────────────────────────────────────────────────
// Model output is untrusted. Before a draft is stored, it passes these checks,
// which are deterministic on purpose: asking a second model whether the first
// one behaved just moves the trust problem around.
//
// Two families of rule:
//
//   Style, derived from .clinerules/copywritingrules.md. No em dashes, no curly
//   quotes, no promotional filler, plain sentences.
//
//   Fidelity, which is the one that actually matters here. Every URL and every
//   proper name in the output must already appear in the source. An article
//   about the legislature that invents a name is a defamation risk, so a draft
//   that does it is parked for a human rather than published.

import type { ValidationIssue } from "../types.ts";

/** Phrases from the copywriting rules that should never survive into a draft. */
const BANNED_PHRASES = [
  "cabe destacar",
  "cabe mencionar",
  "es importante señalar",
  "es importante destacar",
  "en el marco de",
  "juega un papel",
  "un hito",
  "sin lugar a dudas",
  "en resumen",
  "en conclusión",
  "es un testimonio",
  "profundizar en",
  "panorama",
  "vibrante",
  "rico en",
  "clave para entender",
  "no solo",
  "sino que también",
];

/** Bureaucratic wording the humanizer is supposed to have removed. */
const JARGON = [
  "de conformidad con",
  "en virtud de",
  "por cuanto",
  "el suscrito",
  "ut supra",
  "coadyuvar",
  "otrosí",
];

const WORDS_PER_SENTENCE_MAX = 25;

/** Small words that start a name in Spanish and are not themselves names. */
const NAME_PARTICLES = new Set([
  "de",
  "del",
  "la",
  "las",
  "los",
  "y",
  "e",
  "van",
  "von",
]);

function normalizeForCompare(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Finds the capitalized phrases that could be a person or an institution.
 *
 * Spanish capitalizes the first word of every sentence, so position decides
 * whether a capital letter means anything. A single capitalized word opening a
 * sentence is just grammar ("Quieren quitar…"); the same word in the middle of
 * one is a name. A run of two or more capitalized words is a name wherever it
 * appears, which is what catches both "Roberto Villanueva" and
 * "Comisión de Asuntos Jurídicos".
 *
 * Deciding by position beats keeping a list of ordinary words, which could
 * never be complete and would fail good drafts every time it fell short.
 */
export function properNames(text: string): string[] {
  const out = new Set<string>();
  const word = "[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}";
  const re = new RegExp(`${word}(?:\\s+(?:de|del|la|las|los|y|e)?\\s*${word})*`, "g");

  for (const match of text.matchAll(re)) {
    const phrase = match[0].trim();
    const words = phrase.split(/\s+/);
    const meaningful = words.filter((w) => !NAME_PARTICLES.has(normalizeForCompare(w)));

    if (meaningful.length === 1) {
      // Look back for the sentence boundary that would explain the capital.
      const before = text.slice(0, match.index ?? 0);
      if (/(^|[.!?:\n]\s*)$/.test(before)) continue;
    }

    out.add(phrase);
  }
  return [...out];
}

/**
 * Common Spanish words that are wrong without their accent. Each one is a real
 * word or a real error, not a guess: "anos" and "años" mean very different
 * things, and "publico" without the accent is a different tense of a different
 * verb than "público".
 */
const NEEDS_ACCENT: Record<string, string> = {
  anos: "años",
  comision: "comisión",
  comisiones: "comisiones",
  informacion: "información",
  legislacion: "legislación",
  aprobacion: "aprobación",
  votacion: "votación",
  sesion: "sesión",
  articulo: "artículo",
  // "publico" and "publica" are left out on purpose: they are also correct as
  // verbs ("la comisión publica el informe"), and a false positive here would
  // send a perfectly good draft to a human for no reason.
  economico: "económico",

  economica: "económica",
  juridico: "jurídico",
  juridica: "jurídica",
  politica: "política",
  politico: "político",
  dia: "día",
  mas: "más",
  asi: "así",
  segun: "según",
  tambien: "también",
  despues: "después",
  ademas: "además",
  paginas: "páginas",
  ultimo: "último",
  proximo: "próximo",
  numero: "número",
  telefono: "teléfono",
  credito: "crédito",
  transito: "tránsito",
  pension: "pensión",
  cedula: "cédula",
};

/**
 * Catches a draft written without Spanish accents.
 *
 * Asking the model for correct orthography in the prompt is not enough: it
 * complies on some runs and not others, and "setenta y seis anos" is not a typo
 * in Spanish, it is a different and unfortunate word. Since the pipeline feeds
 * validation issues back for one retry, catching it here turns an unreliable
 * request into an enforced rule.
 *
 * Two signals. A specific list of words that are wrong unaccented, and the
 * blunt case of a long Spanish text with no accented character anywhere, which
 * essentially never happens in real writing.
 */
export function accentProblems(text: string): string[] {
  const out: string[] = [];
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];

  const wrong = new Set<string>();
  for (const w of words) {
    const fixed = NEEDS_ACCENT[w];
    if (fixed) wrong.add(`"${w}" debe escribirse "${fixed}"`);
  }
  if (wrong.size) {
    out.push(`Faltan tildes. Corrija: ${[...wrong].join(", ")}.`);
  }

  const hasAccent = /[áéíóúüñÁÉÍÓÚÜÑ]/.test(text);
  if (!hasAccent && text.replace(/\s+/g, "").length > 200 && !wrong.size) {
    out.push(
      "El texto no tiene ni una tilde ni una ñ. Escríbalo en español correcto, con tildes.",
    );
  }
  return out;
}

export function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).map((u) => u.replace(/[.,;]+$/, ""));
}

export interface DraftUnderReview {
  title: string;
  summary: string;
  body: string;
}

/**
 * Checks a draft against its source. An empty list means it is safe to store as
 * a draft; anything else sends it back for one retry and then to a human.
 */
export function validateDraft(draft: DraftUnderReview, sourceText: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const combined = `${draft.title}\n${draft.summary}\n${draft.body}`;
  const haystack = normalizeForCompare(sourceText);

  // ── Fidelity ───────────────────────────────────────────────────────────────

  for (const name of properNames(combined)) {
    if (!haystack.includes(normalizeForCompare(name))) {
      issues.push({
        rule: "name_not_in_source",
        detail: `"${name}" does not appear in the source text.`,
      });
    }
  }

  const sourceUrls = new Set(urlsIn(sourceText).map((u) => u.toLowerCase()));
  for (const url of urlsIn(combined)) {
    if (!sourceUrls.has(url.toLowerCase())) {
      issues.push({ rule: "url_not_in_source", detail: `"${url}" is not in the source text.` });
    }
  }

  // A number that is not in the source is a fabricated figure.
  for (const match of combined.matchAll(/\b\d[\d.,]{2,}\b/g)) {
    const digits = match[0].replace(/[.,]/g, "");
    if (!haystack.replace(/[.,]/g, "").includes(digits)) {
      issues.push({
        rule: "number_not_in_source",
        detail: `The figure "${match[0]}" is not in the source text.`,
      });
    }
  }

  // ── Style ──────────────────────────────────────────────────────────────────

  for (const detail of accentProblems(combined)) {
    issues.push({ rule: "missing_accents", detail });
  }

  if (/[—–]/.test(combined)) {
    issues.push({ rule: "dash", detail: "Contains an em dash or en dash." });
  }

  if (/[\u201C\u201D\u2018\u2019]/.test(combined)) {
    issues.push({ rule: "curly_quotes", detail: "Contains curly quotation marks." });
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)) {
    issues.push({ rule: "emoji", detail: "Contains emoji." });
  }

  const lower = normalizeForCompare(combined);
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(normalizeForCompare(phrase))) {
      issues.push({ rule: "banned_phrase", detail: `Uses the filler phrase "${phrase}".` });
    }
  }
  for (const word of JARGON) {
    if (lower.includes(normalizeForCompare(word))) {
      issues.push({ rule: "jargon", detail: `Still contains the legalese "${word}".` });
    }
  }

  // ── Readability ────────────────────────────────────────────────────────────

  const sentences = draft.body.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const longOnes = sentences.filter((s) => s.split(/\s+/).length > WORDS_PER_SENTENCE_MAX);
  if (longOnes.length) {
    issues.push({
      rule: "sentence_too_long",
      detail: `${longOnes.length} sentence(s) run past ${WORDS_PER_SENTENCE_MAX} words. First: "${
        longOnes[0].slice(0, 80)
      }…"`,
    });
  }

  // ── Shape ──────────────────────────────────────────────────────────────────

  if (draft.title.trim().length < 10) {
    issues.push({ rule: "title_too_short", detail: "The headline is missing or too short." });
  }
  if (draft.summary.trim().length < 20) {
    issues.push({ rule: "summary_too_short", detail: "The summary is missing or too short." });
  }
  if (draft.body.trim().length < 80) {
    issues.push({ rule: "body_too_short", detail: "The body is missing or too short." });
  }

  return issues;
}

/** One line per issue, for the retry prompt. */
export function issuesAsInstructions(issues: ValidationIssue[]): string {
  return issues.map((i) => `- ${i.detail}`).join("\n");
}
