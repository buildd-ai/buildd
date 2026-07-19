# Knowledge Elevation — Auto-Ingestion, Pull-Only Access, and Consolidation Cadence

**Status:** Draft — spec only, no implementation
**Date:** 2026-07-18
**Scope:** Ingestion pipeline, MCP access policy, memory scoping, consolidation lifecycle
**Recon artifact:** Knowledge Layer Audit
**Prior art:** `docs/design/workspace-knowledge-management.md` (Wave 1 shipped; this spec extends it)

---

## Context

The recon audit surfaced a structural failure: nearly all repo-linked workspaces have no code or docs index (F1). The `knowledge-ingest.yml` CI workflow is hardcoded to the buildd workspace. The diff ingest webhook fires for all workspaces but the bootstrap full job is never claimed because runners are workspace-scoped and no runner is targeted at non-buildd workspaces. Per-workspace spec ingestion (`{workspaceId}:spec`) has never run for any client workspace, so `spec_compare` and the spec-validator role return empty results everywhere except buildd.

Additionally, the CI full ingest and diff ingest store paths in different formats (F2): the CI script uses the ingest subdirectory as the root (`core/...`, `web/...`) while the webhook uses full repo-relative paths (`packages/core/...`, `apps/web/...`). `deleteBySource` cannot find CI-ingested chunks when a file is later touched via a PR — stale chunks accumulate indefinitely.

This spec addresses these gaps through five levers:
1. Auto-ingestion on workspace repo link (new trigger)
2. Incremental re-ingestion on merged PRs (fix + formalize existing webhook flow)
3. Per-workspace spec corpus (new corpus: `{workspaceId}:spec` for all workspaces)
4. Memory scoping policy for client teams (team-scoped by design, with project filter option)
5. Pull-only knowledge access (claim payload hint, role prompt gates, instrumentation)
6. Weekly consolidation cadence (staleness control at source)

---

## 1. Auto-Ingestion on Workspace Repo Link

### 1.1 Trigger

When `manage_workspaces` receives a `create` or `update` action with a non-empty `repoUrl` — and the resolved `repoUrl` differs from the workspace's current `repoUrl` — the server enqueues a `scope=full` ingest job for corpora `code` and `docs`. This covers:

- New workspaces created with a repo URL in the same request
- Existing workspaces where a repo is linked for the first time
- Existing workspaces where the repo URL changes (e.g. repo renamed or transferred)

The same trigger fires at the GitHub App installation level: when a repo is installed into the GitHub App (webhook event `installation_repositories.added`), look up any workspace bound to that repo and enqueue a full ingest job if no `{workspaceId}:code` namespace exists yet.

### 1.2 Idempotency and Locking

