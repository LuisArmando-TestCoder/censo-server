/// <reference lib="deno.ns" />
// ── The model, driven through its web interface ──────────────────────────────
// Adapted from irp-funnel-server/API/chatbot/intelligence/scraperLLM.ts. There
// is no API key here: Selenium drives a headless Chrome session against the
// Gemini web app and reads the answer out of the DOM.
//
// That makes it free and also fragile, so everything below is defensive. Each
// call gets bounded retries with backoff, the browser is torn down and rebuilt
// when a session goes bad, and calls are serialized because one browser cannot
// hold two conversations at once.

import { Browser, Builder, By, until, type WebElement } from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome";
import { BudgetExhausted, spend } from "../lib/budget.ts";

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface CallOptions {
  /** How many times to retry a failed call. Each retry restarts the browser. */
  retries?: number;
  /** Base backoff in ms. Doubles per attempt. */
  backoffMs?: number;
}

const CHAT_INPUT = "div.ql-editor";
const RESPONSE_BLOCKS = "message-content, .markdown, .model-response-text";
const GEMINI_URL = "https://gemini.google.com/app";

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2_000;
const LOGIN_WAIT_MS = 60_000;
/** How long to keep waiting while the answer is still growing. */
const ANSWER_TIMEOUT_MS = 120_000;
/** The answer counts as finished once it stops changing for this long. */
const STABLE_CHECKS = 3;
const POLL_MS = 1_500;

let driver: any = null;

// One browser, one conversation at a time. Concurrent calls queue behind this.
let chain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(sel: string, timeoutMs = LOGIN_WAIT_MS): Promise<WebElement> {
  const el = await driver.wait(until.elementLocated(By.css(sel)), timeoutMs);
  await driver.wait(until.elementIsVisible(el), timeoutMs);
  return el;
}

export async function openBrowser(): Promise<void> {
  if (driver) return;

  const options = new Options();
  options.addArguments("--window-size=1200,1000");
  options.addArguments("--disable-blink-features=AutomationControlled");
  options.addArguments("--no-sandbox"); // required on most Linux hosts
  options.addArguments("--disable-dev-shm-usage"); // small /dev/shm in containers
  options.addArguments("--disable-gpu");
  options.excludeSwitches("enable-automation");

  // A profile directory is what makes this usable at all. Without one, Chrome
  // starts signed out on every run, stops at the Google login screen, and the
  // wait below times out — which is exactly how this fails today. Point
  // CHROME_PROFILE_DIR at a directory, sign in once by hand, and the session
  // persists across runs.
  //
  // It is deliberately not the everyday Chrome profile: Chrome refuses to share
  // a profile directory with a running instance, so borrowing it would either
  // fail or force the browser closed mid-work.
  const profileDir = Deno.env.get("CHROME_PROFILE_DIR");
  if (profileDir) options.addArguments(`--user-data-dir=${profileDir}`);

  // Headless by default, because that is how it runs unattended. The signing-in
  // step needs a visible window, and there is no way to type a password into a
  // browser nobody can see.
  const headless = (Deno.env.get("CHROME_HEADLESS") ?? "true") !== "false";
  if (headless) options.addArguments("--headless=new");

  driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).build();
  await driver.get(GEMINI_URL);

  // A signed-out profile stops here until someone logs in.
  try {
    await waitFor(CHAT_INPUT, LOGIN_WAIT_MS);
  } catch (err) {
    throw new Error(
      profileDir
        ? `Gemini no mostró el campo de texto en ${LOGIN_WAIT_MS / 1000}s. La sesión del perfil ` +
          `${profileDir} probablemente expiró: vuelva a iniciarla con ` +
          `CHROME_HEADLESS=false deno task login:gemini`
        : `Gemini no mostró el campo de texto en ${LOGIN_WAIT_MS / 1000}s porque el navegador ` +
          `arranca sin sesión. Configure CHROME_PROFILE_DIR e inicie sesión una vez con ` +
          `CHROME_HEADLESS=false deno task login:gemini`,
      { cause: err },
    );
  }
}

export async function closeBrowser(): Promise<void> {
  if (!driver) return;
  try {
    await driver.quit();
  } catch {
    // already gone
  }
  driver = null;
}

