---
title: Model Routing and Tiers
status: active
owner: max
last_verified: 2026-10-15
summary: A claimed task MUST resolve to one model id at claim time under a fixed precedence — pin, task tier, role pin, then kind×complexity under budget gates and role floor — recorded on tasks.predicted_model.
domain: tasks
surfaces: [packages/core/model-router.ts, packages/core/model-tier-registry.ts, packages/core/model-policy.ts, apps/web/src/app/api/workers/claim/route.ts]
related: [model-policy, provider-failover, mcp-connectors-and-roles, usage-and-cost-accounting, external-cron-triggers]
verified_by: [packages/core/__tests__/model-router.test.ts, packages/core/__tests__/role-model-routing.test.ts, packages/core/__tests__/model-tier-registry.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/models/route.test.ts, packages/core/__tests__/routing-analytics.test.ts, apps/web/src/app/api/model-tiers/policy/route.test.ts]
keywords: [model_tier_registry, predicted_model, model_aliases, system_cache, task_outcomes, downshift, role floor, routing_paused, catalogComplete]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "effective-model"
    type: "symbol"
    name: "resolveEffectiveModel"
    path: "packages/core/model-router.ts"
  - id: "resolve-tier-entry"
    type: "symbol"
    name: "resolveTierEntry"
    path: "packages/core/model-tier-registry.ts"
  - id: "model-routing-tests"
    type: "test_file"
    path: "packages/core/__tests__/model-router.test.ts"
  - id: "claim-resolves-model"
    type: "symbol_reachable"
    symbol: "resolveEffectiveModel"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "read"
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
  (`apps/web/src/app/api/workers/claim/route.ts`), so the analytics
  column and the dispatched value cannot disagree.
- The precedence is fixed and total (`resolveClaimModelInputs`,
  `packages/core/role-model-routing.ts`):
  1. `tasks.context.model` (per-task pin, any string),
  2. `tasks.tier` (`premium-plus`/`premium`/`standard`/`budget`) → tier
     registry,
  3. the role's `workspaceSkills.model` when it is **not** one of
     `haiku`/`sonnet`/`opus`/`inherit`/`premium-plus`/`premium`/`standard`/`budget`
     — i.e. an exact model id pinned on the role,
  4. the `kind × complexity` baseline matrix, after the budget and spike gates
     and the role floor clamp, mapped to a tier by `mapRouterAlias`.
  An explicit caller value always wins over a role: a role pinned to
  `claude-sonnet-5` on a task filed with `tier: "premium"` runs at premium.
- A pin from step 1 or 3 short-circuits **everything**: `resolveEffectiveModel`
  returns `reason: 'explicit_override'` before any gate runs
  (`packages/core/model-router.ts`), so a pinned task is not downshifted
  by budget pressure, not downshifted by a claim spike, not raised to a role
  floor, and not paused at 95% of the daily cost cap.
- The role row is resolved **per task**, the same way `checkConnectorRouting`
  resolves it (`pickRoleRowForTask`): the task workspace's override row, else
  its team's default (`workspaceId IS NULL`). Another workspace's override of
  the same slug never applies, whichever workspaces the claiming runner serves.
- A role whose model comes from **inference** (`context.roleInferred` present)
  contributes nothing to the model — not a pin, not a floor. Only a stated role
  moves the model (`knowledge-base: buildd/design/role-routing.md` §4.1).
- A task created with no role gets its kind's default role when the workspace
  has that role as a routable candidate (engineering → builder, research →
  researcher, writing → writer, analysis → analyst, coordination → organizer;
  `apps/web/src/lib/task-role-default.ts`). It is stamped
  `context.roleInferred` with `source: 'kind'`, so it follows the rule above,
  and the decision model may replace it while the task is unclaimed. A stated
  role is never replaced.
- A role's `model` is a **floor, never a cap**: the clamp only fires when the
  computed tier is *below* it (`model-router.ts`). A role pinned to
  `opus`/`premium` therefore defeats every downshift the budget and spike gates
  just applied.
- A `premium-plus` role floor resolves to the `premium-plus` tier. The router
  tops out at `opus`, so the claim route applies it after the router
  (`roleTierOverride`), not through `mapRouterAlias`, which would give
  `premium`.
- `tasks.tier`, when set, overrides the router's computed tier and any role
  floor — the budget and spike downshifts are discarded — but the 95%
  **pause** still applies, because it returns before the tier lookup.
