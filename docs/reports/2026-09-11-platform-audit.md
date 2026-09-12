# Platform audit — 2026-09-11

Generated audit output. Rebuildable, may go stale. **Not a source of truth.**

Scope: active + recent tasks, 143 missions (52 audited in depth), all 7 initiatives,
48 schedules, and 7d worker-failure analytics.

Security-adjacent and quantitative findings are **deliberately not in this file** —
this repo is public. They are in the private `knowledge-base` repo under the same date.

---

## 1. Open defects

### D1 — Worker exit classification runs before server-side status overrides
**Severity: high.** Deferrals and contract violations burn retry budget.

`apps/web/src/app/api/workers/[id]/route.ts:1079` assigns
`updates.exitCause = classifyReportedFailure({...})` from the *reported* body status.
The Codex sequential-enforcement deferral is only detected at `:1091`
(`error.startsWith('Deferred:')`) — i.e. **after** classification — and
`classifyReportedFailure` takes no deferral input. So a deferred worker books
`code_failure`.

`apps/web/src/lib/worker-exit-taxonomy.ts:109` defines `consumesRetryAttempt` as an
exclusion list (`!== budget_limited && !== infra_failure && !== sandbox_mount_gap &&
!== condition_unmet && !== never_started && !== silent_start`), so **both
`code_failure` and `null` are chargeable**. Consumers:
`apps/web/src/app/api/tasks/cleanup/route.ts:33`, `apps/web/src/lib/stale-workers.ts:191`.

Three symptoms, one cause:
1. Codex deferrals — concurrency control working as designed — are charged a retry and
   can permanently fail a task that was never attempted.
2. The review-contract violation override leaves `exitCause` NULL; `consumesRetryAttempt(null)`
   is `true`, so it is charged.
3. The planning-contract violation path has the identical shape.

`condition_unmet` already exists and is retry-exempt — it is the correct bucket and is
unused on these paths.

**Do not** "fix" this by flipping `consumesRetryAttempt(null)` to exempt — that would mask
genuine unclassified failures. Set explicit causes at each override site instead.

### D2 — `explain` at workspace scope ranks long-abandoned PRs as `awaiting_merge`
**Severity: medium.** The triage surface is mostly dead subjects.

`apps/web/src/lib/mission-completion.ts:335` filters `awaitingMerge` on
`!!w?.prUrl && !w.mergedAt`, never reading `workers.prLifecycleStatus`, which already
models `'closed'` (`packages/core/db/schema.ts:50`).

Blocking on a closed-unmerged PR is deliberate for the completion *gate* (the comment
says so). The defect is that there is no `abandoned` terminal state, so tasks whose PRs
were closed without merging many months ago are reported forever as "awaiting merge"
with `nextAction` "Resolve and merge the open PR(s)" — impossible for a closed PR.

Workspace-scope `explain`, whose contract is "only the subjects that are waiting on
something, ranked", consequently returns overwhelmingly dead subjects and buries the
live ones. Fix: add an `abandoned` state, or exclude closed-unmerged PRs from the ranked
workspace read while keeping the completion gate intact.

### D3 — The human mission-close path bypasses the completion gate silently
**Severity: high.** Root cause of most closed-but-unshipped missions.

`completeMissionIfVerified` has nine callers — all cron / worker / agent paths.
`PATCH /api/missions/[id]`, which the UI "Complete mission" button hits, is **not** one
of them. The bypass is deliberate and documented ("a person may always override"), but
the audit note at `apps/web/src/app/api/missions/[id]/route.ts:~315` fires only
`if (storedCriteria.length > 0 && storedVerdict !== 'pass')`.

So a mission with **zero criteria and unmerged PRs closes with no record at all** — the
most common failure mode is the one never logged. Note
`packages/core/mission-helpers.ts:107`: zero criteria returns `pass`.

### D4 — Initiative health is stale by construction
**Severity: medium.** Directly causes the unhelpful "Losing" badge.

- `apps/web/src/lib/initiative-pulse.ts:371` — `if (i.criteriaFail > 0) return 'losing'`
  is the **first, unconditional** rule, outranking `won_unclaimed` ("Ready to close") at
  `:379`.
- `:490` computes `criteriaFail` with **no mission-status filter**, while `openMissions`
  on the adjacent line `:489` *does* filter `NOT IN ('completed','archived')`. One
  mission that failed a criterion once and then completed pins the arc red forever.