/** A fresh conversation, so nothing from the previous item bleeds into this one. */
async function resetChat(): Promise<void> {
  await openBrowser();
  await driver.get(GEMINI_URL);
  await waitFor(CHAT_INPUT, LOGIN_WAIT_MS);
}

/** Polls the last response block until its text stops growing. */
async function readAnswer(): Promise<string> {
  let previous = "";
  let stable = 0;
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;

  // Give the new response block a moment to mount before reading.
  await sleep(3_000);

  while (Date.now() < deadline) {
    try {
      const blocks = await driver.findElements(By.css(RESPONSE_BLOCKS));
      if (blocks.length) {
        const text: string = await blocks[blocks.length - 1].getText();
        if (text) {
          if (text === previous) {
            stable++;
            if (stable >= STABLE_CHECKS) return text;
          } else {
            stable = 0;
            previous = text;
          }
        }
      }
    } catch {
      // Stale element while the DOM re-renders. Poll again.
    }
    await sleep(POLL_MS);
  }

  if (previous) return previous; // timed out but we have something usable
  throw new Error("The model never produced a readable answer.");
}

async function askOnce(prompt: string): Promise<string> {
  await resetChat();
  const input = await waitFor(CHAT_INPUT);

  // Typing character by character is slow and flaky for long prompts, so the
  // text is set directly and the input events the editor listens for are fired.
  await driver.executeScript(
    (el: any, text: string) => {
      el.focus();
      el.innerText = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    input,
    prompt,
  );

  await sleep(1_500); // let the send button enable itself
  const send = await waitFor("button[aria-label*='Send']");
  await send.click();

  return await readAnswer();
}

/**
 * Sends one prompt and returns the raw answer.
 *
 * Retries with exponential backoff. Because a failure usually means the browser
 * session itself is unhealthy, every retry closes and reopens it rather than
 * poking at the same broken page.
 */
export async function ask(prompt: string, opts: CallOptions = {}): Promise<string> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

  const run = async (): Promise<string> => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Metered per attempt, not per call: every retry reopens the browser
        // and asks the model again, so three attempts are three visits however
        // they look to the caller. Counting the outer call once would let a
        // flapping session spend four times what the budget believes.
        return await spend("model", () => askOnce(prompt));
      } catch (err) {
        // The one failure not worth retrying. Being out of budget is a decision
        // this process already made, so trying again immediately would just
        // spend three attempts rediscovering it — and if the refusal is a
        // backoff, retrying is precisely what the backoff exists to prevent.
        if (err instanceof BudgetExhausted) throw err;

        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[llm] attempt ${attempt + 1} of ${retries + 1} failed: ${message}`);

        await closeBrowser();
        if (attempt < retries) await sleep(backoff * 2 ** attempt);
      }
    }

    throw new Error(
      `The model failed after ${retries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  };

  // Serialize: the queue survives a rejection so one bad call cannot wedge it.
  const queued = chain.then(run, run);
  chain = queued.catch(() => {});
  return await queued;
}

/** Flattens a conversation into the single prompt the web interface accepts. */
export function compileMessages(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const label = m.role === "system"
      ? "INSTRUCCIONES"
      : m.role === "user"
      ? "ENTRADA"
      : "RESPUESTA PREVIA";
    parts.push(`### ${label}\n${m.content}`);
  }
  parts.push("### RESPUESTA\nResponda ahora, siguiendo las instrucciones al pie de la letra.");
  return parts.join("\n\n");
}

/**
 * Asks for JSON and returns it parsed.
 *
 * The model is told to wrap its answer in a fenced block. Model output is
 * untrusted input: the block is located, parsed defensively, and a response
 * that is not valid JSON raises rather than being half-read.
 */
export async function askJson<T>(
  messages: Message[],
  shape: string,
  opts: CallOptions = {},
): Promise<T> {
  const prompt = `${compileMessages(messages)}

Devuelva solamente un bloque JSON con este formato, sin texto antes ni después:

\`\`\`json
${shape}
\`\`\``;

  const raw = await ask(prompt, opts);
  const json = extractJson(raw);
  if (!json) {
    throw new Error(`No JSON block in the answer. First 300 chars: ${raw.slice(0, 300)}`);
  }

  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `The JSON block did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Pulls the JSON out of a fenced block, or falls back to the outermost braces. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return null;
}
