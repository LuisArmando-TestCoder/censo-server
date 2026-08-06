// ── Signing the crawler's browser in, once ───────────────────────────────────
// The summariser reads Gemini through a real browser rather than an API, so it
// needs a Google session. This opens a visible window against the profile that
// the crawler will later reuse headlessly, and waits while a person signs in.
//
// It exists because the alternative is worse: without it the first summary of
// every deployment fails at a login screen nobody can see, sixty seconds at a
// time, with no way to intervene.
//
//   CHROME_PROFILE_DIR=./.chrome deno task login:gemini
//
// Sign in, confirm the chat box is on screen, then press Enter here. The
// session persists in that directory, and `deno task crawl --summaries` will
// find it. Google expires these eventually; when it does, run this again.

const profileDir = Deno.env.get("CHROME_PROFILE_DIR");
if (!profileDir) {
  console.error(`
Falta CHROME_PROFILE_DIR.

Es el directorio donde queda guardada la sesión de Google. Elija uno que no sea
el perfil de Chrome de todos los días: Chrome no comparte un perfil con otra
instancia abierta, así que usarlo obligaría a cerrar su navegador.

  CHROME_PROFILE_DIR=./.chrome deno task login:gemini
`);
  Deno.exit(1);
}

// Headful, always: the whole point is that somebody can see and type.
Deno.env.set("CHROME_HEADLESS", "false");

const { openBrowser, closeBrowser } = await import("../src/intelligence/scraperLLM.ts");

console.log(`
Abriendo Chrome con el perfil ${profileDir}.

Inicie sesión en Google y espere a ver el campo de texto de Gemini. Esta ventana
se queda esperando: cuando el chat esté listo, vuelva aquí y presione Enter.
`);

try {
  // openBrowser already waits for the chat input, so reaching the next line
  // means the session is genuinely usable — not merely that a window opened.
  await openBrowser();
  console.log("Sesión lista. Presione Enter para cerrar el navegador.");
  await Deno.stdin.read(new Uint8Array(1));

  console.log(`
Listo. La sesión queda guardada en ${profileDir}.

Ahora puede correr los resúmenes:

  CHROME_PROFILE_DIR=${profileDir} deno task crawl --summaries
`);
} catch (err) {
  console.error(`\nNo se pudo dejar la sesión lista: ${err instanceof Error ? err.message : err}`);
  Deno.exit(1);
} finally {
  await closeBrowser();
}
