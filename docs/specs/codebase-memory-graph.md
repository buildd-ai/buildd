---
title: Codebase Memory Graph
status: active
owner: max
last_verified: 2026-08-30
summary: Codebase Memory MUST be mounted for every repo-backed Claude task whose binary is present, MUST degrade silently through exactly four named reasons, and MUST never fail a task because indexing failed.
domain: runners
surfaces: [apps/runner/src/cbm-enforcement.ts, apps/runner/src/cbm-bootstrap.ts, packages/core/cbm-health.ts, apps/web/src/app/api/cbm/metrics/route.ts]
related: [mcp-connectors-and-roles, codex-backend-spec, worker-sandbox-isolation, knowledge-store-retrieval]
keywords: [codebase-memory, codebase-memory-mcp, CBM, CBM_ALLOWED_ROOT, CBM_CACHE_DIR, binary_absent, cbmDisabled, index_repository, graph_index_failed, fallbackRate, resultMeta.cbm]
verified_by: [apps/runner/__tests__/unit/cbm-enforcement.test.ts, apps/runner/__tests__/unit/cbm-bootstrap.test.ts, apps/runner/__tests__/unit/bwrap-mount-allowlist.test.ts, packages/core/__tests__/cbm-health.test.ts, apps/web/src/app/api/cbm/metrics/route.test.ts]
supersedes: []
---
# Codebase Memory Graph

**Capability statement**: Every repo-backed Claude task MUST run with the
`codebase-memory` MCP server mounted, scoped to that task's worktree and its own
cache directory; when any activation gate fails the task MUST proceed without the
server and MUST record which of exactly four named reasons applied; and a failed
or timed-out index build MUST NOT fail the task.

This is the living contract for what `docs/design/codebase-memory-mcp-integration.md`
(status: **Proposed**) proposed. That document remains the rationale — the
positioning against `KnowledgeStore`, the measured index timings, the supply-chain
analysis. Where shipped code and that design disagree, **this spec is authoritative**
and the disagreements are named explicitly in §7. The design's central trust
boundary (§3, restated as CBM-9 below) is preserved unchanged.

---

## 0. Why this is a contract and not a preference

CBM is a capability with no per-task failure signal. Every one of its failure
modes looks exactly like a normally-working agent that happens to be reading a lot
of files:

- The binary was **absent from the runner image for four weeks**. Every qualifying
  worker recorded `outcome: 'disabled'`, `disableReason: 'binary_absent'` and ran
  fine. `detectCbmFleetDisabled` exists because of that window.
- Once the binary shipped, `runCbmBootstrap` passed the worktree as a bare trailing
  positional. CBM 0.9.0 parses that as raw JSON args, so `repo_path` was never
  populated: the index worker exited 1 with `repo_path is required` while the server
  reported the misleading `"Indexing worker crashed on a file"`. The unit test
  encoded the bare-positional form, so **it passed for four weeks while every real
  bootstrap failed**. The `--repo-path` assertion (CBM-6) is that regression.
- Once bootstrapping worked, the first cohort of enforced workers made **zero**
  `mcp__codebase-memory__*` calls while `/api/cbm/metrics` reported a ~80% input
  token reduction — a cohort artifact with no mechanism behind it.
  `mechanismObserved` and `detectCbmEnforcedUnused` exist because of that.

Every invariant below is falsifiable for the same reason: a silent capability
needs an assertion, not a preference.

---

## 1. Activation

`buildCbmActivation` (`apps/runner/src/cbm-enforcement.ts:70`) is the single
decision point. It is pure and does not create the cache directory.

**Invariants**:
- **CBM-1**: CBM is enforced iff **all four** hold: the task is not a Codex task,
  `worker.worktreePath` is set, the role has not opted out, and
  `CBM_BINARY_PATH` (`/opt/buildd/bin/codebase-memory-mcp`) exists on the host.
  Default-on: no role has to ask for it.
