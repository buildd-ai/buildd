# Memory done right: write from many episodes, read through one door

**Status:** Proposed
**Related:** `packages/core/mcp-tools.ts` (`learn`, `recall`), `apps/web/src/lib/knowledge-context.ts`, `packages/core/prior-work-render.ts`, `apps/web/src/lib/mission-context.ts`, `packages/core/decision-client.ts`, `packages/core/knowledge-store/consolidation.ts`, [knowledge-tool-surface.md](knowledge-tool-surface.md), [knowledge-elevation.md](knowledge-elevation.md), [workspace-knowledge-management.md](workspace-knowledge-management.md), [decision-calls.md](decision-calls.md), [agent-chat.md](agent-chat.md)

## Problem

Buildd stores a lot and learns little from it.

- **One door per caller, four different answers.** A memory reaches an agent through `recall` (hybrid vector + BM25 + rerank), the claim-time "Related prior work" block (top 3 per corpus over a 0.45 floor), the runner's `## Workspace Memory` block (ILIKE token match, 300 chars each) and the `claim_task` MCP reply (title ILIKE, 200 chars each). The same task sees different memories depending on which door it came through, and scoping fixes have to be applied to each door separately.
- **Writes the index never sees.** Dashboard-created memories and feedback-digest memories land in `memories` without a mirror into `knowledge_chunks`, so `recall` cannot return them. `learn` mirrors with a swallowed error, so the table and the index drift without a signal.
- **One episode is treated as truth.** A single `learn` call from a single task becomes a team memory at full authority. Nothing asks whether the task that wrote it succeeded, whether a second episode agrees, or whether the code it describes still exists. Failed tasks, where most lessons are, write nothing at all.
- **No feedback.** `hit_count` counts pushes and pulls alike, so a memory injected into a hundred prompts and ignored in all of them looks popular. Nothing links a retrieved memory to what the task then did, so no one can say whether memory helps, and the zero-hit decay test in consolidation measures the wrong thing.

## Principles

Taken from what recurs across Letta/MemGPT, Mem0, Zep/Graphiti, LangMem, Generative Agents, ACE and Anthropic's context-engineering and memory-tool guidance:

1. **Small core, pull the rest.** Keep an always-loaded block tiny; give agents an index and let them fetch bodies. Near-relevant memories are distractors, not free context.
2. **One episode proposes, repetition promotes.** A memory starts as a candidate tied to its source episode (task, PR review, chat turn). It gains authority when an independent episode corroborates it or when its source outcome is verified (PR merged, not reverted).
3. **Updates are decisions.** Every write against similar existing memories resolves to ADD, UPDATE, SUPERSEDE or NOOP, with NOOP as the default and the reason logged.
4. **Invalidate, don't delete.** Facts carry validity. A superseded fact stays queryable for "what did we believe when PR X merged" and drops out of default reads.
5. **Heavy work off the hot path.** Extraction, merging and reflection run in the background. The worker's claim path only reads.
6. **Measure use, not retrieval.** A memory earns its place by changing outcomes.

## Proposal

**Crux: a single retrieval service with a use ledger.** Every read path goes through one function, and every memory it returns is recorded with how it reached the agent. If this is wrong (one service cannot serve both a 3-hit claim push and a 50-hit recall), the fallback is one service with per-caller budgets, never four implementations. Everything else in this doc depends on the ledger: promotion, decay, relevance gating and the Jev benchmarks all need "was this memory used".

### Read: one door

`retrieveMemory({ query, scope, caller, budget })` in `packages/core`:

- Resolves the caller's project and applies the same project filter `recall` uses today, so scoping lives in one place.
- Hybrid search (vector + BM25, RRF), rerank, recency x authority, then an optional **relevance gate** (below).
- Query expansion for task-shaped queries: title, declared paths, and error signature as separate queries, fused.
- Returns hits with `{ chunkId, memoryId, rank, score, gated }` and writes one ledger row per hit.

