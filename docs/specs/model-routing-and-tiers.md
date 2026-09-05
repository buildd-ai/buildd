---
title: Model Routing and Tiers
status: active
owner: max
last_verified: 2026-08-30
summary: A claimed task MUST resolve to exactly one model id at claim time under a fixed precedence — explicit pin, role pin, task tier, then kind×complexity baseline under budget gates — recorded on tasks.predicted_model.
domain: tasks
surfaces: [packages/core/model-router.ts, packages/core/model-tier-registry.ts, apps/web/src/app/api/workers/claim/route.ts, packages/core/model-aliases.ts]
related: [provider-failover, mcp-connectors-and-roles, usage-and-cost-accounting, external-cron-triggers]
verified_by: [packages/core/__tests__/model-router.test.ts, packages/core/__tests__/model-tier-registry.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/models/route.test.ts, packages/core/__tests__/routing-analytics.test.ts]
keywords: [model_tier_registry, predicted_model, model_aliases, system_cache, task_outcomes, downshift, role floor, routing_paused, catalogComplete]
supersedes: []
---
# Model Routing and Tiers

**Capability statement**: For every claimed task, buildd MUST decide *which
model* runs it exactly once, at claim time, through one declared precedence
chain, and MUST record that decision on the task row so cost accounting and
calibration read the same answer the dispatcher produced.

This spec owns the **model** axis only. Which *provider process* runs the task,
and what happens when that provider is walled or its credential is rejected, is
the backend axis — see `provider-failover`. The two axes are resolved
independently and nothing reconciles them (see Verification gaps).

---

## Claim-time model resolution

**Capability statement**: A task's model MUST be resolved once, inside the same
atomic claim that assigns the task, under a precedence that a reader can
evaluate by hand.

**Invariants**:
- Resolution runs in `POST /api/workers/claim` between the dependency gates and
  the optimistic-lock `UPDATE`. `predictedModel` and `context.model` are written
  in the **same** `set()` payload
  (`apps/web/src/app/api/workers/claim/route.ts:1612-1630`), so the analytics
  column and the dispatched value cannot disagree.
- The precedence is fixed and total:
  1. `tasks.context.model` (per-task pin, any string),
  2. the role's `workspaceSkills.model` when it is **not** one of
     `haiku`/`sonnet`/`opus`/`inherit`/`premium`/`standard`/`budget` — i.e. an
     exact model id pinned on the role (`route.ts:1557-1567`),
  3. `tasks.tier` (`premium`/`standard`/`budget`) → tier registry,
  4. the `kind × complexity` baseline matrix, after the budget and spike gates
     and the role floor clamp, mapped to a tier by `mapRouterAlias`.
- A pin from step 1 or 2 short-circuits **everything**: `resolveEffectiveModel`
  returns `reason: 'explicit_override'` before any gate runs
  (`packages/core/model-router.ts:99-106`), so a pinned task is not downshifted
  by budget pressure, not downshifted by a claim spike, not raised to a role
  floor, and not paused at 95% of the daily cost cap.
- A role's `model` is a **floor, never a cap**: the clamp only fires when the
  computed tier is *below* it (`model-router.ts:152-157`). A role pinned to
  `opus`/`premium` therefore defeats every downshift the budget and spike gates
  just applied.
- `tasks.tier`, when set, overrides the router's computed tier — the budget and
  spike downshifts are discarded (`route.ts:1597-1598`) — but the 95% **pause**
  still applies, because it returns before the tier lookup.
- `mapRouterAlias` is total: `opus→premium`, `haiku→budget`, anything else
  (including `sonnet` and any unknown string) `→standard`
  (`packages/core/model-tier-registry.ts:24-28`). Role tier values round-trip
  without drift: `premium→opus→premium`.
- The only non-claimable routing outcome is `'paused'`. The task is left
  `pending` — never failed, never given a `start_at` floor — and
  `diagnostics.deferrals.routing_paused` increments (`route.ts:1580-1583`).
