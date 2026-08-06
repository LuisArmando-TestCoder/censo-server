// ── Proving the law scraper against the real site ────────────────────────────
// Everything in consultaLey.ts is an assertion about a SharePoint page we do
// not control: that a control is named this, that a date reads that way, that
// pressing Descargar returns a file. None of that can be verified by a type
// checker, and all of it breaks silently the day the Asamblea redeploys.
//
// So this script talks to the live site and checks the whole chain end to end:
// open the form, search a number, select the row, download the file, unzip it,
// and turn it into Markdown. It writes nothing to Firestore and calls no model,
// which makes it safe to run whenever something looks wrong in production.
//
//   deno task verify:leyes          checks a known law
//   deno task verify:leyes 10964    checks a specific one

import {
  downloadLawText,
  fetchLaw,
  findCeiling,
  openSession,
  parseSilDate,
  searchLaw,
  selectLaw,
} from "../src/scrape/consultaLey.ts";
import { docxToText, lawTextToMarkdown, looksLikeDocx } from "../src/lib/docx.ts";

let failures = 0;

function ok(label: string, detail = "") {
  console.log(`  ✓ ${label}${detail ? `  ${detail}` : ""}`);
}

function bad(label: string, detail = "") {
  failures++;
  console.error(`  ✗ ${label}${detail ? `  ${detail}` : ""}`);
}

function check(condition: boolean, label: string, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
}

/** Trims a long string for a single log line. */
function clip(s: string, n = 90): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

const target = Number(Deno.args[0] ?? 10964);

console.log(`\nVerificando el raspado de leyes (ley ${target})\n`);

// ── Date parsing ─────────────────────────────────────────────────────────────
// Pure, so it runs first: if this is broken, every date on the site is wrong
// and there is no point blaming the network.

console.log("Fechas del SIL");
check(parseSilDate("24-jun.-2026") === "2026-06-24", "24-jun.-2026 → 2026-06-24");
check(parseSilDate("03-mar.-2030") === "2030-03-03", "03-mar.-2030 → 2030-03-03");
check(parseSilDate("18-feb.-1963") === "1963-02-18", "18-feb.-1963 → 1963-02-18");
check(parseSilDate("  ") === null, "espacios → null");
check(parseSilDate(null) === null, "null → null");
check(parseSilDate("no es fecha") === null, "basura → null");

// ── The session ──────────────────────────────────────────────────────────────

console.log("\nSesión");
const session = await openSession();
check(session.cookie.length > 0, "cookie de sesión", clip(session.cookie, 40));
// Without these three hidden fields every postback is rejected by ASP.NET, so
// their presence is the real signal that the session opened.
check(
  (session.state.__VIEWSTATE ?? "").length > 100,
  "__VIEWSTATE",
  `${(session.state.__VIEWSTATE ?? "").length} bytes`,
);
check(!!session.state.__EVENTVALIDATION, "__EVENTVALIDATION");
check(!!session.state.__VIEWSTATEGENERATOR, "__VIEWSTATEGENERATOR");

// ── Search ───────────────────────────────────────────────────────────────────

console.log("\nBúsqueda por número");
const row = await searchLaw(session, target);
if (!row) {
  bad(`la ley ${target} no apareció en la búsqueda`);
} else {
  check(row.number === target, "número correcto", String(row.number));
  check(row.title.length > 10, "título", clip(row.title));
}

// A number that cannot exist must come back null rather than throwing or, worse,
// returning the previous row still on screen.
const absent = await searchLaw(session, 99999);
check(absent === null, "una ley inexistente devuelve null");

// ── Detail ───────────────────────────────────────────────────────────────────

if (row) {
  console.log("\nDetalle");
  const fresh = await openSession();
  const again = await searchLaw(fresh, target);
  const detail = again ? await selectLaw(fresh, again) : null;

  if (!detail) {
    bad("no se pudo seleccionar la fila");
  } else {
    check(typeof detail.inForce === "boolean", "vigencia", String(detail.inForce));
    check(
      detail.publishedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(detail.publishedAt),
      "fecha de publicación",
      String(detail.publishedAt),
    );
    check(
      detail.effectiveAt === null || /^\d{4}-\d{2}-\d{2}$/.test(detail.effectiveAt),
      "fecha de vigencia",
      String(detail.effectiveAt),
    );
    check(!!detail.expedienteNumber, "número de expediente", String(detail.expedienteNumber));

    // Affectations are optional: plenty of laws reform nothing. Only the shape
    // is checked, so this does not fail on a law that legitimately has none.
    const shaped = detail.affectations.every((a) => a.lawNumber && a.affectedLawTitle);
    check(shaped, "afectaciones bien formadas", `${detail.affectations.length} fila(s)`);
  }
}

// ── The document ─────────────────────────────────────────────────────────────

if (row) {
  console.log("\nTexto de ley");
  const fresh = await openSession();
  const again = await searchLaw(fresh, target);
  // Select first: Descargar acts on whatever row the server last rendered, so
  // downloading without selecting would either fail or fetch the wrong law.
  let doc = null;
  if (again) {
    await selectLaw(fresh, again);
    doc = await downloadLawText(fresh, again);
  }

  if (!doc) {
    // Not a failure on its own: many laws have no digitised text, and the code
    // is required to say so rather than to invent one.
    console.log("  · la Asamblea no tiene archivo para esta ley (null)");
  } else {
    check(doc.bytes.length > 1000, "archivo descargado", `${doc.bytes.length} bytes`);
    check(!!doc.filename, "nombre del archivo", doc.filename);

    if (looksLikeDocx(doc.bytes)) {
      ok("es un .docx");
      const text = await docxToText(doc.bytes);
      check(text.length > 500, "texto extraído", `${text.length} caracteres`);
      check(/\w{4,}/.test(text), "el texto tiene palabras", clip(text, 70));

      const md = lawTextToMarkdown(text);
      check(md.length > 0, "markdown generado", `${md.length} caracteres`);
      // The whole point of the Markdown pass is structure; if nothing was
      // promoted to a heading, the law came through as an undifferentiated wall.
      check(/^#{2,3} /m.test(md), "tiene encabezados de artículo");
    } else {
      console.log(`  · no es .docx (probablemente PDF): ${doc.filename}`);
    }
  }
}

// ── The convenience wrapper ──────────────────────────────────────────────────
// fetchLaw is what the cron actually calls, so it is checked as its own thing
// rather than assumed to work because its parts do.

console.log("\nfetchLaw (lo que usa el cron)");
const full = await fetchLaw(target);
if (!full) {
  bad(`fetchLaw devolvió null para ${target}`);
} else {
  check(full.detail.number === target, "detalle", String(full.detail.number));
  check(
    full.document === null || full.document.bytes.length > 1000,
    "documento",
    full.document ? `${full.document.filename}, ${full.document.bytes.length} bytes` : "sin texto",
  );
}

// ── The ceiling ──────────────────────────────────────────────────────────────
// How the sweeper learns where the numbering currently ends. Checked last
// because it costs several requests.

console.log("\nTecho de numeración");
const ceiling = await findCeiling(target);
check(ceiling >= target, "el techo no es menor que la ley conocida", String(ceiling));
check(ceiling < target + 500, "el techo es plausible", String(ceiling));

// ── Result ───────────────────────────────────────────────────────────────────

console.log(
  failures === 0
    ? "\nTodo bien. El raspador sigue de acuerdo con el sitio de la Asamblea.\n"
    : `\n${failures} verificación(es) fallaron. El sitio probablemente cambió.\n`,
);

Deno.exit(failures === 0 ? 0 : 1);
