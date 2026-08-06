// ── The law explainer ────────────────────────────────────────────────────────
// One agent, one job: read the text of a law and say what it actually does to
// people. It is a separate agent from the three in agents.ts because it works
// from a different kind of input. Those read a news item of a few hundred words
// and must decide whether it is worth publishing at all. A law is always worth
// explaining, is far longer, and has a fixed structure, so the useful questions
// are different: who now has to do something, who gets something, and what
// changes tomorrow that was not true yesterday.
//
// The output is deliberately split into headline, summary, explanation, and
// three lists. A single blob of prose would let the model bury the part that
// matters — who pays and who gains — inside a paragraph nobody finishes.

import { askJson, type Message } from "./scraperLLM.ts";
import type { LawDetail } from "../scrape/consultaLey.ts";
import type { LawFlag, LawFlagKind, LawSummary } from "../types.ts";

/**
 * How much of the law to send.
 *
 * Long laws are truncated rather than dropped: an explanation of the first
 * forty thousand characters is worth more than none, and the reader always has
 * the untouched original next to it. The agent is told when this has happened
 * so it can say so instead of pretending it read the whole thing.
 */
const MAX_TEXT_CHARS = 40_000;

const NEVER_INVENT =
  `Regla que no se puede romper: usted solo puede usar lo que está en el texto de la ley.
No agregue cifras, plazos, montos, instituciones ni sanciones que no aparezcan ahí.
Si la ley no dice algo, no lo diga usted. Nunca lo adivine.
Inventar un efecto que la ley no ordena es el error más grave posible.`;

/**
 * The style contract. It mirrors the one in agents.ts on purpose: the two must
 * not drift, or the site will read as though two different people wrote it.
 */
const STYLE_RULES = `Cómo escribir:
- Español de Costa Rica, con tildes y con la ñ. Escriba "años", no "anos".
- Vocabulario de quinto grado. Frases cortas, menos de 25 palabras.
- Voz activa. Diga quién hace qué.
- Nada de guiones largos, comillas curvas ni emojis.
- Nada de relleno: "cabe destacar", "es importante señalar", "en resumen", "un hito".
- Nada de lenguaje jurídico sin traducir. Si usa una palabra técnica porque la
  ley la usa, explíquela en la misma frase.
- No opine. No diga si la ley es buena o mala. Diga qué hace y a quién le toca.
- No cierre con una frase de resumen. Termine en el último dato concreto.`;

const SHAPE = `{
  "headline": "",
  "summary": "",
  "explanation": "",
  "affects": [],
  "benefits": [],
  "implications": [],
  "flags": [
    {
      "kind": "narrow_benefit",
      "title": "",
      "who": "",
      "detail": "",
      "article": "",
      "quote": "",
      "severity": "medium"
    }
  ]
}`;

/**
 * The instruction for the flags.
 *
 * Written as a search for a mismatch between the title and the articles, not as
 * a search for wrongdoing. The difference matters: asked to find corruption, a
 * model will find it in a routine budget transfer, because that is what it was
 * asked for. Asked whether the articles do what the title claims, it has a
 * question with a real answer in the text, and "yes, they match" is an
 * acceptable one.
 */
