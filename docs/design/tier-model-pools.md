# Tier model pools

**Status:** Proposed
**Related:** `packages/core/model-tier-registry.ts`, `packages/core/model-tier-defaults.ts`, `packages/core/model-catalog.ts`, `packages/core/model-capability-requirements.ts`, `packages/core/experiment-randomizer.ts`, `packages/core/experiment-readout.ts`, `packages/core/model-routing-experiment.ts`, `packages/core/model-routing-experiment-source.ts`, `packages/core/decision-client.ts`, `packages/core/inference-client.ts`, `packages/core/inference-keys.ts`, `packages/core/inference-policy.ts`, `packages/core/oauth-budget.ts`, `packages/core/db/schema.ts` (`modelTierRegistry`, `experiments`, `experimentAssignments`, `taskOutcomes`, `userFeedback`, `reviewFeedback`, `conversationMessages`, `conversationApprovals`), `apps/web/src/lib/chat/models.ts`, `apps/web/src/lib/tier-mapping.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/model-tiers/route.ts`, `apps/web/src/app/api/feedback/route.ts`, `apps/web/src/app/app/(protected)/settings/models/`, `cron-manifest.json`, `docs/design/model-tiers.md`, `docs/design/model-routing-experiment.md`, `docs/design/experiment-lifecycle.md`, `docs/design/decision-calls.md`, `docs/design/agent-chat.md`, `docs/design/inference-calls-primitive.md`

---

## Problem

A tier maps to exactly one model. `model_tier_registry` holds one row per
`(team, workspace, tier)`, and `resolveTierEntry` returns that row, or the
catalog's newest in-band pick, or `TIER_DEFAULTS`. That shape fails an admin in
four ways today.

1. **No way to try a second model.** An admin with an OpenRouter key can reach
   hundreds of models. To learn whether `qwen/qwen3-coder` handles `standard`
   work as well as `claude-sonnet-5`, they must repin the whole tier, wait,
   eyeball results, and repin back. Every task on the tier switches at once,
   and nothing records what happened.
2. **The picker lists by vendor, not by the key that pays.** The editor in
   `ModelTiersClient.tsx` is a provider segmented control plus a free-text
   `<datalist>` of every catalog entry for that provider. With OpenRouter
   selected it shows every vendor's models in one flat list. The admin's real
   question is "which key does this spend", then "which vendor inside
   OpenRouter", then price.
3. **Suggestions have no evidence behind them.** `SuggestionCard` shows catalog
   notes (a newer release exists, a pinned id vanished) and then a paragraph
   saying outcome-based suggestions are "not wired yet". The one experiment
   engine that exists, `model_routing`, moves tasks *between* tiers. Nothing
   compares models *within* a tier.
4. **Nothing grades how bad a failure was.** `task_outcomes.outcome` is
   `completed | failed`, and the readout's clean-completion flag
   (`classifyRow`) is binary. A model that ships a subtle wrong migration
   scores the same as one that needs a lint fix. Chat has no quality signal
   at all: `conversation_messages` stores tier, model and usage, and
   `user_feedback.entityType` has no value for a chat turn.

The owner found the current screen wordy and poorly grouped. It explains the
system in prose instead of showing what each tier runs and how well.

## Current state

| Piece | Where | Reuse |
|---|---|---|
| Tier → model | `model_tier_registry`, `resolveTierEntry` (60s cache), `TIER_DEFAULTS` | Stays the **incumbent** source. A pool with one arm resolves exactly as today. |
| Catalog + price bands | `model-catalog.ts`: `normalizeCatalog`, `pickTierModel`, `TIER_PRICE_BANDS`, keyless OpenRouter feed | Picker source, "in band" tag, auto-challenger discovery. |
| Runner servability | `makeCatalogServabilityCheck` (CLI version floors) | Gate on runner arms. |
| Chat routing | `resolveChatModel` in `apps/web/src/lib/chat/models.ts`; since #2858 falls back to OpenRouter (`openRouterModelId`) when the tier's provider has no key | Pool draw slots in before `resolveTierEntry`. |
| Keys | `resolveInferenceCredential` (user → workspace → team), `secrets` `inference_key` rows labelled by provider | Decides which chat routes a team can pick. |
| Registry + randomiser | `experiments` (kind `model_routing`), `experiment_assignments`, `assignExperimentArm` / `hashUnitInterval` salted `${experimentId}:${policyVersion}:${unitId}` | A pool in explore mode *is* an `experiments` row of a new kind. Same randomiser. |
| Readout | `computeExperimentReadout`, `wilsonInterval`, `newcombeInterval`, `insufficient_n`, `DEFAULT_MIN_SAMPLE_PER_ARM = 30` | Incumbent-protection test. |
| Eligibility precedent | `model-routing-experiment.ts`: no explicit model, no role pin, not a reviewer task, budget pressure under `DEFAULT_MAX_BUDGET_PRESSURE`, attempts inherit parent's arm, never defer on capability gap (`served = false`) | Copied as-is for agent pools. |
| Fixed-label judgments | `decisionCall` + `gateChoice` (Jev, `typesafe/jev-1.13`, capability allowlist, escalate-never-relax rule) | Severity grade and next-message classification. |
| Free-text judge | `inferenceCall` | Sampled calibration judge. |
| Human signals | `user_feedback` (`up | down | dismiss`), `review_feedback` (`approved | changes_requested | commented`), `conversation_approvals.status` (`denied`), `tasks.ciRetryPrNumber` / `reviewerRetryPrNumber`, `missions.criteriaRearmCycles`, `missions.criteriaReviewerFindings` | Implicit and explicit reward inputs. |
| Sensitive data | `workspaces.dataClass = 'sensitive'` | Excluded from exploration and grading. |
| Crons | external scheduler, `cron-manifest.json`, `withCronRun`, hourly :00 wake window | One new route rides that window. |

