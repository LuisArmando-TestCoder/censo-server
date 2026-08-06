// ── Public legal documents ───────────────────────────────────────────────────
// Anyone can read these without an account. A policy behind a login is not a
// policy anyone can hold you to.

import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { fail } from "../lib/validate.ts";
import { getLegalDoc, listLegalDocs } from "../db/legal.ts";

const legal = new Hono<AppEnv>();

legal.get("/", async (c) => {
  const docs = await listLegalDocs();
  return c.json({
    docs: docs.map((d) => ({
      id: d.id,
      title: d.title,
      audience: d.audience,
      version: d.version,
      updatedAt: d.updatedAt,
    })),
  });
});

legal.get("/:id", async (c) => {
  const doc = await getLegalDoc(c.req.param("id"));
  if (!doc) fail(404, "That document does not exist.");
  return c.json({ doc: doc! });
});

export default legal;