- `mapRouterAlias` is total: `opus→premium`, `haiku→budget`, anything else
  (including `sonnet` and any unknown string) `→standard`
  (`packages/core/model-tier-registry.ts`). Role tier values round-trip
  without drift: `premium→opus→premium`.
- The `create_task` response's `routing` preview (`computeRoutingPreview`,
  `packages/core/task-routing-preview.ts`) follows the same precedence for the
  **stated** role, using the same helpers, and its `reason` names a role floor
  that raised the tier or a role exact-id pin. A role-less task in a workspace
  with at least two inference candidates gets the note `no role given — one
  may be inferred after creation; an inferred role does not change the model`.
- The only non-claimable routing outcome is `'paused'`. The task is left
  `pending` — never failed, never given a `start_at` floor — and
  `diagnostics.deferrals.routing_paused` increments (`route.ts`).
- `tasks.tier` is write-once: `POST /api/tasks` accepts it
  (`apps/web/src/app/api/tasks/route.ts`) and `PATCH /api/tasks/[id]`
  carries no `tier` branch, matching the schema comment at
  `packages/core/db/schema.ts`.
- Budget pressure is one `dailyBudgetPct` input, `totalCost / maxCostPerDay`
  for API-key accounts (`route.ts`). A subscription login has no server-side
  pressure: buildd keeps no model of a subscription (spec `parallelism-limits`
  R-9), so its gates never fire on one.

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
- AC-22: GIVEN role `email-agent` configured with `model='claude-sonnet-5'`
  AND a task routed to it with `tier='premium'` WHEN a runner claims THEN
  `tasks.predicted_model` is the premium tier's model, not `claude-sonnet-5`.
- AC-23: GIVEN role `builder` with `model='opus'` AND a task routed to it with
  `context.roleInferred` set WHEN a runner claims THEN the floor does not apply
  and an `engineering/simple` task resolves to the budget tier.
- AC-24: GIVEN workspaces A and B each overriding `builder` with a different
  `model` WHEN a runner serving both claims a task in A THEN A's row sets the
  floor.
- AC-4 (failure path): GIVEN `dailyBudgetPct >= 0.95`, a task whose `kind` is
  not `coordination`, and `priority = 0` WHEN a runner claims THEN no worker is
  created for that task, the task stays `pending`, and
  `diagnostics.deferrals.routing_paused` is `1`.
- AC-5: GIVEN the same 95% pressure and `kind='coordination'` WHEN the router
  runs THEN it returns `sonnet` with `reason: 'budget_downshift'` — coordination
  is never paused.

**Code surface**: `packages/core/model-router.ts`
(`BASELINE`, `TIER_ORDER`, `downshift`, `resolveEffectiveModel`),
`packages/core/role-model-routing.ts` (`pickRoleRowForTask`,
`resolveClaimModelInputs`), `packages/core/task-routing-preview.ts`
(`computeRoutingPreview`),
`apps/web/src/app/api/workers/claim/route.ts`,
`packages/core/db/schema.ts` (`tasks.kind`, `complexity`, `tier`,
`predictedModel`, `classifiedBy`),
`packages/core/__tests__/model-router.test.ts`,
`packages/core/__tests__/role-model-routing.test.ts`,
`apps/web/src/app/api/workers/claim/route.test.ts` (`describe('smart model
routing')` including `role model precedence`, and the OAuth-pressure block).

**Out of scope**: which *backend process* executes the task
(`provider-failover`), and per-task `effort` / `thinking` / `maxTurns`
resolution, which the runner reads from task context and workspace gitConfig
(`apps/runner/src/workers.ts`).

---

## Tier registry resolution

**Capability statement**: `premium-plus`/`premium`/`standard`/`budget` MUST
resolve to a concrete `(provider, model)` through one resolver — the
standalone model policy (`docs/specs/model-policy.md`) over the team's registry
— so retargeting a tier is a row write, not a deploy.