## Proposal

A tier becomes a **pool of one to four arms**. An arm is `(route, model)`.
Each tier has two pools: **Agent runs** and **Chat and quick calls**. A pool
runs in one of three modes: `pinned` (one arm, today's behaviour), `split`
(admin-set shares) or `explore` (a bandit proposes shares). Outcomes are
graded per assignment, with Jev adding a mistake-severity grade. buildd
suggests traffic shifts; an admin applies them, unless the admin opted the
pool into auto-shift within stated bounds.

### The crux

**Traffic moves in discrete, versioned allocations. The draw only reads the
current allocation; it never samples a posterior.**

Classic Thompson sampling draws from each arm's posterior on every request, so
every assignment gets its own implicit propensity and traffic drifts
continuously. That breaks three things this design needs:

- **"Never a silent switch."** With per-draw sampling there is no moment where
  traffic "changed", so nothing can be logged, notified, suggested or refused.
- **The admin's floor and cap.** Clamping a per-draw sample to "incumbent keeps
  at least 60%" has no meaning. Clamping an allocation vector does.
- **An honest readout.** `experiment_assignments.propensity` records the share
  in effect at the draw. A fixed allocation per version makes that a real,
  shared number that the Newcombe test and the audit log can both cite.

So Thompson sampling runs once per pool per day in the cron: it estimates
each arm's probability of being best, projects that vector onto the pool's
bounds, and emits a **proposed allocation**. In `split` and `explore` modes
without auto-shift, the proposal becomes a suggestion card. With auto-shift
on, the cron applies it if it passes every bound. Either way the applied
allocation is a new row version with an actor and its evidence.

If this is wrong (if we sampled per draw), we would get faster learning and
lose the audit trail, the bounds, and the ability to tell an admin what
changed and why. On a fleet where one tier sees tens of units a day, not
millions, the learning speed a per-draw bandit buys is small, and a day's
lag per shift costs little.

### 1. Arms and routes

```
arm = (route, model)
route ∈ anthropic | openai | openrouter      -- API keys: chat and quick calls
      | runner:claude | runner:codex         -- runner credentials: agent runs
```

- **Agent-run arms** are limited to what runners can serve: `runner:claude`
  (Claude subscription or `claude_credential`; also covers `anthropic` API keys
  a runner holds) and `runner:codex` (`codex_credential`). The runner's
  `LLMProvider` already admits `openrouter`, but `model-tiers.md` lists the
  OpenRouter agent backend as out of scope, so the picker shows
  `runner:openrouter` as unavailable until it exists (open question 3).
- **Chat arms** are limited to routes with a resolvable `inference_key`. The
  picker only offers routes where the team key, or the acting admin's key,
  resolves.
- **An arm's route is exact.** The #2858 fallback (tier on `anthropic`, only an
  OpenRouter key present, serve through OpenRouter) stays for `pinned` pools,
  because there it preserves today's behaviour. In `split`/`explore`, route is
  part of what the arm measures (latency, price, provider errors). If an arm's
  route has no key for the acting user, the turn serves the incumbent and
  records `served = false`.
- **Incumbent = the registry row.** The incumbent arm of both pools of a tier
  is the existing `model_tier_registry` entry, served on each surface's native
  route. Adding the first challenger **pins the incumbent** if the tier was on
  the catalog's auto pick. A baseline that self-heals to a new model mid-test
  would contaminate every comparison against it.