- **CBM-2**: Each failing gate maps to exactly one `disableReason`, evaluated in
  the same precedence order as the gate itself — `codex_task`, `no_worktree`,
  `role_opt_out`, `binary_absent` (`workers.ts:2356-2364`). There is no fifth
  reason and no unlabelled disable.
- **CBM-3**: Every degradation is **silent to the task**. No gate failure raises,
  requeues, or changes the agent's outcome. A missing binary MUST degrade, never
  block — a hard failure would have taken the whole fleet down for four weeks
  instead of quietly costing tokens.
- **CBM-4**: `cbmCacheDir` is `/tmp/cbm-<workerId>` — per worker, never shared.
  CBM enforces an OS-backed admission barrier over a cache root: two processes on
  one root with different binary versions fail to admit. Per-worker scoping is
  what makes a rolling image update safe.
- **CBM-5**: The role opt-out is a DB fact, not a runner flag. The claim route
  reads `role.mcpServers['codebase-memory'] === false` and sets `cbmDisabled` on
  the claimed-worker payload (`claim/route.ts:2107-2112`); the runner copies it
  onto the worker (`workers.ts:1350`). It is checked independently of
  `configStorageKey`, so opting out works with no R2 config present.

**Acceptance criteria**:
- AC-1: GIVEN a non-Codex task with `worktreePath` set, `cbmRoleDisabled: false`
  and the binary present WHEN `buildCbmActivation` runs THEN it returns
  `enforced: true`, `cbmBinaryPath: '/opt/buildd/bin/codebase-memory-mcp'`, and
  `cbmCacheDir: '/tmp/cbm-<workerId>'`.
- AC-2 (failure path): GIVEN the binary is absent WHEN `buildCbmActivation` runs
  THEN it returns `enforced: false` with `cbmBinaryPath` and `cbmCacheDir`
  undefined, does not throw, and the completed worker reports
  `resultMeta.cbm = { outcome: 'disabled', disableReason: 'binary_absent' }`.
- AC-3: GIVEN two workers with different ids and identical context WHEN activation
  runs for each THEN their `cbmCacheDir` values differ.
- AC-4: GIVEN a role whose skill record has `mcpServers['codebase-memory'] === false`
  WHEN a task for that role is claimed THEN the claimed-worker payload carries
  `cbmDisabled: true` AND the completed worker reports
  `disableReason: 'role_opt_out'`.

## 2. Bootstrap — warm on turn one, never fatal

The harness (not the agent) builds the index before the agent loop starts, so the
agent does not spend turn one on infrastructure.

**Invariants**:
- **CBM-6**: The index is invoked as
  `codebase-memory-mcp cli index_repository --repo-path <worktree>`. The path MUST
  travel as the **value of the `--repo-path` flag**, never as a bare trailing
  positional. No `--mode` is passed; CBM's default applies.
- **CBM-7**: The build is abandoned after `CBM_INDEX_TIMEOUT_MS` (30 000 ms). On
  timeout the child is `SIGTERM`ed and the partial cache dir is removed.
- **CBM-8**: `runCbmBootstrap` **resolves, never rejects**. Non-zero exit, spawn
  error, and timeout all produce `{ ok: false, reason }`. The session then starts
  with `codebase-memory` **still mounted** but without a warm cache; the injected
  system prompt tells the agent to call `index_repository` once if a query reports
  the project is not indexed. Indexing failure MUST NOT fail the task.
- Outcome is recorded either way: `bootstrapResult: 'ok' | 'failed'` plus
  `bootstrapFailReason`, and a milestone (`graph_index_success durationMs=…` or
  `graph_index_failed reason=…`) so the failure is scannable per task.

**Acceptance criteria**:
- AC-5: WHEN `runCbmBootstrap` spawns THEN its argv is exactly
  `['cli', 'index_repository', '--repo-path', <worktreePath>]` and `argv[2]` is
  `'--repo-path'`.
- AC-6 (failure path): GIVEN the index process exits with code 1 WHEN the promise
  settles THEN it resolves `{ ok: false, reason: 'process exited with code 1' }`
  and does not throw.
