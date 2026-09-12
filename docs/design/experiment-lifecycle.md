# Experiment Lifecycle

**Status:** Proposed
**Related:** `apps/runner/src/memory-digest-policy.ts`, `apps/runner/src/prompt-builder.ts:348`, `packages/core/db/schema.ts` → `workerPromptCompositionEvents` (`:1503`), `apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts`, `apps/runner/__tests__/unit/cbm-version-pin.test.ts`, `apps/web/src/lib/cbm-insight.ts`, `apps/web/src/lib/cbm-insight-query.ts`, `apps/web/src/app/api/cbm/metrics/route.ts`, `apps/runner/src/cbm-enforcement.ts`, `packages/core/mcp-tools.ts`, `packages/core/mission-helpers.ts`, `packages/core/derived-metric.ts`, `packages/core/initiative-metric-registry.ts`, `docs/design/workspace-memory-digest-arm.md`, `docs/design/self-host-only-subscription-auth.md`, `docs/reports/2026-09-11-platform-audit.md` (D15, §5c)

---

## Problem

buildd runs experiments on its own agents. It has no way to finish one.

The concrete failures, all currently true:

**1. The live experiment's end date exists only in a chat transcript.** The
memory-digest arm (`apps/runner/src/memory-digest-policy.ts`) is enrolled in
production. Nothing in the repo or the database records when it should stop,
what result would decide it, or who decides. `task_schedules` holds several
workspace schedules; none of them concerns the experiment. There is no mission,
no task, and no entry in `cron-manifest.json` for it either.

**2. Nothing reads the data it collects.** `worker_prompt_composition_events`
is written by exactly one place — `apps/web/src/app/api/workers/[id]/route.ts`
(insert at `:810`, `onConflictDoNothing`) — fed from
`appendPromptCompositionEvent` in `apps/runner/src/workers.ts:3317`. A
repo-wide search for readers returns zero: no route, no `scripts/` entry, no
`apps/web/src/lib` consumer, no UI. The schema comment at `:1499` explains that
the table is deliberately *not* pruned by the task-archive cron because "the
experiment needs the full history across a task's retry chain" — so buildd is
retaining an experiment rail indefinitely and has never queried it. Analysis has
been hand-pasted SQL.

**3. The comparison was contaminated mid-flight, silently.** A retrieval
improvement landed during enrolment without bumping
`MEMORY_DIGEST_POLICY_VERSION`, so one cohort straddles two different injection
behaviours. `docs/reports/2026-09-11-platform-audit.md` §5c records the
consequence: the pooled headline difference sits almost entirely on one side of
that boundary and must not be reported. Nothing broke, no test failed, and the
guard that would have caught it —
`apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts` — shipped
*after* the damage. Its own header says so: "That has already happened once on
this experiment."

**4. A readout without randomisation already shipped, and it produces
confident nonsense.** `GET /api/cbm/metrics`
(`apps/web/src/app/api/cbm/metrics/route.ts`) compares CBM-active against
CBM-disabled workers using real aggregation machinery — `aggregateCbm`,
`computeDeltaPct`, `MIN_COHORT = 5` in `apps/web/src/lib/cbm-insight.ts`. But
the "control" is whoever happened to have the graph switched off, not a
randomised arm. Audit finding D15 shows what that yields: a large negative
input-token delta paired with a wildly positive file-access delta from the same
cohort — a control group barely over the floor, and dominated by tasks on a
different agent backend. `cbm-insight.ts:13` already warns about "an -80% token
delta with no mechanism behind it"; the route reproduced exactly that.

**5. The designed control arm for that experiment enrolled nobody, ever.** The
intended CBM control was a *role* — `builder-nocbm` — which opts out by setting
`mcpServers['codebase-memory'] === false` on its `workspace_skills` row
(`apps/web/src/app/api/workers/claim/skill-and-role-injection.ts:172-178` →
`cbmDisabled` on the claim payload → `disableReason: 'role_opt_out'` at
`apps/runner/src/cbm-enforcement.ts:658`). Roles do not self-enrol: a task only
gets that role if a human routes it there. D15 confirms `role_opt_out` has zero
worker rows in all history. The role exists nowhere in code —
`apps/web/src/lib/default-roles.ts` never seeds it — only as a manually created
DB row and a comment at `cbm-enforcement.ts:183`.

**6. Documentation drifts because nothing forces it not to.**
`docs/design/workspace-memory-digest-arm.md` carried "where does the record
durably land" as an open question long after a migration answered it, and its
`**Related:**` line still cites `docs/design/retrieval-policy-evaluation.md`,
which does not exist.