- **Pool size: 1 to 4 arms.** Enforced at the write boundary with a
  conditional insert (`INSERT … SELECT … WHERE (SELECT count(*) …) < 4`), not
  a transaction. Four keeps each arm's share large enough to learn at fleet
  volumes, and the picker a shortlist.
- **Decision models stay out.** `decision-calls.md` point 5 bars Jev from the
  tier registry. The picker filters the catalog through `normalizeCatalog`,
  which already requires `tools` support and text output.

### 2. Picker

Grouped by **route first**, then **vendor inside OpenRouter**, searchable,
priced from the catalog. Admins shortlist; nobody scrolls a flat list.

```
Anthropic key        claude-opus-5 · claude-sonnet-5 · claude-haiku-4-5
OpenRouter key       anthropic/… · openai/… · google/… · qwen/… · deepseek/… · (n more vendors)
OpenAI key           …
Runner: Claude       (models the fleet's CLI can serve)
Runner: Codex        …
No key: OpenAI       [Add key]
```

- Each row: model id, `$in / $out` per MTok, context, release date, and an
  `in band` tag when `TIER_PRICE_BANDS[tier]` contains its input price.
- Default filter: in band, newest first, per vendor collapsed to its three
  newest. Search spans everything.
- Out-of-band models are addable but tagged `above band` / `below band`. The
  band is a policy default, not a wall.
- The same model under two routes (Sonnet via the Anthropic key and via
  OpenRouter) is two arms, shown as two rows.

### 3. Traffic modes

| Mode | Arms | Who sets shares | Default |
|---|---|---|---|
| `pinned` | 1 | nobody; 100% | **every tier today** |
| `split` | 2–4 | admin types shares; buildd suggests | |
| `explore` | 2–4 | cron proposes; admin applies, or auto-shift applies within bounds | |

Per-pool bounds, all admin-editable:

- `incumbentFloor`, default **0.6**. The incumbent never drops below it
  without an explicit promotion (§6).
- `explorationCap`, default **0.3**. Total share of all challengers. Must be
  ≤ `1 − incumbentFloor`.
- `challengerMin`, default **0.05**. A live challenger keeps at least this
  share in `explore`, so it keeps learning. Below that it is paused or removed,
  not starved.
- `maxStep`, default **0.10** per allocation change for any single arm.

**Thompson step (daily, per `explore` pool).** Arm reward posteriors are
`Beta(α, β)` with fractional updates (`α += w·r`, `β += w·(1 − r)`, §4). The
cron draws 10,000 samples per arm, computes `P(arm is best)`, then projects:
clamp the incumbent to `≥ incumbentFloor`, cap challengers' sum at
`explorationCap`, floor each at `challengerMin`, limit each arm's move to
`maxStep`, renormalise. Prior `Beta(1, 1)` for challengers. The incumbent's
prior is its last 30 days of graded outcomes on the same pool, so a
challenger has to beat real history, not a flat prior.

**Auto-challenger (P3, opt-in).** When the catalog shows an in-band release
newer than every arm, from a route the pool can serve (keys for chat;
`makeCatalogServabilityCheck` for runners), and the pool has fewer than four
arms, the cron adds it at `challengerMin`. Bounds: one auto-challenger per
pool at a time; it counts against `explorationCap`; the cron removes it after
30 days unless an admin keeps it; adding it notifies admins and writes a
change row.

### 4. Assignment

**Unit and stickiness.**