**Invariants**:
- `resolveTierEntry(tier, teamId, workspaceId, surface)` loads the team's
  `model_tier_registry` rows as a `ModelPolicy` (`registryModelPolicy`,
  `packages/core/model-policy.ts`: team rows → `tiers`, team surface rows →
  `surfaces`, workspace rows → `overrides`) and resolves it with the kit's
  `pickRoute`: workspace+surface → workspace → team+surface → team. A tier the
  registry leaves unset goes to the policy service when one is configured
  (`BUILDD_MODEL_POLICY_URL`/`_TOKEN`; `source: 'policy'`), then the catalog
  pick, then the bundled policy (`TIER_DEFAULTS`, derived from
  `DEFAULT_MODEL_POLICY`). The entry carries `source` and `policy`
  (`version`, `planId`, decision layer, surface). `agent` resolves as the
  protocol's `coding`, `chat` as `chat`.
- No call site indexes `TIER_DEFAULTS` or reads registry rows to pick a model
  on its own (`packages/core/__tests__/model-policy-authority.test.ts`); code
  defaults come from `bundledTierEntry`. An exact model id pin is the one
  escape hatch; a shorthand pin (`opus`/`sonnet`/`haiku`) is a tier request
  (`shorthandPinTier`).
- At most one row exists per `(team_id, workspace_id, tier)` — enforced by the
  `model_tier_registry_unique` index (`packages/core/db/schema.ts`). The
  API upserts by explicit read-then-write because `workspace_id IS NULL` does
  not participate in a plain `ON CONFLICT` match
  (`apps/web/src/app/api/model-tiers/route.ts`).
- A team's rows (its policy document) are cached in-process for 60s keyed by
  team; every registry write calls `invalidateTierCache`, which flushes that
  team. A tier change therefore reaches already-queued tasks within one cache
  window.
- A registry read failure or a policy-service outage MUST NOT block dispatch:
  `resolveTierEntry` swallows the DB error, and a failed service resolve backs
  off for 30s and serves its last good answer (no planId), then the catalog
  and the bundled policy. `resolveTierEntrySync` is the bundled answer with no
  DB dependency, for contexts that cannot await.
- All three `TIER_DEFAULTS` entries are `provider: 'anthropic'`
  (`packages/core/model-tier-defaults.ts`), so the last-resort fallback
  never routes a team to a provider it has not configured.
- Single-shot structured inference resolves the *same* registry rather than
  keeping its own model list, and rejects a tier whose provider is an agent
  backend: `provider === 'openai-codex'` returns
  `{ kind: 'unsupported_provider' }` (`packages/core/inference-client.ts`).
- `GET /api/models` MUST answer with the team's tier models even with no stored
  Anthropic credential, and MUST distinguish "catalog unknown" from "catalog
  empty" via `catalogComplete`. A stale-pin warning MUST NOT fire unless the
  catalog is complete (`apps/web/src/app/api/models/route.ts`,
  `apps/web/src/components/ModelPicker.tsx`).

- Who writes it: a team admin (`manage_model_tiers`) picks each tier's
  primary model and the upgrade policy, Automatic (`latest-compatible`) or
  Manual. Everything that routes traffic beyond the primary (tier pools, the
  dial, the `soak` upgrade mode) is a platform operator control
  (`isPlatformOperatorCaller`, `apps/web/src/lib/admin/platform-operator-caller.ts`): its writes
  refuse a team admin with 403 and Settings › Models renders it only for an
  operator. A stored `soak` policy keeps working.

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
- AC-21 (failure path): GIVEN a team admin who is not a platform operator
  WHEN they `PUT /api/model-tiers/policy` with `mode: 'soak'` THEN 403 and the
  stored policy is unchanged; `latest-compatible` and `manual` save.

**Code surface**: `packages/core/model-tier-registry.ts`
(`resolveTierEntry`, `resolveAllTiers`, `invalidateTierCache`,
`resolveTierEntrySync`, `mapRouterAlias`),
`packages/core/model-policy.ts` (`registryModelPolicy`, `resolveRegistryTier`,
`resolveRemoteTier`),
`packages/core/model-tier-defaults.ts` (`TIER_DEFAULTS`, `bundledTierEntry`, `TierEntry`),
`packages/core/db/schema.ts` (`modelTierRegistry`),
`apps/web/src/app/api/model-tiers/route.ts` (GET/POST/DELETE),
`packages/core/mcp-tools.ts` (`manage_model_tiers`),
`apps/web/src/app/api/models/route.ts`,
`packages/core/__tests__/model-tier-registry.test.ts`,
`apps/web/src/app/api/models/route.test.ts`.

**Out of scope**: which credential the resolved provider then uses — see
`credential-isolation` and `docs/credentials-architecture.md`.