- AC-7 (failure path): GIVEN the index process never exits WHEN `timeoutMs`
  elapses THEN the result is `{ ok: false, reason: 'timeout after <n>ms' }`, the
  child was killed, and the worker's `cbmOutcome` stays `'enforced'`.
- AC-8 (failure path): GIVEN spawn emits `error` with `ENOENT` WHEN the promise
  settles THEN `reason` contains `ENOENT`.

## 3. Server wiring and sandbox scope

**Invariants**:
- **CBM-9** (trust boundary, from design §3 — non-negotiable):
  `codebase-memory-mcp install` MUST NEVER run. That command auto-detects 43 agent
  surfaces and writes MCP entries and lifecycle hooks into each (`~/.claude.json`,
  `~/.continue/config.yaml`, …) — agent configuration outside buildd's control.
  The binary is invoked in exactly two forms: `mcp` (stdio server) and
  `cli <tool>` (one-shot). Config and env come from the harness only; nothing
  under `~/.config/codebase-memory-mcp/` is mounted or read.
- **CBM-10**: `buildCbmMcpEntry` resolves every env var to a concrete value —
  `CBM_CACHE_DIR` (per-worker dir), `CBM_ALLOWED_ROOT` (**the session cwd**),
  `CBM_AUTO_WATCH: 'false'`, `CBM_MEM_BUDGET_MB: '1024'`. No `__WORKSPACE_DIR__`
  placeholder survives into the spawned process.
- **CBM-11**: `CBM_ALLOWED_ROOT` is the multi-tenant guard. It restricts what
  `index_repository` will walk, so a worker cannot index another workspace's
  worktree or a host system path. It MUST equal the session cwd, never the parent
  clone and never a static path.
- **CBM-12**: Enforcement MUST NOT double-mount. If `codebase-memory` is already
  present in `queryOptions.mcpServers` (connector or `.mcp.json`), the enforced
  entry is not injected (`workers.ts:2584`).
- **CBM-13**: `CBM_BLOCKED_TOOLS` — `delete_project`, `manage_adr`,
  `ingest_traces` — are appended to `disallowedTools` for **any** mounted
  `codebase-memory` server, regardless of how it was wired. `manage_adr` writes
  ADR files into the repo; that is a repo mutation from an indexing tool and is
  never acceptable as a side effect of a read query.
- **CBM-14**: Under the bwrap mount allowlist the binary is `--ro-bind` and the
  cache dir is `--bind` (rw); both are omitted when the corresponding config field
  is absent, so a non-CBM worker's sandbox gains no CBM paths. The cache dir MUST
  be `mkdir`ed by the caller before argv construction — `buildWorkerBwrapArgv`
  silently drops mounts whose path does not exist.
- **CBM-15**: The cache dir is ephemeral. It is deleted in the session's `finally`
  block, and deletion failure is logged, never thrown.

**Acceptance criteria**:
- AC-9: WHEN the stdio server entry is built THEN `command` is `CBM_BINARY_PATH`,
  `args` is exactly `['mcp']`, and `env.CBM_ALLOWED_ROOT` equals the
  `sessionCwd` argument passed in (not a cached or default path).
- AC-10: GIVEN a `serverConfig.env` containing `__WORKSPACE_DIR__` WHEN bootstrap
  spawns THEN every occurrence in every value is replaced by the worktree path.
- AC-11: GIVEN `cbmBinaryPath` and `cbmCacheDir` are supplied WHEN
  `buildWorkerBwrapArgv` runs THEN argv contains `--ro-bind` for the binary and
  `--bind` for the cache dir; GIVEN both are absent THEN argv contains neither
  `codebase-memory-mcp` nor `cbm-`.
- AC-12: GIVEN any mounted `codebase-memory` server WHEN query options are built
  THEN `disallowedTools` contains all three of
  `mcp__codebase-memory__delete_project`, `…__manage_adr`, `…__ingest_traces`.

## 4. Per-task observability

