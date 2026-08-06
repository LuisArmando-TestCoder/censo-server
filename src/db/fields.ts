// ── Field registry ───────────────────────────────────────────────────────────
// Admins define which fields an article carries. Nothing downstream hardcodes a
// field name: the editor renders inputs from these definitions and the public
// API filters by the same visibility flag. Adding a field is a document write.
//
// The registry is read on almost every request, so it is cached in memory with
// a short TTL. A newly created field appears within seconds without a restart.

import { fsDelete, fsList, fsSet } from "./firestore.ts";
import { COL, fieldDoc } from "./paths.ts";
import type { FieldDef, FieldType } from "../types.ts";

const CACHE_TTL_MS = 15_000;
let cache: { at: number; defs: FieldDef[] } | null = null;

/** Ships with a small, sensible set so the editor is usable from minute one. */
const SEED: FieldDef[] = [
  {
    id: "categoria",
    label: "Categoría",
    type: "select",
    options: ["Ley", "Votación", "Comisión", "Presupuesto", "Otro"],
    required: false,
    publicVisible: true,
    order: 10,
    active: true,
  },
  {
    id: "a_quien_afecta",
    label: "A quién afecta",
    type: "text",
    options: [],
    required: false,
    publicVisible: true,
    order: 20,
    active: true,
  },
  {
    id: "etapa",
    label: "Etapa del trámite",
    type: "select",
    options: [
      "Presentado",
      "En comisión",
      "Primer debate",
      "Segundo debate",
      "Aprobado",
      "Archivado",
    ],
    required: false,
    publicVisible: true,
    order: 30,
    active: true,
  },
  {
    id: "etiquetas",
    label: "Etiquetas",
    type: "tags",
    options: [],
    required: false,
    publicVisible: true,
    order: 40,
    active: true,
  },
  {
    id: "nota_interna",
    label: "Nota interna",
    type: "longtext",
    options: [],
    required: false,
    publicVisible: false,
    order: 50,
    active: true,
  },
];

/** Fills in anything a stored document is missing, so old rows never break. */
function normalize(raw: Partial<FieldDef> & { _id?: string }): FieldDef {
  return {
    id: raw.id ?? raw._id ?? "",
    label: raw.label ?? raw.id ?? "",
    type: (raw.type ?? "text") as FieldType,
    options: Array.isArray(raw.options) ? raw.options : [],
    required: raw.required ?? false,
    publicVisible: raw.publicVisible ?? true,
    order: raw.order ?? 999,
    active: raw.active ?? true,
  };
}

export async function listFields(force = false): Promise<FieldDef[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.defs;

  const rows = await fsList<Partial<FieldDef>>(COL.fieldRegistry);
  const defs = rows.map(normalize).sort((a, b) => a.order - b.order);
  cache = { at: Date.now(), defs };
  return defs;
}

export async function listActiveFields(): Promise<FieldDef[]> {
  return (await listFields()).filter((f) => f.active);
}

export async function upsertField(input: Partial<FieldDef> & { id: string }): Promise<FieldDef> {
  const def = normalize(input);
  await fsSet(fieldDoc(def.id), def as unknown as Record<string, unknown>);
  cache = null;
  return def;
}

/** Deactivates rather than deletes, so existing articles keep their values. */
export async function deactivateField(id: string): Promise<void> {
  const current = (await listFields(true)).find((f) => f.id === id);
  if (!current) return;
  await fsSet(fieldDoc(id), { ...current, active: false } as unknown as Record<string, unknown>);
  cache = null;
}

export async function deleteField(id: string): Promise<void> {
  await fsDelete(fieldDoc(id));
  cache = null;
}

/** Idempotent: only writes the fields that are not there yet. */
export async function seedFields(): Promise<number> {
  const existing = new Set((await listFields(true)).map((f) => f.id));
  let written = 0;
  for (const def of SEED) {
    if (existing.has(def.id)) continue;
    await fsSet(fieldDoc(def.id), def as unknown as Record<string, unknown>);
    written++;
  }
  if (written) cache = null;
  return written;
}

/**
 * Coerces a submitted value to its declared type and rejects anything that
 * cannot be represented. Returns the cleaned values plus the fields that are
 * required but missing.
 */
export function validateFieldValues(
  defs: FieldDef[],
  input: Record<string, unknown>,
): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const def of defs) {
    if (!def.active) continue;
    const raw = input[def.id];
    const empty = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);

    if (empty) {
      if (def.required) missing.push(def.label);
      continue;
    }

    switch (def.type) {
      case "number": {
        const n = Number(raw);
        if (Number.isFinite(n)) values[def.id] = n;
        break;
      }
      case "boolean":
        values[def.id] = raw === true || raw === "true";
        break;
      case "tags":
        values[def.id] = (Array.isArray(raw) ? raw : String(raw).split(","))
          .map((t) => String(t).trim())
          .filter(Boolean)
          .slice(0, 20);
        break;
      case "select": {
        const s = String(raw);
        if (def.options.includes(s)) values[def.id] = s;
        break;
      }
      default:
        values[def.id] = String(raw).slice(0, 5000);
    }
  }

  return { values, missing };
}
