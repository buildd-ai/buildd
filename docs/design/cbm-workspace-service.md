# Grounding `spec_compare` — what's actually broken, and the ~15 lines that fix it

**Status:** proposed (third revision, 2026-08-29 — two earlier drafts were wrong; see §0)
**Follows:** [codebase-memory-mcp-integration.md](./codebase-memory-mcp-integration.md) §6, #1743, #1889

## 0. What the earlier drafts got wrong

**Draft 1** proposed a runner-side job to index the mainline checkout with CBM and
push symbol records into `{workspaceId}:code`. That pipeline already exists (§1).

**Draft 2** correctly withdrew that but still framed the fix as "wire `spec_compare`
to the entity graph." Adversarial review found the actual bottleneck is elsewhere,
and cheaper (§3).

Both drafts assumed the problem was **symbol identity**. It is not. It is
**anchor truncation**, plus a permission bug that means nobody has ever run the
code path being optimised.

## 1. The ingest pipeline exists and is switched on (measured)

`apps/runner/src/knowledge-ingest.ts`, wired at `apps/runner/src/workers.ts:412`/`:527`
and polled each heartbeat tick at `:560`. It claims SHA-keyed ingest jobs, reads the
tree via `git ls-tree`/`git show`, chunks with ast-grep symbol alignment, and — behind
`KNOWLEDGE_SCIP=1` (`knowledge-ingest.ts:104`) — runs `scip-typescript` and pushes
entities/edges/aliases through the authenticated, idempotent
`POST /api/knowledge/ingest-jobs/[id]/graph`.

**The gate is open in production.** Measured on the live runner:

```
pid 58980  bun run apps/runner/src/index.ts   KNOWLEDGE_SCIP=1
```

(Set from `templates/claude-code/main.tf:254` in the infrastructure repo;
`@sourcegraph/scip-typescript` baked at `build/Dockerfile:63`. Note the screen/bash
wrapper pids show it unset — read the env of the `bun` process, not its parents.)

Identity is already file-anchored — `scip-parser.ts:341`,
`key: ${file}#${qualifiedName}` plus a bare `terminalName` — and renames are already
modelled in an `entityAliases` table. Freshness scaffolding already exists in
`knowledge_ingest_jobs` (`schema.ts:1646-1667`: `sha`, `finishedAt`, unique on
`(workspace, sha, scope)`).

**Action: verify graph rows are landing. Build nothing.**

## 2. Indexing "the mainline checkout" is dead on arrival here

Measured in the live workspace:

```
/home/coder/project/buildd   3753b5cf   61 commits behind origin/dev   shallow=false
```

Nothing refreshes it. `main.tf:168` clones five `maxjacu/*` repos and buildd is not
among them; the one buildd clone refreshed at start (`$HOME/.buildd`, `main.tf:296`)
is `--depth 1`, so it cannot compute "N commits behind" at all.

Any design that indexes the mainline checkout would index a tree that is permanently
stale, and Draft 2's freshness contract would trip on day one and stay tripped.

**The freshest tree in the system is the per-worker worktree — which CBM already
indexes**, rooted at `CBM_ALLOWED_ROOT = sessionCwd` (`cbm-enforcement.ts`), warm in
~12s since #1889. Draft 1 proposed replacing the fresh index with a stale one.

## 3. The real bottleneck: `.slice(0, 20)` and pass order

`extractImplementationAnchors` (`packages/core/mcp-tools.ts:3960-3985`) fills a `Set`
in fixed order — file paths → `/api/…` routes → camelCase → PascalCase — then returns
`[...anchors].slice(0, 20)`, space-joined into one lexical BM25 bag.

Simulated over buildd's own design docs: ~97 candidate anchors per call, of which the
cap keeps ~20%. In the worst sample the 20 slots are exhausted by file paths and route
strings **before a single symbol name is reached**, so PascalCase types are
structurally dropped. The code comment calls these "high-signal exact matches," but
non-identifier route strings crowd out the identifiers.

Canonical symbols behind the same `.slice(0, 20)` would yield 20 canonical anchors
instead of 20 regex anchors — still bag-joined, still fused to `topK=5`. **Swapping
the anchor source does not touch the bottleneck.** Ranking and raising the cap does.

## 4. The evidence base is n=1, and the path has never run