So the two experiments buildd actually has are **exactly complementary
failures**: the memory-digest arm has sound randomised assignment and no
readout; the CBM comparison has a readout and no randomised assignment. Neither
has a declared hypothesis, a stopping rule, an owner, or a recorded decision.
Both are held together by someone remembering.

## Current state — what exists to reuse

Surveyed with citations so this design extends rather than reinvents. There is
**no** experiment registry, feature-flag table, cohort table, or A/B config
anywhere: none of the tables in `packages/core/db/schema.ts` is one, and
`packages/core/drizzle/` contains no such migration. The nearest thing to a flag
surface is `apps/web/src/lib/bypass-flags.ts` (per-task operator escape hatches
in `tasks.context`), which is not a rollout mechanism.

| Capability | Where it is today | What it gives a general primitive | What it does not |
|---|---|---|---|
| **Arm assignment** | `memory-digest-policy.ts`: `hashUnitInterval` (FNV-1a, `:143`), `assignMemoryDigestArm` (`:164`), draw salted `${POLICY_VERSION}:${taskId}` (`:180`), `resolveTaskScopedFraction` (`:119`, rejects out-of-range rather than clamping) | A correct, reusable randomiser: per-task so retries cannot switch arms, version-salted so a bump re-randomises, propensity recorded at assignment | Hardcoded to one version constant, one arm union, one call site (`prompt-builder.ts:348`). No notion of a second experiment |
| **Enrolment fraction** | `BUILDD_MEMORY_DIGEST_TASK_SCOPED_FRACTION` / `memoryDigestTaskScopedFraction` — `apps/runner/src/index.ts:478`, `types.ts:668` | A per-runner operator knob that defaults to enrolling nobody | Env-only. Not visible to the control plane, so nothing server-side knows an experiment is live |
| **Event rail** | `worker_prompt_composition_events` (`schema.ts:1503`), index `(policy_version, arm)` at `:1545` | The generic spine: `policy_version`, `arm`, `propensity`, `fraction`, unit id, `ts` — plus the nullable-not-defaulted discipline for unknowable fields (`:1532`, `:1538`) | **Memory-specific payload.** `digest_bytes`, `digest_bytes_available`, `digest_truncated`, `task_match_bytes`, `memory_share`, and `arm` typed `'full' \| 'task_scoped'`. A CBM arm cannot reuse it without widening that union and adding columns meaningless to the other experiment |
| **Readout / aggregation** | `cbm-insight.ts`: `aggregateCbm` (`:74`), `computeDeltaPct` (`:69`), `MIN_COHORT` (`:52`), `BY_DESIGN_SKIP_REASONS` (`:45`); query half `cbm-insight-query.ts` (`fetchCbmSummary:28`, `CBM_ROW_LIMIT:17`); route `/api/cbm/metrics` | A two-arm delta readout with a cohort floor, already written, already shipped — and the repo's compute/query split convention (mirrored in `usage-stats.ts` / `usage-stats-query.ts`, `failure-analytics.ts`) | Fed by an observational cohort, not an assignment. Has no power position, no stopping rule, no version segmentation |
| **Contamination guard** | Two independently invented content pins: `memory-digest-policy-version-pin.test.ts` (fingerprints 13 injection surfaces against `MEMORY_DIGEST_POLICY_VERSION`) and `cbm-version-pin.test.ts` (cross-file binary pin). Plus `packages/core/__tests__/composition-record-columns.test.ts`, which asserts record↔column correspondence by parsing source | A proven pattern for "a coupling the type system cannot see, guarded in CI, that fails on drift" | Hand-written per experiment. Nothing makes a *new* experiment get one |
| **Declared-spec + last-evaluation storage** | `initiatives.kpis` / `kpi_state` / `auto_verify` (`schema.ts:909-914`), types `InitiativeKPI` / `InitiativeKPIState` (`packages/shared/src/types.ts:1519`, `:1528`) | The exact shape a registry needs: a declared spec, the last evaluation with `evaluatedAt` / `evaluatedBy`, and an auto-verify opt-out | Scoped to initiatives; KPI metrics resolve through `initiative-metric-registry.ts` (`KNOWN_METRIC_KEYS:20`), which knows only release metrics |
| **Write-boundary validation** | `packages/core/mission-helpers.ts:173-180` rejects a `metric` goal criterion outright, because no evaluator exists and accepting one would hand the author a gate that can never open | The precedent this design follows: refuse at the write boundary rather than filter at read time | — |
| **"Not available" as a first-class state** | `packages/core/derived-metric.ts`: `DerivedMetric<T>` = value \| `{unavailable, reason}` with typed reasons `no_baseline` / `no_scope` / `not_evaluated`. Also `CriterionVerdict` (`types.ts:1422`) including `UNVERIFIED` / `PENDING` / `NOT_EVALUATED` | Exactly the vocabulary "not yet conclusive" needs, already load-bearing elsewhere | — |
| **Scheduling** | `task_schedules` (`schema.ts:1722`) dispatches an agent task on a cron, ticked hourly by `/api/cron/schedules`. `cron-manifest.json` + `withCronRun` (`apps/web/src/lib/cron-run.ts`) for platform-owned jobs, with `cron_runs` verdicts and paging | Two distinct mechanisms, and the cheaper one (a schedule row) needs **no new code and no new Neon wake window** — it rides the existing tick | Cron routes are not platform-native here; a new one needs a manifest entry, and `scripts/cron-coverage.test.ts` enforces the correspondence |
| **Notification** | `apps/web/src/lib/pushover.ts` `notify()` (server-side, `tasks`/`alerts` apps); per-team channels in `notify-rules.ts`. Agent-side push goes through a dispatch MCP connector's `send_pushover`, which `describeOutputChannel` (`mcp-tools.ts:617`) already detects and labels in `list_schedules` output | A scheduled agent task can already push a readout with zero new code | — |
| **Durable verdict** | `artifacts` (`schema.ts:1548`) with a workspace-unique `key` (`:1572`); `learn` / `recall` for workspace memory | A stable, addressable home for the written-up conclusion | An artifact is prose. It cannot be queried as lifecycle state |
| **MCP read actions** | `get_usage_stats` (`mcp-tools.ts:178`, case `:3245`), `get_failure_analytics` (`:184`, case `:3363`), `get_error_traces` (`:168`, case `:3140`), `get_budget_forecast` (`:177`, case `:3190`) — all **worker** level | The precedent, the idioms (window allowlist → `errorResult`, `resolveWorkspaceId`, clamped `limit`, markdown `text()` reply), and the test template (`packages/core/__tests__/mcp-tools-failure-analytics.test.ts`) | — |
| **Per-tenant config registry** | `model_tier_registry` (`schema.ts:2798`) | Precedent that a scoped config table is an accepted shape here | — |