---

## Alias vocabulary and refresh

**Capability statement**: The three short names `haiku`/`sonnet`/`opus` MUST
mean the tier they name, read from the model policy, so no second table of
model ids can drift from the tier registry.

**Invariants**:
- The alias vocabulary is exactly `{haiku, sonnet, opus}`. `DEFAULT_ALIASES`
  maps each to the bundled policy's tier model (`budget`, `standard`,
  `premium` through `bundledTierEntry`), not to a literal id
  (`packages/core/model-aliases.ts`).
- Routing never reads an alias store. The old resolvers (`resolveModelName`,
  `resolveModelNameSync`) had no reachable caller and were deleted. The global
  `system_cache` row keyed `model_aliases` is an operator-visible record that
  only `updateModelAliases` writes and nothing reads back.
- `updateModelAliases` classifies candidates by substring on the model id
  (`includes('haiku')`, `'sonnet'`, `'opus'`) and writes **nothing** when no
  candidate matches any family — an empty write would blank the row
  (`model-aliases.ts`). Later candidates overwrite earlier ones within
  the same family, so list order decides.
- `POST /api/admin/refresh-model-aliases` is a platform-operator route: it
  admits only an admin-level `bld_` key whose account id is listed in
  `BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`, returns HTTP 403 for any other key (and
  for every key when the variable is unset) and HTTP 401 for an unauthenticated
  caller (`apps/web/src/lib/platform-admin.ts`, `authorizePlatformAdmin`).
  Omitted aliases keep their `DEFAULT_ALIASES` value.
- Effort and thinking must stay compatible with the resolved id:
  `requiresThinkingEnabled` matches `claude-opus-5`, and
  `resolveEffectiveThinking` drops a `thinking: { type: 'disabled' }` override
  at `xhigh`/`max` effort rather than letting the API return 400
  (`model-aliases.ts`).
- The role/skill picker is tier-first: legacy `opus`/`sonnet`/`haiku` values are
  normalised to `premium`/`standard`/`budget` on mount and written back, and a
  tier value is never reported as a stale pin
  (`apps/web/src/components/ModelPicker.tsx`).

**Acceptance criteria**:
- AC-11: WHEN `DEFAULT_ALIASES` is read THEN `haiku`, `sonnet` and `opus`
  equal `bundledTierEntry('budget')`, `bundledTierEntry('standard')` and
  `bundledTierEntry('premium')` models.
- AC-12 (failure path): GIVEN an API key whose `level` is not `admin`, or an
  admin-level key not listed in `BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`, WHEN
  `POST /api/admin/refresh-model-aliases` is called THEN the response is HTTP
  403 and `updateModelAliases` is not called.
- AC-13: GIVEN `{ opus: 'claude-opus-4-8' }` as the request body WHEN the
  refresh route runs THEN `updateModelAliases` receives an entry with
  `value: 'claude-opus-4-8'` and the untouched `sonnet` default.
- AC-14: WHEN `resolveEffectiveThinking('claude-opus-5', 'max', { type:
  'disabled' })` is called THEN it returns `undefined`.

**Code surface**: `packages/core/model-aliases.ts`
(`DEFAULT_ALIASES`, `updateModelAliases`, `requiresThinkingEnabled`, `resolveEffectiveThinking`),
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
- `scripts/lint-model-ids.ts` (a `bun`-run TypeScript tokenizer, not a
  line-based `grep`) runs in CI on every build
  (`.github/workflows/build.yml`) and exits non-zero when a model-id
  literal matching `claude-(haiku|sonnet|opus|fable|mythos)-[0-9]`,
  `claude-[0-9]`, `gpt-[0-9]` or `o[0-9]-(mini|preview)` appears in a
  `.ts`/`.tsx` file outside the allowlist. It walks each file tracking
  comment/string/template-literal state so a model id inside a line comment,
  a block comment, or JSDoc is never flagged — only code, string literals,
  and template literals (including `${...}` interpolations) are matched.
  Test files (`__tests__`, `.test.`, `.spec.`) are excluded entirely.
- The allowlist is a declared list of exact file paths with a stated reason
  per entry (`scripts/lint-model-ids.ts`); a directory prefix or a
  non-`.ts`/`.tsx` entry is rejected at lint time. The registry, defaults,
  pricing, capability-requirements, MCP help-text, the QA judge and the
  runner UI list are the sanctioned homes for literals.