Callers: `recall`, the claim-time block, the runner `## Workspace Memory` block, `claim_task`, mission planning and authoring prior work. The runner's ILIKE search is retired once the service matches its recall on the eval set.

**Injection shape.** Claim time injects an index: one line per memory (type, title, id, why it matched), capped by a token budget (illustrative: 800 tokens). The agent pulls bodies with `recall`. A small, user-curated **directive** tier (see Chat) is the only always-loaded body text.

### Measure: the use ledger

A `memory_uses` table: `(taskId, workerId, chunkId, via: push|pull, rank, score, gatedBy, outcome)`. `outcome` is filled after completion:

- `used` if the agent pulled the body, cited the id, or the final summary acts on it (Jev yes/no over the memory text plus the summary; see Jev).
- `ignored` otherwise; `contradicted` if the task's outcome disagrees with it.

Hit counts split into `pushCount` and `useCount`. Consolidation's decay test reads `useCount`. An optional holdout (off by default) withholds pushed memories from a small random share of claims so outcome attribution has a control group.

### Write: candidates, then promotion

- **Sources, many episodes over time:** `learn` calls; failed tasks (the error plus the last summary); PR reviews that requested changes; reverts; chat turns where the user states a preference or correction ("always", "never", "remember"); merged PRs touching paths a memory is anchored to.
- **Candidate first.** New memories are written with `state: candidate`, provenance (source kind + id) and path anchors (`files`). Candidates are recallable when asked for but not pushed.
- **Update decision.** Against the top similar memories, the writer resolves ADD / UPDATE / SUPERSEDE / NOOP. The existing 0.94 auto-replace and 0.88 to 0.94 conflict band become inputs to this decision rather than the whole rule.
- **Promotion to `active` is automatic, judged by Jev.** Evidence is assembled deterministically: source outcome (task succeeded, PR merged, not reverted within a window), independent corroborating episodes, use-ledger counts, source kind. Jev answers yes/no "promote?" over that evidence. Hard floors Jev cannot override: external-source content never auto-promotes, and a candidate with zero verified outcomes and zero corroboration stays a candidate. While Jev is in shadow, the deterministic rule decides (verified outcome or one corroborating episode). Candidates neither promoted nor used within a window expire.
- **Validity.** `validFrom` / `invalidatedAt` next to `supersedes`. When a merged PR touches a memory's anchored paths, the memory is flagged for re-verification instead of trusted forever.
- **Reflection.** A background job per workspace, triggered by accumulated new episodes rather than a clock, reads recent outcomes and writes a few `pattern` / `decision` candidates that link back to their sources. It edits memories one at a time and never regenerates a whole summary (whole-text rewrites erode detail).
- **Graduation.** A pattern that stays active and used across many tasks is proposed as a skill or CLAUDE.md change via a PR a human merges.

### Chat

Chat gets two tiers: **directives** (user-stated rules, always loaded, small, editable in settings) and **knowledge** (everything else, through the one door). A chat turn that states a rule produces a directive candidate the user confirms in one tap. Directives apply to the user everywhere by default; Jev suggests "only this workspace" when the rule names workspace-specific things (a repo, a path, a mission), and the confirm card shows that suggestion preselected.

### Where Jev helps

Jev answers typed questions (choice, score, yes/no) cheaply and fast, and never writes prose. Each decision is **confidence-gated and fails open** to the current rule (5s deadline, low confidence, error). Shadow is reserved for the two decisions whose mistakes are invisible or spread: the relevance gate (a hidden memory leaves no trace) and promotion (one bad promotion reaches every agent). Those log verdicts until the use ledger can grade them, then switch on. The rest go live with the first release, because a wrong answer is visible, confirmed by a human, or reversible:

