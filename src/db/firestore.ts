// ── Firestore REST client ────────────────────────────────────────────────────
// A small, dependency-free Firestore layer for Deno. Authenticates with the
// service account (signs an RS256 JWT → OAuth access token, cached), encodes/
// decodes Firestore typed values, and exposes the operations the repositories
// need: reads, writes, create-if-absent, compare-and-set, structured queries,
// and atomic field increments for the reaction counters.

import { config } from "../config.ts";
import { recordRefusal, spend } from "../lib/budget.ts";

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

let _sa: ServiceAccount | null = null;
async function serviceAccount(): Promise<ServiceAccount> {
  if (!_sa) _sa = JSON.parse(await Deno.readTextFile(config.serviceAccountPath));
  return _sa!;
}

// ── OAuth access token ────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Reading and writing documents. Everything the running server needs. */
export const SCOPE_DATASTORE = "https://www.googleapis.com/auth/datastore";
/** Administering the database itself, such as creating indexes. Scripts only. */
export const SCOPE_CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

const tokens = new Map<string, { value: string; exp: number }>();

async function accessToken(scope: string = SCOPE_DATASTORE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokens.get(scope);
  if (cached && cached.exp - 60 > now) return cached.value;

  const sa = await serviceAccount();
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  })));

  const unsigned = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const token = { value: data.access_token as string, exp: now + (data.expires_in ?? 3600) };
  tokens.set(scope, token);
  return token.value;
}

// ── Value codec (JS ⇄ Firestore typed values) ────────────────────────────────

type FsValue = Record<string, unknown>;

function toValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") {
    return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  }
  throw new Error(`Unsupported value type: ${typeof v}`);
}

function toFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
  return out;
}

function fromValue(val: FsValue): unknown {
  if ("nullValue" in val) return null;
  if ("stringValue" in val) return val.stringValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return val.doubleValue;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) {
    const values = (val.arrayValue as { values?: FsValue[] }).values ?? [];
    return values.map(fromValue);
  }
  if ("mapValue" in val) {
    return fromFields((val.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  }
  return null;
}

function fromFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

// ── REST plumbing ─────────────────────────────────────────────────────────────

/** `projects/{id}/databases/{db}/documents` — the resource name Firestore uses
 *  inside request bodies (write transforms, document references). */
async function docsResourceName(): Promise<string> {
  const sa = await serviceAccount();
  return `projects/${sa.project_id}/databases/${config.firestoreDatabase}/documents`;
}

/** The same path as an absolute URL, for the REST endpoints themselves. */
async function docsRoot(): Promise<string> {
  return `https://firestore.googleapis.com/v1/${await docsResourceName()}`;
}

/** `projects/{id}/databases/{db}` — the parent for admin calls such as indexes. */
export async function databaseResourceName(): Promise<string> {
  const sa = await serviceAccount();
  return `projects/${sa.project_id}/databases/${config.firestoreDatabase}`;
}

/**
 * Every read and every write in the system goes through here.
 *
 * That is what makes it the right place for the budget: one function to count,
 * with no way for a repository to reach Firestore around it. The token exchange
 * is deliberately outside the accounting — it is Google's OAuth endpoint, not
 * the database, it is cached for an hour, and counting it would make the number
 * mean something other than "documents we touched".
 *
 * A 429 is reported to the limiter rather than merely returned, because
 * Firestore answers an exhausted quota with a status rather than an error, and
 * a limiter that only watched for thrown exceptions would keep cheerfully
 * spending against a door that is already shut.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
  scope: string = SCOPE_DATASTORE,
): Promise<Response> {
  const token = await accessToken(scope);

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  return await spend("firestore", async () => {
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429) recordRefusal("firestore");
    return res;
  });
}

interface DocMeta<T> {
  data: T;
  updateTime: string;
}

/** Drops an unread response body so no resource leaks (Deno flags these). */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already consumed
  }
}

/** Get a document → its data, or null if it doesn't exist. */
export async function fsGet<T>(path: string): Promise<T | null> {
  const meta = await fsGetWithMeta<T>(path);
  return meta ? meta.data : null;
}