- `tasks.tier` is write-once: `POST /api/tasks` accepts it
  (`apps/web/src/app/api/tasks/route.ts:838`) and `PATCH /api/tasks/[id]`
  carries no `tier` branch, matching the schema comment at
  `packages/core/db/schema.ts:870-873`.
- Budget pressure has two sources folded into one `dailyBudgetPct` input:
  `totalCost / maxCostPerDay` for API-key accounts, and for OAuth seats the
  learned window pressure from `oauthBudgetPressure`, combined with `Math.max`
  (`route.ts:933-975`). Seat accounts report no cost, so without the second
  source their gates would never fire.

**Acceptance criteria**:
- AC-1: GIVEN a pending task whose `context.model` is `claude-opus-4-8` AND an
  account at 92% of `maxCostPerDay` WHEN a runner claims THEN
  `tasks.predicted_model` and `context.model` are both `claude-opus-4-8` — no
  downshift is applied.
- AC-2: GIVEN a task with `kind='engineering'`, `complexity='simple'`, no
  `roleSlug` and no resolvable team WHEN a runner claims THEN
  `tasks.predicted_model` is `haiku`.
- AC-3: GIVEN role `builder` configured with `model='sonnet'` AND a task
  `engineering/simple` routed to it WHEN a runner claims THEN
  `tasks.predicted_model` is `sonnet` — the floor raises the baseline `haiku`.
- AC-4 (failure path): GIVEN `dailyBudgetPct >= 0.95`, a task whose `kind` is
  not `coordination`, and `priority = 0` WHEN a runner claims THEN no worker is
  created for that task, the task stays `pending`, and
  `diagnostics.deferrals.routing_paused` is `1`.
- AC-5: GIVEN the same 95% pressure and `kind='coordination'` WHEN the router
  runs THEN it returns `sonnet` with `reason: 'budget_downshift'` — coordination
  is never paused.

**Code surface**: `packages/core/model-router.ts`
(`BASELINE`, `TIER_ORDER`, `downshift`, `resolveEffectiveModel`),
`apps/web/src/app/api/workers/claim/route.ts:1551-1630`,
`packages/core/db/schema.ts:866-876` (`tasks.kind`, `complexity`, `tier`,
`predictedModel`, `classifiedBy`),
`packages/core/__tests__/model-router.test.ts`,
`apps/web/src/app/api/workers/claim/route.test.ts` (`describe('smart model
routing')`, and the OAuth-pressure block at `:3796`).

**Out of scope**: which *backend process* executes the task
(`provider-failover`), and per-task `effort` / `thinking` / `maxTurns`
resolution, which the runner reads from task context and workspace gitConfig
(`apps/runner/src/workers.ts:2300-2310`).

---

## Tier registry resolution

**Capability statement**: `premium`/`standard`/`budget` MUST resolve to a
concrete `(provider, model)` through one chain — workspace override, team
default, code default — so retargeting a tier is a row write, not a deploy.

**Invariants**:
- `resolveTierEntry(tier, teamId, workspaceId)` returns the first match of:
  the `model_tier_registry` row for `(team, workspace, tier)`, the row for
  `(team, NULL, tier)`, then `TIER_DEFAULTS[tier]`. The returned entry carries
  `source: 'workspace' | 'team' | 'default'`, so a caller can always tell which
  level answered (`packages/core/model-tier-registry.ts:57-111`).
- At most one row exists per `(team_id, workspace_id, tier)` — enforced by the
  `model_tier_registry_unique` index (`packages/core/db/schema.ts:2246`). The
  API upserts by explicit read-then-write because `workspace_id IS NULL` does
  not participate in a plain `ON CONFLICT` match
  (`apps/web/src/app/api/model-tiers/route.ts:109-144`).
- Entries are cached in-process for 60s keyed by `${teamId}:${workspaceId}`;
  every registry write calls `invalidateTierCache`, which flushes the team-wide
  key and the named workspace key (`model-tier-registry.ts:32-47`,
  `model-tiers/route.ts:146` and `:204`). A tier change therefore reaches
  already-queued tasks within one cache window.
