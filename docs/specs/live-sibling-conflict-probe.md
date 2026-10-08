---
title: Live Sibling Conflict Probe
status: active
owner: max
last_verified: 2026-10-08
summary: Two live workers whose touches share a file MUST be trial-merged on a runner, and a real conflict MUST reach both workers once per pair, naming files, hunks and who rebases.
domain: runners
surfaces: [apps/web/src/lib/sibling-conflict-probe.ts, apps/runner/src/sibling-probe.ts, apps/web/src/app/api/cron/sibling-probe/route.ts]
related: [orchestration-decisions-shadow, runner-liveness]
keywords: [sibling_conflict_probe, sibling_probes, merge-tree, mergiraf, early warning, live overlap, rebase notice, pendingInstructions]
verified_by: [apps/web/src/lib/sibling-conflict-probe.test.ts, apps/web/src/lib/sibling-conflict-probe-store.test.ts, apps/runner/__tests__/unit/sibling-probe.test.ts, apps/web/src/app/api/cron/sibling-probe/route.test.ts, apps/runner/__tests__/unit/env-scan-tools.test.ts]
supersedes: []
assertions:
  - id: "find-sibling-pairs"
    type: "symbol"
    name: "findSiblingPairs"
    path: "apps/web/src/lib/sibling-conflict-probe.ts"
  - id: "pick-rebaser"
    type: "symbol"
    name: "pickRebaser"
    path: "apps/web/src/lib/sibling-conflict-probe.ts"
  - id: "apply-probe-result"
    type: "symbol"
    name: "applySiblingProbeResult"
    path: "apps/web/src/lib/sibling-conflict-probe.ts"
  - id: "runner-merge-tree-probe"
    type: "symbol"
    name: "runSiblingProbe"
    path: "apps/runner/src/sibling-probe.ts"
  - id: "probe-tests"
    type: "test_file"
    path: "apps/web/src/lib/sibling-conflict-probe.test.ts"
  - id: "runner-probe-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/sibling-probe.test.ts"
---
# Live Sibling Conflict Probe

**Capability statement**: When two live workers in one workspace touch the
same file, Buildd MUST find out whether their branches actually conflict, by
a trial merge on a runner rather than a guess, and tell both workers once,
while their diffs are small, which files and regions collide and who rebases.
It is advisory: nothing is blocked.

Same-file overlap no longer holds a task at claim (see
`orchestration-decisions-shadow`), and most shared-file pairs merge cleanly.
This is the early warning for the ones that do not.

**Invariants**:

- Pairs come from observed touches (the runner's touched-paths heartbeat,
  `workers.observed_touches`), exact file match, live non-merged workers in one
  workspace only. A generated file (built-in regenerable or the workspace's
  `gitConfig.derivedFiles`) and the repo-wide `**` sentinel never form a pair.
  The same worker, the same branch or the same task never pairs with itself.
- A worker the workflow kernel owns never pairs: a repair or reviewer attempt
  (`tasks.delivery_role` other than `owner`), or an owner whose delivery is
  past `WORKING` (in review, repairing, fixing, awaiting push, landing, ...).
  The kernel's own conflict retry is the one authority over that PR. An
  unreadable delivery state counts as kernel-owned (fail closed), and a pair
  that became kernel-owned before its result arrives notifies nobody
  (`detail.suppressed: kernel_owned`).
- The prober is the worker that would rebase: the one not yet in review (no
  PR) when exactly one has a PR, otherwise the later starter.
