// ── Legal and community documents ────────────────────────────────────────────
// Stored as data, not hardcoded pages, so they can be corrected without a
// deploy and so each version is dated for the reader.
//
// The seeds below are a working starting point written in plain Spanish, and
// they describe what the code actually does today. They are NOT reviewed legal
// advice. Costa Rica's Ley 8968 governs personal data here, and holding cédula
// numbers brings duties toward PRODHAB, so a lawyer should review these before
// launch. See ROADMAP.md.

import { fsList, fsSet } from "./firestore.ts";
import { COL, legalDoc } from "./paths.ts";
import { sha256Hex } from "../lib/hash.ts";
import type { LegalDoc } from "../types.ts";

const VERSION = "2026-08-06";

const SEED: LegalDoc[] = [
  {
    id: "privacidad-votante",
    title: "Privacidad para personas votantes",
    audience: "votante",
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `## Qué guardamos

- Su correo electrónico. Lo usamos para mandarle el código de acceso.
- El nombre que usted escoja mostrar.
- Sus reacciones y comentarios, junto con la fecha.
- Sus respuestas al cuestionario de opinión.
- Su número de cédula, solo si usted lo escribe. No es obligatorio.

## Qué NO hacemos

- No verificamos su cédula contra el padrón. No tenemos acceso a esa base.
  Guardar el número no prueba quién es usted y no lo presentamos como prueba.
- No vendemos sus datos.
- No publicamos su correo ni su cédula. Los demás solo ven el nombre que escogió.

## Sus respuestas de opinión

Las respuestas del cuestionario forman un puntaje entre izquierda y derecha.
Ese puntaje es suyo. Lo usamos junto con el de los demás para publicar cifras
generales, siempre sin nombres.

## Sus derechos

Usted puede pedir ver sus datos, corregirlos o borrarlos. Escriba a la dirección
del pie de página. La Ley 8968 le da ese derecho.

## Cuánto tiempo

Guardamos su cuenta mientras usted la use. Si pide que la borremos, quitamos su
correo, su cédula y su nombre. Sus comentarios quedan sin autor.`,
  },
  {
    id: "privacidad-funcionario",
    title: "Privacidad para funcionarios públicos",
    audience: "funcionario",
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `Aplica todo lo de la política para personas votantes, más esto:

## Su cargo es información pública

Si usted dice que tiene un cargo público, ese dato puede aparecer junto a sus
comentarios. Lo que dice una persona con poder de decisión no es lo mismo que lo
que dice cualquiera, y el lector merece saber la diferencia.

## Nosotros no confirmamos cargos

Usted marca la casilla; nosotros no la verificamos contra ningún registro. Por
eso mostramos ese dato como algo que usted declaró, no como algo comprobado.

## Contacto


Podemos escribirle para invitarlo a dar su opinión sobre un tema. Puede decir que
no, y puede pedir que no le volvamos a escribir.`,
  },
  {
    id: "privacidad-extranjero",
    title: "Privacidad para personas extranjeras",
    audience: "extranjero",
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `Aplica todo lo de la política para personas votantes, con dos diferencias:

- No le pedimos número de cédula.
- Sus respuestas de opinión se cuentan aparte, para no mezclarlas con las de
  quienes votan en Costa Rica.

Puede leer, comentar y reaccionar igual que cualquier otra persona.`,
  },
  {
    id: "privacidad-editor",
    title: "Privacidad para editores",
    audience: "editor",
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `Aplica todo lo de la política para personas votantes, más esto:

## Su trabajo queda registrado

Cada artículo guarda quién lo creó y quién lo editó. Eso no se puede apagar: es
lo que permite responder por lo que se publica.

## Solo sus artículos

Usted puede editar los artículos que le asignaron. No puede editar los de otras
personas. Un administrador puede darle o quitarle ese acceso en cualquier momento.

## Los borradores automáticos

El sistema genera borradores a partir de lo que publica la Asamblea Legislativa.
Ningún borrador se publica solo. Alguien tiene que leerlo y aprobarlo. Si usted
publica un texto, usted responde por él.`,
  },
  {
    id: "reglas-comunidad",
    title: "Reglas de la comunidad",
    audience: null,
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `Este sitio es para entender qué está haciendo el Congreso y decir qué piensa
usted al respecto. Para que eso funcione, hay unas pocas reglas.

## Sí

- Critique decisiones, votos y leyes, con todas sus palabras.
- Discrepe de otras personas.
- Corrija un dato equivocado. Si nos equivocamos, dígalo.

## No

- Amenazas contra nadie, ni contra figuras públicas.
- Datos privados de otras personas: dirección, teléfono, cédula, lugar de trabajo.
- Insultos por raza, nacionalidad, religión, género, orientación o discapacidad.
- Afirmaciones inventadas sobre lo que alguien hizo. Diga lo que puede sostener.
- Repetir el mismo mensaje una y otra vez.

## Comentarios tapados

Algunos comentarios aparecen tapados, con un botón para verlos. Eso pasa cuando
el comentario tiene insultos o ataques personales, pero igual dice algo. No lo
borramos: quien quiera leerlo entra a su cuenta, confirma que es mayor de edad,
y lo ve completo. Mientras tanto el texto no sale de nuestros servidores.

Quien lo escribió siempre ve su propio comentario.

## Qué pasa si se rompe una regla

Si el comentario no aporta nada, no se publica y le decimos por qué en el
momento. Si ya estaba publicado, lo ocultamos. Se guarda el registro, no se
borra. Si pasa varias veces, la cuenta pierde el permiso de comentar.


## Sobre las figuras públicas

Un diputado en ejercicio se expone a la crítica dura por lo que hace en el cargo.
Eso está permitido y es el punto del sitio. Lo que no está permitido es inventar
hechos ni meterse con su familia.`,
  },
  {
    id: "terminos",
    title: "Términos de uso",
    audience: null,
    version: VERSION,
    updatedAt: VERSION,
    bodyMarkdown: `Estas son las condiciones para usar El Censo. Están en español simple porque
un contrato que usted no entiende no sirve de nada.

## Qué es este sitio

El Censo lee lo que publica la Asamblea Legislativa y lo explica en palabras
corrientes. También le deja opinar sobre eso.

No somos el gobierno, ni la Asamblea, ni un partido. No tenemos ningún vínculo
oficial con ellos.

## Cómo se escriben las notas

Un sistema automático lee los documentos oficiales y prepara un borrador. Una
persona lo revisa antes de que salga publicado. Cada nota enlaza el documento
original para que usted verifique lo que dice.

El sistema puede equivocarse. Si encuentra un error, escríbanos y lo corregimos.
Si la corrección cambia el sentido de la nota, lo decimos en la misma nota en
lugar de arreglarla en silencio.

## Lo que usted publica

Los comentarios son suyos. Al publicarlos nos da permiso de mostrarlos en el
sitio. Usted responde por lo que escribe.

Podemos ocultar un comentario que rompa las reglas de la comunidad. Si pasa
varias veces, la cuenta pierde el permiso de comentar.

## Su cuenta

Una persona, una cuenta. No se vale crear cuentas para inflar votos ni para
hacerse pasar por otra persona.

Puede cerrar su cuenta cuando quiera. Escríbanos a la dirección del pie de página.

## Lo que no prometemos

El sitio se ofrece tal como está. No garantizamos que esté disponible a toda
hora ni que cada nota esté libre de errores.

Las notas son información, no consejo legal. Si algo le afecta de verdad,
consulte a un abogado y lea el documento original que enlazamos.

## Enlaces a otros sitios

Enlazamos a la Asamblea Legislativa, a YouTube y a otros sitios. No controlamos
lo que ellos publican ni cómo tratan sus datos.

## Cambios a estos términos

Si cambiamos estas condiciones, cambiamos también la fecha de arriba. Los
cambios importantes se avisan en el sitio.

## Ley aplicable

Aplica la ley de Costa Rica.`,
  },
];

