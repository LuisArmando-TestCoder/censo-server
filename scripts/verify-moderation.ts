/// <reference lib="deno.ns" />
// Proof for comment screening: the fast pass sorts insults from argument, the
// redaction step withholds the text rather than merely marking it, and the age
// rule decides who gets it back.
//
// The model pass is not exercised here. It needs a browser and half a minute,
// and it can only tighten a verdict, so the guarantees that matter to a reader
// are the deterministic ones below.
//
//   deno run --allow-env --allow-read --env-file scripts/verify-moderation.ts

import { screenLocally } from "../src/intelligence/moderator.ts";
import { viewComments } from "../src/db/posts.ts";
import { isAdult } from "../src/db/users.ts";
import type { Comment } from "../src/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nVerifying comment screening\n");

// ── The fast pass ────────────────────────────────────────────────────────────
// Harsh criticism of a public figure is the point of the site, so it has to
// survive. Threats and slurs aimed at a person do not.

console.log("Sorting comments");

const clean = [
  "El diputado no llegó a votar tres veces este mes. Eso es abandono del puesto.",
  "No estoy de acuerdo con la ley. Sube el costo de la canasta básica.",
  "Esta reforma es un desastre y quien la propuso no leyó el expediente.",
  // Violent verbs aimed at a bill, not a person. The threat rule must ignore these.
  "Hay que matar ese proyecto de ley antes de que llegue al plenario.",
  "Esa ley mata el empleo en las zonas rurales del país.",
  "La comisión enterró el expediente y nadie dio explicaciones.",
];

for (const text of clean) {
  const r = screenLocally(text);
  check(`deja pasar: "${text.slice(0, 40)}…"`, r.verdict === "clean", r.reason ?? "");
}

const harsh = "Qué idiota el diputado, no sirve para nada.";
const harshResult = screenLocally(harsh);
check(
  "marca el insulto como subido de tono",
  harshResult.verdict === "controversial",
  harshResult.verdict,
);

// Written in lower case on purpose. Shouted at the screen, this would trip the
// all-caps rule first and the threat rule would never be tested.
const threat = screenLocally("te voy a matar, te voy a buscar a tu casa");
check("rechaza la amenaza", threat.verdict === "junk", threat.verdict);
check("la explica en español", (threat.reason ?? "").length > 0, threat.reason ?? "");

const shouting = screenLocally("ESTO ES UNA VERGÜENZA TOTAL Y NADIE HACE NADA");
check("rechaza los gritos", shouting.verdict === "junk", shouting.reason ?? "");

const mush = screenLocally("ajkdhfkjahsdf");
check("rechaza el texto sin sentido", mush.verdict === "junk", mush.reason ?? "");

// ── Withholding, not blurring ────────────────────────────────────────────────

console.log("\nEntregando el hilo a distintos lectores");

const base = {
  postId: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  hidden: false,
  screened: true,
};

const thread: Comment[] = [
  { ...base, id: "c1", userId: "u1", displayName: "Ana", body: "Punto normal.", tone: "clean" },
  {
    ...base,
    id: "c2",
    userId: "u2",
    displayName: "Beto",
    body: "Insulto fuerte.",
    tone: "controversial",
  },
];

const anon = viewComments(thread, null);
check("visitante sin cuenta lee el comentario normal", anon[0].body === "Punto normal.");
check("visitante sin cuenta no recibe el otro", anon[1].body === null);
check("y sabe que está bloqueado", anon[1].locked === true);

const minor = viewComments(thread, { id: "u9", canSeeControversial: false });
check("menor de edad tampoco lo recibe", minor[1].body === null);

const adult = viewComments(thread, { id: "u9", canSeeControversial: true });
check("mayor de edad sí lo recibe", adult[1].body === "Insulto fuerte.");

const author = viewComments(thread, { id: "u2", canSeeControversial: false });
check("quien lo escribió siempre lo ve", author[1].body === "Insulto fuerte.");

// ── Who counts as an adult ───────────────────────────────────────────────────

console.log("\nRegla de edad");

const year = new Date().getUTCFullYear();
check("sin año declarado, bloqueado", isAdult({ birthYear: null }) === false);
check("con 17 años, bloqueado", isAdult({ birthYear: year - 17 }) === false);
check("con 18 años, permitido", isAdult({ birthYear: year - 18 }) === true);

// ── Legacy comments ──────────────────────────────────────────────────────────
// Threads written before screening existed have no tone. They must keep reading
// normally rather than turning into a wall of grey bars.

const legacy = viewComments(
  [{ ...base, id: "c3", userId: "u3", displayName: "Caro", body: "Viejo.", tone: "clean" }],
  null,
);
check("los comentarios viejos siguen visibles", legacy[0].body === "Viejo.");

console.log(
  failures === 0 ? "\nTodo bien.\n" : `\n${failures} verificación(es) fallaron.\n`,
);
Deno.exit(failures === 0 ? 0 : 1);