/** Get a document with its updateTime (needed for compare-and-set). */
export async function fsGetWithMeta<T>(path: string): Promise<DocMeta<T> | null> {
  const res = await authedFetch(`${await docsRoot()}/${path}`);
  if (res.status === 404) {
    await drain(res);
    return null;
  }
  if (!res.ok) throw new Error(`fsGet ${path} failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return { data: fromFields(doc.fields ?? {}) as T, updateTime: doc.updateTime };
}

/** Create or overwrite a document (no field mask → full replace). */
export async function fsSet(path: string, obj: Record<string, unknown>): Promise<void> {
  const res = await authedFetch(`${await docsRoot()}/${path}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`fsSet ${path} failed: ${res.status} ${await res.text()}`);
  await drain(res);
}

/**
 * Merge-update: writes only the given keys, leaving every other field intact.
 * Uses an updateMask so a partial write can never clobber unrelated data.
 */
export async function fsUpdate(path: string, obj: Record<string, unknown>): Promise<void> {
  const url = new URL(`${await docsRoot()}/${path}`);
  for (const k of Object.keys(obj)) url.searchParams.append("updateMask.fieldPaths", k);
  const res = await authedFetch(url.toString(), {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`fsUpdate ${path} failed: ${res.status} ${await res.text()}`);
  await drain(res);
}

/** Create a document only if it doesn't already exist. Returns false on conflict. */
export async function fsCreate(
  collectionPath: string,
  docId: string,
  obj: Record<string, unknown>,
): Promise<boolean> {
  const url = `${await docsRoot()}/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
  const res = await authedFetch(url, {
    method: "POST",
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (res.status === 409) {
    await drain(res);
    return false;
  }
  if (!res.ok) {
    throw new Error(
      `fsCreate ${collectionPath}/${docId} failed: ${res.status} ${await res.text()}`,
    );
  }
  await drain(res);
  return true;
}

/**
 * Compare-and-set: overwrite only if the doc's updateTime still matches.
 * Returns false when another writer changed it first (lost race).
 */
export async function fsCasUpdate(
  path: string,
  obj: Record<string, unknown>,
  updateTime: string,
): Promise<boolean> {
  const url = `${await docsRoot()}/${path}?currentDocument.updateTime=${
    encodeURIComponent(updateTime)
  }`;
  const res = await authedFetch(url, {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (res.status === 400 || res.status === 409) {
    await drain(res); // FAILED_PRECONDITION → lost race
    return false;
  }
  if (!res.ok) throw new Error(`fsCasUpdate ${path} failed: ${res.status} ${await res.text()}`);
  await drain(res);
  return true;
}

export async function fsDelete(path: string): Promise<void> {
  const res = await authedFetch(`${await docsRoot()}/${path}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`fsDelete ${path} failed: ${res.status} ${await res.text()}`);
  }
  await drain(res);
}

/**
 * Atomically add to numeric fields on one document, server-side. Two concurrent
 * callers both land: the counters can never lose a vote to a read-modify-write
 * race. Missing fields start at zero. Deltas may be negative.
 */