## Proposal

Add an **experiment registry** that owns the lifecycle, and reuse every
mechanism above unchanged. Nothing in this design alters how any arm is
assigned today.

**The crux: the registry is the source of truth for the *declaration and the
decision*, and the repo stays the source of truth for *what an arm means*.**

If that split is wrong, the whole design is. The temptation is to put
everything in one place. Both single-home options fail concretely:

- **Registry-only** (fraction, arm semantics and surface fingerprints all in
  the DB) breaks the contamination guard. The guard has to run in CI, and CI
  here has no dependable database: worker sandboxes are deliberately denied a
  production `DATABASE_URL`, and the `DATABASE_URL` repo secret has been
  malformed for months with the knowledge-ingest job soft-skipping it. A drift
  guard that cannot run is the `~55 actions` comment problem again — prose that
  drifts because nothing checks it.
- **Repo-only** (a committed `experiments.yaml`) cannot record a decision. A
  conclusion is reached after a release, by a person, at a time; a file in git
  records it only if someone opens a PR, which is precisely the "someone
  remembers" dependency that produced every failure in the Problem section. It
  also cannot hold an enrolment count.

So: **declaration, lifecycle state, owner, stopping rule and decision live in a
table. Arm semantics, the policy version, and the surface fingerprints live in
tracked files.** The write boundary joins them — you cannot open enrolment for a
slug whose policy module is not registered in code, and CI fails if a
registered module's surfaces move without a version bump.

### 1. Lifecycle states

Five states. Each transition has a precondition, and the preconditions are
enforced at the write boundary, following `mission-helpers.ts:173`.

| State | Meaning | Required to enter |
|---|---|---|
| `declared` | Hypothesis on record, nobody enrolled | Everything in the mandatory list below |
| `enrolling` | Assignment is live | A registered policy module whose version matches the row; a pinned surface fingerprint set; a stopping rule; `expiresAt` |
| `frozen` | Assignment stopped, data complete, analysis open | Entered automatically when a stopping rule fires, or manually |
| `concluded` | A decision is recorded | A non-empty decision with a verdict and a rationale |
| `retired` | The losing code path is gone, or the winner is now default | The arm code is deleted or the treatment is unconditional |

**Mandatory before enrolment opens** — the list is the point of the whole
design, because every item on it is something the live experiment lacks:

1. **Hypothesis** — one sentence, falsifiable.
2. **Arms** — names, and which one is the control.
3. **Randomisation unit** — `task` / `workspace` / `account`. Declared, not
   assumed; see open questions.
