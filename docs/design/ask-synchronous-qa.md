# `ask`: Synchronous Read-Only Q&A

**Status:** Proposed
**Related:**
- `docs/design/cbm-v2-warm-start.md` — v0.9.0-era warm-cache design; **superseded by shipped code** (see §2)
- `docs/specs/codebase-memory-graph.md` — living CBM contract; §2's shared-cache findings below correct two of its claims (see §2.6)
- `apps/web/src/lib/pr-review-status.ts`, `apps/web/src/lib/pr-review-request.ts` — the long-poll reference implementation this spec mirrors
- `apps/web/src/app/api/mcp/route.ts` — worker-to-worker messaging (`send_worker_message`), the precedent for abuse limits
- `apps/web/src/lib/failure-analytics.ts` — the metric `ask` must never appear in
- `apps/runner/src/cbm-enforcement.ts` — the already-shipped shared-cache (P9) mechanism `ask` should reuse, not reinvent

**Deliverable of this doc only.** No implementation task should be filed from this spec until the owner approves it. Section headers below map 1:1 onto the task's nine required sections.

---

## Problem

Every question an external agent needs answered about this platform currently costs a full task: claim poll, worktree clone, branch, PR-shaped completion contract. Observed 2026-09-10: three separate 30-second factual questions (is a given fix deployed, what build is the runner on, is a given task row subject-reconciled) each required filing a task. One probe task returned its answer wrapped in a fabricated latency figure, because the completion contract is built for shipping code, not for answering — `complete_task`'s `summary` field invites narrative polish, and an agent under that contract will manufacture a number rather than say "not measured."

`recall` is already hot and stateless but retrieval-only over indexed corpora. It cannot read live state, run read-only `gh`, or reason across sources. `ask` is a synchronous, low-latency, read-only Q&A agent that closes that gap for repo-structural and platform-state questions — not a task, not a worker.

---

## 1. Transport and the serverless clamp

### Why a single 120s blocking hold is not available

This app has no `maxDuration` configured and Vercel's default function duration is **60s** (`apps/web/src/lib/pr-review-status.ts:16-22`, the comment on `MAX_REVIEW_WAIT_SECONDS`). A request that blocks for 120s doesn't get a slow response — it gets killed mid-flight by the platform, which looks like a network error to the caller and gives it nothing to resume from. `get_pr_review` already solved this and is the reference implementation:

```
// apps/web/src/lib/pr-review-status.ts:14-22
export const MAX_REVIEW_WAIT_SECONDS = 45;
export const REVIEW_POLL_INTERVAL_MS = 2_000;
```

`waitForPrReviewStatus` (`apps/web/src/lib/pr-review-request.ts:129-163`) is an in-process loop — no Pusher, no DB `LISTEN/NOTIFY` — that reads status, sleeps `REVIEW_POLL_INTERVAL_MS` (2s) if not terminal, and returns `{ status, timedOut: true }` once the remaining budget drops under one more poll interval. The clamp is enforced identically client- and server-side (`Math.min(Math.max(waitSeconds, 0), MAX_REVIEW_WAIT_SECONDS)`, `route.ts:422-424` and `pr-review-request.ts:145`) — a caller that asks for more simply gets less, never an error.

**`ask` reuses this exact pattern, unmodified:**

```
ask({ question: string, waitSeconds?: number })
  → { answer: string, evidence: [...], confidence, timedOut: false }
  → { timedOut: true, askId: string }

ask({ askId: string, waitSeconds?: number })   // resume
  → same two shapes
```

Same 45s ceiling, same 2s poll interval, same clamp-not-reject semantics, same field name (`timedOut`) for muscle-memory consistency with `get_pr_review`.

### Why `ask` needs `askId` where `get_pr_review` does not

`get_pr_review` never mints a resume token because its resource already has a stable external identifier: a PR review *is* the state of `prNumber`, a row that exists independent of any particular poll call, written by a reviewer **task** running as an ordinary durable worker. The polling HTTP request is disposable; the work it's polling is not.

