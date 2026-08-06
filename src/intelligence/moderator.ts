// ── Comment screening ────────────────────────────────────────────────────────
// Every comment gets one of three verdicts.
//
//   clean          it appears in the thread
//   controversial  it appears blurred, behind a login and an age check
//   junk           it is refused at submit time and the writer is told why
//
// The split exists because heat and noise are different problems. A furious,
// profane opinion about a legislator is still an opinion, and hiding it makes
// the thread a lie. Fifty crying-laughing emojis is not an opinion, and letting
// it through makes the thread worthless. So heat gets a blur and noise gets a
// refusal.
//
// Screening runs in two passes. The deterministic pass below decides at submit
// time: it is instant, free, and works whether or not a model is reachable. The
// model pass runs afterwards in the background, because driving a browser takes
// half a minute and nobody waits that long to post. The model can only tighten
// a verdict, never loosen one, so a clean rating from a hallucinating model
// cannot unblur something the deterministic pass already flagged.

import { askJson, type Message } from "./scraperLLM.ts";

export type Verdict = "clean" | "controversial" | "junk";

export interface Screening {
  verdict: Verdict;
  /** Shown to the writer when the verdict is junk. Spanish, plain, no scolding. */
  reason: string | null;
}

/**
 * Words that mark heat rather than noise. A comment containing these is an
 * opinion someone will want to argue with, so it goes behind the blur instead
 * of into the bin.
 *
 * This list is deliberately about insult and accusation, not about profanity on
 * its own. "Esta ley es una mierda" is an opinion. It gets blurred, not killed.
 */
const HEAT = [
  "ladrón",
  "ladrona",
  "ladrones",
  "corrupto",
  "corrupta",
  "corruptos",
  "rata",
  "ratas",
  "sinvergüenza",
  "vendido",
  "vendida",
  "vendidos",
  "traidor",
  "traidora",
  "traidores",
  "mentiroso",
  "mentirosa",
  "mentirosos",
  "hijueputa",
  "jueputa",
  "hpta",
  "malparido",
  "imbécil",
  "idiota",
  "estúpido",
  "estúpida",
  "basura",
  "mierda",
  "puta",
  "puto",
  "cabrón",
  "pendejo",
  "pendeja",
  "carajo",
  "maldito",
  "maldita",
  "asqueroso",
  "repugnante",
  "descarado",
  "descarada",
];

/** Bare marketing patterns. These are noise no matter what else is in the text. */
const SPAM = [
  /\bwhatsapp\b/i,
  /\bwsp\b/i,
  /\btelegram\b/i,
  /\bbitcoin\b/i,
  /\bcripto\b/i,
  /\binvers[ií]on\s+segura\b/i,
  /\bgana\s+(dinero|plata)\b/i,
  /\bdinero\s+f[áa]cil\b/i,
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\+506\s?\d{4}/,
];

/**
 * Threats against a person.
 *
 * Every pattern needs a human target, which is what keeps ordinary political
 * speech out of the net: "hay que matar el proyecto de ley" and "esa ley mata
 * el empleo" are arguments, while "hay que matarlo" is not. Saying a politician
 * is a thief is criticism and belongs on the site; saying you know where he
 * lives is a different act, and no amount of context makes it publishable.
 */
const THREATS = [
  /\b(te|lo|la|los|las|le|les)\s+(voy|vamos|van)\s+a\s+(matar|quemar|buscar|encontrar|reventar|golpear|violar|desaparecer|partir)\b/,
  /\bvoy\s+a\s+(matar|quemar|buscar|encontrar|reventar|golpear|violar)(te|lo|la|los|las|le)\b/,
  /\b(hay\s+que|habria\s+que|deberian|deberiamos|merece\s+que\s+lo)\s+(matar|colgar|quemar|fusilar|linchar|apu[nñ]alar)(lo|la|los|las|le|les)\b/,
  /\bque\s+(lo|la|los|las)\s+(maten|quemen|cuelguen)\b/,
  /\bojala\s+(se\s+(muera|mueran)|te\s+mueras|(lo|la|los)\s+maten)\b/,
  /\bs[e]\s+donde\s+(viv[ie]s?|vive|trabaja|estudian?)\b/,
  /\b(matar|quemar|golpear)\s+a\s+(tu|su)\s+(familia|hijo|hija|hijos|mama|papa|esposa|esposo)\b/,
];

const MIN_LETTERS = 12;
const MIN_WORDS = 3;

/** Strips emoji, punctuation, and spacing so only real letters remain. */
function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => (w.match(/\p{L}/gu) ?? []).length > 1).length;
}

/** Accent-insensitive haystack so "ladron" matches "ladrón". */
function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function isThreat(text: string): boolean {
  const hay = fold(text).replace(/\s+/g, " ");
  return THREATS.some((re) => re.test(hay));
}