- `evaluateInitiativeKPIs` has exactly one caller (the on-demand endpoint) — no cron, no
  hook. An initiative can therefore render a verdict computed before its last missions
  completed, and nothing corrects it.

  **Caveat, established by re-evaluation:** the one arc rendering "Losing" was initially
  assumed to be a stale-verdict artifact. Forcing a fresh evaluation returned `fail`
  again, on two blocking KPIs — one of which had only just become computable and is a
  *new* real failure, not a stale one. So the staleness defect above is structural (there
  is genuinely no re-evaluation path) but must not be inferred from that arc's badge; in
  that case the badge was accidentally correct. Re-evaluate before concluding a red
  initiative is merely stale.
- The `autoVerify` toggle at `initiatives/[id]/InitiativeKPIPanel.tsx:208` promises
  "Re-check KPIs automatically when all child missions complete". The field is written and
  read for display, but **no evaluator consults it**.
- `initiatives/[id]/page.tsx:315` hardcodes `completionAttempted: true`, making
  "Completion refused" the only reachable non-pass label and asserting an attempt that
  never occurred.

### D5 — No UI affordance to close an initiative
**Severity: medium.**

The only two client PATCHes in the initiatives tree are the `autoVerify` toggle
(`InitiativeKPIPanel.tsx:91`) and mission linking (`AssignMissionModal.tsx:65`). Neither
writes `status`. The API validates all four values
(`active|paused|completed|archived`) and nothing auto-completes an initiative, ever.
"Ready to close" renders as a `<span>` inside a `<Link>`.

Missions, by contrast, do have controls: "Complete mission"
(`missions/[id]/MissionSettings.tsx:284`), "Archive" (`:454`, completed-only), and
pause/resume via `MissionMonitoringToggle.tsx` — which `return null`s unless the mission
has a cron schedule. Not reachable for missions either: `active → archived` directly, and
**reopen**, despite the API instrumenting an `isReopen` feed note.

### D6 — `progress` is wrong in both directions
**Severity: medium.** Produces false "unhealthy" readings.

`packages/core/mission-helpers.ts:638-820` credits the parent work row rather than the
retry attempt that actually merged, so a *successful* dedup permanently caps a mission
below 100%. It also counts PR-less completions as landed. Roughly a third of the
sub-100% "completed" missions are this artifact, not real failure.

### D7 — The hourly invariant sweep is blind to closed-but-unshipped missions
**Severity: medium.**

None of the 11 keys in `apps/web/src/lib/mission-invariants.ts` covers
closed-with-unlanded-deliverables or closed-with-failed-deliverables, and
`mission_unverifiable` is scoped `status === 'active'` only. The sweep built to catch
this class cannot see any of it.

### D8 — `release_status` has no source-ref field for `branch_merge`
**Severity: low.** Existing task covers this.

`apps/web/src/app/api/releases/status/route.ts` — the `ref` resolution ternary has arms
for `workflow_dispatch` and `script` but none for `branch_merge`, so `ref` falls through
to `target.defaultBranch` while `prodBranch` resolves to `strategy.prodBranch`. On a
single-branch repo they are identical and the route throws "Release config error: ref and
prodBranch resolve to the same value". `git grep sourceRef origin/dev` returns nothing —
no source-ref field exists to configure.

### D9 — Unwrapped `JSON.parse` leaks bare engine parse-error text
**Severity: low.**

The signature `JSON Parse error: Unrecognized token '\'` recurs in worker failures, and
`git grep "Unrecognized token" origin/dev` returns zero hits — so it is raw
JavaScriptCore parse-error text from an unwrapped `JSON.parse` on an external payload
(agent SDK / Codex stream chunk, or an MCP tool result) reaching the worker error field
with no attribution. Unactionable as written. Wrap the parse with source attribution
(which payload, which field, a truncated excerpt) and classify it.

### D10 — `autoVerify` never fires for missions either
**Severity: medium.**

Same defect shape as D4. Several criteria-bearing missions have zero evaluation record
ever, including one still active. `manage_missions get` prints
"⚠ Completion is BLOCKED until every criterion passes" on missions that closed anyway.

### D11 — bwrap / env-scan unit tests fail on inherited `BUILDD_DISABLE_SANDBOX`
**Severity: low.** Two existing duplicate tasks cover this.

`bwrap-capability-probe.test.ts`, `bwrap-runtime-recovery.test.ts` and
`apps/runner/src/env-scan.test.ts` fail when the worker environment sets
`BUILDD_DISABLE_SANDBOX=1`. Only the first references the variable, and only to set it
deliberately in one case; the other two have zero references and nothing clears an
inherited flag. The suite should neutralize the inherited flag per-file rather than
depend on ambient env.

---