| Surface | Unit | Sticks across |
|---|---|---|
| Agent runs | mission when the task has one, else the task (same as `model_routing`) | re-claims, CI/conflict/reviewer retries (`taskClass: 'attempt'` inherits the parent's row), every worker run of the task |
| Chat turns | the **turn chain**: consecutive turns of one conversation at one tier | tool steps, approval resumes, retries. A chain ends when the per-turn tier router picks another tier, after 6h idle, or when the arm is removed or frozen |
| Quick calls (`inferenceCall` sites with a tier) | the call's subject (task, mission) when it has one, else not enrolled | retries of the same call |

A new unit draws `u = hashUnitInterval(`${experimentId}:${policyVersion}:${unitId}`)`
and picks the arm whose cumulative share interval contains `u` under the
current allocation. Each served turn or task still gets its own assignment row
so rewards attribute per turn, but a chain reuses the chain's arm.

**Where the draw runs.**

- Agent: in the claim route, after `resolveEffectiveModel` and
  `drawModelRoutingArm`, in place of the bare `resolveTierEntry` call. A task
  the `model_routing` experiment enrolled is **not** drawn by a pool: it
  serves its tier's incumbent. One experiment at a time per unit keeps both
  readouts clean (open question 4).
- Chat: in `resolveChatModel`, before `resolveTierEntry`.
- Every pool code path catches and logs. An error serves the incumbent, never
  fails a claim or a turn.

**Eligibility.** A unit is never enrolled, and serves the incumbent, when:
it has an explicit model or a role model pin; it is a reviewer task (the
reviewer is a reward signal, so its model stays fixed across arms); the
workspace is `dataClass = 'sensitive'`; the tier is `premium-plus`; OAuth
budget pressure is at or above `DEFAULT_MAX_BUDGET_PRESSURE` for a runner arm;
or the pool is frozen or over its budget cap (§6). Ineligible units write no
assignment row, so they cannot dilute a readout.

**Capability gaps never defer.** A drawn runner arm the claiming runner cannot
serve, or a chat arm whose route has no key for this user, serves the
incumbent with `served = false`. Analysis stays intent-to-treat, as in
`model_routing`.

### 5. Reward

Every resolved assignment gets one `tier_outcomes` row with a **severity**, a
**quality** `q`, a **reward** `r ∈ [0, 1]` and a **weight** `w`.

#### 5a. Severity

```
none      no mistake
minor     cost a retry, a lint/CI fix, a rephrase; no wrong result reached a person
major     wrong result reached a person or a PR: wrong answer, wrong action,
          invented fact, reviewer changes requested on substance
critical  damage: destructive action, data loss, a merged regression, a
          security issue, an executed action the user had to undo
```

`q` by severity: none **1.0**, minor **0.75**, major **0.3**, critical **0**.
The gaps are deliberate: one major mistake costs as much as nearly three
minor ones, and a critical one zeroes the unit.

**Three sources set severity, highest precedence first:**

1. **Explicit** (a person said so): chat thumbs, `user_feedback` on a task's
   summary or artifact, an admin regrade on the detail screen.
2. **Deterministic floor** (facts in the DB): computed in code, no model.
3. **Jev grade** (§5c), confidence-gated.

Explicit beats everything. Otherwise severity = `max(deterministic floor,
gated Jev grade)`. **Jev can raise severity above the floor and never lower
it**, the same escalate-only rule `decision-calls.md` sets for every decision
call that touches stored state.

#### 5b. Signals per surface

**Agent runs** (per unit, after it resolves; §7):

| Signal | Source | Floor |
|---|---|---|
| Clean completion (`classifyRow` = `clean`) | `experiment-readout.ts` | none |
| CI retry dispatched | `tasks.ciRetryPrNumber` on an attempt child | minor |
| Conflict retry | `tasks.conflictRetryPrNumber` | none (base drift, not the model) |
| Reviewer changes requested | `review_feedback.state = 'changes_requested'`, `tasks.reviewerRetryPrNumber` | minor |
| Goal criteria re-armed | `missions.criteriaRearmCycles` delta while the unit ran | minor |
| Failed, model-attributable | `task_outcomes.outcome = 'failed'` and `exitCause` not in `INFRA_EXIT_CAUSES` | major |
| PR abandoned | readout `prAbandoned` | major |
| Human thumbs on summary/artifact | `user_feedback` (`summary`, `artifact`) | explicit: up → none, down → Jev grades within minor..critical |

**Chat turns:**

*Explicit.* Thumbs up or down on each assistant turn. A thumbs-down offers one
optional tap for a reason. The reason sets severity directly:

| Reason chip | Severity | Notes |
|---|---|---|
| Wrong answer | major | |
| Wrong action | major; critical if the action executed and the user then undid it | |
| Made something up | major | |
| Ignored what I said | minor | |
| Too slow | none for severity; counts in the latency term (§5d) at 3× weight | a slow correct answer is not a mistake |
| (no reason) | Jev grades within minor..critical; minor if Jev is below its gate | the user said it was bad, not how bad |

A thumbs-up sets severity `none`, and it overrides implicit signals for that
turn.

*Implicit, deterministic.*

| Signal | Source | Floor |
|---|---|---|
| Approval denied | `conversation_approvals.status = 'denied'` | minor |
| Approval edited before confirm | a new `edited` flag on the approval (today an edited input fails the `inputHash` match) | minor |
| Undo of an action the agent took | the undo endpoint writes a signal row | critical if the action was a write, else major |
| Abandoned to the form fallback within the same session | chat's "file it as a mission instead" path | minor |

*Implicit, Jev.* When the user's next message arrives, a decision call
classifies it:

```
question  next_message: choice
  correction  the user says the previous reply or action was wrong and restates what they meant
  complaint   the user objects to quality, tone or speed without restating the ask
  rephrase    the user asks the same thing again in different words, with no objection
  satisfied   the user thanks, confirms, or builds on the reply as correct
  neutral     a new topic or a continuation that says nothing about the previous reply
```

Gated by `gateChoice` at a per-label threshold read off the benchmark (§7),
starting shape 0.9. Above the gate: `correction` and `complaint` count as a
mistake and trigger the severity grade on the **assistant turn the message
refers to** (the immediately preceding turn, or the one an explicit quote
points at); `rephrase` sets a minor floor; `satisfied` sets none;
`neutral` records no signal. Below the gate the classification is dropped and
the turn keeps only deterministic signals.

#### 5c. Jev severity grade

A `decisionCall` with one Choice question, `severity`, labels
`none | minor | major | critical` with the contrastive definitions in §5a, no
catch-all, and the instruction to follow the definitions over wording in the
state. The state is a **compact outcome summary**, never a transcript:

- Agent: tier, surface, terminal status, exit cause, CI/conflict/reviewer retry
  counts, criteria verdicts, and the first 300 characters of up to three
  reviewer finding bodies. At most 2,000 characters in total.
- Chat: which tools the turn called and their outcomes, approval status, the
  thumbs reason if any, and the user's next message truncated to 500
  characters.

It runs under a new inference capability, `tier_outcome_grading`, off by
default. The next-message classifier runs under `chat_feedback_classification`,
also off. Storing a key starts nothing, per `inference-policy.ts`.

**Calibration.** A sampled judge checks Jev:

- The sweep samples **5%** of graded outcomes, capped at **20 per team per
  day**, and runs an `inferenceCall` judge on the same summary plus the full
  reviewer bodies (agent) or the assistant turn text (chat), in memory only.
- **The judge model must not be an arm of the pool it judges**, so a model
  never grades itself.
- Weekly, per pool: quadratic-weighted kappa between Jev and the judge. Below
  **0.6** on at least 50 pairs, the pool's Jev grades drop to weight 0 (floor
  and explicit signals only) and the screen says so. Admin regrades count as
  gold labels in the same comparison.

