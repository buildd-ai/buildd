---
name: spec-sync
description: "Spec-driven development loop for buildd. Keeps docs/SPEC.md as the single source of truth and reconciles downstream artifacts (buildd-docs, buildd-site, knowledge-base) against it. Use when re-grounding the product spec, auditing doc drift, after major schema/route changes, or before a docs/site refresh."
author: buildd
---

# Spec-Sync

Spec-driven development for buildd. **Code is the source of truth; `docs/SPEC.md`
is its canonical written form; the doc/site repos are outputs.** This skill keeps
that chain from rotting.

## Mental model

```
code (schema + routes + runner)  ──►  docs/SPEC.md  ──►  buildd-docs / buildd-site
        (truth)                        (canonical)         (downstream outputs)
                         ▲                                        │
                         └──────────── drift tasks ◄──────────────┘
```

Never edit SPEC.md to match the docs. Edit it to match the **code**, then fix the
docs to match SPEC.md.

## When to use

- Re-grounding the spec after drift has accumulated.
- After a schema (`packages/core/db/schema.ts`) or API-route change that alters the
  domain model — update SPEC.md §2/§4 in the same PR.
- Before refreshing `buildd-docs` or `buildd-site`.
- Periodic drift audit (regenerate `docs/doc-drift-punchlist.md`).

## The loop (proven pipeline)

```
ingest (clean code corpus)  →  retrieve (surface candidates)  →  JUDGE (agent reads evidence)  →  emit drift
```

1. **Re-derive truth.** `schema.ts` (tables/enums), `api/**` routes, `apps/runner/src/backends/`
   are ground truth. Don't trust the doc repos. Keep `docs/SPEC.md` matching them.
2. **Ingest a CLEAN code corpus.** Exclude history — migrations and tests keep removed
   features semantically "alive" (a `CREATE TABLE objectives` migration makes "objectives"
   look implemented forever). Always ingest the code side with:
   `INGEST_SKIP_DIRS=drizzle,__tests__ INGEST_SKIP_TESTS=1` (see ingest section).
3. **Retrieve, don't trust scores.** `spec-drift.ts` surfaces top code/doc matches per probe.
   **Scores SURFACE; they do NOT decide.** A reranker always returns a best match, so a
   documented-not-built feature still scores moderately against its semantic neighbor
   (proven: "objectives" matches the *missions* table at ~0.45). Never gate drift on a
   threshold — it reports false-green.
4. **Judge the evidence.** Run `spec-drift.ts <ns> --evidence` and pass the JSON to a judge —
   a `Task` agent interactively, or `claude -p` headless in CI. The judge rules, per term:
   *do the CODE snippets actually implement it (real table/route/impl), or are they only
   semantic neighbors?* This is the step that catches drift; the retrieval is just its input.
5. **Reconcile** docs/site *against SPEC.md* — never the reverse. Optionally file confirmed
   drift as buildd tasks.

## The embedding corpus (unified workspace store)

`spec_compare` reads the **unified workspace store** — the same store that `query_knowledge`
uses. Two corpora within the workspace:

| Corpus | Namespace | What it holds |
|--------|-----------|--------------|
| `code` | `{workspaceId}:code` | Source files ingested by the knowledge-ingest GH Actions workflow |
| `spec` | `{workspaceId}:spec` | Spec/docs chunks (SPEC.md, buildd-docs, buildd-site, knowledge-base) |

Ingestion is handled by the **GH Actions knowledge-ingest workflow** — not the ephemeral
Neon branch this skill previously maintained. Re-run that workflow to refresh the corpus.

For local or ad-hoc ingestion, use:

```bash
SPEC_WORKSPACE_ID=<workspace-uuid> \
DATABASE_URL=<target-db> \
VOYAGE_API_KEY=<key>            # omit -> lexical-only (BM25), still usable \
  bash .claude/skills/spec-sync/scripts/ingest-spec-corpus.sh
```

The corpus is **rebuildable** — each file's prior chunks are cleared before re-chunk
(idempotent on `(namespace, source_id)`).

### Prerequisites / gotchas
- `VOYAGE_API_KEY` is **not** in `.env`/shell by default — without it you get lexical-only
  (no semantic search). Confirm before claiming "embedded."
- `spec_compare` resolves the workspace from the MCP connection context. Connect with
  `?workspace=<id>` when calling the remote MCP endpoint.

## Non-negotiables

- SPEC.md changes follow the code, never the marketing.
- A feature absent from `schema.ts`/routes does **not** exist — remove it from docs.
- Removed concepts (Objectives, Recipes, heartbeat-as-feature, `observations`,
  `codex_credentials`) stay removed. See SPEC.md §8.