An `ask` question has no such pre-existing key — it's a new question with no row until `ask` creates one. If the answering work is itself decoupled from the request (§5 explains why it must be), the caller needs a way to find that work again after a `timedOut` response. `askId` is that key: minted on intake, the row it identifies is what survives when the polling call itself is killed by the platform timeout, exactly mirroring how a `prNumber`'s reviewer task survives every individual `get_pr_review` call. Losing the answer on timeout — the failure mode a flat 45s cap without a resume token would produce — is strictly worse than a caller having to pass one extra field.

---

## 2. CBM attachment — the core latency decision

### 2.1 The premise in the task brief is half right, corrected by evidence from the binary

The task asks whether the version-keyed canonical index can be **mounted read-only, no copy, no incremental update, no bootstrap**. The literal "mounted read-only" clause does not survive contact with the binary. Two independent lines of evidence, both against the live `codebase-memory-mcp 0.10.8` binary at `/opt/buildd/bin/codebase-memory-mcp` (not the README):

**Concurrent readers on a shared cache root: YES, admitted.**
- Empirical: 16 concurrent `cli search_graph` processes launched against one shared `CBM_CACHE_DIR` (built from `packages/shared/src`, no `index_repository` running concurrently) — all 16 returned `rc=0` with byte-identical output. Only the first process logged `version_cohort.claimed_unheld`; the rest attached to the daemon it started without any admission-failure message.
- Shipped code confirms this is a known, tested property, not an accident: `apps/runner/src/cbm-enforcement.ts:589-590` — *"concurrent seeds are safe (verified at 0.10.8: two simultaneous index_repository writers into one cache dir both succeed with integrity intact)"* — a stronger claim than pure concurrent reads, since it covers writers.
- Also confirmed live on this host: two currently-running worker sessions (this task's own worker and a sibling task's worker, different repos/branches) are both wired with the identical `CBM_CACHE_DIR=/home/coder/.buildd-cbm-cache` right now (`ps aux`, filtered for `codebase-memory-mcp`), each with its own `CBM_RUNTIME_DIR`.

**A literal filesystem read-only (`:ro`) mount of the cache root: NO, not viable.**
- Empirical: chmod'd a copy of a built cache dir to `a-w` (simulating a `:ro` bind mount) and pointed `CBM_CACHE_DIR` at it. A `search_graph` query that normally returns in ~1-2s **hung past a 20s timeout with zero output** — not a clean error. Redirecting `CBM_RUNTIME_DIR` to a separate writable directory (so daemon lock files land elsewhere) did **not** fix it: the runtime dir got its lock files written correctly, but the query still hung.
- This matches the binary's own strings output: `"concurrent readers block the WAL reset"` — CBM's SQLite backend uses WAL mode, which requires write access to create/update `-wal`/`-shm` sidecar files next to the DB file itself, not just to a separate lock directory. A read-only cache root denies that, and CBM's failure mode for it is a silent hang, not a fast error — worse than the fallback this section is supposed to specify.
- Shipped code encodes the same fact structurally: `apps/runner/src/bwrap-mount-allowlist.ts:161` mounts `cbmCacheDir` unconditionally `rw` — `builtins.push({ path: resolve(config.cbmCacheDir), mode: 'rw', required: true })` — with **no** `:ro` branch for any CBM mode, shared-cache included.

**MUST RESOLVE — answered:** CBM's admission barrier *does* admit N concurrent participants on one cache root, but the isolation this buys is at the daemon/version-cohort layer, not the filesystem layer. A literal `:ro` mount collapses the "no copy, no incremental update, no bootstrap" latency claim by turning every `ask` query into a hang. The fallback the task anticipated (a per-ask seeded copy) is **not needed either** — see §2.2, there is a third option already shipped and battle-tested that gets the same latency win without either extreme.