#### 5d. Reward and weight

```
r = clip( q − w_c · δ_cost − w_l · δ_lat , 0, 1 )
δ_x = clip( log2( x_unit / median_x(incumbent, pool, 30d) ), −1, 1 )
w_c = 0.10   w_l = 0.05       (per-pool settings)
```

Quality dominates by construction: one minor mistake (−0.25) outweighs being
2× the incumbent's cost (−0.10) and 2× its latency (−0.05) together. A model
half the incumbent's cost at equal quality earns +0.10. Cost is dollars for API
routes. For subscription runner arms it is `MODEL_WEIGHTS` pacing units,
labelled *virtual* on screen, because those dollars are not spent.

Weight `w` for the Beta update, by the highest-precedence signal present:

| Signal | w |
|---|---|
| explicit (thumbs, admin regrade, summary feedback) | 1.0 |
| deterministic floor only, or floor + gated Jev on an agent unit | 1.0 |
| gated Jev only (chat: next-message class, no explicit, no floor) | 0.5 |
| no signal (chat turn with no thumbs, no floor, Jev neutral or below gate) | 0: not counted |

Silence is not success. A chat turn nobody reacted to tells the bandit
nothing, so it does not count.

**Anti-dominance caps.** A single conversation contributes at most 5 turns of
weight to an arm; a single user at most 20% of an arm's total weight; a
single mission at most 5 tasks. One enthusiastic user, or one long mission,
cannot move traffic alone.

Agent and chat pools never pool rewards across surfaces, even for the same
model. They are different arms measuring different work.

#### 5e. Minimum evidence before any shift

No allocation change, suggested or automatic, until **every** arm involved
has:

| | Agent pool | Chat pool |
|---|---|---|
| Resolved units | ≥ 30 (`DEFAULT_MIN_SAMPLE_PER_ARM`) | ≥ 50 counted turns |
| Spread | ≥ 5 distinct missions or tasks | ≥ 10 conversations and ≥ 3 distinct users |
| Time | ≥ 7 days since the arm joined | ≥ 7 days |
| Grading health | Jev kappa not below 0.6, or Jev weight 0 | same |

Below that, the arm shows `learning n/30` and the readout verdict is
`insufficient_n`. Cutting a challenger for harm needs less (§6).

### 6. Guardrails

- **Incumbent protection.** Taking the incumbent below `incumbentFloor`, or
  replacing it, is a **promotion**, and it needs all of: the §5e minimum,
  `P(challenger beats incumbent) ≥ 0.95` from the posterior, and the
  Newcombe interval on mean `q` (and on clean-completion rate for agent pools)
  excluding zero in the challenger's favour. Promotion is **always an admin
  click**. Auto-shift can never do it. A promotion writes the new registry
  row, moves the old incumbent to challenger at `challengerMin`, and bumps the
  experiment's `policyVersion`.