- A registry read failure MUST NOT block dispatch: `resolveTierEntry` swallows
  the DB error and returns `TIER_DEFAULTS[tier]`
  (`model-tier-registry.ts:106-110`). `resolveTierEntrySync` is the same answer
  with no DB dependency, for contexts that cannot await.
- All three `TIER_DEFAULTS` entries are `provider: 'anthropic'`
  (`packages/core/model-tier-defaults.ts:20-24`) — the last-resort fallback
  never routes a team to a provider it has not configured.
- Single-shot structured inference resolves the *same* registry rather than
  keeping its own model list, and rejects a tier whose provider is an agent
  backend: `provider === 'openai-codex'` returns
  `{ kind: 'unsupported_provider' }` (`packages/core/inference-client.ts:441-448`).
- `GET /api/models` MUST answer with the team's tier models even with no stored
  Anthropic credential, and MUST distinguish "catalog unknown" from "catalog
  empty" via `catalogComplete`. A stale-pin warning MUST NOT fire unless the
  catalog is complete (`apps/web/src/app/api/models/route.ts:87-131`,
  `apps/web/src/components/ModelPicker.tsx:34-44`).

**Acceptance criteria**:
- AC-6: GIVEN team T with both a `(T, W, premium)` row and a `(T, NULL, premium)`
  row WHEN `resolveTierEntry('premium', T, W)` runs THEN it returns the
  workspace row with `source: 'workspace'`.
- AC-7: GIVEN team T with no `budget` row at any level WHEN
  `resolveTierEntry('budget', T)` runs THEN it returns
  `TIER_DEFAULTS.budget` with `source: 'default'`.
- AC-8 (failure path): GIVEN the database throws on the registry read WHEN
  `resolveTierEntry('premium', T)` runs THEN it returns `TIER_DEFAULTS.premium`
  and does not throw.
- AC-9: GIVEN a cached entry for team T WHEN `invalidateTierCache(T)` is called
  THEN the next `resolveTierEntry` for T issues a fresh database read.
- AC-10 (failure path): GIVEN a team with no stored Anthropic credential WHEN
  `GET /api/models` is called THEN the response is HTTP 200 carrying the three
  tier models with `catalogComplete: false`, and no request is made to
  `api.anthropic.com`.

**Code surface**: `packages/core/model-tier-registry.ts`
(`resolveTierEntry`, `resolveAllTiers`, `invalidateTierCache`,
`resolveTierEntrySync`, `mapRouterAlias`),
`packages/core/model-tier-defaults.ts` (`TIER_DEFAULTS`, `TierEntry`),
`packages/core/db/schema.ts:2234-2248` (`modelTierRegistry`),
`apps/web/src/app/api/model-tiers/route.ts` (GET/POST/DELETE),
`packages/core/mcp-tools.ts:4020-4074` (`manage_model_tiers`),
`apps/web/src/app/api/models/route.ts`,
`packages/core/__tests__/model-tier-registry.test.ts`,
`apps/web/src/app/api/models/route.test.ts`.

**Out of scope**: which credential the resolved provider then uses — see
`credential-isolation` and `docs/credentials-architecture.md`.

---

## Alias vocabulary and refresh

**Capability statement**: The three short names `haiku`/`sonnet`/`opus` MUST
resolve to full model ids from a refreshable store, so pointing an alias at a
newer release needs no deploy — and MUST pass any other string through
untouched.

**Invariants**:
- The alias vocabulary is exactly `{haiku, sonnet, opus}`. `resolveModelName`
  and `resolveModelNameSync` return their input unchanged for every other value,
  including a full model id (`packages/core/model-aliases.ts:34-56`). Alias
  resolution is therefore idempotent over model ids.
- The store is a single **global** `system_cache` row keyed `model_aliases`,
  with a 1-hour DB TTL and a 5-minute in-process cache. It is not team-scoped.
  `DEFAULT_ALIASES` is the cold-cache fallback and the per-alias fallback when
  the cached map omits a family (`model-aliases.ts:11-28`, `:58-82`).