4. **Enrolment fraction** — the treatment share.
5. **Primary outcome** — exactly one, named as a metric key. Secondary
   outcomes may be listed and are explicitly descriptive.
6. **Power target** — the minimum detectable effect and the resulting minimum
   units per arm.
7. **Stopping rule** — see §3.
8. **Hard expiry** — a backstop date.
9. **Owner** — a `users` row.
10. **Surface set** — the files and symbols whose change would move an arm.

`declared` with an incomplete list is fine; `enrolling` is not reachable
without it.

### 2. The registry

A new `experiments` table, plus a per-experiment policy module in code.

```
experiments
  id, slug (unique), title
  state            'declared'|'enrolling'|'frozen'|'concluded'|'retired'
  hypothesis       text
  spec             jsonb  -- arms, control, unit, fraction, primary/secondary
                          -- outcomes, MDE, minUnitsPerArm, stopping rule
  policy_version   text   -- MIRRORS the code constant; CI asserts equality
  owner_user_id    uuid -> users
  enrolment_opened_at, frozen_at, expires_at
  readout_state    jsonb  -- last computed readout, shaped like kpi_state
  decision         jsonb  -- verdict, rationale, decidedAt, decidedBy,
                          -- artifactKey
  workspace_id, team_id  -- scoping, both nullable
```

`spec` and `readout_state` are jsonb for the same reason `initiatives.kpis` and
`kpi_state` are: the shape is a contract in `packages/shared`, validated at the
write boundary, and it will change faster than a migration cadence tolerates.
`policy_version` is a plain column rather than part of `spec` because CI
compares it to a code constant and that comparison should not require reaching
into a blob.

**What deliberately does *not* move into the table:** the enrolment fraction as
the runner reads it. It stays the per-runner env var. Making the runner fetch a
fraction from the control plane at claim time adds a network dependency to
prompt assembly and a failure mode — "the registry was unreachable, so what
fraction was in effect?" — that the recorded-at-assignment `propensity` column
exists to avoid. The registry's `spec.fraction` is the *declared* fraction; the
row's `propensity` is the *effective* one, and a readout that finds them
disagreeing should say so rather than pick one. (Open question 5.)