- One `sibling_probes` row per pair (unique on workspace + pair key). A pair
  is not re-asked while a request is outstanding, nor within
  `SIBLING_PROBE_INTERVAL_MS` of its last probe; a request handed to a runner
  and not answered within `SIBLING_PROBE_DISPATCH_TIMEOUT_MS` is re-asked, and
  a request no runner took within `SIBLING_PROBE_REQUEST_TIMEOUT_MS` (the
  prober's runner cannot probe) is re-asked of the OTHER worker.
- The server never runs git. The prober's runner gets the request on its next
  heartbeat response (`siblingProbes`), only if it declared `siblingProbe`
  support, and reports the result on a later heartbeat (`siblingProbeResults`).
  A result from any worker other than the row's prober is ignored.
- The runner probes with `git merge-tree --write-tree` between its HEAD and
  the sibling's fetched branch: no checkout, no index change, no effect on the
  agent's worktree. The fetch uses `--no-write-fetch-head` into a private ref
  (`refs/buildd/probe/<probeId>`, deleted afterwards), so the agent's
  FETCH_HEAD is untouched. The server-supplied branch name and probe id are
  validated before any git command runs, and `--` / `--end-of-options` ends
  option parsing before them. It never throws; any failure is an `error`
  result.
- The runner's report is untrusted. A conflict path is kept only when, with
  control characters, newlines and backticks stripped and its length capped,
  it is one of the pair's shared files or either worker's observed touches;
  anything else is dropped and counted (`detail.rejectedPaths`). Listed files
  and line ranges are capped and quoted in the instruction.
- With `gitConfig.mergiraf` on and the binary installed, each conflicted file
  with all three stages is retried through `mergiraf merge`; a file it merges
  cleanly is not a conflict. If every conflicted file resolves, the outcome is
  `mergiraf_resolved`. A conflict only on generated files is `clean`.
- A real conflict queues one instruction to each worker on the instruct queue
  (`workers.pending_instructions`, the base-advance-notice channel), carrying
  the files, the conflict line ranges, and the rebaser/holder role. The marker
  `[sibling-conflict: <pairKey>]` stops a second copy while one is undelivered.
  A pair is told once per conflicting pair of branch heads
  (`sibling_probes.notified_heads`): the same two heads conflicting again are
  never re-sent, however much later; new heads that still conflict are told
  once more.
- Every result is a `sibling_conflict_probe` gate event: `warned` for a
  conflict or a probe error, `accepted` for clean or mergiraf-resolved, with
  `detail.notified`, `detail.debounced`, `detail.suppressed` and
  `detail.rejectedPaths`. This is the denominator for
  "does early warning cut conflict retries".
- The cron's gated tick (`?gate=due`) touches Postgres only when a heartbeat
  marked a workspace due (new touched paths); the hourly floor tick always
  runs. `SIBLING_PROBE_ENABLED=0` turns the probe off on the server.
- The runner's environment check probes `mergiraf` (with `command -v`) and
  reports it among its tools, so a workspace's opt-in is visible as effective
  or not.

**Acceptance criteria**:

- AC-1: GIVEN two live workers whose observed touches share `x.ts` WHEN the
  cron runs THEN one `sibling_probes` row is requested for the pair, addressed
  to the rebaser.
- AC-2: GIVEN the runner reports a `conflict` on `x.ts` WHEN the result is
  applied THEN both workers get exactly one instruction naming `x.ts` and its
  line range, and the same heads reported conflicting again notify nobody.
- AC-7: GIVEN the runner reports a conflict path that is neither a shared file
  nor either worker's touch (for example one carrying a newline and an
  injected instruction) WHEN the result is applied THEN the path never reaches
  an instruction and is counted in `detail.rejectedPaths`.
- AC-8: GIVEN either worker's delivery is past `WORKING`, or either is a
  repair/reviewer attempt WHEN the cron runs THEN the pair is not requested.
- AC-9: GIVEN a requested row no runner took for
  `SIBLING_PROBE_REQUEST_TIMEOUT_MS` WHEN the cron runs THEN it is re-asked of
  the other worker.
- AC-10: GIVEN a probe WHEN the runner fetches the sibling's branch THEN
  FETCH_HEAD is unchanged and no private probe ref is left behind; an unsafe
  branch name is an `error` result before any git command runs.
- AC-3: GIVEN the runner reports `clean` WHEN the result is applied THEN no
  instruction is queued and the gate event is `accepted` / `clean`.
- AC-4: GIVEN a same-file conflict that mergiraf merges (both sides adding
  different imports) and the workspace enables mergiraf WHEN the runner probes
  THEN the outcome is `mergiraf_resolved` and no instruction is queued.
- AC-5: GIVEN a gated cron tick and nothing due WHEN it runs THEN Postgres is
  not read.
- AC-6: GIVEN a runner that did not declare `siblingProbe` support WHEN it
  heartbeats THEN no request is handed to it or marked dispatched.

**Code surface**:

- `apps/web/src/lib/sibling-conflict-probe.ts`: `findSiblingPairs`,
  `pickRebaser`, `shouldRequestProbe`, `requestSiblingProbes`,
  `takeSiblingProbeRequests`, `applySiblingProbeResult`,
  `buildSiblingConflictInstruction` (pure).
- `apps/web/src/lib/sibling-conflict-probe-store.ts`:
  `createSiblingProbeStore`, `siblingProbeHeartbeat` (the worker PATCH
  route's one call in `apps/web/src/app/api/workers/[id]/route.ts`).
- `apps/web/src/app/api/cron/sibling-probe/route.ts`: the cron, two entries in
  `cron-manifest.json` (floor + Redis-gated).
- `apps/runner/src/sibling-probe.ts`: `runSiblingProbe`,
  `enqueueSiblingProbes`; wired from `apps/runner/src/worker-sync.ts`.
- `apps/runner/src/env-scan.ts`: `DEFAULT_TOOLS` includes `mergiraf`.
- Data model: `sibling_probes` in `packages/core/db/schema.ts`; wire types
  `SiblingProbeRequest` / `SiblingProbeResult` in `packages/shared/src/types.ts`;
  gate slug `SIBLING_CONFLICT_PROBE` in `packages/core/gate-slugs.ts`.

**Out of scope**:

- Blocking or pausing either worker: the probe only informs.
- Probing uncommitted or unpushed work on the non-prober side: the sibling's
  branch is read from `origin`.
- Semantic (non-textual) conflicts between the two branches.