**Invariants**:
- **CBM-16**: A worker whose `cbmOutcome` was set MUST report `resultMeta.cbm`
  (`CbmMetrics`) at terminal state — including on the provision-failure path,
  where a minimal `resultMeta` shell is created so `cbm` still travels with the
  completion payload. A worker with no `cbm` block is pre-CBM and MUST be excluded
  from both metric cohorts, never counted as zero.
- **CBM-17**: `toolCalls` counts only tools prefixed `mcp__codebase-memory__`,
  keyed by the bare tool name. `readCount` / `grepCount` / `globCount` count
  `Read` / `Grep` / `Glob` exactly; no other tool increments them. These are the
  substitution signal — graph calls up, file-access calls down — so mixing any
  other tool into either side destroys the only mechanism evidence there is.
- **CBM-18**: `totalCbmCalls` equals the sum of `toolCalls`.

**Acceptance criteria**:
- AC-13: GIVEN a session with two `search_code` calls and one `query_graph` call
  WHEN metrics are built THEN `toolCalls = { search_code: 2, query_graph: 1 }` and
  `totalCbmCalls = 3`.
- AC-14: GIVEN a session that called `mcp__buildd__buildd`, `Bash`, `Edit` and
  `Write` WHEN metrics are built THEN `toolCalls` is empty and `readCount`,
  `grepCount`, `globCount` are all 0.
- AC-15: GIVEN `cbmOutcome` was never set WHEN metrics are built THEN no `cbm`
  block is attached.

## 5. Fleet health — the two opposite silences

Both detectors are best-effort: they never throw and never block completion. Both
are no-ops unless `OPS_ALERTS_ENABLED` is truthy, and both fire only from
**completed** workers (`workers/[id]/route.ts:1639-1644`).

**Invariants**:
- **CBM-19**: `detectCbmFleetDisabled` alerts (severity `error`) when the current
  worker and the prior `CBM_FLEET_THRESHOLD - 1` (= 4) completed workers in the
  workspace **all** report `disabled` / `binary_absent`. A single non-matching
  worker breaks the streak. The current worker's outcome is passed in directly
  rather than re-read, because it may not be committed when the check runs.
- **CBM-20**: With fewer than `CBM_FLEET_THRESHOLD - 1` prior rows the detector
  MUST stay silent — a fresh workspace does not page.
- **CBM-21**: `detectCbmEnforcedUnused` alerts (severity `warning`) when the last
  `CBM_UNUSED_THRESHOLD` (= 10) completed workers were all non-`disabled` with a
  zero total across `toolCalls`. Absent `toolCalls` on a mounted worker counts as
  unused. Its threshold is deliberately higher than CBM-19's: one task with no
  structural question legitimately makes no graph calls; ten in a row means the
  steering does not work.
- **CBM-22**: Alerts are deduplicated per workspace per `reportOps` throttle
  window via `dedupeKey` — `cbm-fleet-disabled:<workspaceId>` and
  `cbm-enforced-unused:<workspaceId>`.

**Acceptance criteria**:
- AC-16 (failure path): GIVEN `OPS_ALERTS_ENABLED=1`, four prior completed workers
  with `binary_absent` and a current worker with `binary_absent` WHEN
  `detectCbmFleetDisabled` runs THEN exactly one `reportOps` call is made with
  `dedupeKey: 'cbm-fleet-disabled:<workspaceId>'` and severity `error`.
- AC-17: GIVEN the same history but a current worker with `outcome: 'enforced'`
  WHEN the detector runs THEN zero `reportOps` calls are made.
- AC-18: GIVEN only three prior rows WHEN the detector runs THEN zero
  `reportOps` calls are made.
- AC-19: GIVEN nine prior completed workers with `outcome: 'enforced'` and empty
  `toolCalls` plus a current worker of the same shape WHEN
  `detectCbmEnforcedUnused` runs THEN one `reportOps` call is made with severity
  `warning`; GIVEN any one of them has `toolCalls: { trace_path: 1 }` THEN zero.

## 6. Efficacy reporting — no mechanism, no number

`GET /api/cbm/metrics` answers three questions: are input tokens per task down,
are `Read`/`Grep`/`Glob` calls down, and how often is CBM not active. It is
admin-scoped.