- **Harm cut is fast and automatic.** A challenger drops to 0 immediately when
  it has ≥ 2 critical grades in its first 20 units, or
  `P(worse than incumbent) ≥ 0.9` after 10 units. Reducing exploration is
  always allowed without an admin; the cut still writes a change row and
  notifies.
- **Budget caps.** Per pool, a daily cap on **challenger** spend (dollars for
  API routes; pacing units for subscription arms). When the day's challenger
  spend reaches it, the pool writes a system allocation (incumbent 100%) until
  midnight in the team's timezone. Units in that window are not enrolled.
  Chat's team budget (`chatDailyBudgetUsd`) still applies on top.
- **No exploration where it doesn't belong.** Sensitive workspaces, the
  `premium-plus` tier, explicit models, role pins and reviewer tasks never
  enter a pool (§4). Grading never sends a sensitive workspace's text to any
  model.
- **Freeze.** One switch per pool and one per team. Frozen = incumbent 100%,
  no draws, no auto-challenger, no auto-shift. Takes effect within the 60s
  tier cache. Unfreezing restores the last admin-applied allocation, not
  whatever auto-shift proposed in between.
- **Audit log.** Every traffic change is a `tier_pool_changes` row: before and
  after shares, actor (a user, or `system:auto-shift`, `system:harm-cut`,
  `system:budget-cap`, `system:freeze`), and the evidence snapshot (n, posterior
  means, intervals) that justified it. Dismissed suggestions are rows too.
- **Never a silent switch.** Every change row notifies the team's admins
  through the existing notify rules. Auto-shift batches into one daily digest
  per team. The tier screen shows the last change on each pool.
- **Auto-shift bounds (P3, opt-in per pool).** It may move shares only among
  challengers and between the incumbent and challengers inside
  `[incumbentFloor, 1]`; at most `maxStep` per arm per day; only past the §5e
  minimum; never promote; never add an arm except the auto-challenger.

### 7. Where grading runs, and what it costs

**One new cron route**, `/api/cron/tier-pools`, hourly at :00, inside the wake
window the schedules tick and `role-outcomes` already open. Registered in
`cron-manifest.json` and wrapped in `withCronRun`. Each run:

1. **Resolve.** Marks assignments resolved: agent units at PR merge or
   abandon, or terminal status with no PR, or 14 days after claim with
   whatever is known (then `pending` becomes `unclean` exactly as the readout
   treats it). Chat turns 24h after the turn, or when the next user message
   was classified.
2. **Grade.** Up to 200 resolved, ungraded rows per run, oldest first:
   deterministic floor, then the Jev call when the capability is on. Sampled
   judge calls within their daily cap.
3. **Update.** Refreshes each arm's `Beta(α, β)`, severity counts, cost and
   latency medians.
4. **Allocate.** Once per day per pool, at the team's local 06:00: the Thompson
   step (§3), bounds, harm cut, then a suggestion or an auto-shift.

The chat next-message classifier runs in `after()` on the next user turn, the
same pattern as the `classifyTask` shadow, with a 3s deadline. It cannot
delay or fail the turn.

**Cost bound.** Jev calls ≤ resolved units + counted chat turns, each a few
hundred input tokens at Jev's published per-token price with free output: a
small fraction of a cent per call. Judge calls ≤ 20 per team per day at the
judge model's price. Both are team inference spend and both sit behind
capabilities that default off.

**Benchmark first.** Before either capability can apply a grade, the
`decision-calls.md` sequence holds: shadow (log the grade, apply nothing),
hand-label a held-out set in the gitignored `.decision-data/`, run
`scripts/decision-benchmark.ts`, then set the per-label thresholds in code.

### 8. Data model

All additive except one NOT NULL relaxation.