| Decision | Jev question | Replaces | Mode |
|---|---|---|---|
| Worth keeping | yes/no: durable lesson, not a task summary? | nothing (today every `learn` lands) | live: "no" writes a candidate, never drops |
| Type | choice: gotcha / pattern / decision / discovery / architecture | caller's guess | live |
| Update | choice: ADD / UPDATE / SUPERSEDE / NOOP given the top similar | 0.88 to 0.94 "retry with supersedes" | live in the 0.88 to 0.94 band; supersede invalidates, reversible |
| Relevance gate | yes/no per hit: does this change what the agent should do on this task? | fixed 0.45 floor | shadow |
| Use label | yes/no: does the summary act on this memory? | nothing | live (measurement), spot-checked |
| Chat tier | choice: directive / knowledge / neither | nothing | live: proposes a card the user confirms |
| Directive scope | choice: everywhere / this workspace | user picks from scratch | live: preselects, user confirms |
| Promote | yes/no over assembled evidence, inside hard floors | deterministic rule | shadow; deterministic rule decides meanwhile |

Not Jev: reflection and extraction of text. Those need a generating model and run as background runner tasks on the team's seat.

Built (step 4): every decision above is defined in `packages/core/memory-decisions.ts` with its threshold next to its question. Keep and type run on `learn` and `buildd_memory save`; until candidates exist, a confident "not durable" only adds the `jev:not-durable` tag. Update resolves the band into ADD, UPDATE (a new row holding the existing text plus the incoming text, which supersedes the old row; needs higher confidence), SUPERSEDE or NOOP, and below threshold returns the conflict reply as before. Use labels run after a task completes. The relevance shadow is a hook in `retrieveMemory` that runs after the response, on a sample of pushes (`MEMORY_RELEVANCE_SHADOW_SAMPLE`, default 0.25), for standard workspaces and attributed tasks only. `MEMORY_DECISIONS_DISABLED=1` turns every memory decision off. Every verdict is a `memory_decisions` row next to the rule's answer, and spend is also receipted in `ai_usage`. `packages/core/scripts/memory-decision-readout.ts` compares Jev, the rule and the ledger. The thresholds are provisional until the readout can grade them.

## Implementation sketch

Load-bearing first.

1. **Correctness.** Project filter on every memory read (in flight as a security fix); mirror dashboard and feedback-digest writes; surface mirror failures instead of swallowing them; stop pushes from counting as hits.
2. **One door + ledger.** `retrieveMemory` in `packages/core`, `memory_uses` table, migrate all read paths, keep the current rules as defaults so output is unchanged until an option flips.
3. **Index injection** behind a flag, compared on the ledger's use rate and the existing `eval-retrieval.ts` golden set.
4. **Jev decisions**: live where the table says live, shadow for relevance and promotion; readout from the ledger.
5. **Candidate state, promotion, validity, failed-task and review extraction.**
6. **Reflection job and chat directives.**
7. **Graduation to skills.**

Defaults stay no-ops: steps 2 to 4 change nothing an agent sees until a flag flips. Background jobs piggyback on existing crons and batch per workspace, so they add no new database wake windows.

## Safety properties

- Promotion never runs on content from outside the team (external PR comments, issue text) without human approval; that is the memory-poisoning path.
- Reflection is capped per workspace per run (illustrative: 5 candidates) and only edits one memory per decision.
- Expiry and invalidation are reversible: nothing is hard-deleted by automation.

## Decisions (2026-09-27)

1. **Claim push:** index injection (type, title, id per line); bodies pulled with `recall`.
2. **Promotion:** automatic, judged by Jev inside hard floors; deterministic rule while Jev is in shadow.
3. **Directives:** user-level everywhere by default; Jev suggests workspace scope.
4. **Jev:** live now for keep, type, update, use label, chat tier and directive scope (confidence-gated, fail open); shadow for relevance gate and promotion until the ledger grades them.

## Open questions

1. **Holdout.** Lean: ship the ledger without it; turn on a small holdout only once the ledger shows enough traffic to read.
2. **Promotion window.** How long a merged PR must stay unreverted before it counts as verified. Lean: 72 hours.

## Non-goals

- Replacing the knowledge store, embeddings or reranker.
- Code search (codebase-memory owns it).
- Cross-team memory sharing.
- Email or external connectors as memory sources.