**Invariants**:
- **CBM-23**: Unauthenticated requests are rejected with HTTP 401; a non-admin API
  key is rejected with HTTP 403. Session users see only workspaces in their teams.
- **CBM-24**: A reported delta requires **both** cohorts to reach `MIN_COHORT`
  (= 5) **and** `mechanismObserved` to be true (at least one active task made a
  graph call). Otherwise `inputTokenDeltaPct` and `fileAccessDeltaPct` are `null`
  and `deltasSuppressedBecause` names the reason
  (`no_graph_tool_calls_observed` | `insufficient_cohort`). Reporting a delta with
  no mechanism behind it is worse than reporting nothing — that is precisely the
  ~80% figure this endpoint once published.
- **CBM-25**: `binary_absent` workers are EXCLUDED from the comparison baseline
  (`comparableCount`). They come from a different infrastructure regime, not from
  a control group that could have used CBM and didn't. They remain in
  `cbmDisabled.count` and `disableReasons`, because narrowing an existing field
  would silently change its meaning.
- **CBM-26**: Empty cohorts yield `null`, never `0`. `fallbackRate` is `null` when
  nothing is tracked; `avg` of an empty set is `null`.

**Acceptance criteria**:
- AC-20 (failure path): GIVEN no session and no API key WHEN `GET /api/cbm/metrics`
  is called THEN the response is HTTP 401; GIVEN a non-admin API key THEN HTTP 403.
- AC-21: GIVEN five active workers with `toolCalls: {}` and five disabled workers
  with `disableReason: 'role_opt_out'` WHEN metrics are computed THEN
  `mechanismObserved` is false, `activeWithZeroToolCalls` is 5,
  `inputTokenDeltaPct` is null, and `deltasSuppressedBecause` is
  `'no_graph_tool_calls_observed'`.
- AC-22: GIVEN the only disabled rows are `binary_absent` WHEN metrics are
  computed THEN `cbmDisabled.comparableCount` is 0 and both deltas are null,
  while `cbmDisabled.count` and `disableReasons.binary_absent` still report them.
- AC-23: GIVEN five active workers with non-empty `toolCalls` averaging 8000 input
  tokens and five `role_opt_out` workers averaging 12000 WHEN metrics are computed
  THEN `mechanismObserved` is true, `deltasSuppressedBecause` is null, and
  `inputTokenDeltaPct` ≈ −0.333.
- AC-24: GIVEN a worker whose `resultMeta` has no `cbm` block WHEN metrics are
  computed THEN it appears in neither cohort and `totalTracked` excludes it.

## 7. Where the code and the design doc disagree

`docs/design/codebase-memory-mcp-integration.md` is status **Proposed** and was
not updated as implementation diverged. The differences are behavioural, not
cosmetic:

| Design doc | Shipped code (authoritative) |
|---|---|
| §2 "available to **opted-in** roles"; §7 Phase 1 role-level opt-in | Default-**on** for every repo-backed Claude task; roles opt **out** (CBM-1, CBM-5) |
| §2.3 bootstrap calls `index_repository` **over the MCP session** | Bootstrap is a separate CLI one-shot (`cli index_repository`), run before the agent loop and **outside** the bwrap sandbox |
| §2.4 tool restriction enforced via the role's **`allowedTools` allowlist** | Enforced by a **blocklist** on `disallowedTools`; `CBM_ALLOWED_TOOLS` is documentation only and is not consulted at runtime (see gaps) |
| §5.5 on index timeout, "start the agent session **without CBM** in the MCP server list" | CBM stays **mounted** without a warm cache; the agent is told to index on demand (CBM-8) |
| §5.5 emits a `graph_index_timeout` event | Emits per-task milestones `graph_index_success` / `graph_index_failed reason=…`; there is no `graph_index_timeout` event |
| §7 "Index fallback rate = `graph_index_timeout` events / total CBM tasks", target <5% | `fallbackRate` measures **activation**, not index failure: it is `disabled / tracked` over all four disable reasons. A failed bootstrap does not appear in it at all (see gaps) |
| §2.2 config lives in the role record's `mcpServers` map | The env is built in code by `buildCbmMcpEntry`; the role record's entry is consulted only as the `false` opt-out sentinel |

