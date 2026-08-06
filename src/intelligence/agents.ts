// ── The three agents ─────────────────────────────────────────────────────────
// Each one does a single job and hands structured output to the next.
//
//   Extractor  reads the raw item and answers what, when, where, who, why.
//   Reasoner   decides whether an ordinary person is affected, and how.
//   Humanizer  writes it at a fifth-grade reading level, with no jargon.
//
// Every agent is told, in its own words, that inventing anything is the one
// unforgivable error. The validator then checks that instruction was followed
// rather than trusting it.

import { askJson, type Message } from "./scraperLLM.ts";
import type { LinkKind, RawItem } from "../types.ts";

/** Different link types carry different evidence, so each gets its own note. */
const LINK_GUIDANCE: Record<LinkKind, string> = {
  youtube:
    "Un enlace de YouTube es la grabación de la sesión. Usted no puede ver el video, así que menciónelo como grabación disponible y no describa lo que aparece en él.",
  sharepoint:
    "Un enlace a asamblea.go.cr lleva a la ficha oficial. Cítelo como la fuente, sin suponer qué dice por dentro.",
  document:
    "Un enlace a un archivo es el documento oficial. Nómbrelo como documento adjunto, sin suponer su contenido.",
  external:
    "Un enlace externo es material de terceros. Menciónelo solo si el texto explica de qué se trata.",
};

const NEVER_INVENT =
  `Regla que no se puede romper: usted solo puede usar lo que está en el texto de entrada.
No agregue nombres, cifras, fechas, cargos, partidos ni citas que no aparezcan ahí.
Si un dato no está, escriba que no está en la fuente. Nunca lo adivine.
Inventar el nombre de una persona o lo que hizo es el error más grave posible.`;

// ── Extractor ────────────────────────────────────────────────────────────────

export interface Extraction {
  /** What happened, in one plain sentence. */
  what: string;
  /** When, exactly as the source states it. Empty when the source is silent. */
  when: string;
  /** Which body or committee. Empty when the source is silent. */
  where: string;
  /** Names the source actually mentions. Never inferred. */
  who: string[];
  /** The stated reason, if there is one. */
  why: string;
  /** Whether the source really says anything, or is only an agenda line. */
  substance: "full" | "thin" | "empty";
}

const EXTRACTION_SHAPE = `{
  "what": "",
  "when": "",
  "where": "",
  "who": [],
  "why": "",
  "substance": "full | thin | empty"
}`;