- The vocabulary gap has exactly one measurement (PR #1429 / task `a61de0b5`): a
  single query pair, `0.013` prose vs `0.789` identifier. Those values are now
  **hardcoded literals in a mocked test**
  (`packages/core/__tests__/mcp-tools-spec-compare.test.ts:52,60`), asserting the code
  path against a fake store — not retrieval behaviour. `golden-queries.json` has zero
  `spec_compare` cases, so there is no harness to re-measure with.
- No telemetry: zero hits for `toolCall|trackToolUse|toolUsage` in `mcp-tools.ts`. You
  cannot answer "has `spec_compare` ever been called."
- **It is admin-gated** (`mcp-tools.ts:169` — `adminActions`, not `workerActions`), so
  no worker can reach it.
- The one role built to use it is broken: `default-roles.ts:457` instructs
  spec-validator to run `buildd action=spec_compare`, but its `allowedTools`
  (`:507`) is `['Read','Grep','Glob','WebSearch','WebFetch']` — **no
  `mcp__buildd__buildd`**. Compare `reviewer` (`:434`), which lists it. A role told to
  call a tool it cannot invoke is proof the path has never run.
- `docs/design/knowledge-elevation.md:13` records that `{workspaceId}:spec` ingestion
  "has never run for any client workspace."
- The prose-only spec the gap requires barely exists: 51 of 57 `docs/design/*.md`
  contain literal `apps/…` or `packages/…` paths (518 total, ~9 per doc); 55 of 57
  contain backticked identifiers. The regex operates on an essentially fully-anchored
  corpus.

## 5. Recommendation — three small changes, no new pipeline

1. **Fix `spec-validator`'s `allowedTools`**: add `mcp__buildd__buildd`. Nothing below
   is measurable until the tool can be invoked. Trivial.
2. **Rank and un-truncate the anchors** (~5-10 LOC in `extractImplementationAnchors`):
   score by specificity, put identifiers ahead of `/api/` route strings, raise the cap.
   Then re-run the #1429 prose pair. This is the only change that plausibly moves
   `0.013`, and it is independent of any indexer.
3. **Give `/api/cbm/metrics` a consumer**, and fix its efficacy maths. It currently
   compares post-fix `cbmActive` workers against pre-fix `cbmDisabled` workers and
   reported `inputTokenDeltaPct: -0.808` — with **no mechanism behind it**, because
   `avgToolCalls` was `{}`, i.e. zero graph tool calls. Same-window comparison at
   minimum.

**Keep** the tri-state anchor result — `resolved+drift` / `resolved+clean` /
`unresolved-anchor`. Cheap, indexer-independent, and in a spec-first repo "no such
symbol yet" is the signal rather than an error.

**Drop** the CBM extractor, the CBM ingest path, the mainline index, the
CBM-specific freshness contract, and Option A's tunnel.

## 6. The option both earlier drafts missed

The worker **already has the graph**, rooted at its own worktree — strictly fresher
than any mainline index. A spec-validator worker can resolve an unresolved anchor with
`search_graph` in-session today, for the cost of a role-prompt edit. That is the
cheapest possible version of "ground anchors in real symbols," and it needs no
pipeline, no corpus write, and no freshness contract.

Whether agents will actually do so is exactly what recommendation 3 measures.

## 7. Option A (inbound CBM service) — rejected, unchanged

CBM 0.9.0 has no HTTP query API (stdio MCP, one-shot `cli <tool>`, and a
localhost-bound `--ui` visualization). No inbound path exists to the workspace:
Coder's default port share level is `owner` and host Tailscale is logged out.
`spec_compare` runs on Vercel, which has no repo checkout for `--repo-path`.

## 8. Secondary: worker DB operations in the workspace

**Claim and gating stay server-side** — correct only while one authority serializes
them, and a workspace recreated on every start must not hold that authority; fencing
tokens are the standard guard even then.

**Append-only telemetry is the only candidate** (progress ticks, milestones, CBM
counters): crash-tolerant across the runner's `while true` restart loop, never
authoritative, buffered inside `/home/coder` (the only path surviving container
recreation), idempotent dedupe keys for at-least-once delivery. Commit to numeric
thresholds before measuring, or the measurement yields no decision. Do not start here.