`docs/design/cbm-v2-warm-start.md` (also Proposed) would replace the per-task cold
rebuild with a version-keyed canonical seed. Nothing in it has shipped; §4.2's
cold-per-task model (CBM-4) is what this spec describes.

## Code surface

- **Activation** — `apps/runner/src/cbm-enforcement.ts`: `buildCbmActivation` (:70),
  the four-gate expression (:75), cache-dir naming (:80), `buildCbmMcpEntry` (:88),
  `CBM_BLOCKED_TOOLS` (:23), `CBM_ALLOWED_TOOLS` (:33, documentation only).
- **Bootstrap** — `apps/runner/src/cbm-bootstrap.ts`: `CBM_INDEX_TIMEOUT_MS` (:14),
  `resolveCbmEnv` (:26), `runCbmBootstrap` (:75), argv (:93), timeout + partial-cache
  removal (:100-106), non-zero-exit path (:115-126).
- **Sandbox** — `apps/runner/src/bwrap-mount-allowlist.ts`: `CBM_BINARY_PATH` (:14),
  CBM mounts (:115-116), the drop-missing-mount filter (:118-122), `--tmpfs /tmp` (:128).
- **Session wiring** — `apps/runner/src/workers.ts`: `cbmDisabled` propagation (:1350),
  cache-dir declaration (:1607-1609), activation + `mkdirSync` + bootstrap
  (:2314-2352), outcome/reason classification (:2356-2364), counter init (:2365-2366),
  graph system-prompt append (:2373-2389), bwrap argv with CBM mounts (:2398-2409),
  MCP injection guard (:2584-2586), `disallowedTools` (:2592-2596),
  `resultMeta.cbm` assembly incl. provision-failure shell (:3117-3146), cache-dir
  cleanup (:3391-3397), per-tool counters (:3830-3838).
- **Role opt-out** — `apps/web/src/app/api/workers/claim/route.ts:2107-2112`.
- **Fleet health** — `packages/core/cbm-health.ts`: `CBM_FLEET_THRESHOLD` (:22),
  `detectCbmFleetDisabled` (:44), `CBM_UNUSED_THRESHOLD` (:87),
  `detectCbmEnforcedUnused` (:115); call site
  `apps/web/src/app/api/workers/[id]/route.ts:1639-1644`.
- **Metrics route** — `apps/web/src/app/api/cbm/metrics/route.ts`: auth (:37-48),
  cohort partition (:101-110), `fallbackRate` (:113), `mechanismObserved` (:130-133),
  `comparable` baseline (:140), `MIN_COHORT` (:151), `specTargets` (:202-223).
- **Data model** — `packages/core/db/schema.ts`: `CbmMetrics` (:526-543),
  `ResultMeta.cbm` (:562); runner mirror `apps/runner/src/types.ts:207,287`.
- **Provisioning** — `docker/worker/Dockerfile:3-27` (`CBM_VERSION`,
  `CBM_SHA256_AMD64`, `CBM_SHA256_ARM64`, sha256 verify, `--version` smoke check);
  `apps/runner/install.sh:375-417` (the same pin for Coder workspaces, which is
  what actually provisions running hosts).
- **Tests** — `apps/runner/__tests__/unit/cbm-enforcement.test.ts`,
  `apps/runner/__tests__/unit/cbm-bootstrap.test.ts`,
  `apps/runner/__tests__/unit/cbm-observability.test.ts`,
  `apps/runner/__tests__/unit/bwrap-mount-allowlist.test.ts`,
  `packages/core/__tests__/cbm-health.test.ts`,
  `apps/web/src/app/api/cbm/metrics/route.test.ts`.

## Out of scope

- **Warm-start / shared cache.** `docs/design/cbm-v2-warm-start.md` (canonical
  version-keyed seed, 90% index-time saving) is proposed, not shipped. CBM-4's
  per-task cold rebuild is current behaviour.