export async function fsIncrement(
  path: string,
  deltas: Record<string, number>,
): Promise<void> {
  const res = await authedFetch(`${await docsRoot()}:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `${await docsResourceName()}/${path}`,

          fieldTransforms: Object.entries(deltas).map(([field, by]) => ({
            fieldPath: field,
            increment: Number.isInteger(by) ? { integerValue: String(by) } : { doubleValue: by },
          })),
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`fsIncrement ${path} failed: ${res.status} ${await res.text()}`);
  await drain(res);
}

/** List all documents in a collection (paginated). Returns each doc's data + id. */
export async function fsList<T>(collectionPath: string): Promise<Array<T & { _id: string }>> {
  const out: Array<T & { _id: string }> = [];
  let pageToken = "";
  do {
    const url = new URL(`${await docsRoot()}/${collectionPath}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await authedFetch(url.toString());
    if (res.status === 404) break;
    if (!res.ok) {
      throw new Error(`fsList ${collectionPath} failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    for (const doc of data.documents ?? []) {
      const id = String(doc.name).split("/").pop()!;
      out.push({ ...(fromFields(doc.fields ?? {}) as T), _id: id });
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export interface QueryFilter {
  field: string;
  op:
    | "EQUAL"
    | "NOT_EQUAL"
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
    | "ARRAY_CONTAINS";
  value: unknown;
}

export interface QueryOptions {
  where?: QueryFilter[];
  orderBy?: { field: string; desc?: boolean };
  limit?: number;
}

/**
 * Structured query against one collection. Indexed and paged server-side, so
 * it stays cheap as collections grow (unlike filtering a full fsList in memory).
 */
export async function fsQuery<T>(
  collectionId: string,
  opts: QueryOptions = {},
): Promise<Array<T & { _id: string }>> {
  const body: Record<string, unknown> = {
    structuredQuery: {
      from: [{ collectionId }],
      ...(opts.where && opts.where.length
        ? {
          where: {
            compositeFilter: {
              op: "AND",
              filters: opts.where.map((f) => ({
                fieldFilter: {
                  field: { fieldPath: f.field },
                  op: f.op,
                  value: toValue(f.value),
                },
              })),
            },
          },
        }
        : {}),
      ...(opts.orderBy
        ? {
          orderBy: [{
            field: { fieldPath: opts.orderBy.field },
            direction: opts.orderBy.desc ? "DESCENDING" : "ASCENDING",
          }],
        }
        : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    },
  };

  const res = await authedFetch(`${await docsRoot()}:runQuery`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`fsQuery ${collectionId} failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  const out: Array<T & { _id: string }> = [];
  for (const row of rows) {
    if (!row.document) continue; // readTime-only rows
    const id = String(row.document.name).split("/").pop()!;
    out.push({ ...(fromFields(row.document.fields ?? {}) as T), _id: id });
  }
  return out;
}

/**
 * Filters server-side, then orders and trims in memory.
 *
 * Firestore requires a composite index whenever a query filters on one field
 * and sorts on another, and creating those indexes needs an IAM role the
 * service account does not currently hold (see scripts/ensure-indexes.ts). A
 * filter on a single field is served by the automatic index, so this fetches
 * the matching rows and sorts them here.
 *
 * The `scan` cap bounds the cost. Once the indexes exist, callers can switch
 * back to fsQuery with an orderBy and drop the in-memory pass.
 */
export async function fsQuerySorted<T>(
  collectionId: string,
  opts: {
    where?: QueryFilter[];
    sortBy: keyof T & string;
    desc?: boolean;
    limit?: number;
    scan?: number;
  },
): Promise<Array<T & { _id: string }>> {
  const rows = await fsQuery<T>(collectionId, {
    where: opts.where,
    limit: opts.scan ?? 500,
  });

  const dir = opts.desc ? -1 : 1;
  rows.sort((a, b) => {
    const av = a[opts.sortBy] as unknown;
    const bv = b[opts.sortBy] as unknown;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });

  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

/** Number of documents matching a query, without transferring their contents. */

export async function fsCount(collectionId: string, where: QueryFilter[] = []): Promise<number> {
  const body = {
    structuredAggregationQuery: {
      structuredQuery: {
        from: [{ collectionId }],
        ...(where.length
          ? {
            where: {
              compositeFilter: {
                op: "AND",
                filters: where.map((f) => ({
                  fieldFilter: {
                    field: { fieldPath: f.field },
                    op: f.op,
                    value: toValue(f.value),
                  },
                })),
              },
            },
          }
          : {}),
      },
      aggregations: [{ alias: "n", count: {} }],
    },
  };
  const res = await authedFetch(`${await docsRoot()}:runAggregationQuery`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`fsCount ${collectionId} failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  for (const row of rows) {
    const n = row?.result?.aggregateFields?.n;
    if (n) return Number(n.integerValue ?? n.doubleValue ?? 0);
  }
  return 0;
}
