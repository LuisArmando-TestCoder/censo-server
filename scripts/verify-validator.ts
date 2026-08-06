/// <reference lib="deno.ns" />
// Slice 7 proof: the guardrail catches a fabricated name, a fabricated figure,
// an invented link, and the banned style patterns, while letting a faithful,
// plainly written draft through.
//
// This one needs no network and no browser.
//
//   deno run --allow-env --allow-read scripts/verify-validator.ts

import { accentProblems, validateDraft } from "../src/intelligence/validator.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const SOURCE = `Reforma al Codigo Procesal Penal busca agilizar los procesos judiciales
eliminando la audiencia preliminar. La Comision de Asuntos Juridicos aprobo el
expediente 22902 el martes 4 de agosto. Vea la sesion en
https://www.youtube.com/watch?v=OJKY7U8p8cM`;

function has(issues: { rule: string }[], rule: string): boolean {
  return issues.some((i) => i.rule === rule);
}

console.log("\nVerifying the output guardrail\n");

// ── A faithful, plainly written draft passes ─────────────────────────────────
// Written with accents, as published Spanish must be. The source itself arrives
// unaccented from SharePoint, which is fine: fidelity is compared with accents
// stripped, so the draft may spell a word properly even when the source did not.
const good = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "Si la reforma avanza, los juicios penales podrían tardar menos.",
  body: `La Comisión de Asuntos Jurídicos aprobó una reforma al Código Procesal Penal.
La reforma quita la audiencia preliminar.

El expediente 22902 se aprobó el martes 4 de agosto. La sesión quedó grabada.`,
}, SOURCE);
check("a faithful draft passes clean", good.length === 0, good.map((i) => i.rule).join(", "));

// ── Accents ──────────────────────────────────────────────────────────────────
// A prompt asking for correct spelling is obeyed on some runs and not others,
// so the guardrail has to enforce it.

console.log("");

const unaccented = validateDraft({
  title: "Una comision investigara los fondos del FEES",
  summary: "Les afecta porque se revisara el uso de los recursos publicos.",
  body: `Una comision investigara como se usan los recursos del FEES.
La sesion quedo grabada y la informacion es publica.

El plenario conmemora setenta y seis anos del primer voto femenino.`,
}, SOURCE);
check("a draft written without accents is rejected", has(unaccented, "missing_accents"));

check(
  '"anos" is caught, because it is a different word',
  accentProblems("El plenario conmemora setenta y seis anos.").length > 0,
);
check(
  "correct Spanish raises nothing",
  accentProblems("La Comisión aprobó el expediente. La sesión quedó grabada.").length === 0,
);
check(
  '"publica" as a verb is not flagged',
  accentProblems("La comisión publica el informe cada año sin falta.").length === 0,
);

console.log("");

// ── Fabrication ──────────────────────────────────────────────────────────────
const invented = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "Si la reforma avanza, los juicios penales podrian tardar menos.",
  body: `El diputado Roberto Villanueva defendio la reforma en la sesion.
La Comision de Asuntos Juridicos la aprobo el martes.`,
}, SOURCE);
check("a name absent from the source is rejected", has(invented, "name_not_in_source"));

const madeUpNumber = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "Si la reforma avanza, los juicios penales podrian tardar menos.",
  body: `La Comision de Asuntos Juridicos aprobo el expediente 22902.
La medida afectaria a 45000 casos abiertos en el pais.`,
}, SOURCE);
check("a figure absent from the source is rejected", has(madeUpNumber, "number_not_in_source"));

const madeUpLink = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "Si la reforma avanza, los juicios penales podrian tardar menos.",
  body: `La Comision de Asuntos Juridicos aprobo el expediente 22902.
Puede leer el texto en https://ejemplo.com/reforma-penal para conocerlo.`,
}, SOURCE);
check("a link absent from the source is rejected", has(madeUpLink, "url_not_in_source"));

// A figure that IS in the source must not be flagged.
const realNumber = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "Si la reforma avanza, los juicios penales podrian tardar menos.",
  body: `La Comision de Asuntos Juridicos aprobo el expediente 22902.
La reforma quita la audiencia preliminar de los juicios penales.`,
}, SOURCE);
check(
  "a figure taken from the source is not flagged",
  !has(realNumber, "number_not_in_source"),
  realNumber.map((i) => i.rule).join(", "),
);

// ── Style ────────────────────────────────────────────────────────────────────
const styled = validateDraft({
  title: "Reforma al Codigo Procesal Penal",
  summary: "Cabe destacar que la reforma es un hito para el pais entero.",
  body: `La Comision de Asuntos Juridicos aprobo el expediente 22902 el martes.
De conformidad con lo aprobado, se elimina la audiencia preliminar del proceso.`,
}, SOURCE);
check("filler phrases are rejected", has(styled, "banned_phrase"));
check("legalese is rejected", has(styled, "jargon"));

const dashed = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "La reforma penal avanza en la Comision de Asuntos Juridicos ahora.",
  body: `La Comision aprobo el expediente 22902 — la reforma quita una audiencia.
El texto pasa al plenario para su discusion final entre los diputados.`,
}, SOURCE);
check("em dashes are rejected", has(dashed, "dash"));

const curly = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "La reforma penal avanza en la Comision de Asuntos Juridicos ahora.",
  body: `La Comision aprobo lo que llamo una \u201Creforma necesaria\u201D para el pais.
El expediente 22902 pasa ahora al plenario legislativo para su discusion.`,
}, SOURCE);
check("curly quotes are rejected", has(curly, "curly_quotes"));

const rambling = validateDraft({
  title: "Quieren quitar una audiencia para acelerar los juicios",
  summary: "La reforma penal avanza en la Comision de Asuntos Juridicos ahora.",
  body:
    `La Comision de Asuntos Juridicos aprobo el expediente 22902 el martes 4 de agosto y con esa decision la reforma al Codigo Procesal Penal avanza un paso mas hacia el plenario donde los diputados tendran que discutirla otra vez antes de que pueda convertirse en ley.`,
}, SOURCE);
check("overlong sentences are rejected", has(rambling, "sentence_too_long"));

const stub = validateDraft({ title: "Corto", summary: "Muy corto.", body: "Nada." }, SOURCE);
check(
  "an empty draft is rejected",
  has(stub, "title_too_short") && has(stub, "summary_too_short") && has(stub, "body_too_short"),
);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
Deno.exit(failures === 0 ? 0 : 1);