```
tier_pools                                  -- one per (team, workspace?, tier, surface)
  id, team_id, workspace_id NULL, tier, surface 'agent'|'chat'
  mode 'pinned'|'split'|'explore'           -- default 'pinned'
  experiment_id → experiments               -- kind 'tier_pool'; NULL while pinned
  allocation jsonb {armId: share}           -- current, applied
  allocation_version int
  incumbent_floor real 0.6, exploration_cap real 0.3, challenger_min real 0.05, max_step real 0.1
  cost_weight real 0.1, latency_weight real 0.05
  challenger_daily_cap numeric NULL, auto_challenger bool false, auto_shift bool false
  frozen_at, frozen_by, created_at, updated_at
  UNIQUE (team_id, workspace_id, tier, surface)

tier_pool_arms
  id, pool_id → tier_pools, route, model
  role 'incumbent'|'challenger', status 'active'|'paused'|'removed'
  source 'admin'|'auto_challenger'|'registry'
  stats jsonb {alpha, beta, n, weight, severity:{none,minor,major,critical}, costMed, latMed, pBest, updatedAt}
  added_by, added_at, removed_at
  -- ≤ 4 active per pool: conditional insert, no transaction

tier_pool_changes                           -- append-only audit log
  id, pool_id, kind 'allocation'|'arm_added'|'arm_removed'|'mode'|'freeze'|'unfreeze'
                   |'suggestion'|'suggestion_dismissed'|'promotion'
  before jsonb, after jsonb, evidence jsonb
  actor_user_id NULL, actor_system text NULL, created_at

tier_outcomes                               -- one per assignment; stores labels, never text
  id, assignment_id → experiment_assignments UNIQUE
  resolved_at, graded_at
  signals jsonb        -- flags and counts only: {ciRetry, reviewerChanges, approvalDenied, undo, ...}
  explicit 'up'|'down' NULL, explicit_reason NULL
  next_message_class NULL, next_message_confidence NULL
  severity, severity_source 'explicit'|'deterministic'|'jev'|'admin', severity_confidence NULL
  jev_model NULL, judge_severity NULL, judge_model NULL
  q real, reward real, weight real, cost numeric, cost_unit 'usd'|'pacing', latency_ms
```

Changes to existing tables:

- `experiments.kind` gains `'tier_pool'`. Free text in SQL, so a union change
  only.
- `experiment_assignments`: `task_id` becomes nullable; add nullable
  `conversation_id`, `message_id`, `arm_id → tier_pool_arms`,
  `allocation_version`; a CHECK that `task_id` or `message_id` is set; a
  partial unique index on `(experiment_id, message_id)`. `unit_type` gains
  `'conversation'` and `arm` holds the arm id for this kind. Dropping NOT NULL
  is non-destructive; the existing `(experiment_id, task_id)` unique index
  keeps working because NULLs are distinct.
- `user_feedback.entityType` gains `'conversation_message'`; add a nullable
  `reason` column with the five chip values. One vote per user per turn
  already holds through `user_feedback_user_entity_idx`, and a user can change
  it.
- `conversation_approvals` gains `edited boolean default false`.

**Privacy rule.** Bandit stats store classifications, grades and numbers.
`tier_outcomes` and `tier_pool_arms.stats` have no text column, and the
grader writes no message, reviewer body or turn text anywhere: it reads text
into memory for the call and drops it. Logs carry ids and labels only, as the
`[decision-shadow]` line does. Thumbs `comment` is not collected for chat.

**Migration notes.** Follow `.claude/skills/schema-change/SKILL.md`: one
migration for the three new tables, one for the `experiment_assignments` and
`user_feedback` changes, generated with `bun db:generate`, index checked
against concurrent sessions before push. No backfill: every existing tier
reads as `pinned` because it has no `tier_pools` row, and
`resolveTierEntry` sees no change. Pools are created lazily when an admin adds
the first challenger.

### 9. Admin screen

Settings → Team → Agent backends → Model tiers, rebuilt around pools. One
screen, two sections: **Agent runs** and **Chat and quick calls**. Provider
keys move to a compact strip at the top (route, last four, status) with the
full cards one tap away.

- **Tier list.** One row per tier per section. Each row lists its arms with
  traffic %, win rate (share of graded units with severity `none`), severity
  mix as a four-segment bar, and cost per 1k units. A suggestion sits inline
  on the row it concerns: the one-line evidence, then `[Shift traffic]
  [Dismiss]`. No explanatory paragraphs; the mode chip (`pinned` / `split` /
  `explore` / `frozen`) and the numbers carry the state.
- **Add model.** A sheet opened from `+ Add model` on a row: search, route
  groups, vendor groups inside OpenRouter, price, band tag, `[Add]`.
- **Tier detail.** Per-arm evidence (n, win rate, severity counts, mean
  reward with interval, P(best), cost, p50 latency, share against floor and
  cap), the mode and bound controls, freeze, the change log, and recent graded
  outcomes with their signals and grade source. An admin can regrade an
  outcome there.
- **Chat.** Each assistant turn gets thumbs. A thumbs-down opens the reason
  chips (a popover on desktop, a bottom sheet on phone). One tap records the
  reason and closes.
- Members see everything read-only. Only owners and admins get controls, as
  today.

### Implementation sketch

Load-bearing piece first.

**P1: pools, pinned and split, stats.**

1. `packages/core/tier-pool.ts`, pure: allocation validation (bounds, sum to
   1), cumulative-interval draw over `hashUnitInterval`, turn-chain
   stickiness, severity floor rules, `q` and `r`, weights and caps. No DB.
2. Schema: the three tables plus the `experiment_assignments` and
   `user_feedback` changes.