### D17 — Flipping `accounts.authType` to the metered path can leave an account uncapped
**Severity: high.** Independent of any migration plan; a footgun today.

The two auth types are gated differently: the subscription path is limited by a session
gate, the metered path by `maxCostPerDay`. That column is **nullable**, so flipping an
account's `authType` to the metered value without setting a cap in the same statement makes
the guard falsy and the account **uncapped**.

Any migration, backfill or admin action that changes `authType` must set a cap atomically.
Worth a `CHECK`-style invariant or a write-boundary guard so the unsafe intermediate state is
unrepresentable rather than merely discouraged.

## 2. Already fixed — do not re-chase

| Symptom | Resolution |
|---|---|
| `sandbox_mount_gap` false positives (largest single failure bucket in the window) | commit `4be1c6b2`, 2026-09-07 — tightened the scanner and made the abort annotate-only |
| `tasks_active_planning_per_mission` unique violation marching schedules toward auto-pause | `.onConflictDoNothing()` at `apps/web/src/app/api/cron/schedules/route.ts:722`, with a skipped-not-failed path |
| `metric` goal criteria blocking completion forever | rejected at the write boundary, `packages/core/mission-helpers.ts:172-180`; one grandfathered mission remains |
| `description` criteria degrading to `NOT_EVALUATED` without an API key | fixed 2026-08-29 — prose grading now dispatches a grading task. Residual verdicts are pre-fix artifacts that were never re-graded |
| `recalculateOverall` folding `NOT_EVALUATED` into `pass` | **not a bug.** `packages/core/mission-helpers.ts:106-111` is correct. Stored `overall: pass` rows carrying `NOT_EVALUATED` children are stale data predating it |

Residual hygiene: schedule `lastError` is never cleared on success, so paused schedules
keep advertising bugs that were fixed weeks ago.

---

## 3. Stale queue entries

- A reviewer task is pending against PR #2050, which merged 2026-09-03. Its mission is
  already completed.
- A task's description still carries an "IN FLIGHT — PR #1998" banner; that PR merged
  2026-08-31 and `apps/web/src/lib/criteria-rearm.ts` plus its test are on `dev`.
- Two tasks describe D11 identically (same three files, same mission, both priority 1);
  one cites a wrong path — `env-scan.test.ts` lives at `apps/runner/src/`, not
  `__tests__/unit/`.

---

## 4. Mission and initiative state

**Missions.** Of 52 audited, most that never achieved their goal fall into: deliverables
closed unmerged (largest group), closed with failed deliverables, criteria never
evaluated at close, zero-task missions that never started, and stale-paused abandonment.
Two active missions are stalled rather than progressing.

Important correction to a natural assumption: **sub-100% progress does not mean orphaned
queue work.** `progress` is deliverable-only, and across every task-bearing mission in
the closed-under-100% cohort, none had a pending or in-progress work task. Sub-100%
almost always means a PR closed unmerged.

A recurring pattern worth naming: **the feature merges, its verification PR does not.**

> **Reliability caveat on the "closed unmerged" count.** A mission can read as unshipped
> when its work actually landed. Spot-checking one such mission found both its tasks
> pointing at the same closed-unmerged PR, yet the change fully present on `dev` — it had
> been re-done later under a different commit that no task record references. So
> "deliverables closed unmerged" is an upper bound on real loss: it reliably detects a
> broken *PR attribution* chain, and only probably detects unshipped work. Confirm against
> `dev` before treating any single entry as a real gap. This is itself a defect — see D6.

**Initiatives.** All 7 began this audit `active` at 100% rolled-up progress, 6 deriving
`won_unclaimed` ("Ready to close"). Four have since been closed. Three remain open, each
for a substantive reason: one genuinely fails two blocking KPIs on current data; one's
deliverable is a *decision* that no child mission or artifact records, so closing it
would assert a verdict nobody made; and one has all four KPIs permanently `UNVERIFIED`
because their metric keys predate the 4-key registry, so it cannot self-verify in its
present shape. None of this was closeable from the UI (D5).

**Schedules.** The large majority of schedules in the workspace are per-mission heartbeat
rows left `PAUSED` after their mission completed. `apps/web/src/lib/mission-archive.ts`
states outright that paused/completed are "deliberate states we never touch", so they
accumulate indefinitely. There is no reaper.

---

## 5. Vocabulary problems in the UI

Four separate red states with overlapping meaning:

| Surface | Values | Source |
|---|---|---|
| Verdict chip | `losing / grinding / stuck / won_unclaimed / winning / dormant / empty` | `apps/web/src/lib/verdict-presentation.ts:28-36` |
| KPI gate chip | `clear / unverified / failing / refused` | `packages/core/mission-helpers.ts:544-621` |
| Task health pill | `NOMINAL / BLOCKED / FAILING / STALLED` | `apps/web/src/lib/mission-helpers.ts:72` |
| KPI row | "Fail" badge | `initiatives/[id]/InitiativeKPIPanel.tsx:16` |

`FAILING` on a mission row means "any countable task ever failed"
(`mission-helpers.ts:108`) — no recency window, and no check whether a retry later
succeeded. It is only softened to a `⚠` once the mission itself is completed or archived.
`won_unclaimed` — finished work awaiting closure — is listed in `NOT_WINNING_ORDER`
(`verdict-presentation.ts:42`), so finished arcs are counted as "not winning".

Also: `initiativeStatusChip`, `deriveInitiativeDisplayStatus` and `motionLabel` have no
non-test consumers, yet Home still sorts via `sortInitiatives` (`home/page.tsx:344`),
which ranks by that dead display status — so Home and `/app/initiatives` order the same
arcs differently.

---

## 5b. Codebase-graph (CBM) defects

Measured 2026-09-11. Verdict recorded as an initiative artifact: **keep, default-on**. Context
cost is ~600–900 tokens because tool schemas are deferred behind ToolSearch, so the
"narrow it to save context" argument is void. Adoption on the correct denominator
(`aggregateCbm` over mounted, eligible workers) is 11.0% at 7d and **29.8%** restricted to
graph-relevant task kinds — most workers are `observation`/untyped and have no structural
question. Retire "CBM share of tool calls" as a health signal; it is the naive measure
`apps/web/src/lib/cbm-insight.ts:5-8` explicitly abandoned.

### D12 — The graph steering block is appended twice, with a mis-ordered guard
**Severity: high.** Most likely of these three to be suppressing adoption.

In `apps/runner/src/workers.ts`: `cbmMountBlocked` is initialised `false`, the steering block
is appended, `cbmMountBlocked = true` is only set *later* on bwrap mount failure, and the
block is appended **a second time** — the second call passing no options.

Two consequences. Normal workers pay ~580 tokens instead of ~290. And because
`buildCbmSystemPromptBlock` branches on `sharedBaseIndex`
(`apps/runner/src/cbm-enforcement.ts:485-492`), on the ~46% of workers running off a shared
base index the no-args copy asserts *"This worktree is already indexed"* while the first copy
correctly says *"It maps the base checkout, not your branch — Read the file for current
content."* An agent that believes the second reads a stale `get_code_snippet` of a file it
just edited, gets burned once, and reverts to grep for the rest of the session.

Separately, a mount-blocked worker receives the block anyway via the first append — the exact
failure the guard's own comment claims to prevent. Latent: `mount_unavailable` has 0 rows.

### D13 — CBM is unavailable inside skill subagents
**Severity: medium.**

Skill subagents receive an explicit `tools` list defaulting to
`Read/Grep/Glob/Bash/Edit/Write` — no MCP tools and no `ToolSearch`. Delegated work
structurally cannot reach the graph, so it is unavailable rather than merely deferred.

### D14 — 41.9% of graph index builds fail at the 60s timeout
**Severity: high.**

7d: 78 of 172 builds fail (30d: 35.6%; target 5%), essentially all `timeout after 60000ms`
(`apps/runner/src/cbm-bootstrap.ts:23`). A timeout **deletes the cache**, so the agent starts
cold. Adoption tracks this directly: 12.6% when the index is warm, 7.8% fresh-built, 6.4%
after a failed build.

### D15 — The designed CBM control arm never enrolled anyone
**Severity: medium.** Invalidates any claim that CBM is A/B tested.

Role `builder-nocbm` ("Builder (no CBM — trial control)") exists, but the `role_opt_out` skip
reason has **zero worker rows in all history**. Its 5 tasks fired in a single 78-second burst,
all one kind, one recording `no_worktree`. So the value question — does the graph improve
outcomes — has never been tested. Related trap: `aggregateCbm`'s `inputTokenDeltaPct` of
−69% is unusable, because the control is 5 Codex tasks on a different backend clearing
`MIN_COHORT` by one row, with a companion `fileAccessDeltaPct` of +3103%. That is a
recurrence of the "−80% delta with no mechanism" the module header already warns about.

### D16 — Role guidance contradicts the harness guidance
**Severity: low.** Text-only fix.