const FLAG_RULES = `SEGUNDA TAREA: buscar lo que la ley no anuncia.

Una ley puede llamarse "protección del desarrollo social" y, en el artículo 14,
exonerar de impuestos a una sola empresa. El resumen honesto de esa ley sigue
sin avisarle a la gente de lo que pasó. Su segunda tarea es avisar.

Compare el título de la ley contra lo que ordenan los artículos. Marque en
"flags" solo lo que no calce. Estos son los casos:

- "narrow_benefit": el beneficio cae sobre una empresa, una familia, una
  institución o un grupo muy pequeño, mientras el título habla del interés
  general. Marque siempre que la ley nombre a un beneficiario concreto.
- "hidden_cost": alguien queda pagando algo que el título no menciona: una
  deuda, un traslado de fondos, una responsabilidad.
- "weakened_control": se quita o se ablanda una auditoría, un concurso público,
  un permiso, un requisito o una sanción. También cuando algo que era
  obligatorio pasa a ser opcional o "a criterio de".
- "unrelated_clause": un artículo que no tiene nada que ver con el tema de la
  ley. Es la forma clásica de colar un favor.
- "self_dealing": beneficia a la misma institución, oficina o funcionarios que
  la van a aplicar. Incluya aumentos de salario, plazas, viáticos o pensiones.
- "vague_power": se da un poder con palabras tan amplias que el único límite es
  quien lo ejerza. Por ejemplo "podrá disponer de los recursos que estime
  necesarios".

Reglas para marcar, sin excepción:

1. "quote" tiene que ser una frase copiada LITERALMENTE del texto que le di.
   Cópiela carácter por carácter. Si no puede copiar la frase, no marque nada.
   Sin la cita, la marca no se publica.
2. Describa lo que la ley dice, no lo que usted sospecha. No escriba que hubo
   corrupción, presiones, sobornos ni intenciones ocultas. Usted no sabe eso.
   Diga qué dice el artículo y a quién le sirve. La gente juzga.
3. Si el beneficio ya viene anunciado en el título, no lo marque. Una ley que se
   llama "beneficios para los pescadores de Puntarenas" y beneficia a los
   pescadores de Puntarenas no esconde nada.
4. "severity": use "high" solo si la ley nombra al beneficiario, o si quita un
   control que ya existía. Use "medium" para lo demás. Use "low" cuando le
   parezca menor y prefiera dejarlo anotado.
5. Si los artículos hacen lo que el título dice, deje "flags" vacío. Eso es lo
   normal y es una respuesta correcta. No invente una marca por llenar el campo.
   Una marca falsa hace más daño que una marca que faltó.`;