- `updateModelAliases` classifies candidates by substring on the model id
  (`includes('haiku')`, `'sonnet'`, `'opus'`) and writes **nothing** when no
  candidate matches any family — an empty write would blank the row
  (`model-aliases.ts:116-130`). Later candidates overwrite earlier ones within
  the same family, so list order decides.
- `POST /api/admin/refresh-model-aliases` rejects a non-admin API key with HTTP
  403 and an unauthenticated caller with HTTP 401
  (`apps/web/src/app/api/admin/refresh-model-aliases/route.ts:24-29`). Omitted
  aliases keep their `DEFAULT_ALIASES` value.
- Effort and thinking must stay compatible with the resolved id:
  `requiresThinkingEnabled` matches `claude-opus-5`, and
  `resolveEffectiveThinking` drops a `thinking: { type: 'disabled' }` override
  at `xhigh`/`max` effort rather than letting the API return 400
  (`model-aliases.ts:91-110`).
- The role/skill picker is tier-first: legacy `opus`/`sonnet`/`haiku` values are
  normalised to `premium`/`standard`/`budget` on mount and written back, and a
  tier value is never reported as a stale pin
  (`apps/web/src/components/ModelPicker.tsx:7-44`).

**Acceptance criteria**:
- AC-11: WHEN `resolveModelNameSync('claude-haiku-4-5-20251001')` is called
  THEN it returns that id unchanged, with no cache or database access.
- AC-12 (failure path): GIVEN an API key whose `level` is not `admin` WHEN
  `POST /api/admin/refresh-model-aliases` is called THEN the response is HTTP
  403 and `updateModelAliases` is not called.
- AC-13: GIVEN `{ opus: 'claude-opus-4-8' }` as the request body WHEN the
  refresh route runs THEN `updateModelAliases` receives an entry with
  `value: 'claude-opus-4-8'` and the untouched `sonnet` default.
- AC-14: WHEN `resolveEffectiveThinking('claude-opus-5', 'max', { type:
  'disabled' })` is called THEN it returns `undefined`.

**Code surface**: `packages/core/model-aliases.ts`
(`DEFAULT_ALIASES`, `resolveModelName`, `resolveModelNameSync`,
`updateModelAliases`, `requiresThinkingEnabled`, `resolveEffectiveThinking`),
`packages/core/db/schema.ts` (`systemCache`),
`apps/web/src/app/api/admin/refresh-model-aliases/route.ts` and its
`route.test.ts`, `apps/web/src/components/ModelPicker.tsx` and
`ModelPicker.test.tsx`.

**Out of scope**: the Anthropic catalog fetch itself, which belongs to the tier
registry block above.

---

## Model-id containment

**Capability statement**: A model id MUST NOT be hardcoded outside the registry,
pricing, and picker files, so retargeting a tier is a single row write rather
than a code sweep.

**Invariants**:
- `scripts/lint-model-ids.sh` runs in CI on every build
  (`.github/workflows/build.yml:99`) and exits non-zero when a model-id literal
  matching `claude-(haiku|sonnet|opus|fable|…)-[0-9]`, `claude-[0-9]`,
  `gpt-4[0-9o-]` or `gpt-3.5` appears in a `.ts`/`.tsx` file outside the
  allowlist. Test files are excluded by the grep filter.
- The allowlist is a declared list with a stated reason per entry
  (`scripts/lint-model-ids.sh:11-21`); the registry, defaults, pricing, MCP
  help-text, the QA judge and the runner UI list are the sanctioned homes for
  literals.
- Cost accounting classifies an id by substring rather than by exact match, so
  an unknown id degrades to the Sonnet rate instead of to zero:
  `priceForModel` (`packages/core/model-prices.ts:43-50`) and `modelWeight`
  (`packages/core/oauth-budget.ts:91-99`, which also accepts the tier names
  `premium`/`budget`).

**Acceptance criteria**:
- AC-15 (failure path): GIVEN a new literal `claude-opus-5` added to
  `packages/core/mission-helpers.ts` WHEN `bash scripts/lint-model-ids.sh` runs
  THEN it exits 1 and prints that file and line.