No role body mentions the code graph, and two point away from it. The `organizer` role says
*"for a task that is primarily codebase investigation (grep, read files, query_knowledge),
prefer builder"* — defining codebase investigation **as grep**. The `builder` role routes
structural lookup to `recall ... scope=code`, a third retrieval channel competing with both
grep and the graph. Seeded from `apps/web/src/lib/default-roles.ts`.

Note: role `allowedTools` is **dead config** for roles — `skill-and-role-injection.ts:165`
puts it on the claim payload but the runner never reads that field; the hard allowlist path
applies only to subagents built from `skillBundles`. Do not "fix" CBM availability there.

## 5c. Memory-digest A/B is live but was contaminated mid-flight

The `full` vs `task_scoped` workspace-memory experiment measures correctly — one row per
prompt build in both arms in `worker_prompt_composition_events`
(`packages/core/db/schema.ts:1449-1497`), with a real cohort in prod. Exposure worked: memory's
share of the prompt fell 41% → 16%, prompt bytes −28.9%.

But `MEMORY_DIGEST_POLICY_VERSION` (`apps/runner/src/memory-digest-policy.ts:73`) has been
bumped exactly once, ever — and the module's own header states the rule: *"changing the
control silently rebases the comparison and any change to it must bump
`MEMORY_DIGEST_POLICY_VERSION`."* A later change added a whole new retrieval step without a
bump, so one cohort straddles two different injection behaviours. The pooled headline
difference lives almost entirely in the pre-change era and vanishes after it, so the pooled
number must not be reported.

**Two fixes.** Add a CI guard pinning the injection path to the policy version, mirroring the
existing `apps/runner/__tests__/unit/cbm-version-pin.test.ts` pattern — that would have caught
this at review. And have the web side stamp its own retrieval version into each row: the
version constant lives in the runner but describes web behaviour, which is the root cause.

## 6. Operational findings surfaced during cleanup

Not defects in the product, but unowned and unfiled:

- **A release-driver schedule has `Last: never`, `Runs: 0`, `Next: N/A`** — it has never
  fired once. Either dead or misconfigured; recommend deletion after confirming intent.
- **Two workspaces share one name**, neither with a repo, one holding orphaned tasks.
  Likely one is stray. A second name is likewise duplicated.
- **Missions with `workspace_id IS NULL` are effectively invisible**: absent from every
  workspace-scoped listing and a 404 from `explain`, while `manage_missions get` returns
  them fine. This is the practical harm of the scoping split, and it is how a mission can
  sit unnoticed for months.
- Stale `lastError` confirmed in the wild: the already-fixed planning-task unique-violation
  was still the last recorded error on several heartbeat schedules, long after the fix.

### Retracted findings

Two items from the first draft of this audit were wrong, both traced to an over-trusted
artifact rather than to the repos. Recorded here so they are not re-chased:

- **"A Coder template image is pinned to CBM `0.9.0`."** False. The pin is **`0.10.8`**,
  in two places that are actively kept in sync: `docker/worker/Dockerfile:10`
  (`ARG CBM_VERSION=0.10.8`, plus per-arch SHA256) and `apps/runner/install.sh:388`.
  `apps/runner/__tests__/unit/cbm-version-pin.test.ts` asserts the two agree and the SHAs
  exist, and `.github/workflows/worker-image.yml:51` runs `scripts/verify-cbm-pin.sh`
  against the upstream release in CI. The only surviving `0.9.0` is a stale comment in
  `.cbmignore:2`. This surface is well-governed, not neglected.
- **"A personal mission has a live daily heartbeat six months past its window."** False.
  Its cron is twice-monthly and restricted to January–March, with `Last: never` and
  `Runs: 0` — dormant, never fired. The "daily 09:00–10:00" reading confused the
  mission's `activeHours` window with its cron frequency. Its only real defect was the
  NULL workspace noted above.

**Process lesson:** an artifact that records *state* is not evidence about *now*. Both
retractions came from a 2026-09-02 ground-truth artifact whose closing section is headed
"Proposed remediation breakdown (NOT filed)". Re-verify against the repo before treating
any artifact line as current.

## 7. Suggested order of work

1. **D1** — retry accounting corrupts task outcomes; cheapest real fix.
2. **D5 + D4** — the close affordance plus bounding `criteriaFail`; directly fixes the
   "unhelpful badge" complaint.
3. **D3** — make the human close path record an `awaiting_merge` override.
4. **D7** — add invariants for closed-with-unlanded / closed-with-failed deliverables.
5. **D6** — fix the progress numerator so dedup does not read as failure.
6. **D2**, then D9 / D10 / D11 / D8.