export function buildExtractorMessages(item: RawItem): Message[] {
  const linkNotes = item.links.length
    ? item.links
      .map((l) => `- ${l.url}\n  ${LINK_GUIDANCE[l.kind]}`)
      .join("\n")
    : "No hay enlaces.";

  const system =
    `Usted extrae hechos de publicaciones oficiales del Estado costarricense: la
Asamblea Legislativa y La Gaceta, el diario oficial.
Su única tarea es separar lo que el texto dice de lo que no dice.


${NEVER_INVENT}

Sobre "substance":
- "full" si el texto explica un hecho concreto.
- "thin" si apenas anuncia una sesión o menciona un tema sin explicarlo.
- "empty" si no dice nada aprovechable.`;

  const user = `TÍTULO
${item.title || "(sin título)"}

CUERPO
${item.body || "(sin cuerpo)"}

FECHA DEL EVENTO
${item.eventDate ?? "(no indicada)"}

CANAL
${item.channel ?? "(no indicado)"}

ENLACES
${linkNotes}`;

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function extract(item: RawItem): Promise<Extraction> {
  return askJson<Extraction>(buildExtractorMessages(item), EXTRACTION_SHAPE);
}

// ── Reasoner ─────────────────────────────────────────────────────────────────

export interface Reasoning {
  /** Whether this is worth telling an ordinary person about. */
  worthPublishing: boolean;
  /** Why it is or is not worth it. */
  rationale: string;
  /** Concretely who is affected, only when the source supports saying so. */
  whoIsAffected: string;
  /** What changes for them, in practice. Empty when the source cannot say. */
  practicalEffect: string;
  /** What the source leaves unanswered. Stated openly rather than filled in. */
  unknowns: string[];
}

const REASONING_SHAPE = `{
  "worthPublishing": true,
  "rationale": "",
  "whoIsAffected": "",
  "practicalEffect": "",
  "unknowns": []
}`;

export function buildReasonerMessages(item: RawItem, facts: Extraction): Message[] {
  const system = `Usted decide si un acto del gobierno le importa a una persona común.

Le importa cuando cambia algo real: lo que paga, lo que puede hacer, cómo la tratan
las instituciones, o qué tan seguro está su trabajo, su salud o su barrio.

No le importa cuando es solo trámite interno, protocolo o una sesión anunciada sin
contenido. En ese caso ponga worthPublishing en false y explique por qué en una frase.

La Gaceta publica cada día decenas de avisos de rutina: edictos de registro civil,
marcas comerciales, remates, nombramientos de suplentes, permisos individuales y
convocatorias de asambleas de empresas. Casi todos afectan a una sola persona o
empresa y no son noticia. Publíquelos solo si el propio texto muestra que cambian
algo para mucha gente: un precio, un impuesto, una regla, un servicio o un derecho.


${NEVER_INVENT}

Si el texto no alcanza para decir a quién afecta, deje "whoIsAffected" vacío y
ponga esa duda en "unknowns". Es mejor admitir el vacío que rellenarlo.`;

  const user = `HECHOS EXTRAÍDOS
${JSON.stringify(facts, null, 2)}

TEXTO ORIGINAL
${item.title}

${item.body}`;

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function reason(item: RawItem, facts: Extraction): Promise<Reasoning> {
  return askJson<Reasoning>(buildReasonerMessages(item, facts), REASONING_SHAPE);
}

// ── Humanizer ────────────────────────────────────────────────────────────────

export interface HumanDraft {
  title: string;
  summary: string;
  /** Plain paragraphs separated by a blank line. No markup. */
  body: string;
}

const DRAFT_SHAPE = `{
  "title": "",
  "summary": "",
  "body": ""
}`;

/**
 * The style contract, condensed from .clinerules/copywritingrules.md. It is
 * stated as plain prohibitions because the validator enforces the same list
 * literally, and the two must not drift.
 */
const STYLE_RULES = `Cómo escribir:
- Español de Costa Rica, con tildes y con la ñ. Escriba "años", no "anos";
  "comisión", no "comision". Un texto sin tildes se lee como un error.
- Vocabulario de quinto grado. Frases cortas, menos de 25 palabras.

- Voz activa. Diga quién hizo qué.
- Nada de guiones largos, comillas curvas ni emojis.
- Nada de relleno: "cabe destacar", "es importante señalar", "en resumen", "un hito".
- Nada de lenguaje burocrático: "de conformidad con", "en virtud de", "coadyuvar".
- No adorne ni opine. Cuente el hecho y a quién le pega.
- Empiece por lo que cambia para la gente, no por el trámite.
- No cierre con una frase de resumen. Termine en el último dato concreto.
- Si algo no se sabe, dígalo en una frase y siga.`;

export function buildHumanizerMessages(
  item: RawItem,
  facts: Extraction,
  thinking: Reasoning,
  previousIssues?: string,
): Message[] {
  const system = `Usted le explica a la gente de Costa Rica qué está haciendo su gobierno,
sin la palabrería de los políticos.


${STYLE_RULES}

${NEVER_INVENT}

Formato:
- "title": una línea que diga qué pasó. Sin emojis ni asteriscos.
- "summary": una sola frase que diga a quién le afecta y cómo.
- "body": dos a cinco párrafos, separados por una línea en blanco.`;

  const parts = [
    `HECHOS\n${JSON.stringify(facts, null, 2)}`,
    `ANÁLISIS\n${JSON.stringify(thinking, null, 2)}`,
    `TEXTO ORIGINAL\n${item.title}\n\n${item.body}`,
  ];

  if (previousIssues) {
    parts.push(
      `SU BORRADOR ANTERIOR FUE RECHAZADO POR ESTO. Corrija cada punto:\n${previousIssues}`,
    );
  }

  return [{ role: "system", content: system }, { role: "user", content: parts.join("\n\n") }];
}

export function humanize(
  item: RawItem,
  facts: Extraction,
  thinking: Reasoning,
  previousIssues?: string,
): Promise<HumanDraft> {
  return askJson<HumanDraft>(
    buildHumanizerMessages(item, facts, thinking, previousIssues),
    DRAFT_SHAPE,
  );
}