- AC-16: WHEN `modelWeight('premium')` and `modelWeight('claude-opus-4-6')` are
  called THEN both return `MODEL_WEIGHTS.opus`, and `modelWeight(null)` returns
  the Sonnet weight `1`.

**Code surface**: `scripts/lint-model-ids.sh`, `.github/workflows/build.yml:99`,
`packages/core/model-prices.ts`, `packages/core/oauth-budget.ts`,
`packages/core/__tests__/oauth-window.test.ts:96-112`,
`packages/core/__tests__/model-prices.test.ts`.

**Out of scope**: how the resulting cost is aggregated and billed — see
`usage-and-cost-accounting`.

---

## Routing telemetry and the calibration loop

**Capability statement**: Each terminal task MUST leave exactly one row
describing what the router chose and how the task then went, so the routing
matrix can be argued about with data rather than taste.

**Invariants**:
- `recordTaskOutcome` writes at most one `task_outcomes` row per terminal
  outcome. It is skipped entirely when the completion is an auto-retry, so a
  retried task contributes one row, not one per attempt
  (`apps/web/src/app/api/workers/[id]/route.ts:1614-1629`).
- The row copies `kind`, `complexity`, `classified_by` and `predicted_model`
  from the task row rather than trusting the caller
  (`packages/core/routing-analytics.ts:45-74`).
- A task with a NULL `predicted_model` never went through the router and MUST
  NOT produce a row (`routing-analytics.ts:56-57`).
- The write is best-effort telemetry: every failure is swallowed, reported via
  `reportOps`, and returns `false` — it MUST NOT block the worker status update
  (`routing-analytics.ts:76-81`).
- `recordTaskOutcome` reads the task through a raw `sql` template, never the
  Drizzle query builder, because the `tasks` relations emit a `workers`
  reference with no FROM clause (`routing-analytics.ts:38-51`, pinned by
  `packages/core/__tests__/routing-analytics.test.ts:14-22`).
- `GET /api/cron/routing-calibration` is read-only, requires
  `Authorization: Bearer $CRON_SECRET`, and returns HTTP 401 on a mismatch and
  HTTP 500 when `CRON_SECRET` is unset
  (`apps/web/src/app/api/cron/routing-calibration/route.ts:19-28`). Being
  side-effect-free is load-bearing: it is the liveness probe target for the
  cron-sync workflow (see `external-cron-triggers`).
- The calibration job is staged **dark**: its `cron-manifest.json` entry carries
  `"enabled": false`, so the aggregate has never been produced on a schedule.
  Nothing consumes its output — the prompt-flip step it exists to feed is
  explicitly not implemented.

**Acceptance criteria**:
- AC-17: GIVEN a task with `kind='engineering'`, `complexity='complex'`,
  `classified_by='organizer'`, `predicted_model='sonnet'` WHEN its worker
  reports a terminal `completed` THEN exactly one `task_outcomes` row is
  inserted carrying those four values and `outcome: 'completed'`.
- AC-18 (failure path): GIVEN a task whose `predicted_model` is NULL WHEN
  `recordTaskOutcome` runs THEN no insert occurs and it returns `false`.
- AC-19 (failure path): GIVEN the outcome insert rejects WHEN
  `recordTaskOutcome` runs THEN it resolves `false` and does not throw, leaving
  the worker update unaffected.
- AC-20 (failure path): GIVEN a request to `/api/cron/routing-calibration`
  whose bearer token does not equal `CRON_SECRET` WHEN it is handled THEN the
  response is HTTP 401 and no query is issued.

**Code surface**: `packages/core/routing-analytics.ts`
(`recordTaskOutcome`, `detectDownshift`),
`packages/core/db/schema.ts:1443-1470` (`taskOutcomes`),
`apps/web/src/app/api/workers/[id]/route.ts:1613-1630`,
`apps/web/src/app/api/cron/routing-calibration/route.ts`,
`cron-manifest.json` (`Buildd: Routing Calibration`, `enabled: false`),
`packages/core/__tests__/routing-analytics.test.ts`.

**Out of scope**: the OAuth window measurement that reads `predicted_model` for
budget pressure (`apps/web/src/lib/oauth-budget-window.ts`) — it is a *consumer*
of this decision, specced under `usage-and-cost-accounting`.