- **Semantic and historical retrieval.** The graph answers structural questions
  only. Intent, history and prior decisions come from the knowledge tools — see
  `docs/specs/knowledge-store-retrieval.md`. The injected prompt states this
  boundary to the agent verbatim.
- **CBM's own indexing correctness** — what it parses, how the graph is modelled,
  `.cbmignore` semantics, `query_graph`'s Cypher subset. Upstream's contract.
- **Codex tasks.** CBM is Claude-only by construction (CBM-1); see
  `docs/specs/codex-backend-spec.md`.
- **The bwrap sandbox itself** — namespace setup, the support probe,
  `BUILDD_DISABLE_SANDBOX`. This spec covers only the two CBM mounts.
- **Connector-mounted `codebase-memory`.** A role may wire the server itself; only
  CBM-12 (no double-mount) and CBM-13 (blocked tools) bind that path. The
  `legacy_mcp_json` outcome that would label it is unreachable (see gaps).
- **Choosing the pinned version.** This spec requires the pin to be consistent and
  checksum-verified, not that any particular version is current.

## Verification gaps

Unguarded claims and defects found while writing this spec. Nothing here is
asserted as an invariant above.

1. **FIXED** — Version pin drift, unguarded.** `CBM_VERSION` is `0.9.0` in **two**
   independent places — `docker/worker/Dockerfile:5` and
   `apps/runner/install.sh:379` — each with its own duplicated amd64/arm64 sha256
   pair. No test, lint, or CI check asserts the two agree, and nothing checks the
   pin against upstream: `DeusData/codebase-memory-mcp` latest is **v0.10.8**
   (published 2026-08-19), so the fleet is 1 minor + 8 patches behind. A bump that
   updates one file and not the other produces a Docker image and a Coder
   workspace running different binaries, which is exactly the admission-barrier
   hazard CBM-4 exists to avoid.

   Closed on dev before this PR: `cbm-version-pin.test.ts` enforces version and linux-checksum equality between the Dockerfile and `install.sh`, and `verify-cbm-pin.sh` diffs all six digests against upstream in `worker-image.yml`. Both pins are 0.10.8.

2. **FIXED** — `install.sh` never upgrades an existing binary.** `install.sh:382` short-circuits
   on `"$CBM_BINARY_PATH" --version` succeeding and only prints the version it
   found. Bumping `CBM_VERSION` therefore has **no effect** on any already-provisioned
   host; the only path to a new binary is a manual delete or an image rebuild. No
   test covers this.

   Closed on dev before this PR: `cbm_provision()` compares the installed `--version` against the pin and upgrades.

3. **FIXED** — The blocklist does not fail closed against new upstream tools.**
   `CBM_ALLOWED_TOOLS` is explicitly "documentation only" and is never read at
   runtime; enforcement is `CBM_BLOCKED_TOOLS` on `disallowedTools`. Combined with
   gap 1, any destructive tool added between v0.9.0 and a future bump is exposed to
   agents by default. The design doc's §2.4 allowlist would have failed closed.
   `cbm-enforcement.test.ts:121` pins `CBM_ALLOWED_TOOLS.length === 12`, which
   asserts nothing about what the agent can actually call.

   Narrowed here, NOT closed: `CBM_BLOCKED_TOOLS` is now derived from `CBM_ALLOWED_TOOLS` against the recorded tool surface, so an unallowed surface tool is blocked automatically, and the blocklist is applied unconditionally rather than only when the runner mounted CBM itself (an SDK-loaded project `.mcp.json` previously got no blocklist at all). The residual gap stands: `disallowedTools` cannot express deny-by-default, so a tool a future release ADDS is unclassified and unblocked. Bumping the pin requires re-classifying the surface.