- Cost accounting classifies an id by substring rather than by exact match, so
  an unknown id degrades to the Sonnet rate instead of to zero:
  `priceForModel` (`packages/core/model-prices.ts`).

**Acceptance criteria**:
- AC-15 (failure path): GIVEN a new literal `claude-opus-5` added to
  `packages/core/mission-helpers.ts` WHEN `bun run scripts/lint-model-ids.ts`
  runs THEN it exits 1 and prints that file and line. GIVEN the same literal
  appears only inside a comment or JSDoc WHEN the check runs THEN it exits 0 —
  a model id in prose cannot retarget a tier and is not what this gate exists
  to prevent (`scripts/lint-model-ids.ts --self-test` proves both directions).

**Code surface**: `scripts/lint-model-ids.ts`, `.github/workflows/build.yml`,
`packages/core/model-prices.ts`,
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
  (`apps/web/src/app/api/workers/[id]/route.ts`).
- The row's `outcome` is the task's FINAL status, not the one the worker
  reported: a contract guard or a completion-policy slot (loop exhausted,
  release failed) that fails a reported completion records `failed`. A release
  held for CI records nothing from the worker PATCH; the PATCH keeps the row on
  `tasks.context.heldReleaseOutcome`, and the release PR's CI resolution
  records it with the release's outcome
  (`apps/web/src/lib/routing-analytics-subscribers.ts`).
- The row copies `kind`, `complexity`, `classified_by` and `predicted_model`
  from the task row rather than trusting the caller
  (`packages/core/routing-analytics.ts`).
- A task with a NULL `predicted_model` never went through the router and MUST
  NOT produce a row (`routing-analytics.ts`).
- The write is best-effort telemetry: every failure is swallowed, reported via
  `reportOps`, and returns `false` — it MUST NOT block the worker status update
  (`routing-analytics.ts`).
- `recordTaskOutcome` reads the task through a raw `sql` template, never the
  Drizzle query builder, because the `tasks` relations emit a `workers`
  reference with no FROM clause (`routing-analytics.ts`, pinned by
  `packages/core/__tests__/routing-analytics.test.ts`).
- `GET /api/cron/routing-calibration` is read-only, requires
  `Authorization: Bearer $CRON_SECRET`, and returns HTTP 401 on a mismatch and
  HTTP 500 when `CRON_SECRET` is unset
  (`apps/web/src/app/api/cron/routing-calibration/route.ts`). Being
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
`packages/core/db/schema.ts` (`taskOutcomes`),
`apps/web/src/app/api/workers/[id]/route.ts`,
`apps/web/src/app/api/cron/routing-calibration/route.ts`,
`cron-manifest.json` (`Buildd: Routing Calibration`, `enabled: false`),
`packages/core/__tests__/routing-analytics.test.ts`.

---

## Verification gaps

Unguarded claims and live drift found while writing this spec, re-checked
against the code on dev. A finding marked **Fixed** stays so the history reads;
it names what closed it.

**Fixed: the resolved model reaches the SDK.** The runner runs on the model the
claim route resolved: `resolveSessionModel` (`apps/runner/src/prompt-builder.ts`)
prefers `task.context.model` over the runner-global `config.model`, with
`BUILDD_HONOR_TASK_MODEL=0` as the kill switch. Still open: the `roleConfig.model`
field the claim payload carries is not read by the runner.

**Fixed: `task_outcomes.downshifted` reads full model ids.** `detectDownshift`
maps the stored `predicted_model` through `normalizeToTier`, so a resolved full
id, a tier name and a bare alias all compare, and the baseline table is
imported from `model-router.ts` (`BASELINE`) instead of a local copy
(`packages/core/routing-analytics.ts`).

**The calibration loop is still dark.** The job is `enabled: false` in
`cron-manifest.json`, so it never runs on a schedule. Its `overshoots` flag
tests `predictedModel === 'opus'` (`routing-calibration/route.ts`), which
cannot match a full model id, so that flag is unreachable even if the job ran.
No code consumes the route's response. Fixed since: the worker PATCH route now
passes `actualModel` into `recordTaskOutcome`, so predicted-vs-actual has data.

**Fixed: `kind` and `complexity` reach the matrix.** `POST /api/tasks` reads
both (`apps/web/src/app/api/tasks/route.ts`), and MCP `create_task` takes them
and rejects out-of-vocabulary values instead of dropping them. A task filed
without them still routes as `engineering/normal`.

