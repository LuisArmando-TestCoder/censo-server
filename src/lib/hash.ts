// ── Hashing ──────────────────────────────────────────────────────────────────
// Stable ids derived from content, so the same input always maps to the same
// document. Used for user ids (from email) and raw-item change detection.

const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A user's document id. Email is the identity key; the id is a derived slug. */
export function userId(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

/** URL-safe slug from a headline, with a short suffix to keep it unique. */
export function slugify(title: string, suffix: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base ? `${base}-${suffix}` : suffix;
}