4. **FIXED** — `legacy_mcp_json` is unreachable.** The value exists in
   `packages/core/db/schema.ts:528` and `apps/runner/src/types.ts:207,287`, and
   `cbm-observability.test.ts:80` tests it — but **no code path ever assigns it**.
   `workers.ts:2356-2364` writes only `enforced` or `disabled`. Consequence: a
   worker with `codebase-memory` mounted from a connector or `.mcp.json` while
   `cbmEnforced` is false is recorded `disabled` with a `disableReason`, even
   though the agent had the tools and may have called them — and the metrics route
   then files it in the *baseline* cohort (`route.ts:105`). That silently
   contaminates the control group the endpoint's whole comparison rests on.

   Closed on dev before this PR: `resolveCbmOutcome` classifies mounted-but-not-enforced as `legacy_mcp_json`, so a CBM-equipped session is no longer recorded in the metrics control group.

5. **`fallbackRate` does not measure what its name and target claim.** It is
   `disabled / tracked` over all four reasons, so `codex_task`, `no_worktree` and
   `role_opt_out` — all by-design outcomes — inflate it. `fallbackRateMet`
   (`< 0.05`) is therefore a statement about fleet composition, not index
   reliability, and is structurally unreachable on any fleet with Codex or
   service-role tasks. Meanwhile a **failed bootstrap** — the thing the design's
   "index fallback rate" was about — never appears in it, because
   `bootstrapResult: 'failed'` keeps `outcome: 'enforced'`. No metric anywhere
   aggregates `bootstrapResult`; the only trace of a failed index is a per-task
   milestone string. This is the specific silence that let the `--repo-path` bug
   run for four weeks.
6. **FIXED** — Bootstrap failure drops the cache-dir sandbox mount.** Ordering in
   `workers.ts` is `mkdirSync(cbmCacheDir)` (:2327) → `runCbmBootstrap` (:2336),
   which `rmSync`s the dir on failure or timeout (`cbm-bootstrap.ts:104,123`) →
   `buildWorkerBwrapArgv({ cbmCacheDir })` (:2398-2409), which drops mounts whose
   path is missing with a `Skipping unavailable sandbox mount` warning. So after a
   failed index the agent is told to run `index_repository` on demand into a
   directory that is no longer bind-mounted from the host — it lands in the
   sandbox's own `--tmpfs /tmp`. Not data loss (the cache is ephemeral either way),
   but the advertised recovery path in CBM-8 is untested end-to-end, and the only
   signal is a warning line.

   Closed: the ordering half on dev (#1981 restores the runtime dir and re-asserts before the argv build), and the silent-drop half here — CBM binds are `required`, and an unmountable one disables CBM loudly with a milestone and `cbmDisableReason` instead of letting on-demand indexing land in the throwaway tmpfs.

7. **No test exercises the runner's session flow.** CBM-3, CBM-8 (the "task still
   starts" half), CBM-12, CBM-14's mkdir-before-argv obligation, CBM-15, and the
   `disallowedTools` append are all implemented inline in `workers.ts` and covered
   only by unit tests of the helpers they call.
   `cbm-observability.test.ts` re-implements buildCbmMetrics and handleToolCall
   as local copies rather than importing them, so CBM-2, CBM-16, CBM-17 and CBM-18
   are asserted against a **transcription** of `workers.ts`, not against
   `workers.ts`. A change to the real classifier would not fail that file.
8. **Health detectors only run on `completed` workers.** `workers/[id]/route.ts:1639`
   gates both detectors on `status === 'completed'`. A workspace where every worker
   fails will never page, however broken CBM is. Both are also silent unless
   `OPS_ALERTS_ENABLED` is truthy; nothing asserts it is set in production.
9. **`CBM_ALLOWED_ROOT` equals `cwd`, but the gate reads `worker.worktreePath`.**
   `buildCbmActivation` is called with `worktreePath: worker.worktreePath`
   (:2317) while both the index root and `CBM_ALLOWED_ROOT` are the session `cwd`
   (:2337, :2585). They are assigned together at `workers.ts:1403-1404`, so they
   agree today, and no assertion enforces that they must. CBM-11's isolation
   guarantee rests on that unchecked coincidence.
10. **`limit: 5000` on the metrics query** is silent truncation: a busy window
    returns a biased sample with no indication in the response.