**Fixed: the alias resolvers are gone.** `resolveModelName` and
`resolveModelNameSync` had no reachable caller and were deleted;
`updateModelAliases` is called only by the operator refresh route, and the
module docstring now says so (`packages/core/model-aliases.ts`).

**Fixed: global model-alias writes are operator-gated.** The refresh route runs
`authorizePlatformAdmin` first (AC-12, pinned by the route's `route.test.ts`).
Still open: the alias-refresh response reports aliases that the write may have
silently dropped: `{ opus: 'claude-fable-5' }` returns
`aliases.opus = 'claude-fable-5'` while `updateModelAliases` classifies by
substring and stores no `opus` key at all.

**Tier-registry reads and writes do not assert team membership.** The invariant
is that a caller MUST be a member of the team whose tier registry it reads or
writes, and a caller failing that check MUST be rejected rather than served. No
test asserts it. Specifics are tracked privately until the guard lands.

**Registry fields that are stored but never consumed.** `defaultEffort` and
`defaultMaxTurns` round-trip through the API, the schema, and `TierEntry`
(`packages/core/model-tier-registry.ts`) but no dispatch path reads them:
the claim route takes only `entry.model`, `entry.provider`, `entry.source`
(`route.ts`).

**Tier provider and task backend are never reconciled.** A tier row may be
`provider: 'openai-codex'` or `'openrouter'`
(`apps/web/src/app/api/model-tiers/route.ts`) while `tasks.backend` is
`claude`. The claim route reads `entry.provider` only to stamp
`context.resolvedTier`, and rejects nothing. The docstring claim that "dispatch
throws a clear error if dispatched" (`model-tier-registry.ts`) has no
implementing code. `provider-failover` owns `dispatchable: false` for backends;
nothing applies an equivalent rule to tier providers.

**Role tier values are handed to the SDK verbatim as subagent models.** After
the picker normalises a role to `premium`/`standard`/`budget`, that string is
passed through the claim payload into `agents[slug].model`
(`apps/runner/src/workers.ts`) with no translation to a model id or to the
SDK's own alias vocabulary.

**`scripts/lint-model-ids.ts` history.** The directory-prefix allowlist bug
(`apps/web/src/app`, which suppressed every violation under the entire web
app) and the missing `gpt-5*`/`o[0-9]-*` pattern coverage were both fixed at
C30 — see the file's own header comment. As of the 2026-09 tokenizer rewrite,
the allowlist is enforced as exact `.ts`/`.tsx` file paths (a directory entry
or non-source-file entry is a lint-time error, not a silent no-op), and the
`apps/web/src/lib/config-helpers.ts` entry is current — that file's model
dropdown options are real literals, not stale.

**Model ids in the fallbacks.** Fixed: `TIER_DEFAULTS` and `DEFAULT_ALIASES`
no longer hold literal ids; both read the bundled model policy through
`bundledTierEntry` (`packages/core/model-tier-defaults.ts`), and
`priceForModel` has a `fable` branch.

**Untested invariants in this spec.** No test covers: the claim route's
tier-registry path (the routing tests all run with no `teamId` and assert the
alias fallback, `apps/web/src/app/api/workers/claim/route.test.ts`);
`tasks.tier` overriding a budget downshift; `tasks.tier` immutability under
`PATCH /api/tasks/[id]`; `context.resolvedTier` contents; `/api/model-tiers`
authorisation or upsert semantics; the routing-calibration aggregate.
(`scripts/lint-model-ids.ts` covers itself via `--self-test`, run in CI
before the real scan — see `Model-id containment` above.)

**Silent rejection of an invalid tier.** Both creation paths drop an
unrecognised `tier` instead of returning HTTP 400 —
`apps/web/src/app/api/tasks/route.ts` and
`packages/core/mcp-tools.ts`, so `tier: 'ultra'` yields a task that
silently routes at `standard`.

**Fixed: comment drift in the seeded roles.** The header of
`apps/web/src/lib/default-roles.ts` now names Organizer as Sonnet and says the
role `model` is the claim-time floor that the matrix moves off only for tasks
carrying `kind` / `complexity`.

Renumbered: AC-3a to AC-22, AC-3b to AC-23, AC-3c to AC-24.