/**
 * A stored document carries two extra flags the reader never sees.
 *
 * `adminEdited` marks a document a person has rewritten through the admin, which
 * puts it permanently out of reach of seeding. `seedHash` records which version
 * of the seed text produced it, so corrections here reach an existing database
 * instead of sitting in the source forever.
 */
interface StoredLegalDoc extends LegalDoc {
  adminEdited?: boolean;
  seedHash?: string;
}

function normalize(raw: Partial<StoredLegalDoc> & { _id?: string }): StoredLegalDoc {
  return {
    id: raw.id ?? raw._id ?? "",
    title: raw.title ?? "",
    audience: raw.audience ?? null,
    bodyMarkdown: raw.bodyMarkdown ?? "",
    version: raw.version ?? "",
    updatedAt: raw.updatedAt ?? "",
    adminEdited: raw.adminEdited === true,
    seedHash: raw.seedHash ?? "",
  };
}

/** Strips the bookkeeping fields before a document goes over the wire. */
function publicView(doc: StoredLegalDoc): LegalDoc {
  return {
    id: doc.id,
    title: doc.title,
    audience: doc.audience,
    bodyMarkdown: doc.bodyMarkdown,
    version: doc.version,
    updatedAt: doc.updatedAt,
  };
}

async function listStored(): Promise<StoredLegalDoc[]> {
  const rows = await fsList<Partial<StoredLegalDoc>>(COL.legalDocs);
  return rows.map(normalize).sort((a, b) => a.id.localeCompare(b.id));
}

export async function listLegalDocs(): Promise<LegalDoc[]> {
  return (await listStored()).map(publicView);
}

export async function getLegalDoc(id: string): Promise<LegalDoc | null> {
  return (await listLegalDocs()).find((d) => d.id === id) ?? null;
}

/** An admin edit takes the document out of seeding for good. */
export async function upsertLegalDoc(
  input: Partial<LegalDoc> & { id: string },
): Promise<LegalDoc> {
  const doc = normalize({
    ...input,
    updatedAt: new Date().toISOString().slice(0, 10),
    adminEdited: true,
  });
  await fsSet(legalDoc(doc.id), doc as unknown as Record<string, unknown>);
  return publicView(doc);
}

/**
 * Writes the seed documents, and rewrites the ones that have drifted from it.
 *
 * Create-only seeding looks safe and quietly rots: a correction to the text here
 * never reaches a database that was seeded once, months ago, so the published
 * policy keeps describing behaviour the code no longer has. Comparing a hash of
 * the seed body catches that without asking anyone to remember a version bump.
 *
 * A document an admin has edited is never touched, whatever the hash says.
 */
export async function seedLegalDocs(): Promise<number> {
  const stored = new Map((await listStored()).map((d) => [d.id, d]));
  let written = 0;

  for (const doc of SEED) {
    const current = stored.get(doc.id);
    const seedHash = await sha256Hex(`${doc.title}\n${doc.bodyMarkdown}`);

    if (current?.adminEdited) continue;
    if (current && current.seedHash === seedHash) continue;

    const record: StoredLegalDoc = { ...doc, adminEdited: false, seedHash };
    await fsSet(legalDoc(doc.id), record as unknown as Record<string, unknown>);
    written++;
  }
  return written;
}