function hasHeat(text: string): boolean {
  const hay = ` ${fold(text).replace(/[^\p{L}\s]/gu, " ")} `;
  return HEAT.some((w) => hay.includes(` ${fold(w)} `));
}

/** Five or more of the same character in a row, as in "jajajaaaaa" or "!!!!!". */
function hasRuns(text: string): boolean {
  return /(.)\1{4,}/u.test(text);
}

/** The same word over and over, which is how padding usually looks. */
function isRepetitive(text: string): boolean {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  return new Set(words).size <= Math.ceil(words.length / 3);
}

function isShouting(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 15) return false;
  const upper = letters.filter((ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase());
  return upper.length / letters.length > 0.8;
}

/**
 * The synchronous pass. Decides junk versus everything else on substance, and
 * clean versus controversial on heat.
 *
 * Ordering matters. Threats are checked first, because a threat shouted in
 * capitals should be answered as a threat rather than with a note about typing
 * in lower case. After that, substance comes before heat, so an angry comment
 * that is also empty is refused rather than blurred. Someone typing "LADRONES"
 * and nothing else has not contributed an argument.
 */
export function screenLocally(body: string): Screening {
  const text = body.trim();

  if (isThreat(text)) {
    return {
      verdict: "junk",
      reason: "No publicamos amenazas. Critique lo que hizo la persona, no la persona.",
    };
  }

  if (letterCount(text) < MIN_LETTERS) {
    return {
      verdict: "junk",
      reason: "Escriba una idea completa. Con emojis o una sola palabra no se entiende su punto.",
    };
  }

  if (wordCount(text) < MIN_WORDS) {
    return {
      verdict: "junk",
      reason: "Escriba al menos una frase. Así los demás pueden responderle.",
    };
  }

  if (SPAM.some((re) => re.test(text))) {
    return {
      verdict: "junk",
      reason: "No se pueden publicar enlaces, teléfonos ni ofertas aquí.",
    };
  }

  if (isRepetitive(text)) {
    return {
      verdict: "junk",
      reason: "Su comentario repite lo mismo varias veces. Dígalo una vez.",
    };
  }

  if (hasRuns(text) && letterCount(text) < 40) {
    return {
      verdict: "junk",
      reason: "Escriba su opinión sin alargar las letras.",
    };
  }

  if (isShouting(text)) {
    return {
      verdict: "junk",
      reason: "Escriba en minúsculas. Todo en mayúsculas no se lee.",
    };
  }

  if (hasHeat(text)) {
    return { verdict: "controversial", reason: null };
  }

  return { verdict: "clean", reason: null };
}

// ── The model pass ───────────────────────────────────────────────────────────

interface ModelVerdict {
  verdict: Verdict;
  reason: string;
}

const SHAPE = `{
  "verdict": "clean | controversial | junk",
  "reason": ""
}`;

function buildMessages(body: string): Message[] {
  return [
    {
      role: "system",
      content:
        `Usted clasifica comentarios de lectores en un sitio de noticias políticas de Costa Rica.

Devuelva una de tres categorías:

- "clean": una opinión normal, aunque esté en desacuerdo o suene molesta.
- "controversial": un ataque personal, una acusación fuerte, una grosería dirigida
  a alguien, o algo que va a provocar pelea. Sigue siendo una opinión, solo que
  subida de tono.
- "junk": no aporta nada. Spam, publicidad, insultos sin ningún argumento,
  puras groserías, o texto sin sentido.

Reglas:
- Estar en desacuerdo no es "junk". Enojarse tampoco.
- Criticar a una persona con cargo público es parte del debate. Eso es
  "controversial", no "junk".
- Solo use "junk" cuando quitar el comentario no le quite nada a la conversación.
- El campo "reason" se le muestra a quien escribió. Una sola frase, en español,
  sin regaños. Déjelo vacío si no es "junk".`,
    },
    { role: "user", content: `Comentario:\n\n${body}` },
  ];
}

const ORDER: Record<Verdict, number> = { clean: 0, controversial: 1, junk: 2 };

/**
 * Asks the model and returns the stricter of the two verdicts.
 *
 * Model output is untrusted: an unrecognised verdict, or any failure at all,
 * leaves the local screening in place. The worst case is that a comment stays
 * where the deterministic pass put it, which is the behaviour when no model is
 * configured anyway.
 */
export async function screenWithModel(body: string, local: Screening): Promise<Screening> {
  let model: ModelVerdict;
  try {
    model = await askJson<ModelVerdict>(buildMessages(body), SHAPE, { retries: 1 });
  } catch (err) {
    console.warn(`[moderator] model pass failed, keeping the local verdict: ${err}`);
    return local;
  }

  if (!(model.verdict in ORDER)) return local;
  if (ORDER[model.verdict] <= ORDER[local.verdict]) return local;

  return {
    verdict: model.verdict,
    reason: model.verdict === "junk" ? (model.reason?.trim() || null) : null,
  };
}
