// ── The pipeline ─────────────────────────────────────────────────────────────
// One raw item in, one draft article out, with every step recorded.
//
//   extract → reason → humanize → validate → (retry once) → draft
//
// Nothing here ever publishes. A clean draft lands as `draft` and a problematic
// one as `needs_human`, so an editor always stands between the model and the
// reader. The full trace is written to pipeline_runs, which is what makes an
// article auditable after the fact.

import { extract, type HumanDraft, humanize, reason } from "./agents.ts";
import { issuesAsInstructions, validateDraft } from "./validator.ts";
import { createPost, getPost, updatePost } from "../db/posts.ts";
import { getSource } from "../db/sources.ts";
import { setRawItemStatus } from "../db/rawItems.ts";

import { fsSet } from "../db/firestore.ts";
import { pipelineRunDoc } from "../db/paths.ts";
import { randomId } from "../lib/validate.ts";
import type {
  AgentName,
  AgentStep,
  Citation,

  PipelineRun,
  PostBlock,
  PostStatus,
  RawItem,
  ValidationIssue,
} from "../types.ts";

export interface PipelineResult {
  rawItemId: string;
  verdict: PipelineRun["verdict"] | "skipped";
  postId: string | null;
  issues: ValidationIssue[];
  note: string;
}

/** Splits plain paragraphs into blocks, appending one link block per source. */
function toBlocks(draft: HumanDraft, item: RawItem): PostBlock[] {
  const blocks: PostBlock[] = draft.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ id: randomId(6), kind: "paragraph" as const, text, items: [] }));

  for (const link of item.links) {
    blocks.push({
      id: randomId(6),
      // A video gets its own block so the reader can watch the session itself.
      kind: link.kind === "youtube" ? "video" : "source_link",
      text: link.url,
      items: [],
    });
  }

  return blocks;
}

export async function runPipeline(item: RawItem): Promise<PipelineResult> {
  const runId = randomId(12);
  const steps: AgentStep[] = [];
  const startedAt = new Date().toISOString();

  const record = async (
    agent: AgentName,
    iteration: number,
    prompt: string,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    const stepStart = new Date().toISOString();
    try {
      const output = await fn();
      steps.push({
        agent,
        iteration,
        prompt,
        output: JSON.stringify(output),
        ok: true,
        error: null,
        startedAt: stepStart,
        finishedAt: new Date().toISOString(),
      });
      return output;
    } catch (err) {
      steps.push({
        agent,
        iteration,
        prompt,
        output: "",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt: stepStart,
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  };

  const persist = async (
    verdict: PipelineRun["verdict"],
    issues: ValidationIssue[],
  ): Promise<void> => {
    const run: PipelineRun = {
      id: runId,
      rawItemId: item.id,
      steps,
      issues,
      verdict,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await fsSet(pipelineRunDoc(runId), run as unknown as Record<string, unknown>);
  };

  await setRawItemStatus(item.id, "processing");

  try {
    // 1. What does the source actually say?
    const facts = await record("extractor", 1, "extract", () => extract(item)) as Awaited<
      ReturnType<typeof extract>
    >;

    if (facts.substance === "empty") {
      await persist("needs_human", [
        { rule: "no_substance", detail: "The source item carries nothing to explain." },
      ]);
      await setRawItemStatus(item.id, "done", null);
      return {
        rawItemId: item.id,
        verdict: "skipped",
        postId: null,
        issues: [],
        note: "Nothing in the source to explain.",
      };
    }

    // 2. Does it matter to anyone outside the building?
    const thinking = await record("reasoner", 1, "reason", () => reason(item, facts)) as Awaited<
      ReturnType<typeof reason>
    >;

    if (!thinking.worthPublishing) {
      await persist("needs_human", [
        { rule: "not_newsworthy", detail: thinking.rationale || "Internal procedure only." },
      ]);
      await setRawItemStatus(item.id, "done", null);
      return {
        rawItemId: item.id,
        verdict: "skipped",
        postId: null,
        issues: [],
        note: thinking.rationale || "Internal procedure only.",
      };
    }

    // 3. Write it, check it, and give exactly one chance to fix what is wrong.
    const sourceText = `${item.title}\n${item.body}`;
    let draft = await record(
      "humanizer",
      1,
      "humanize",
      () => humanize(item, facts, thinking),
    ) as HumanDraft;
    let issues = validateDraft(draft, sourceText);

    if (issues.length) {
      const instructions = issuesAsInstructions(issues);
      draft = await record(
        "humanizer",
        2,
        "humanize (retry)",
        () => humanize(item, facts, thinking, instructions),
      ) as HumanDraft;
      issues = validateDraft(draft, sourceText);
    }

    // A draft that still fails is stored for a human, never discarded: the
    // editor can see what the model produced and why it was held back.
    const status: PostStatus = issues.length ? "needs_human" : "draft";

    // The footnote names the upstream item rather than pasting a URL: a reader
    // can weigh "Asamblea Legislativa, 3 de marzo" without opening anything.
    const source = await getSource(item.sourceId);
    const citations: Citation[] = [{
      title: item.title,
      origin: source?.institution ?? item.sourceId,
      date: item.eventDate,
      url: item.links[0]?.url ?? null,
    }];

    const fields = {
      title: draft.title,
      summary: draft.summary,
      blocks: toBlocks(draft, item),
      sourceUrls: item.links.map((l) => l.url),
      citations,
      status,
    };


    // An item that has already produced an article is rewritten in place. The
    // alternative is two articles about one event, differing only in wording,
    // with the reader left to guess which is current. The published state is
    // deliberately left alone: a rewrite must not quietly republish something an
    // editor archived, nor unpublish what is live.
    const existing = item.postId ? await getPost(item.postId) : null;

    let postId: string;
    if (existing) {
      const keepStatus = existing.status === "published" || existing.status === "archived";
      await updatePost(existing.id, keepStatus ? { ...fields, status: existing.status } : fields);
      postId = existing.id;
    } else {
      const created = await createPost({
        ...fields,
        origin: "generative",
        ownerEmail: null,
        rawItemId: item.id,
      });
      postId = created.id;
    }

    await persist(issues.length ? "needs_human" : "published_draft", issues);
    await setRawItemStatus(item.id, issues.length ? "needs_human" : "done", postId);

    return {
      rawItemId: item.id,
      verdict: issues.length ? "needs_human" : "published_draft",
      postId,

      issues,
      note: issues.length
        ? `Held for review: ${issues.length} issue(s).`
        : "Draft ready for an editor.",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persist("failed", [{ rule: "agent_error", detail }]);
    await setRawItemStatus(item.id, "failed");
    return {
      rawItemId: item.id,
      verdict: "failed",
      postId: null,
      issues: [{ rule: "agent_error", detail }],
      note: detail,
    };
  }
}