---

## Verification gaps

Unguarded claims and live drift found while writing this spec. Each is a real
finding, not a TODO placeholder.

**The resolved model does not reach the SDK.** `apps/runner` reads no model from
the server. `tasks.context.model` and `tasks.predicted_model` are written by the
claim route and read back only by the claim route, analytics, and OAuth
pressure; a repo-wide search for `context.model` finds no consumer in
`apps/runner`. The executing session uses the runner-global
`config.model` — `process.env.MODEL || savedConfig.model ||
TIER_DEFAULTS.standard.model` (`apps/runner/src/index.ts:428`) — passed straight
through `apps/runner/src/workers.ts:2417` and
`apps/runner/src/backends/claude-backend.ts:39`. The claim route's own comment
("injected into task.context.model so worker-runner picks it up",
`apps/web/src/app/api/workers/claim/route.ts:1554`) and the schema comment on
`task_outcomes.actual_model` ("what the worker actually ran on") are both
false today. Consequence: every invariant in this spec is verified at the
*decision* layer only; no test asserts the decision is honoured at execution.
The `roleConfig.model` field is transmitted to the runner
(`route.ts:2099`) and never read either.

**`task_outcomes.downshifted` is always `false`, and its baseline table has
drifted.** `detectDownshift` bails out unless `predicted_model` is literally
`haiku`/`sonnet`/`opus` (`packages/core/routing-analytics.ts:111`), but the
claim route writes the *resolved full id* whenever a team resolves
(`route.ts:1602`). Only the no-team fallback path writes an alias. Separately,
the BASELINE copy in `routing-analytics.ts:91-99` says
`coordination: opus/opus/opus` while the real matrix in
`model-router.ts:66` says `sonnet/sonnet/opus` — two copies of one table, one
of them wrong. The drift is currently masked by the first bug.
`packages/core/__tests__/routing-analytics.test.ts:106` encodes the masking
behaviour as intent.

**The calibration loop is dark end to end.** The job is `enabled: false` in
`cron-manifest.json`, so it has never run on a schedule. Its `overshoots` flag
tests `predictedModel === 'opus'` (`routing-calibration/route.ts:68`), which
cannot match a full model id, so that flag is unreachable even if the job ran.
`actual_model` is never passed by the only caller
(`apps/web/src/app/api/workers/[id]/route.ts:1622-1629`), so predicted-vs-actual
comparison has no data. No code consumes the route's response.

**`kind` and `complexity` are almost always NULL, so the routing matrix is
unreachable.** The only production writer is the schedules cron
(`apps/web/src/app/api/cron/schedules/route.ts:637-639` via
`classifyScheduleCadence`). `POST /api/tasks` accepts no `kind`/`complexity`
field at all, and MCP `create_task` **rejects** them as unknown parameters
(`packages/core/mcp-tools.ts:1573-1582`) — while the seeded Organizer prompt
instructs the agent to "Always set `kind` and `complexity`" and shows a plan
example containing both (`apps/web/src/lib/default-roles.ts:104`, `:118-119`).
Every non-scheduled task therefore defaults to `engineering/normal` →
`sonnet` → `standard`.