**Per-experiment event payloads stay in per-experiment tables.** A generic
`experiment_events` table would have to hold every experiment's measurements,
which means either a jsonb payload (unqueryable without casts, and the existing
table's typed integer columns are what make a readout cheap) or an
ever-widening column set mostly NULL. Instead the registry row names its
payload source, and `worker_prompt_composition_events` stays exactly as it is.
What *is* worth extracting is the enrolment spine — `(experiment_slug,
policy_version, arm, propensity, fraction, unit_id, ts)` — as a shared shape so
a second experiment does not re-derive it. The memory-digest table already has
every one of those columns except the slug, which is implicit in the table name.

**Generalising the assignment function has one trap.** Extracting
`assignMemoryDigestArm` into a shared `assignArm(slug, version, unitId,
fraction)` that salts with `${slug}:${version}:${unitId}` would **re-randomise
the live experiment**, because its current salt is `${version}:${unitId}` with
no slug. That is a silent reassignment of every enrolled task mid-flight — the
exact harm the version salt exists to prevent. The extraction must therefore
take the salt prefix as a parameter and the memory-digest caller must pass its
existing prefix verbatim, with a test asserting a fixed task id still draws the
arm it draws today. Future experiments use the slug-qualified prefix.

### 3. Stopping rules that are not dates

A wall-clock end date is the wrong primitive because accrual rate is unknown
and not controlled — it depends on how many tasks the fleet happens to run,
which arm-eligible work exists, and whether a runner was up. The live
experiment's "end date in a transcript" would have fired against whatever
sample size had accumulated by then.

Declared rule, in order of preference:

1. **Accrual** — `minUnitsPerArm`, derived from the declared MDE. Fires when
   both arms clear it. This is the default and the one the doc pushes authors
   towards, because it is the only rule whose precondition is a number the
   author had to think about.
2. **Futility** — the observed confidence interval excludes the MDE in both
   directions, so more data cannot change the decision.
3. **Harm** — a declared guardrail metric crosses a declared bound. This is the
   one automatic transition with a safety obligation, so state its bound: harm
   evaluation runs at most once per readout, requires both arms to clear
   `MIN_COHORT` (reusing `cbm-insight.ts:52`), and its only effect is
   `enrolling → frozen`. It never edits a fraction, never dispatches work, and
   cannot conclude an experiment. Freezing is reversible by the owner; nothing
   here deletes data.
4. **Expiry** — the hard backstop. Reaching it moves the experiment to `frozen`
   and nothing else. It is not a verdict.

**"Not yet conclusive" is a normal state, not a failure.** Reuse
`DerivedMetric` from `packages/core/derived-metric.ts` for the readout's
primary outcome, with the existing typed reasons doing real work:

- `no_scope` — no enrolled units yet (fraction is 0, or nothing eligible ran).
- `no_baseline` — one arm has rows and the other does not.
- `not_evaluated` — a readout is computable but has not been run.

plus two the experiment case needs and the current enum lacks: `underpowered`
(both arms present, below `minUnitsPerArm`) and `straddles_versions` (the
selected window contains more than one `policy_version` — the memory-digest
failure, made loud). A `frozen` experiment whose readout is
`unavailable: underpowered` is a legitimate, reportable outcome, and a
`concluded` decision may record verdict `inconclusive`. Neither is an error
state and neither should page anyone.

`straddles_versions` deserves emphasis: it turns the contamination that
happened into a *refusal to produce a number*. Today the pooled number is
computable and wrong, which is worse than unavailable.

### 4. Contamination protection, generalised

Today the protection is two hand-written pin tests that nobody is obliged to
write for a third experiment. Generalise it in three parts.

**(a) One pin test iterates the registry instead of hardcoding one
experiment.** The declared surface set for every experiment whose state is
`enrolling` gets fingerprinted against that experiment's `policy_version`. The
registry of *surfaces* is a tracked file — the CI-has-no-database constraint
from the crux — so the shape is a committed manifest keyed by slug, and the DB
row's `policy_version` is asserted equal to the manifest's. Migrating the
existing test means moving its 13 fingerprints under the `memory-digest` key
and changing nothing about what is pinned, so the first commit is a no-op by
construction.

**(b) Every component that can move an arm stamps its own version.** The audit
named the root cause precisely: `MEMORY_DIGEST_POLICY_VERSION` lives in the
runner but describes web-side retrieval behaviour. A runner-side constant
cannot notice a change to a server-side query. So an experiment declares its
surfaces *per component*, and each component contributes a version stamped into
the event row. A change on the web side bumps the web stamp without anyone
editing the runner. This is the single highest-value item in the design, and it
is the one the existing guard cannot deliver.

**(c) When a surface changes mid-flight: invalidate and re-randomise. Never
auto-split.** Auto-splitting a cohort at the change boundary sounds
conservative and is not: it halves the power of both halves without saying so,
doubles the number of analyses (inviting the peeking problem in open question
6), and requires assuming the change affected only the arm you think it did —
the memory-digest case is exactly a change that moved the *control*, which is
the assumption's failure mode. Invalidation is honest and the machinery already
exists: bumping the version both prevents pooling and, because the draw is
salted with it, re-randomises. The cost is real — accrual restarts — and that
cost is the correct incentive to freeze before touching a surface. The readout
reports pre-bump rows as a separate, closed cohort rather than deleting them.

An experiment's declaration should therefore be read as a claim on its
surfaces: while it is `enrolling`, changing one costs you the sample.

### 5. Surfacing — MCP first, dashboard optional

Add one **worker-level read action** to the `buildd` tool: `get_experiments`.
Read-only, following `get_failure_analytics` and `get_usage_stats` exactly —
both are in `workerActions` (`mcp-tools.ts:184`, `:178`), so admins inherit
them and trigger tokens get the "requires a worker or admin token" refusal from
`requireWorkerLevel` (`:802`).

Returns, per declared experiment: slug, state, hypothesis, owner, arms and
which is the control, declared vs effective fraction, enrolment counts per arm,
the primary-outcome readout as a `DerivedMetric` (so `underpowered` and
`straddles_versions` arrive as states, not as zeros), the power position
(units per arm against `minUnitsPerArm`), which stopping rule would fire next,
`expiresAt`, and — once `concluded` — the decision and its artifact key.

Mechanically, adding it means three edits and one test file, and no more:
add the name to `workerActions` (`mcp-tools.ts:158-185`); add a `descriptions`
entry in `buildParamsDescription` (`:338-399`), which is **mandatory** because
`apps/web/src/app/api/mcp/tools.test.ts` asserts every advertised action is
documented; add a `case` to the `handleBuilddAction` switch, also **mandatory**
because `packages/core/__tests__/mcp-tools-action-coverage.test.ts` calls every
advertised action and fails on `Unknown action:`. Both transports and the usage
analytics are generic over the action string. No count assertion exists
anywhere, so nothing breaks by arithmetic — though the `~55 actions` comments
at `schema.ts:1437` and `apps/runner/src/action-events.ts:4`/`:18` are already
stale by four, which is its own small argument for not hardcoding counts in
prose.

Declaring, freezing and concluding are **admin** actions, for the reason in §6:
these are operator capabilities, and the structured `{error:'forbidden',…}`
refusal from `requireAdminLevel` (`:822`) is the right gate.

**Why MCP plus a scheduled push is sufficient, and a dashboard is optional.**

The failure this design exists to fix is not "the data was hard to see." The
data was durable, indexed, and retained on purpose for six months. The failure
is that **seeing it required someone to decide to look**, and nobody did. A
dashboard page has exactly that property. Adding one would reproduce the
failure mode in a nicer font.

MCP plus a schedule inverts it, in three ways a page cannot:

1. **The readout arrives unbidden.** A `task_schedules` row dispatching an
   agent task that calls `get_experiments` and pushes via the dispatch
   connector's `send_pushover` needs *no new code at all* — the schedule
   mechanism, the hourly tick, the connector and the output-channel labelling
   in `list_schedules` all exist. Compare a new cron route: a
   `cron-manifest.json` entry, a `withCronRun` handler, `cron-coverage.test.ts`
   correspondence, and its own Neon wake window, in exchange for a fixed
   message.
2. **The reader can act, in the same session.** An agent that reads
   `underpowered` can extend the expiry; one that reads `straddles_versions`
   can freeze and file the contamination; one that reads a fired accrual rule
   can conclude the experiment and write the artifact. A page can only inform,
   and then depends on a human to open a second surface to act. This is the
   difference between a dashboard and a loop.
3. **It is silent when there is nothing to say.** A scheduled agent decides
   whether a readout is worth a push. A page is equally silent whether the
   experiment is healthy or forgotten — the two states look identical, which is
   the state the live experiment has been in.

There is also a structural argument: the generic surface is the *stopping-rule
evaluation*, not the pixels. Whatever computes "which rule fires next" has to
exist before a page could render it, and once it exists MCP exposure is three
edits. Build the primitive; the page is a later, cheap, optional consumer.

**If a minimal UI is still wanted**, it belongs at
`/app/health/usage`. That page already hosts the usage drill-down
(`apps/web/src/app/app/(protected)/health/usage/UsageClient.tsx`), already owns
window resolution and clamping (`usage-drilldown.ts:53`), and already renders
period-over-period deltas with a cohort floor (`MIN_DELTA_TASKS:107`) — the
same vocabulary a readout needs. Keep it to **one read-only panel**: declared
experiments, state, arm counts, power position, next rule. No declaring, no
concluding, no fraction editing in the UI — those are registry writes and
belong behind the admin action, where the write-boundary validation lives.
A panel that can only read cannot half-declare an experiment.

### 6. Separation — should this be a different app?

**Recommendation: no. One deployment, one package, an admin token gate.**

A second Vercel project buys a second auth surface, a second env set, a second
deploy path, and a second holder of database credentials — while the data stays
in one database, which is where the actual sensitivity is. The experiment rail
joins `tasks`, `workers` and `workspaces`; a separate app would either hold the
same `DATABASE_URL` (no isolation gained, one more copy to leak) or call back
into this app's API (a new internal auth surface to design). The repo's own
prior art agrees: `docs/design/self-host-only-subscription-auth.md` §2 rates
"separate deployment artifact" as strictly stronger than a package boundary but
**defers it**, because the cost is a duplicated dashboard and doubled CI/deploy
surface, and notes it "does not by itself stop the hosted DB holding" the
sensitive rows.

**Does internal experiment tooling belong behind that same package boundary?**
No, and the reason is a clean distinguishing test worth stating:

> A **package** boundary is for capability that must be **absent** from a
> build. A **token** gate is for capability that must be **present but
> restricted**.

Subscription auth qualifies for the first: the whole point is that a hosted
artifact cannot accept the credential, and absence is the property, because
"who can flip it" is answerable only by a reviewable dependency-manifest diff.
Experiment tooling fails that test on both halves:

- **The mechanism must be present everywhere.** Arm assignment runs in the
  runner on every deployment. It is how the product improves. Excluding it from
  a build means that build cannot be experimented on, which is the opposite of
  the goal.
- **The readout is restricted, not absent.** A self-hosting operator running
  their own arms has a legitimate claim on their own experiment data — it is
  their tasks and their workers. What must not cross is *buildd's* experiment
  declarations, and that is tenancy scoping (`workspace_id` / `team_id` on the
  registry row plus the existing admin gate), not artifact composition. This is
  the same conclusion as the `metric`-criterion boundary: reject at the write
  boundary, scope at read, do not fork the artifact.

The one thing genuinely worth keeping out of the public repo is the **content**
of results: figures, per-arm counts, and anything that describes production
volume. That is already governed by the No-Production-Data gate and by the
convention that quantitative findings live in the private knowledge base. It is
a publishing rule, not a deployment topology.

### 7. Migrating the in-flight experiment

The memory-digest arm is enrolled right now and a readout is being built
separately. Retro-declaration must be **metadata-only**.

1. **Insert one `experiments` row** with `slug: 'memory-digest'`,
   `state: 'enrolling'`, `policy_version` set to the current value of
   `MEMORY_DIGEST_POLICY_VERSION`, and the hypothesis and arms transcribed from
   `docs/design/workspace-memory-digest-arm.md`. `enrolment_opened_at` is
   **derived** from the earliest `worker_prompt_composition_events.ts` at the
   current version, not typed by hand — the data already knows.
2. **Do not bump the policy version to declare it.** Declaring is metadata; the
   version salts the assignment draw, so bumping it would re-randomise every
   enrolled task and discard the accrued sample in the act of writing it down.
   This is an invariant, not a caution, and it should have a test: writing a
   registry row must not require or trigger a version change.
3. **Do not backfill or rewrite any event row.** The existing table is the
   payload source, referenced by the registry row. Its `arm` union, its
   nullable `backend` / `task_match_derived_by` discipline, and its exemption
   from the archive cron all stay exactly as they are.
4. **Set the missing lifecycle fields honestly.** Owner: a real user. Stopping
   rule: an accrual target. `expires_at`: a real backstop, since none exists.
5. **Flag the declaration as reconstructed.** `spec.preregistered: false`. The
   hypothesis and power target are being written *after* seeing data, so the
   primary outcome is descriptive, not preregistered, and a readout must say so.
   Silently recording a retrofitted target as if it had been declared up front
   would make the registry's central claim — "this was declared before
   enrolment" — false on its first row.
6. **Contamination is recorded, not repaired.** The straddled cohort described
   in the audit stays straddled. The registry notes the affected window so the
   readout returns `straddles_versions` for it rather than a pooled number.

The CBM experiment is then declared from scratch, properly: it needs a real
self-enrolling assignment (the role-based control enrolled nobody), and its
existing `aggregateCbm` readout becomes the payload reader for a randomised
cohort instead of an observational one. That is the second consumer that proves
the primitive is not shaped around the first.

### Implementation sketch

Load-bearing piece first.

1. **Stopping-rule evaluation and the readout contract** — the
   `DerivedMetric`-shaped primary outcome with `underpowered` /
   `straddles_versions`, and "which rule fires next". Pure functions, no DB,
   in `packages/core`. Everything else is a consumer of this.
2. **The `experiments` table and its write-boundary validation** — state
   machine preconditions, the mandatory-declaration list, the
   `policy_version`-matches-code assertion.
3. **Retro-declare `memory-digest`** (§7) and point the readout at the existing
   event table. First real consumer.
4. **The generic pin test** — migrate the existing 13 fingerprints under a slug
   key; no-op by construction.
5. **`get_experiments`** worker-level read action, plus admin declare/freeze/
   conclude.
6. **A `task_schedules` row** that reads and pushes. No new code.
7. **Per-component version stamping** (§4b) — the root-cause fix, sequenced
   after the rail works end to end because it changes what every row carries.
8. *Optional, later:* the `/app/health/usage` panel.

Every step defaults to a no-op: the table ships empty, declaring changes no
assignment, the pin starts by pinning what is already pinned, and the read
action reports "no declared experiments" until someone declares one.

## Open questions

**1. Randomisation unit for a workspace-scoped treatment.** The per-task hash
is right for prompt composition and probably wrong for CBM: a code graph warms
a cache across tasks in a workspace, so per-task assignment leaks treatment
into control. That argues for cluster randomisation on the workspace, which
costs far more units for the same power. I lean towards declaring `unit`
explicitly, refusing to pool across units, and accepting that a
workspace-randomised experiment may be underpowered for a long time — with
`underpowered` as an honest standing answer rather than a reason not to declare
it. I am not confident the fleet has enough workspaces for this to ever resolve.

**2. Whether the primary outcome can be expressed mechanically at all.** The
rework columns the memory-digest experiment is judged on (`ci_retry_pr_number`,
`conflict_retry_pr_number`, `reviewer_retry_pr_number` at `schema.ts:967-975`,
`criteria_rearm_cycles` at `:859`) live on `tasks`, and there is no metric-query
registry that can address them — which is exactly why `mission-helpers.ts:173`
rejects `metric` criteria outright. So this design needs the registry that
missions lack. I lean towards extending `initiative-metric-registry.ts`
(`KNOWN_METRIC_KEYS:20`) with experiment-relevant keys rather than inventing a
second resolver, but that couples two features that are otherwise unrelated and
I would want a second opinion.

**3. What "owner" means.** A `users` FK is the obvious answer and the one I
lean to, because accountability should name a person. But buildd's own work is
done by agents on schedules, and a human owner who never looks is the status
quo with a name attached. The alternative — the owner is a *mission*, so the
organizer keeps re-raising it — is more likely to actually work and harder to
hold accountable. Possibly both: a user for accountability, a mission for
cadence.

**4. Interaction between concurrent experiments.** Two experiments enrolling
the same tasks can interact, and with independent salts the overlap is random
rather than controlled. I lean towards declaring mutual exclusion and refusing
overlapping enrolment at the write boundary, because a full factorial design
needs more units than this fleet plausibly produces. But mutual exclusion means
experiments queue, and queueing is how the current one ended up with no end
date.

**5. Whether the enrolment fraction should eventually move into the registry.**
Recommended against for now (§2), but the current split means the declared
fraction and the effective fraction can silently disagree across a multi-runner
fleet, and the only evidence is the `propensity` column. A readout that
compares them would surface it; I have not decided whether disagreement should
be a warning or a freeze.

**6. Peeking.** If a scheduled push reports the readout regularly, someone will
form a view before the accrual target — which inflates false positives exactly
as repeated hypothesis tests do. Options: alpha-spending (correct, and more
statistics than this repo currently carries anywhere), or declaring every
pre-target readout as descriptive-only and withholding the primary-outcome
estimate until the rule fires. I lean to the second because it is enforceable
in the readout contract rather than in a reviewer's discipline, but it makes the
scheduled push less informative, which fights the whole point of §5.

**7. Retention.** `worker_prompt_composition_events` is deliberately exempt
from the archive cron. That was defensible for one experiment and does not
generalise — a rail that every future experiment writes to and nothing prunes
grows without bound. A `retired` experiment's rows are the obvious candidate
for pruning, but they are also the only evidence behind a recorded decision.
I lean to pruning on `retired` plus a preserved aggregate, and I do not have a
good answer for how much aggregate is enough.

**8. Where the decision durably lands.** Three candidates, all already
supported: a registry column (queryable, but prose in a jsonb blob), an
`artifacts` row with a stable workspace-unique `key` (the natural home for a
write-up, and shareable), or a `learn` memory (surfaces in future prompts,
which is where a conclusion most wants to be). I lean to all three with the
registry column as the record of *that* a decision exists and the artifact key
as the pointer — but three homes is three chances to drift, which is the
Problem section's sixth item.

**9. Does a concluded experiment have to retire its losing arm?** Leaving dead
arm code in place is how `builder-nocbm` persisted as a comment pointing at a
control that never existed. Forcing deletion on `concluded` is cleaner but
blocks concluding on a code change, which will delay decisions. I lean to
`retired` being a separate, required state with no deadline, and to the readout
naming experiments stuck in `concluded` — visible debt rather than enforced
cleanup.

**10. Whether the CBM experiment can be randomised at all without new
enforcement.** Its treatment is currently decided by role config and worktree
availability (`cbm-enforcement.ts` `buildCbmActivation`), with
`BY_DESIGN_SKIP_REASONS` (`cbm-insight.ts:45`) excluding several reasons from
the comparison. A randomised arm needs a deliberate disable path that is
distinguishable from all of those — otherwise assigned-control and
failed-to-mount collapse into one bucket, which is how the current readout got
its nonsense delta. I have not verified that such a path exists.

## Non-goals

- **No statistics engine.** No sequential testing, no alpha-spending, no
  variance estimation beyond what a readout needs to say `underpowered`. Open
  question 6 is deliberately unresolved.
- **Not a feature-flag or rollout system.** This is measurement. Gating a
  product behaviour for a tenant is a different problem with different
  primitives (`bypass-flags.ts`, `workspace_skills`), and conflating the two is
  how an experiment turns into a permanent conditional.
- **No customer-facing experimentation.** Tenants are not enrolled in anything
  by this design; buildd's own fleet is the population.
- **No change to the memory-digest arms, their fraction, or their event
  table.** §7 is metadata-only, by construction.
- **No migration of existing event rows** into a generic rail.
- **No second Vercel project and no new package** (§6).
- **Not a replacement for the private knowledge base.** Quantitative results
  and anything describing production volume continue to live there; the registry
  holds the declaration, the state, and the fact of a decision.
- **No automatic conclusion.** A stopping rule can freeze an experiment. Only a
  person (or an agent acting with an admin token on their behalf) can conclude
  one, and the decision field is mandatory prose. Nothing here infers a verdict
  from a p-value.