### 2.2 The shipped mechanism `ask` should reuse: P9 shared-cache seeding

Both docs listed as required reading are stale on this exact point. `docs/design/cbm-v2-warm-start.md` (status Proposed, v0.9.0-era, canonical dir seeded by copy) and `docs/specs/codebase-memory-graph.md` (CBM-4: *"cbmCacheDir is `/tmp/cbm-<workerId>` — per worker, never shared"*; §7 out-of-scope: *"Warm-start / shared cache... is proposed, not shipped"*) both predate a mechanism that has, in fact, shipped: `apps/runner/src/cbm-enforcement.ts` implements a shared-cache seed system (internal comments call it "P9") that is live in production right now.

The mechanism, read directly from `cbm-enforcement.ts`:

- `sharedCbmCacheDir()` (`:165-168`) resolves to `~/.buildd-cbm-cache` (or `BUILDD_CBM_SHARED_CACHE` override) — one shared root per host.
- Seed records are written by whichever worker's `index_repository` run happens to complete, keyed by a hash of `(repoPath, baseRef)` (`seedRecordPath`, `:347-356`), so a seed built against one base can never silently answer a query against another (`:335-346`, the "null/unknown base ref rule").
- `buildCbmActivation` (`:519-579`) checks for a matching seed record **before** falling back to a fresh per-worker index. On a hit (`:541-556`):
  ```ts
  return {
    enforced: true,
    cbmBinaryPath: CBM_BINARY_PATH,
    cbmCacheDir: shared,                        // the ONE shared root, rw-mounted
    cbmRuntimeDir: sharedModeRuntimeDir(ctx.workerId),  // /tmp/cbm-rt-<workerId>, per-participant
    sharedCache: true,
    skipBootstrapIndex: true,                    // no index_repository call at all
    cbmProject: record.project,
  };
  ```
  `skipBootstrapIndex: true` is exactly "no bootstrap." No copy happens — the participant's `CBM_CACHE_DIR` **is** the shared root, not a copy of it. No incremental update runs — the participant never calls `index_repository`.
- Isolation is achieved by giving each participant its **own runtime coordination directory outside the shared root** (`cbmRuntimeDirFor`/`sharedModeRuntimeDir`, `:416-440`), because CBM 0.10.x's daemon refuses to start a second participant using a *different* `CBM_CACHE_DIR` under the same daemon account — but tolerates arbitrarily many participants on the *same* `CBM_CACHE_DIR` with distinct `CBM_RUNTIME_DIR`s (verified against 0.10.8 per the comment at `:424-432`).
- Staleness is bounded by an out-of-band, fire-and-forget refresh (`spawnCbmSeedRefresh`, `:716-`), rate-limited per `(repoPath, baseRef)` by a 10-minute cooldown (`SEED_RETRY_COOLDOWN_MS`, `:691`) with a lease/lapse mechanism so a wedged seeder can't permanently block future refreshes (`:610-627`).