**The alias subsystem has no live consumer.** Its only caller was `classifyTask`
in `packages/core/task-classifier.ts`, which itself had no production caller and
was deleted in v0.192.0 (#2006) — so `resolveModelName` now has none at all.
`apps/web/src/app/api/tasks/route.ts` imports a same-named keyword classifier
from `@/lib/task-category`, which is unrelated. The
`task_classification` inference capability is declared
(`packages/core/inference-policy.ts:78-84`) but nothing performs it. Nothing
calls `updateModelAliases` except the admin route, contradicting the module
docstring's claim that workers refresh it "automatically … via
`supportedModels()`" (`packages/core/model-aliases.ts:15-18`).

**Global model-alias writes are not admin-gated on every auth path.** The
invariant is that a write to the global model-alias row MUST require an admin
credential regardless of how the caller authenticated, and a non-admin caller
MUST be rejected. No test asserts it. Specifics are tracked privately until the
guard lands. Separately, the alias-refresh response reports aliases that the
write may have silently dropped: `{ opus: 'claude-fable-5' }` returns
`aliases.opus = 'claude-fable-5'` while `updateModelAliases` classifies by
substring and stores no `opus` key at all.

**Tier-registry reads and writes do not assert team membership.** The invariant
is that a caller MUST be a member of the team whose tier registry it reads or
writes, and a caller failing that check MUST be rejected rather than served. No
test asserts it. Specifics are tracked privately until the guard lands.

**Registry fields that are stored but never consumed.** `defaultEffort` and
`defaultMaxTurns` round-trip through the API, the schema, and `TierEntry`
(`packages/core/model-tier-registry.ts:93-94`) but no dispatch path reads them —
the claim route takes only `entry.model`, `entry.provider`, `entry.source`
(`route.ts:1601-1603`).

**Tier provider and task backend are never reconciled.** A tier row may be
`provider: 'openai-codex'` or `'openrouter'`
(`apps/web/src/app/api/model-tiers/route.ts:86`) while `tasks.backend` is
`claude`. The claim route reads `entry.provider` only to stamp
`context.resolvedTier`, and rejects nothing. The docstring claim that "dispatch
throws a clear error if dispatched" (`model-tier-registry.ts:54-55`) has no
implementing code. `provider-failover` owns `dispatchable: false` for backends;
nothing applies an equivalent rule to tier providers.

**Role tier values are handed to the SDK verbatim as subagent models.** After
the picker normalises a role to `premium`/`standard`/`budget`, that string is
passed through the claim payload into `agents[slug].model`
(`apps/runner/src/workers.ts:2259`) with no translation to a model id or to the
SDK's own alias vocabulary.

**`scripts/lint-model-ids.sh` is much weaker than it reads.** Its allowlist
contains the bare prefix `apps/web/src/app` (`:20`), which suppresses every
violation under the entire web app — routes included — because violation lines
are prefixed `./`. `gpt-5*` ids are not in the pattern at all (only `gpt-4…`
and `gpt-3.5`), so a hardcoded `gpt-5-codex` passes. The alternatives
`sonnet-5|fable-5|opus-4` inside the group are dead — they would require a
trailing `-[0-9]` that those ids do not have. The `apps/web/src/lib/config-helpers.ts`
entry is stale: that file contains no model id.

**Stale model ids in the fallbacks.** `TIER_DEFAULTS.standard` is
`claude-sonnet-4-6` (`packages/core/model-tier-defaults.ts:22`) and
`DEFAULT_ALIASES.sonnet` matches it (`packages/core/model-aliases.ts:22`), while
the current family is Claude 5 (`claude-sonnet-5`). Neither
`priceForModel` nor `modelWeight` has a `fable` branch, so `claude-fable-5`
prices and weighs as Sonnet.

**Untested invariants in this spec.** No test covers: the claim route's
tier-registry path (the routing tests all run with no `teamId` and assert the
alias fallback — `apps/web/src/app/api/workers/claim/route.test.ts:1980`);
`tasks.tier` overriding a budget downshift; `tasks.tier` immutability under
`PATCH /api/tasks/[id]`; `context.resolvedTier` contents; `/api/model-tiers`
authorisation or upsert semantics; `scripts/lint-model-ids.sh` itself; the
routing-calibration aggregate.

**Silent rejection of an invalid tier.** Both creation paths drop an
unrecognised `tier` instead of returning HTTP 400 —
`apps/web/src/app/api/tasks/route.ts:838` and
`packages/core/mcp-tools.ts:1703-1705` — so `tier: 'ultra'` yields a task that
silently routes at `standard`.

**Comment drift in the seeded roles.** The header of
`apps/web/src/lib/default-roles.ts:4-8` says Organizer is Opus (it is `sonnet`,
`:158`) and that Organizer/Builder "downshift via task complexity" — but
Builder's `opus` floor (`:259`) defeats every complexity and budget downshift,
per the floor-not-cap invariant above.