export function buildLawMessages(detail: LawDetail, text: string): Message[] {
  const truncated = text.length > MAX_TEXT_CHARS;
  const body = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

  const system = `Usted le explica a la gente de Costa Rica qué dice una ley que acaba de
aprobarse, para que cualquier persona la entienda sin abogado.

Escriba para alguien que no terminó el colegio, que no sabe qué es un "inciso" y
que solo quiere saber una cosa: ¿esto me toca a mí?

${STYLE_RULES}

${NEVER_INVENT}

Qué va en cada campo:

- "headline": el nombre de la ley en palabras de la calle, como se lo contaría a
  un vecino. Máximo 12 palabras. Diga lo que la ley hace, no el tema del que
  trata. No repita el título oficial. Sin comillas ni punto final.

- "summary": una sola frase que diga qué cambia y para quién.

- "explanation": la explicación completa, en Markdown. Recorra la ley artículo
  por artículo en el orden en que viene, y no se salte ninguno. De cada uno diga
  qué ordena, a quién obliga y desde cuándo. Use subtítulos con "##" y listas
  con "-". No resuma de más: si la ley pone un plazo, un monto o una multa, ese
  número tiene que aparecer aquí. Si la ley reforma otra ley, diga qué decía
  antes y qué dice ahora, pero solo si el texto lo muestra.

- "affects": a quiénes les cae una obligación, un costo, un requisito, un límite
  o una sanción. Sea concreto: "las personas que venden en el Depósito Libre de
  Golfito", no "los comerciantes". Una entrada por grupo. Vacío si la ley no
  impone nada a nadie.

- "benefits": a quiénes les da dinero, un derecho, un permiso, una exoneración o
  una ventaja. Igual de concreto. Vacío si no beneficia a nadie en particular.

- "implications": qué cambia en la práctica desde que la ley rige. Una
  consecuencia por entrada, en presente, empezando por el verbo. Por ejemplo:
  "Baja el impuesto que pagan los locales de Golfito". Piense en lo que una
  persona notaría: precios, trámites, permisos, plazos, multas, servicios.

Si la ley es puro trámite interno y de verdad no le cambia nada a nadie, dígalo
así en "summary" y deje las listas vacías. Es preferible a inventar un efecto.

${FLAG_RULES}`;

  const record = [
    `Número de ley: ${detail.number}`,
    `Título oficial: ${detail.title}`,
    detail.publishedAt ? `Publicada: ${detail.publishedAt}` : null,
    detail.effectiveAt ? `Rige desde: ${detail.effectiveAt}` : null,
    detail.gacetaNumber ? `Gaceta: ${detail.gacetaNumber}` : null,
    detail.expedienteNumber ? `Expediente: ${detail.expedienteNumber}` : null,
    detail.procedureType ? `Tipo: ${detail.procedureType}` : null,
  ].filter(Boolean).join("\n");

  const affectations = detail.affectations.length
    ? detail.affectations
      .map((a) => `- Ley ${a.lawNumber} (${a.affectedLawTitle}): ${a.affectedArticle}`)
      .join("\n")
    : "Esta ley no reforma ninguna otra.";

  const user = `FICHA OFICIAL
${record}

LEYES QUE REFORMA
${affectations}

TEXTO DE LA LEY
${body}${
    truncated
      ? "\n\n[El texto continúa. Usted recibió solo la primera parte: dígalo al final de la explicación.]"
      : ""
  }`;

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

const FLAG_KINDS: readonly LawFlagKind[] = [
  "narrow_benefit",
  "hidden_cost",
  "weakened_control",
  "unrelated_clause",
  "self_dealing",
  "vague_power",
];

/**
 * Flattens text for comparison: no accents, no case, no run of whitespace.
 *
 * The model reliably reproduces the words of a quote and just as reliably
 * mangles the spacing, because the DOCX it was given is full of line breaks and
 * non-breaking spaces from the original layout. Comparing the flattened forms
 * checks the thing that matters — that these words are in the law — without
 * failing over a space the converter inserted.
 */
function flatten(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[“”"'’‘]/g, "")
    .trim();
}

/**
 * Keeps only the flags whose quote really appears in the law.
 *
 * This is the safeguard the whole feature rests on. A flag is a public claim
 * that a law quietly favours someone, attached to that law's own page, under
 * our name. A model that paraphrases a clause into something more damning than
 * the text supports would have us publishing an accusation nobody can check.
 *
 * So the rule is mechanical rather than editorial: the quote must be findable
 * in the source text, or the flag does not exist. Short quotes are dropped too,
 * because a five-word fragment will match something by accident and proves
 * nothing to a reader.
 */
function verifiedFlags(value: unknown, lawText: string): LawFlag[] {
  if (!Array.isArray(value)) return [];

  const haystack = flatten(lawText);
  const seen = new Set<string>();
  const kept: LawFlag[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;

    const quote = String(f.quote ?? "").trim();
    const title = String(f.title ?? "").trim();
    const detail = String(f.detail ?? "").trim();

    // No quote, no flag. Stated once here and enforced nowhere else, so there
    // is exactly one place to look when asking how a claim got published.
    if (quote.length < 25 || !title || !detail) continue;
    if (!haystack.includes(flatten(quote))) continue;

    const kind = FLAG_KINDS.includes(f.kind as LawFlagKind)
      ? (f.kind as LawFlagKind)
      : "narrow_benefit";

    const severity = f.severity === "high" || f.severity === "low" ? f.severity : "medium";

    // Two flags quoting the same clause are one finding described twice.
    const key = flatten(quote).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);

    kept.push({
      kind,
      title,
      who: String(f.who ?? "").trim(),
      detail,
      article: String(f.article ?? "").trim(),
      quote,
      severity,
    });
  }

  // Loudest first, and capped: a page listing twelve concerns communicates
  // less than one listing the three that matter.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  kept.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return kept.slice(0, 6);
}

/**
 * Reads one law and returns the explanation.
 *
 * The fields are trimmed and the lists forced to arrays of strings, because a
 * model that returns a bare string where a list was asked for should degrade to
 * one item rather than crash the crawler mid-batch.
 */
export async function explainLaw(detail: LawDetail, text: string): Promise<LawSummary> {
  const raw = await askJson<Partial<LawSummary>>(buildLawMessages(detail, text), SHAPE);

  const list = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };

  return {
    headline: (raw.headline ?? "").trim(),
    summary: (raw.summary ?? "").trim(),
    explanation: (raw.explanation ?? "").trim(),
    affects: list(raw.affects),
    benefits: list(raw.benefits),
    implications: list(raw.implications),
    // Checked against the law we actually sent, not against what came back.
    flags: verifiedFlags(raw.flags, text),
  };
}

/**
 * Checks the explanation is usable before it is stored.
 *
 * Cheap structural checks only: that the model answered at all, and that it did
 * not hand back the official title as though it were plain language. Judging
 * whether the *content* is faithful is what the original text sitting beside it
 * on the page is for.
 */
export function lawSummaryIssues(summary: LawSummary, detail: LawDetail): string[] {
  const issues: string[] = [];
  if (summary.headline.length < 10) issues.push("headline demasiado corto");
  if (summary.headline.length > 140) issues.push("headline demasiado largo");
  if (summary.summary.length < 20) issues.push("summary demasiado corto");
  if (summary.explanation.length < 120) issues.push("explanation demasiado corta");

  const fold = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (fold(summary.headline) === fold(detail.title)) {
    issues.push("headline repite el título oficial");
  }

  return issues;
}