**Recommendation:** `ask` mounts CBM exactly the way a shared-cache-hit task already does — `CBM_CACHE_DIR = sharedCbmCacheDir()` (rw, per the binary's real requirements), a fresh tiny `CBM_RUNTIME_DIR` per `ask` session (instant to create — it holds only lock files, not a 94MB+ DB), `skipBootstrapIndex: true`. This delivers "no copy, no incremental update, no bootstrap" for real, just not through a literal read-only mount. "Read-only" is instead a **tool-allowlist guarantee** (§4), which the design needs regardless of the mount mode, since `ask` must never call `index_repository` even though it technically could reach a writable cache dir.

If no seed record exists yet for the target `(repoPath, baseRef)` — a cold workspace, or a base `ask` has never seen traffic for — `ask` must not fall back to a per-ask cold index (10-32s per `CBM_INDEX_TIMEOUT_MS`'s own comment in `cbm-bootstrap.ts:16-21`, which blows the latency budget outright). It should answer plainly that the repo isn't indexed yet for that base and suggest retrying, the same honest-unknown posture §9 requires everywhere else.

### 2.3 Staleness policy

The canonical seed is keyed to `(repoPath, baseRef)`, not to "now." `ask` answers about the repo as it exists at the moment of the call, but its structural claims describe the seed's indexed state, which may lag by up to the refresh cooldown (10 minutes) plus however long the last refresh took. `ask` must:
- Read the `CbmSeedRecord` for the resolved base and surface its `ref`/commit alongside any structural claim ("per the graph as of `<ref>`@`<sha>`, indexed `<age>` ago") — the same discipline `buildCbmSystemPromptBlock`'s shared-base-index text already imposes on ordinary tasks (`cbm-enforcement.ts:479-511`: *"It maps the base checkout, not your branch: trust it for structure, and Read the file for current content"*).
- Never trigger its own refresh — `ask` is read-only; refreshes happen as a side effect of ordinary task traffic. If the seed looks stale enough to matter for a given question, the honest answer names the staleness rather than silently trusting it.

### 2.4 Not this spec's problem to resolve, but worth naming

`ask` shares the CBM binary and shared cache with every ordinary repo-backed task. It does not need its own copy of `CBM_BLOCKED_TOOLS`/version-pin machinery — it inherits whatever CBM version the fleet is already running.

### 2.5 What this section does NOT know

- Whether `ask` sessions calling `search_graph`/`trace_path` concurrently with an ordinary task's *cold* `index_repository` run against the *same* shared root is safe — the evidence above covers concurrent reads and concurrent *seed-writer* races, not a reader racing a writer mid-build. Untested; flagged, not assumed.
- The actual latency of a shared-cache-hit `ask` end-to-end (agent turn + CBM query round trip under the sandbox this spec hasn't designed the wiring for) was not measured — only the CBM layer was benchmarked in isolation.

### 2.6 Correction owed to two existing docs

`docs/specs/codebase-memory-graph.md` CBM-4 ("per worker, never shared") and its §7 out-of-scope line ("Warm-start / shared cache... is proposed, not shipped") are both contradicted by the shipped `sharedCbmCacheDir`/P9 mechanism cited above. `docs/design/cbm-v2-warm-start.md` describes a copy-based seeding design that was superseded by the record-based shared-cache approach before it shipped. This spec does not attempt to fix those docs — flagging the drift here (and via a `learn` entry, see completion) is as far as this task's scope goes.

---

## 3. Not a worker

### 3.1 The lesson already paid for

`get_failure_analytics`'s denominator is every `workers` row whose status is not in `IN_FLIGHT_WORKER_STATUSES` (`apps/web/src/lib/failure-analytics.ts:75-82`). Two prior fixes corrected it in opposite directions:
- One changed the denominator from *all* worker rows to *terminal-only* rows — in-flight workers had been silently diluting (deflating) the published failure rate.
- A second added `superseded` (a worker replaced via `/respond` after a human answered its question) to `IN_FLIGHT_WORKER_STATUSES`, excluding it entirely rather than letting it fall into either bucket — counting it as success inflated success; counting it as failure mischaracterized an answered question as broken work (`failure-analytics.ts:65-73`, the comment explains this explicitly: *"Excluding it from the terminal population is the only outcome that doesn't lie in one direction or the other"*).

The second fix is the load-bearing lesson: **the safe way to exclude a concept from a metric is to never put it in the source table**, not to rely on every future aggregation query remembering to filter it. A third source of corruption — `ask` sessions leaking into the `workers`/`tasks` cohort — must not repeat this.

### 3.2 Storage shape

`ask` sessions live in a **dedicated `asks` table**, never `tasks` or `workers`:

```
asks
  id                uuid primary key         -- the askId
  workspace_id       uuid
  question           text
  status              text  -- 'pending' | 'answered' | 'failed'
  answer              text  null
  evidence            jsonb null   -- [{file, line, note}]
  confidence           text null   -- 'high' | 'medium' | 'low' | 'unknown'
  cbm_seed_ref         text null   -- the CbmSeedRecord.ref used, for staleness disclosure
  asked_by_account_id  uuid
  created_at            timestamptz
  answered_at            timestamptz null
  tokens_used             integer null
  error                     text null
```

In-flight = `status = 'pending'`; completed = `answered` or `failed`. Because there is no `workers` row at all, `ask` sessions are structurally excluded from `get_failure_analytics`, success-rate-by-role, and `checkWorkspaceCap`'s `maxConcurrentTasks` accounting (`apps/web/src/app/api/workers/claim/workspace-cap-gate.ts`-style logic counts active `workers` rows — an `ask` session never creates one, so it never competes for or is counted against a concurrency seat) — by construction, not by a filter someone has to remember to add.

---

## 4. Tool allowlist — enforced server-side

### 4.1 Allowlist, not blocklist — and why that choice is not arbitrary here

CBM's own tool restriction is a **blocklist**: `CBM_BLOCKED_TOOLS` appended to `disallowedTools` (`docs/specs/codebase-memory-graph.md` CBM-13). The same spec's own verification gaps name the cost of that choice explicitly (Verification Gap #3): *"The blocklist does not fail closed against new upstream tools... any destructive tool added between v0.9.0 and a future bump is exposed to agents by default. The design doc's §2.4 allowlist would have failed closed."*

`ask` promises read-only as a *safety* guarantee to a caller who is, by definition, not a vetted in-flight worker (§8) — a best-effort blocklist that silently exposes a new mutating tool on the next CBM/buildd MCP version bump is not an acceptable posture for that promise. `ask` sessions are therefore built with the Claude Agent SDK's `allowedTools` (an **allowlist**), the same mechanism the harness already uses per-session, inverted from how CBM-13 uses it. Anything not named is unreachable, including every tool a future release adds.

### 4.2 Enforcement point

Session construction in the runner, at the same call site that builds `disallowedTools` for ordinary CBM-enforced sessions today (`apps/runner/src/workers.ts`, the `queryOptions` assembly around the existing CBM blocklist append) — `ask` sessions get their own branch here that sets `allowedTools` instead of extending `disallowedTools`. This is a server-side, harness-level gate: the list is built by the runner before the agent's first turn, not something the agent can negotiate or the MCP server can be asked to relax.

### 4.3 The list

**Allowed:**
- CBM read tools: `search_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `get_architecture`, `search_code`, `list_projects`, `index_status`, `check_index_coverage`, `detect_changes`. Explicitly **not** `index_repository` (§2.2 — `ask` rides an existing seed, never builds one), `delete_project`, `manage_adr`, `ingest_traces`.
- `recall` (read-only by construction — `mcp__buildd__recall`).
- `buildd` read-only actions only: `get_task`, `list_tasks`, `get_pr`, `get_release`, `list_releases`, `get_failure_analytics`, `get_usage_stats`, `get_budget_forecast`, `list_connectors`, `get_task_messages`, `trace_schedule`, `list_schedules`.
- A new **narrow read-only SQL surface** — not raw `db` access. Needs its own follow-up design (query allowlist or a read-replica role); flagged as unresolved rather than hand-waved.
- `gh` read verbs only (`gh pr view`, `gh run view`, `gh issue view`, `gh api` GET-only). The existing PR-reviewer role is the precedent that this is already done elsewhere in the fleet: its `disallowedTools` blocks every mutating `gh pr`/`mcp__codebase-memory__*_pull_request*` verb by name (observed live in this host's process list for the reviewer session), which is exactly the read/write split `ask` needs, just expressed as an allowlist instead of that role's blocklist.

**Explicitly not allowed, no exceptions:** any `buildd` mutation action (`create_task`, `create_pr`, `create_artifact`, `merge_pr`, `update_task`, `manage_*`, `post_note`, …), any file write tool (`Write`, `Edit`, `NotebookEdit`), `Bash` beyond the read-only `gh`/SQL surfaces above, and `mcp__codebase-memory__index_repository`/`delete_project`/`manage_adr`/`ingest_traces`.

---

## 5. Dispatch path

### 5.1 The claim loop is disqualified by construction

Any path through the `tasks`/`workers` claim state machine has a latency floor set by the claim poll interval, independent of how fast the answering agent itself is — and per §3, `ask` must never create a `workers` row at all. The claim loop is out on both counts.

### 5.2 `/start` is not the bypass it looks like

`apps/web/src/app/api/tasks/[id]/start/route.ts` looks like the closest precedent for "direct dispatch," but reading it end to end shows it isn't one: it runs a long chain of gates (dependency, connector routing, mission-held, mission-budget, subject-liveness, workspace-cap), then still only **broadcasts** `TASK_ASSIGNED` over Pusher (`triggerEvent`, `:349-353`) and returns `{ started: true }` — the actual work still waits for a worker's own claim cycle to pick it up. `/start` accelerates *prioritization*, not *dispatch latency*; it does not remove the poll-bound floor, it just jumps the queue.

The one genuinely reusable piece of `/start` is the **push mechanism**, not the claim semantics: Pusher delivers to an already-connected runner in well under a second, which is the right primitive for `ask`'s latency budget. The claim/gate machinery around it is not.

### 5.3 Recommendation: a direct route, pushed to a warm pool, no claim/task/worker row

`ask`'s intake (`POST /api/ask` or the `ask` MCP action's server-side handler) should:
1. Validate the caller's token and build the `allowedTools` list (§4).
2. Write the `asks` row (§3) with `status: 'pending'`.
3. Push a **new, distinct** Pusher event (e.g. `ASK_DISPATCHED`, not `TASK_ASSIGNED` — reusing the task-assignment channel would pull `ask` back into the claim-loop's mental model and risk a future refactor treating it as claimable) to a pool of runner connections capable of handling an `ask` session.
4. Long-poll the `asks` row exactly as `get_pr_review` long-polls PR review state (§1).

**Open and unresolved by this spec:** what "a pool of runner connections capable of handling an `ask` session" actually is. Today's runners are workers already bound to a claimed task's worktree; an `ask` session needs no worktree (§2's shared-cache-only design) but still needs *some* process to run the bounded agent loop in, since per `CLAUDE.md`, Vercel cannot run a multi-minute Claude execution and an `ask` session, while short, is not zero-turn either. Whether that's a small dedicated always-warm pool, or any currently-idle runner opportunistically repurposed for the duration of one `ask` call, is a follow-up design question this spec surfaces but does not answer — flagged in §9/Open Questions rather than guessed at.

---

## 6. State

### 6.1 Stateless by default

`ask({ question, waitSeconds })` with no `threadId` concept in the default path — the intake in §5 requires no prior context.

### 6.2 Recommendation: do not ship the stateful path in v1

Worker-to-worker messaging (`send_agent_message`, `apps/web/src/app/api/mcp/route.ts`) is the direct precedent for what a resumable, multi-turn agent-to-agent surface needs before it's safe: a hop cap of **5** (`route.ts:622-625`, *"prevents ping-pong loops between workers"*), a rate limit of **5 messages/sender/minute/recipient task** (`route.ts:686-688`), and a **2 KB** body cap (`route.ts:617`). Every one of those limits exists because two agents *can* ping-pong and burn budget, and the fleet had to learn that the hard way (`docs/design/path-claims-coordination.md:346-349`). A stateful `threadId` on `ask` — one agent asking a follow-up, another agent (or the same one) answering, potentially repeatedly — is the identical exposure with a different name.

Shipping stateful `ask` in v1 means guessing those three numbers cold, with no usage data to calibrate against. **Recommendation: v1 ships stateless only.** Once real `ask` volume exists, a v2 spec can size a `threadId` path's hop cap / rate limit / size cap against actual observed usage instead of an analogy.

---

## 7. Cost and abuse control

- **Hard wall-clock cap:** 45s per individual `ask`/resume call (§1, matching `MAX_REVIEW_WAIT_SECONDS`). A separate **total budget per `askId`** across all its resumptions (recommend 90s, i.e. two full waits) after which the row is marked `failed` with whatever partial draft exists, rather than left `pending` forever.
- **Partial answer on timeout:** if the underlying agent session has produced a draft answer by the time the total budget is exhausted, return it with `confidence: 'low'` and a note that the budget was exhausted, rather than discarding work already paid for.
- **Per-caller rate limit:** mirror the worker-messaging shape (a count per sender per time window) rather than inventing new units — e.g. N `ask` calls per caller per minute. The exact N needs calibration from real traffic; not measured here.
- **Token budget per ask:** a hard per-session cap, enforced the same way a bounded agent loop is capped elsewhere in the fleet (`maxTurns`-style). Exact figure needs calibration; flagged, not guessed.
- **What stops `ask` degrading into a poll loop:** the per-caller rate limit above must apply to **resume calls too**, not just new-question intake — otherwise a caller sidesteps the budget entirely by hammering `ask({ askId, waitSeconds: 0 })` in a tight loop instead of waiting out the long-poll. This is the same shape of gap the messaging rate limit exists to close, just on the polling side instead of the messaging side.

---

## 8. Auth

### 8.1 Token level

`ask`'s caller is, by the problem statement, an **external agent session** — one that today has to file a whole task just to ask a factual question. That caller already holds at most a **trigger-level** API key (the level that creates/lists tasks from outside buildd; see the buildd MCP server's `trigger ⊂ worker ⊂ admin` token hierarchy). `ask` should be gated at **trigger level**, not worker-level and not admin:
- **Not worker-level:** a worker token is minted per in-flight worker for the duration of a claimed task. `ask`'s caller has no worker row (§3) — there is nothing to mint a worker token *for*.
- **Not admin-level:** `ask` is meant to be the *cheap, low-friction* path; gating it behind admin would defeat the purpose the whole spec exists for.
- **Trigger-level fits exactly:** it's already the ceiling granted to "create tasks from outside," and `ask` exists specifically to reduce how often that ceiling needs to be spent on a task at all.

### 8.2 Why this is not worker-to-worker messaging

`send_agent_message` (§6.2) is scoped to **in-flight workers talking to other in-flight workers** — both ends already hold worker-level tokens tied to live `workers` rows, and the whole hop-cap/rate-limit apparatus exists to bound a conversation *between two things buildd is already running*. `ask`'s caller is structurally outside that: no worker row, no task, often not even a buildd-workspace participant in the sense a worker is. Reusing the messaging path would mean either minting a synthetic worker row for every `ask` caller (directly violating §3) or bolting an external-caller exception onto a mechanism designed for internal agent-to-agent traffic. Trigger-level auth on a dedicated `asks` table keeps the two systems — and the two threat models — separate.

---

## 9. What `ask` must NOT become

A cheap synchronous agent is a back door around spec-before-code — "just ask it" replacing a filed task. The boundary:

**`ask` answers:** repo-structural and platform-state factual questions answerable read-only within the wall-clock and token budget — "is fix X in this PR merged to `main`," "what build is runner Y currently on," "what calls function F," "is task Z's subject PR still open," "does role R have connector C mounted." Every one of these has a single, checkable, bounded answer that a CBM query, a `recall`, a `buildd` read action, or a `gh` read verb can produce without writing anything.

**`ask` must refuse and redirect to a task:**
- Anything requiring a mutation — obviously excluded by §4's allowlist, but the *agent's own response* should say so explicitly ("this requires filing a task") rather than silently attempting a workaround.
- Anything requiring multi-step reasoning across a large diff or a plan — i.e., actual engineering work wearing a question's clothes. If answering requires the kind of investigation a task's `update_progress` milestones exist to track, it's a task.
- Anything where the "answer" is itself a deliverable needing review, PR provenance, or an artifact trail — `ask` has no PR-shaped completion contract and must not grow one.
- A chain of follow-up questions that amounts to filing a task one question at a time — the same shape §6's hop-cap reasoning guards against, just manifesting as call volume instead of message hops. The per-caller rate limit (§7) is the mechanical backstop; refusal is the semantic one.

**The response schema itself is a guardrail, not just a contract.** The incident that motivated this spec — a probe task fabricating a latency figure because `complete_task`'s narrative `summary` field pressures an agent toward polish — is the reason `ask`'s response shape is `{ answer, evidence: [{file, line, note}], confidence, cbmSeedRef }` rather than a free-text summary. `confidence: 'unknown'` with no `evidence` is a valid, complete, terminal answer. Nothing in the schema rewards inventing a number over stating that one wasn't measured.

---

## Proposed Implementation Task Breakdown

**Not filed.** Requires owner approval of this spec first.

### Task A — `asks` table + migration
**Scope:** `packages/core/db/schema.ts`, `packages/core/drizzle/`
Add the `asks` table per §3.2. `bun db:generate`, commit migration.

### Task B — `ask` MCP action (long-poll wrapper)
**Scope:** `packages/core/mcp-tools.ts`, `apps/web/src/app/api/mcp/route.ts`
Mirror `get_pr_review`'s tool contract shape exactly (§1): `ask({question, waitSeconds})` / `ask({askId, waitSeconds})`. Reuses `MAX_REVIEW_WAIT_SECONDS`-equivalent clamp and a `waitForAskStatus` helper structured like `waitForPrReviewStatus`.

### Task C — `POST /api/ask` intake route
**Scope:** new `apps/web/src/app/api/ask/route.ts`
Auth at trigger level (§8), builds `allowedTools` (§4), writes the `asks` row, pushes the new `ASK_DISPATCHED` Pusher event (§5). Depends on Task A.

### Task D — Runner-side `ask` session handler
**Scope:** `apps/runner/src/` (new module, not `workers.ts`'s full worker lifecycle)
Consumes `ASK_DISPATCHED`, mounts CBM in shared-cache mode per §2.2 (`sharedCbmCacheDir()`, fresh per-ask `CBM_RUNTIME_DIR`, `skipBootstrapIndex: true`), runs the bounded agent loop under the §4 allowlist, PATCHes the answer back to the `asks` row. This task should also resolve §5's open "warm pool" question — it cannot ship without an answer to where this handler actually runs.

### Task E — Rate limiting + token budget enforcement
**Scope:** `apps/web/src/app/api/ask/route.ts` and the MCP handler
Per-caller rate limit on both intake and resume calls (§7), total-budget-per-askId enforcement, partial-answer-on-timeout.

### Task F — Warm-runner-pool design (follow-up spec, not a task)
§5.3's open question needs its own design doc before Task D can be scoped precisely. Flagging here rather than guessing a shape now.

---

## Open Questions (explicit, not silently assumed)

1. **§5.3:** what pool of runner processes actually executes an `ask` session, and how is "warm" maintained? Not designed here.
2. **§2.5:** is a reader racing a concurrent cold-build writer on the same shared cache root safe? Not tested — only concurrent-reads and concurrent-writer-races were verified.
3. **§4.3:** the read-only SQL surface for `ask` has no design yet — needs a query allowlist or a read-replica role, not raw `db` access.
4. **§7:** the exact per-caller rate limit and token-budget numbers need calibration from real `ask` traffic; the messaging-limit numbers were borrowed as a *shape* precedent, not validated as the right magnitude for this different use case.
5. **§6.2:** stateful `threadId` is deliberately out of v1 scope entirely, pending usage data.

*End of spec. Requires human approval before any implementation task is filed.*