The `knowledge_ingest_jobs` table (added in workspace-knowledge-management.md §3.2, shipped in PR #1180) carries a partial unique index:

```sql
CREATE UNIQUE INDEX knowledge_ingest_jobs_workspace_full_active
  ON knowledge_ingest_jobs (workspace_id, repo)
  WHERE scope = 'full' AND status IN ('queued', 'running');
```

This index is the primary guard. Before inserting a new `scope=full` job, the handler runs a `SELECT 1 FROM knowledge_ingest_jobs WHERE workspace_id = $1 AND repo = $2 AND scope = 'full' AND status IN ('queued', 'running') LIMIT 1`. If a row exists the insert is skipped — the existing job will pick up the latest HEAD when it runs. The partial unique index is a backstop against concurrent requests racing past the application-level guard.

This was the failure mode after PR #1159 (recon §4.2): multiple PRs merged in quick succession each saw `hadCodeIndex=false` and each enqueued a full job at a different SHA, bypassing the unique index because SHAs differed. The fix (PR #1220) added both the partial unique index on `(workspace_id, repo)` (dropping SHA from the constraint) and the `SELECT...LIMIT 1` application guard. This spec formalizes that fix as the canonical pattern for all future full-job enqueueing.

**Concurrent full-backfill cannot stack** because:
1. The application guard checks for any queued/running full job regardless of SHA.
2. The partial unique index enforces this at the database level.
3. A new trigger during an in-flight full job is a no-op; the running job ingests at its SHA and incremental diffs catch anything that merged after it started.

### 1.3 Execution Path

Full ingest jobs execute on the runner fleet (reusing the worker rail: a system task with `roleSlug='ingest'`, hidden from the task UI, claimed by any runner with repo access). For workspaces with no active runner, an admin can trigger ingestion via:

- `POST /api/admin/workspaces/[id]/ingest/bootstrap` — enqueues a full job; server-side execution using the buildd API key.
- Parameterized `workflow_dispatch` on `knowledge-ingest.yml` with `workspace_id` and `repo` inputs — for cases where a runner-less workspace needs an initial index.

The parameterized CI path is the immediate backfill mechanism for the 10 currently un-indexed workspaces.

### 1.4 Path Normalization Fix (Prerequisite)

Before any new full-ingest jobs run, the path format inconsistency (recon F2) must be resolved. In `packages/core/scripts/ingest-knowledge.ts:151`, change:

```typescript
// BEFORE — subdir-relative paths: core/knowledge-store/types.ts
const root = path.resolve(dirArg);

// AFTER — full repo-relative paths: packages/core/knowledge-store/types.ts
const root = process.cwd();
```

`dirArg` remains the walk start point unchanged. After deployment, a one-time re-ingest of the buildd workspace prunes the old subdir-relative chunks (the `DELETE WHERE updated_at < job.startedAt` sweep at job end handles removal). All subsequent ingest jobs — CI, runner, and diff — will store and look up paths in the same format (`packages/core/...`, `apps/web/...`), making `deleteBySource` reliable across streams.

This fix is a prerequisite for §2 (incremental re-ingestion) to work correctly. Without it, diff ingest continues to miss stale full-ingest chunks.

---

## 2. Incremental Re-Ingestion on Merged PRs

### 2.1 Diff-Scoped Re-Ingestion (Primary Path)

The existing merge webhook (`apps/web/src/app/api/github/webhook/route.ts`) already calls `enqueueMergedPrIngestJobs()` on every merged PR for any workspace with a bound repo. This is the incremental re-ingestion hook; no new wiring is needed once the path normalization fix (§1.4) is in place.

Diff ingest for a merged PR:
1. Fetch changed files from the GitHub API (installation token, same credentials already in the webhook handler).
2. For each changed file: fetch blob content at merge SHA via the Contents API.
3. Delete existing chunks for removed or renamed paths via `deleteBySource(namespace, sourcePath)`.
4. Chunk + upsert new content into `{workspaceId}:code` or `{workspaceId}:docs` (classified by extension).
5. `_markSuperseded` fires on upsert — pre-merge chunks for changed files are marked `is_current=false, superseded_by=<new chunk id>` automatically.

Path cap: 100 files / 2 MB fetched per diff job. PRs exceeding the cap escalate to a `scope=full` job (subject to the idempotency guard in §1.2).

### 2.2 Full Backfill Becomes Admin-Only

After the initial index is created via the workspace-link trigger (§1), full re-ingestion is triggered only by:

- An explicit admin action (`POST /api/admin/workspaces/[id]/ingest/bootstrap` or `workflow_dispatch`)
- A diff job escalating past the file/size cap
- A weekly scheduled full re-sync (as a recovery sweep, not the primary freshness mechanism)

Normal workflow — a developer merges a PR — triggers the diff job, not a full job. This avoids the concurrent full-backfill stacking failure mode and keeps ingest latency low (diff jobs complete in seconds; full jobs take minutes).

### 2.3 Delete-Then-Insert Semantics

For each path in the diff:
- **Modified file:** `deleteBySource` removes existing chunks for that path, then upsert inserts new chunks. The path used for both sides must be the full repo-relative path (`packages/core/...`, `apps/web/...`) — consistent with the §1.4 fix.
- **Deleted file:** `deleteBySource` only; no upsert.
- **Renamed file:** `deleteBySource` on the old path, upsert on the new path.
- **Added file:** upsert only.

Source path format: always `{repo-relative path without leading slash}`, e.g. `packages/core/db/schema.ts`. This is what the GitHub API returns and what `ingest-knowledge.ts` will produce after the §1.4 fix. `deleteBySource` must match on this exact format — no normalization at query time.

### 2.4 Bootstrap Side-Effect

When a diff job runs and `listNamespaces` shows no `{workspaceId}:code` namespace yet, the diff job enqueues a full backfill job (subject to the idempotency guard) before exiting. The diff itself is applied immediately (even for a first-run workspace) so the PR's changes are indexed without waiting for the full backfill; the full job then fills in the rest of the codebase. This matches the current behaviour introduced in workspace-knowledge-management.md §3.4.

---

## 3. Per-Workspace Docs/Spec Corpus

### 3.1 What Goes Into `{workspaceId}:spec`

For each workspace, the `spec` corpus indexes design documents and specifications from the linked repo. Canonical source: `docs/design/` (this directory). Additional paths that contribute to spec:

| Path pattern | Included |
|---|---|
| `docs/design/*.md` | Yes — primary spec corpus |
| `docs/*.md` | Yes — architecture docs, ADRs |
| `SPEC.md` (repo root or any location) | Yes |
| `README.md` | Yes — product intent |
| `apps/*/docs/**/*.md` | Yes — app-level specs |
| `packages/*/docs/**/*.md` | Yes — package-level specs |
| `apps/*/README.md` | Yes |
| `packages/*/README.md` | Yes |
| `*.test.ts`, `*.spec.ts`, migrations, lockfiles | No |

The extension filter is the same as the docs corpus (`['.md', '.mdx', '.txt', '.rst']`). The distinction between `docs` and `spec` at ingest time: both consume the same file extensions; the `spec` corpus is the subset of docs files that live in design/spec paths. In practice, the CI ingest script passes `--corpus spec docs/` as a separate pass after `--corpus docs docs/`.

### 3.2 Path Normalization

All chunks stored in `{workspaceId}:spec` use full repo-relative paths with any `apps/` or `packages/` prefix preserved, identical to the code corpus after the §1.4 fix:

| File on disk | Stored `source_path` |
|---|---|
| `/repo/docs/design/knowledge-elevation.md` | `docs/design/knowledge-elevation.md` |
| `/repo/apps/web/docs/api.md` | `apps/web/docs/api.md` |
| `/repo/packages/core/README.md` | `packages/core/README.md` |

No truncation or normalization of prefix segments. This ensures `deleteBySource` works correctly when a spec file is edited via a PR diff.

### 3.3 `spec_compare` and Spec-Validator Role Behaviour

`spec_compare` queries both `{workspaceId}:code` and `{workspaceId}:spec`. For the 10 workspaces with no index, both sides currently return empty. Once per-workspace spec ingestion runs:
- Code snippets in `{workspaceId}:code` surface the implemented state.
- Design docs in `{workspaceId}:spec` surface the documented intent.
- `spec_compare` can produce genuine code-vs-spec evidence rather than empty results.

The spec-validator role's prompt gates (`query spec before writing specs`) become meaningful for client workspaces.

### 3.4 Migration for Legacy spec-sync Chunks

The legacy `SPEC_SYNC_NAMESPACE` held buildd's own code and docs under subdir-relative paths. It was retired from production in PR #1159. No client workspace ever wrote to it.

Migration plan:
1. No data migration needed for client workspaces — they have no `spec` chunks at all; the initial full ingest creates them fresh.
2. For the buildd workspace (`57ffc0e4`): the `{workspaceId}:spec` namespace may not yet contain design docs (the CI workflow currently passes `--corpus spec docs/` but this needs verification). If empty, a one-time `workflow_dispatch` of `knowledge-ingest.yml` with `--corpus spec docs/design` bootstraps it.
3. The legacy `471effe1` namespace: no migration. Chunks remain queryable for historical access (the `eval-retrieval.ts` harness still references it) but are not in the default retrieval path (`knowledgeNamespace` no longer routes there). No cleanup action needed.

---

## 4. Memory Scoping for Client Teams

### 4.1 The One-Team-Per-Client Policy

Memory is stored at the team level (`{teamId}:memory`). All workspaces under the same team share one memory namespace. This is intentional: members of the same team collaborate across workspaces, and memories about patterns, decisions, and gotchas are shared context — they shouldn't be siloed per workspace.

The policy for external client deployments: **one buildd team per external client**. Do not create multiple teams for the same client organization and do not mix client organizations under a single team. This is the primary bleed control: memories written about Client A's infrastructure never appear in Client B's context because they are under different teams and therefore different team namespaces.

### 4.2 Optional Workspace/Project Filter on the Memory Read Path

Teams with multiple workspaces (e.g. a client with separate `mobile`, `backend`, and `infra` workspaces) may accumulate memories that are relevant only to one workspace. The memory namespace is shared but the query path can be scoped:

`query_knowledge(corpus=memory, query=..., filter={workspaceId})` — when a `workspaceId` filter is provided, the retrieval layer applies an additional metadata filter on `workspace_id` (if the memory chunk was saved with a workspace tag) before ranking. Memories saved without a workspace tag are returned regardless of filter (they are team-wide).

Saving a workspace-scoped memory: `buildd_memory save` accepts an optional `project` field that maps to the workspace slug. Agents working in a specific workspace should tag memories with the workspace slug when the memory is specific to that workspace's codebase or conventions.

**Implementation note:** The `project` field is already accepted by `buildd_memory save` and stored in chunk metadata. The retrieval filter is a soft preference — it boosts workspace-matching chunks, not an exclusive filter — so team-wide memories remain discoverable even when a workspace filter is active. This is intentional: a memory about "never use db.transaction() with neon-http" is team-wide and should surface in every workspace.

### 4.3 Bleed Risk and Mitigation

The bleed risk in a shared-team memory namespace: Agent A works on workspace X and saves a memory about X's specific API conventions. Agent B works on workspace Y and retrieves that memory. If the memory is tagged with workspace X's slug, the retrieval boost for workspace Y queries is reduced; but the memory remains visible.

Mitigations (in priority order):
1. **One team per client** — inter-client bleed is impossible; intra-client bleed is expected and acceptable.
2. **Workspace tagging** — agents save workspace-specific memories with the `project` field set. The retrieval layer de-prioritizes cross-workspace hits.
3. **Memory titles are workspace-qualified** — agents should title memories with the workspace context when it matters, e.g. "buildd: never use db.transaction() with neon-http" vs. "neon-http: no transactions". The title is a lexical recall signal; a workspace-qualified title naturally reduces cross-workspace recall.
4. **Consolidation** (§6) — the weekly consolidation pass merges near-duplicate memories across workspaces where the workspace context is the only differentiator, producing a team-wide canonical memory.

There is no cryptographic or access-control isolation between workspaces within a team's memory. That is by design — teams share context. The one-team-per-client policy is the only hard boundary.

---

## 5. Knowledge Access Policy — Pull-Only

*This decision is settled. The hybrid push option (inject code/spec chunks at claim time) is explicitly rejected. Do not re-open it.*

### 5.1 Decision and Rationale

**No knowledge content is injected into the claim payload beyond what `buildKnowledgeContext` already injects (memory, plan, task excerpts at ≤160 chars each).**

Rejected: injecting top-K code or spec chunks at claim time (recon F5 recommended this as a hybrid approach).

Rationale:
- **`pathManifest` is optional and absent on most tasks at claim time.** File-path-matched push is speculative: the agent hasn't started yet and we don't know which files it will touch. Injecting code chunks matched against the task title embeds a retrieval guess that may be wholly irrelevant.
- **Injected memories carry system-context authority.** The agent receives them in the system prompt / context block before any tool output. A stale injected memory is treated with the same credibility as a fresh one; the agent cannot distinguish staleness. By contrast, pulled results from `query_knowledge` are tool output — the agent evaluates them as evidence, not as ground truth, and can assess staleness from the `savedAt` age included in pull results (§5.4).
- **Push compounds with every task.** Every Builder task running in parallel would receive the same 2-4k code tokens, amplifying cost with zero per-agent control. Pull lets each agent decide whether retrieval is worth the cost for its specific sub-task.
- **Instrumentation becomes impossible.** If code context is always pushed, there is no signal distinguishing "agent used code knowledge" from "agent ignored it." Pull-based querying, combined with the telemetry in §5.3, makes this measurable.

### 5.2 Corpora Availability Hint (Claim Payload)

The claim payload includes a single lightweight line in the context block — not chunk content, just counts:

```
memory 208 · code indexed · spec 340 — query_knowledge before diagnosing
```

Format: `memory {N} · {code status} · {spec status} — {call-to-action}`

Where:
- `memory {N}` — total chunk count in `{teamId}:memory` (integer; fetched from `listNamespaces`)
- `code status` — `code indexed` if `{workspaceId}:code` has chunks, `code not indexed` if empty
- `spec status` — `spec {N}` with chunk count if `{workspaceId}:spec` has chunks, `spec not indexed` if empty
- Call-to-action — fixed string: `query_knowledge before diagnosing`

Token cost: ~20 tokens. Cannot go stale in the way chunk content would — counts reflect the current index state at claim time. An agent seeing `code not indexed` knows immediately that `query_knowledge(corpus=code)` will return empty and should skip it; an agent seeing `code indexed` knows the pull is worth attempting.

This hint is generated server-side in `buildKnowledgeContext` by calling `listNamespaces` with the workspace and team IDs. It replaces no existing injected content; it is appended to the existing context block.

### 5.3 Role Prompt Gates

Role prompts (CLAUDE.md content bundled into the role config on R2) are the pull enforcement mechanism. Three mandatory gates:

**Builder role:**
```
Before diagnosing any error or editing any file, call query_knowledge(corpus=memory)
with the task title and the error message. Call query_knowledge(corpus=code) for the
specific symbol or path you are about to change. Skip only if the corpora availability
hint shows 'code not indexed'.
```

**Spec-validator / Organizer roles:**
```
Before writing or reviewing any spec, call query_knowledge(corpus=spec) with the
feature name. Before writing or reviewing an implementation plan, call
query_knowledge(corpus=memory) with the feature name to surface prior decisions.
```

**All roles (universal gate):**
```
Before saving a memory via buildd_memory save, call query_knowledge(corpus=memory)
with the proposed memory title. If a near-duplicate exists (cosine > 0.9 in pull
results), update the existing memory instead of creating a new one.
```

These gates are specification — the role CLAUDE.md files must implement them. They are verifiable via the instrumentation in §5.3.

### 5.4 Instrumentation

`handleMemoryAction` (case `query_knowledge`, in `packages/core/mcp-tools.ts`) currently emits no telemetry (recon F6). Add a fire-and-forget `emit_event` call after each successful `query_knowledge` execution:

```typescript
await handleBuilddAction(ctx, 'emit_event', {
  type: 'knowledge_query',
  label: corpus,
  metadata: {
    query: (params.query as string)?.slice(0, 100),
    topK,
    hitCount: results.length,
  },
});
```

This enables:
- `query_events(type='knowledge_query')` — per-task corpus query log; cross-reference with the task timeline to verify gates are firing before file edits.
- Per-task query rate metric: tasks with zero `knowledge_query` events from a Builder role are flagged in the heartbeat (`failedZeroQueries: true` on the heartbeat checklist).
- Workspace-level aggregate: how often agents query `corpus=code` vs. `corpus=memory` vs. `corpus=spec`; which workspaces never pull.

Zero performance impact: fire-and-forget, same pattern as existing `emit_event` calls in the claim route.

### 5.5 Freshness in Pull Results

`query_knowledge` results for `corpus=memory` include inline freshness metadata:

```
[savedAt: 14 days ago · superseded: false] Memory title — first 160 chars of content...
```

Format per result: `[savedAt: {humanized age} · superseded: {true|false}]`

- `savedAt` age is computed at retrieval time from the chunk's `created_at` timestamp.
- `superseded: true` means `is_current=false` (the chunk was explicitly superseded). Such chunks are excluded from default retrieval unless `include_superseded=true` is passed. When a superseded chunk is returned (e.g. via history query), the flag is shown so the agent knows to distrust it.
- Default retrieval excludes superseded chunks entirely — the `WHERE is_current=true` filter in `pg-vector-store` already enforces this for the hybrid query path.

The agent reads freshness inline and applies judgment: a 2-year-old memory about a framework version is weak signal; a 3-day-old memory about a specific bug fix is strong signal. Push injection cannot provide this judgment — the agent receives stale and fresh memories identically. Pull does.

---

## 6. Consolidation Cadence

### 6.1 Weekly Run, Per Team

A scheduled agent task runs weekly (Monday 08:00 UTC, configurable per team) against the team's knowledge corpora. One task per team; triggered by the existing `taskSchedules` mechanism with `roleSlug='consolidator'`.

The consolidation task is the **primary staleness control** under the pull-only policy. Because no content is pushed at claim time, stale memories that persist in `{teamId}:memory` will eventually be pulled by agents and believed. The weekly consolidation pass is what keeps the memory corpus accurate.

### 6.2 Consolidation Steps

**Step 1 — Find duplicates (memory + task corpora):**

```
consolidate_knowledge(op=find_duplicates, corpora=[memory, task], threshold=0.92)
```

Returns near-duplicate chunk pairs within the same namespace. For each pair, the agent reads both chunks and decides:
- **Merge:** one clearly supersedes the other (newer, more accurate, broader scope). Update the survivor via `buildd_memory update` with the merged content; mark the loser superseded via the `supersedes` parameter.
- **Keep both:** genuinely different memories that happen to be semantically similar (e.g. same pattern in two different repos). No action.
- **Archive both:** if both are noise (test scaffolds, inbox-triage outcomes — the clusters identified in recon F4). Archive via `consolidate_knowledge(op=archive)`.

The consolidation agent does not merge automatically — it presents each pair to human judgment via a structured report artifact. Human approves, agent executes. This is deliberate: automated merging of memories risks losing nuance.

**Step 2 — Find decayed chunks (task + artifact corpora):**

```
consolidate_knowledge(op=find_decayed, corpora=[task, artifact], halfLifeMultiple=6)
```

Task-outcome and artifact chunks past 6× their half-life with zero retrieval hits are noise. Archive them:

```
consolidate_knowledge(op=archive, corpus=task, sourceIds=[...])
```

`archive` sets `is_current=false` — audit-recoverable, nothing is deleted. The chunk drops out of default retrieval immediately.

**Step 3 — Supersede stale architecture memories:**

The three stale memories identified in recon F3 (`5b6f7d8f`, `601b62d8`, `342f84ac`) assert pre-PR #1159 routing. They must be superseded manually as part of the first consolidation run after this spec is accepted:
- `5b6f7d8f` → supersede with `6b6d1cbd`
- `601b62d8` → supersede with `6b6d1cbd`
- `342f84ac` → update (replace namespace table row only; keep KnowledgeStore interface section); reference `6b6d1cbd` for namespace rows

**Step 4 — Emit consolidation report:**

The agent creates an artifact (`type=report, key=consolidation-{YYYYMMDD}`) listing:
- Pairs reviewed, merges executed, archives executed
- Net chunk count delta per namespace
- Any pairs left for human review

The report artifact is indexed into the `{workspaceId}:artifact` corpus — it is itself retrievable knowledge for the next consolidation run.

### 6.3 Immediate Archive Backlog (Recon F4)

The 15+ zero-hit noise duplicates identified in recon F4 should be archived in the first consolidation run, not left to the weekly schedule:

| Cluster | Source IDs to archive | Keep |
|---|---|---|
| TEST scaffold runs | `cbeaa963`, `e2160f63`, `c119268e`, `671496b2`, `a896a5c8`, `67b33455` | None |
| Inbox triage | `278184f1`, `dfa50e13`, `a9204e2a`, `a3f13c16` | `6b2c20a4` (representative) |
| PR #572 heartbeat ok | `7becf09a`, `ef0ea48e`, `976bb396` | `721838a6` (representative) |

Archive action: `consolidate_knowledge(op=archive, corpus=task, sourceIds=[...])`. These are task-outcome auto-summaries mirrored into the memory corpus — not hand-written memories — so no human merge review is needed; archive directly.

---

## 7. Migration Plan and Rollout Order

### 7.1 Dependencies

```
§1.4 path fix (ingest-knowledge.ts)
  └─ §1 auto-ingest (workspace-link trigger)
  └─ §2 incremental re-ingest (diff ingest correctness)
       └─ §3 spec corpus (same path normalization applies)

§5.2 availability hint (buildKnowledgeContext)   — independent
§5.3 instrumentation (emit_event in mcp-tools)   — independent
§5.4 freshness metadata (pg-vector-store)        — independent
§4 memory scoping (save/query conventions)       — independent
§6 consolidation schedule                        — independent (immediate backlog: F4 archives)
```

### 7.2 Rollout Order

**Phase 0 (prerequisite, 1 PR):**
- Fix `ingest-knowledge.ts:151` (`root = process.cwd()`).
- Re-ingest buildd workspace to prune subdir-relative chunks.
- Verify `deleteBySource` works end-to-end: merge a test PR touching a known file; confirm old chunk is deleted, new chunk appears.

**Phase 1 (independent, can ship in parallel):**
- Add `repoUrl`-change trigger in `manage_workspaces` to enqueue full ingest job.
- Add availability hint to `buildKnowledgeContext` (§5.2).
- Add `emit_event` in `handleMemoryAction` case `query_knowledge` (§5.3).
- Add `savedAt` age + `superseded` flag to `query_knowledge` memory results (§5.4).
- Update role CLAUDE.md files with pull gates (§5.3): builder, spec-validator, organizer, all-roles universal gate.

**Phase 2 (sequenced after Phase 0):**
- Parameterize `knowledge-ingest.yml` with `workspace_id` + `repo` `workflow_dispatch` inputs.
- Run backfill for the 10 un-indexed workspaces via `workflow_dispatch`.
- Add spec corpus pass to the CI workflow and parameterized dispatch.

**Phase 3 (sequenced after Phase 2):**
- Create consolidation schedule (weekly, Monday 08:00 UTC).
- Run first consolidation manually with the F4 archive backlog.
- Verify report artifact appears in `{workspaceId}:artifact` corpus.

**Phase 4 (ongoing):**
- Monitor `query_events(type='knowledge_query')` — verify Builder role tasks show ≥1 code query per task.
- Flag tasks with zero queries in the heartbeat checklist.
- Adjust role prompt gates based on observed query patterns.

---

## 8. Open Questions

1. **GitHub App coverage for non-buildd workspaces.** The merge webhook requires a GitHub App installation on the repo. For workspaces whose repos are personal forks (e.g. `maxjacu/moa-ops`, `maxjacu/mercury-ekp`), the GitHub App may not be installed. Confirm installation status before relying on the diff ingest trigger; use the admin bootstrap endpoint as fallback.

2. **Runner coverage.** The runner full-ingest path (§1.3) requires a runner with repo access. Non-buildd workspaces have no dedicated runner. The parameterized CI workflow (§7.2 Phase 2) covers backfill; future steady-state needs either a shared runner pool or continued use of the CI workflow for full jobs.

3. **Spec corpus on webhook trigger.** The diff ingest webhook classifies files by extension into `code` or `docs`; it does not yet produce a separate `spec` corpus. Deciding which `docs/` files go to `docs` vs. `spec` at webhook time requires the path-pattern filter from §3.1. Options: (a) add a `spec` classification pass to the diff ingest; (b) treat `spec` as a full-ingest-only corpus updated weekly rather than on every PR. The simpler option is (b) initially.

4. **Memory dedup gate latency.** The universal gate in §5.3 requires agents to query before saving. If `query_knowledge(corpus=memory)` has high latency (>2s), agents may skip it. Monitor P95 latency of `knowledge_query` events; if latency is a problem, the gate should fire asynchronously (agent saves, background job checks for duplicates and flags).