3. Draw in the claim route and in `resolveChatModel`, behind "no pool row ⇒
   unchanged". Eligibility copied from `model-routing-experiment.ts`.
4. Chat thumbs and reason chips (`POST /api/feedback` with the new entity
   type); approval `edited` flag.
5. The cron's resolve, deterministic grade and stats steps. No Jev yet.
6. The rebuilt screen: tier list, picker, detail, manual split, audit log,
   freeze. Suggestions in P1 are readout-based only (Newcombe on `q`).

**P2: explore and Jev.**

7. Thompson step and projection in `tier-pool.ts`; daily allocate step;
   suggestion cards; harm cut.
8. `tier_outcome_grading` and `chat_feedback_classification` capabilities;
   shadow, benchmark, thresholds; then gated apply.
9. Sampled judge and the kappa health check.

**P3: auto-challenger and auto-shift.**

10. Catalog-driven auto-challenger with its bounds.
11. Auto-shift, opt-in per pool, with the daily digest.

**Safety property.** With no `tier_pools` row, every code path returns what it
returns today. Every pool path catches and serves the incumbent. Automatic
actions are bounded: harm cut and budget cap only *reduce* exploration;
auto-challenger adds at most one arm at `challengerMin`; auto-shift moves at
most `maxStep` per arm per day and never promotes.

## Open questions

1. **Win rate: clean share or P(beats incumbent)?** I lean to *share of graded
   units with severity none* on the list, because an admin reads it without a
   statistics lesson, and P(best) on the detail screen only. The risk: an arm
   with a high clean share and rare critical failures looks good on the list.
   The severity bar next to it is meant to catch that.
2. **Severity weights.** `q` = 1 / 0.75 / 0.3 / 0 is a judgment call. I lean to
   shipping it as a per-pool setting with these defaults, and revisiting once
   the judge comparison shows how Jev spreads grades.
3. **Runner arms through OpenRouter.** The runner's `LLMProvider` admits
   `openrouter`, but the agent backend for it is out of scope in
   `model-tiers.md`. Until it exists, agent pools can only compare models the
   fleet's Claude and Codex credentials serve. I lean to showing the route
   greyed out rather than hiding it, so admins know what they are missing.
4. **One experiment per unit.** A unit in the `model_routing` experiment
   serves the pool incumbent. That keeps both readouts clean and slows pool
   learning while a routing experiment runs. Factorial designs need more units
   than this fleet produces. I lean to exclusion, with the pool showing
   "shared with a routing experiment" when it applies.
5. **Clustering.** Turns in a chain and tasks in a mission correlate, so
   per-turn intervals are too narrow. The per-conversation and per-mission
   caps blunt it. A cluster-robust interval is the correct fix, the same open
   question `model-routing-experiment.md` carries. I lean to adding it before
   the first promotion.
6. **Which judge.** It must be outside the pool it judges. A fixed judge per
   team (the premium incumbent of the *other* surface) is simple but drifts
   when that incumbent changes. I lean to pinning the judge model in the
   pool's config and bumping it deliberately, as Jev's version is pinned.
7. **Workspace pools.** The schema admits workspace-scoped pools. Most
   workspaces will never reach the §5e minimum alone. I lean to team pools
   only in P1–P3 and workspace override only for `pinned`.
8. **Quick calls.** `inferenceCall` sites with a tier (criteria grading,
   summaries) share the chat pool. Their outcome signals are thin. I lean to
   enrolling them only when a site has an explicit signal to report, and
   otherwise serving the incumbent.
9. **Premium-plus.** Excluded from exploration by the owner's rule. Should
   `split` be allowed there, admin-set with no bandit? I lean no for now:
   anything on that tier is opt-in and expensive, and pinned keeps it
   predictable.

## Non-goals

- **Per-draw posterior sampling.** The crux rules it out.
- **Changing a running session's model.** An arm is fixed for a unit.
- **Moving tasks between tiers.** That is `model_routing`'s job; pools choose
  a model inside a tier.
- **Decision models in pools.** Jev and other System One models stay out of
  the tier registry.
- **Storing message text for learning.** Only labels, grades and numbers.
- **A new credential table.** Routes resolve through `secrets` as today.
- **A statistics engine.** No alpha-spending, no sequential tests beyond the
  posterior and the existing Newcombe interval.
- **Exploration on tenants who have not opted in.** A pool does nothing until
  an admin adds a challenger.

## Prototype

A static HTML prototype, kept outside the repo, covers the tier list with
inline suggestions, the add-model picker grouped by route and vendor, one
tier's detail with per-arm evidence and recent graded outcomes, a chat reply
with thumbs, and the thumbs-down reason sheet on phone. Desktop 1440×900 and
phone 390×844, dark and light. All data is fictional.
