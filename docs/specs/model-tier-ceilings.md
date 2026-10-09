---
title: Model Tier Ceilings
status: active
owner: max
last_verified: 2026-10-09
summary: Every chat turn, task claim and server inference call MUST run at or below the most restrictive applicable team, workspace, admin-member and personal tier maximum, refusing explicit requests above it with policy_denied.
domain: billing
surfaces: [packages/shared/src/model-tier-ceiling.ts, packages/core/model-tier-ceiling.ts, packages/core/model-tier-ceiling-store.ts, apps/web/src/lib/tier-ceiling-check.ts]
related: [model-policy, model-routing-and-tiers, usage-and-cost-accounting]
keywords: [tier cap, tier ceiling, maximum tier, premium-plus, disable premium-plus, policy_denied, tier_policy, overCapAuto, model_tier_ceilings, personal maximum, member cap, spend band, Cap at this tier]
verified_by: [packages/core/__tests__/model-tier-ceiling.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/tasks/route.test.ts, apps/web/src/app/api/tasks/[id]/route.test.ts, apps/web/src/lib/chat/turn.test.ts, apps/web/src/app/api/chat/route.test.ts, apps/web/src/app/api/chat/[id]/route.test.ts, apps/web/src/app/api/ai/plan/route.test.ts, packages/core/__tests__/inference-client.test.ts, apps/web/src/lib/model-ceilings-api.test.ts]
supersedes: []
assertions:
  - id: resolve-tier-ceiling
    type: symbol
    name: resolveTierCeiling
    path: packages/shared/src/model-tier-ceiling.ts
  - id: enforce-tier-ceiling
    type: symbol
    name: enforceTierCeiling
    path: packages/shared/src/model-tier-ceiling.ts
  - id: enforce-model-ceiling
    type: symbol
    name: enforceModelCeiling
    path: packages/core/model-tier-ceiling.ts
  - id: load-tier-ceiling
    type: symbol
    name: loadTierCeiling
    path: packages/core/model-tier-ceiling-store.ts
  - id: claim-enforces-ceiling
    type: symbol_reachable
    symbol: tierCeilingLoader
    entry: apps/web/src/app/api/workers/claim/route.ts
    as: read
  - id: denied-by-ceiling
    type: symbol
    name: deniedByCeiling
    path: apps/web/src/lib/tier-ceiling-check.ts
  - id: tier-ceiling-core-test
    type: test_file
    path: packages/core/__tests__/model-tier-ceiling.test.ts
---

# Model Tier Ceilings

## Model tier ceilings

**Capability statement**: A team admin can cap which model tier runs, team-wide,
per workspace and per member, optionally per surface (coding agents or chat and
inference). A member can set a lower personal maximum for themselves. The server
enforces the result on every request. Hiding a choice in a picker does not count.

This is not the chat setting **New chats start at / Cap at this tier**
(`teams.chatDefaultTier`, `chatCapNewSessionTier`). That setting only picks the
tier a new conversation starts on, and the person can change it afterwards. A
ceiling is a limit the person cannot override.

### Tiers and layers

Tiers in order of cost: `budget < standard < premium < premium-plus`. A ceiling
of tier T allows T and every cheaper tier.

| Layer | Stored in | Written by |
|---|---|---|
| `team` | `teams.model_tier_ceilings.team` | team admin (`manage_model_tiers`) |
| `workspace` | `teams.model_tier_ceilings.workspaces[workspaceId]` | team admin; the workspace must belong to the team |
| `member_admin` | `team_members.model_tier_ceilings.admin` | team admin. The member cannot change it. |
| `member_self` | `team_members.model_tier_ceilings.self` | only that member. Neither an admin nor an API key can write it. |

A layer is `{ all?, agent?, chat? }`. Its cap on a surface is the lower of `all`
and that surface's own key. `agent` covers task runs (the claim route). `chat`
covers chat turns, `/api/ai/plan` and server inference.

**Effective maximum** is the lowest tier named by any layer that applies (the
most restrictive wins). If several layers name that same tier, the binding layer
reported is the first in team → workspace → member_admin → member_self order. If
no layer sets a cap, there is no ceiling and routing behaves exactly as it did
before ceilings existed.

**Disabling premium-plus** means setting a cap of `premium`. Premium-plus
remains opt-in: nothing routes to it automatically. Opting in is not the same
as being allowed to use it, though. An explicit premium-plus request is still
held against every layer.

### Explicit versus automatic

| Origin | Examples | Above the ceiling |
|---|---|---|
| explicit | `tasks.tier`, a `context.model` pin (shorthand or exact id), the stated role's model (floor or exact id), a chat pin, a plan request's `tier` | **refused** with `policy_denied`. Never downgraded. |
| automatic | the router's kind × complexity pick, an approval continuation, a server feature's tier | **downgraded to the ceiling** (default `overCapAuto: 'downgrade'`), or refused if the team set `overCapAuto: 'deny'` |

Nothing is ever raised. A fallback (the chat no-key retry, the dispatch guard's
fallback) never goes above the ceiling.

### Spend band, not just the label

A tier is a label. The model behind it is what costs money. The final served
model is checked by its **spend band**: the `TIER_PRICE_BANDS` band of its input
price (`modelSpendBand`). Above every band counts as premium-plus. The check
works the same for every provider: an OpenAI or OpenRouter model is banded by
price exactly like a Claude model. Credential source and provider do not affect
what a ceiling allows.

- If a pool arm or routing-experiment arm is priced above the ceiling, it is not
  served. The incumbent or control is served instead, with
  `eligibility.fallback = 'tier_ceiling'`.
- If the team's own registry row maps a tier label to a model priced above the
  ceiling, the run is refused (claim: held as `tier_policy`; chat: 403
  `model_above_ceiling`). With no ceiling, the claim only logs a warning when a
  label's model is priced above that label.
- An unpriced model (not in the catalog, and not a Claude id the family rule can
  band) passes, with a warning. Refusing it would block work because of a
  catalog outage the team cannot fix.

### Identity

The member layers only apply when the server knows which person the request is
for:

- **Chat**: the signed-in person.
- **Tasks**: the task's requester (`resolveTaskRequesterUserId`: the creator,
  else up the parent chain, else the mission or schedule creator).
- **`/api/ai/plan`** and **server inference** run as the team or an API key and
  never have a person.

A person is only identified for a team they are a member of. With no identified
person, only the team and workspace layers apply. The response says so
(`identified: false`), and a personal maximum is never reported as enforced
when nobody is identified.

### Ceilings and dollar budgets

A ceiling limits **which class** of model may spend. A budget limits **how
much** is spent. The budgets are the chat daily budget, the per-user daily
share, an account's `maxCostPerDay` and an app's AI budget. Both apply
independently:

- A run must pass both. Budget pressure can downshift a run (router
  `routing_paused`, plan `downgrade`). A ceiling only ever lowers or refuses.
- A per-user daily dollar budget is not a tier cap. A person with plenty of
  budget left still cannot use a tier above their ceiling. A person under their
  ceiling who has used up their budget is still refused for budget.
- A plan's budget downgrade works within the options the ceiling left. Options
  priced above the ceiling are removed before the plan decides.

### Special cases

- **Already-queued tasks, retries, failovers, schedules and missions** are all
  task rows. Each one is checked at claim, every time it is claimed. Lowering a
  ceiling holds those tasks from the next claim on. Raising it releases them.
  Held means deferred, not failed: the claim records a `claim_loop_deferral`
  gate event with reason `tier_policy`. Its `detail` is the `policy_denied`
  body. A named claim (`taskId`) returns that reason as its exclusion.
- **Persisted chat pins**: a conversation pinned to a tier before the ceiling
  was lowered is refused with 403 on its next turn, until it is unpinned or
  re-pinned lower.
- **Clearing** a tier or pin is never refused. Neither is lowering one.
- **Coding-agent-only caps** do not touch chat, and chat-only caps do not touch
  tasks.
- **An unreadable ceiling** (database error) holds the claim rather than
  assuming there is no ceiling.
- **Caching**: none across requests. A change applies on the next claim, turn
  or call on every server instance. The claim loop memoizes reads within one
  request. Teams with no member layers skip the requester lookup (the
  `membersCapped` flag).

### API

- `GET /api/teams/[id]/model-ceilings` (optional `workspaceId` query): for any member or a key
  of the team. Returns the policy, the caller's own layers (`me`; null for a
  key), and `effective.agent` / `effective.chat` with
  `{ max, binding, layers, identified, overCapAuto, explanation }`. Admins also
  get `members` and `audit`.
- `PUT /api/teams/[id]/model-ceilings` `{ team?, workspaces?, overCapAuto? }`:
  for `manage_model_tiers`.
- `PUT /api/teams/[id]/model-ceilings/members/[userId]` `{ ceilings }`: for
  `manage_model_tiers`. Sets that member's admin layer.
- `PUT /api/teams/[id]/model-ceilings/me` `{ ceilings }`: for the signed-in
  member only. Sets their self layer.

`{}` clears a layer. An unknown key or tier is a 400; it is never saved as "no
ceiling". Writes use an optimistic lock on the stored JSON, so concurrent saves
retry instead of overwriting each other. Persistent conflict returns 409. Every
change appends `{ at, by, layer, before, after }` to a bounded audit tail.

### policy_denied

```json
{ "error": "policy_denied", "code": "tier_above_ceiling" | "model_above_ceiling",
  "message": "...", "surface": "agent" | "chat",
  "requested": { "tier": "premium-plus", "origin": "task_tier", "model?": "..." },
  "maxTier": "premium", "binding": { "source": "team", "tier": "premium" },
  "remedy": "Choose premium or lower, or ask a team admin to raise the team's maximum." }
```

HTTP 403 from `POST /api/tasks`, `PATCH /api/tasks/[id]`, `POST /api/chat`,
`PATCH /api/chat/[id]`, a chat turn and `POST /api/ai/plan`. Server inference
returns `{ kind: 'policy_denied', tier, maxTier }` (only under
`overCapAuto: 'deny'`). Request-time refusals write a `tier_ceiling` gate event.

**Invariants**:

- No claimed task's served model, and no chat turn's served model, is in a spend
  band above the effective ceiling for its surface, unless its price is unknown.
- An explicit request above the ceiling is never served at a different tier. It
  is refused.
- An automatic tier is never raised by the ceiling logic.
- With no layer set, the claim, chat, plan and inference paths produce exactly
  what they produced before ceilings existed.
- A member's write cannot change `admin`, the team layer or a workspace layer.
- The member layers are never applied to a request with no identified member of
  that team.

**Acceptance criteria**:

- AC-1: GIVEN team cap `premium` WHEN a task with `tier: premium-plus` is created THEN 403 `policy_denied` with `binding.source = team` and no row is inserted.
- AC-2: GIVEN team cap `premium` WHEN a queued task pinned to `claude-fable-5-1` is claimed THEN it is not claimed and `diagnostics.deferrals.tier_policy = 1`.
- AC-3: GIVEN a member's self cap `standard` WHEN they open a chat pinned `premium` THEN 403. A `budget` pin is accepted.
- AC-4: GIVEN admin cap `budget` and self cap `premium-plus` for a member THEN their effective maximum is `budget` with `binding.source = member_admin`.
- AC-5: GIVEN workspace cap `standard` on workspace A WHEN a `premium` task runs in workspace B THEN it is claimed normally.
- AC-6: GIVEN team cap `standard` WHEN the router picks premium for a task THEN the task runs at standard and `context.tierCeiling = { from: premium, to: standard }`.
- AC-7: GIVEN team cap `standard` WHEN a routing-experiment treatment arm is premium THEN the control model is served.
- AC-8: GIVEN team cap `premium` WHEN chat's resolved model is an OpenAI model priced in the premium-plus band THEN 403 `model_above_ceiling`.
- AC-9: GIVEN self cap `budget` for a user AND a task with no resolvable requester THEN only the team and workspace layers apply.
- AC-10: GIVEN no ceilings anywhere THEN a `premium-plus` task files and claims as before.
- AC-11: WHEN a member PUTs their admin layer THEN 403. WHEN they PUT `/me` THEN only `self` changes.

**Code surface**:

- Rule (isomorphic): `packages/shared/src/model-tier-ceiling.ts`: `resolveTierCeiling`, `enforceTierCeiling`, `policyDenied`, `explainTierCeiling`, `parseSurfaceCeilings`
- Spend band and claim origin: `packages/core/model-tier-ceiling.ts`: `modelSpendBand`, `enforceModelCeiling`, `claimTierRequest`, `bandExceedsLabel`
- Store: `packages/core/model-tier-ceiling-store.ts`: `loadTierCeiling`, `tierCeilingLoader`, `writeTeamTierCeilings`, `writeMemberTierCeilings`
- Schema: `teams.modelTierCeilings`, `teamMembers.modelTierCeilings` (`packages/core/db/schema.ts`)
- Claim: `apps/web/src/app/api/workers/claim/route.ts` (`tier_policy` deferral; `explicit-deferral.ts`)
- Request-time check: `apps/web/src/lib/tier-ceiling-check.ts`: `rejectOverCeiling`, `previewUnderCeiling`. Used by `api/tasks/route.ts`, `api/tasks/[id]/route.ts`, `api/chat/route.ts`, `api/chat/[id]/route.ts`
- Chat turn: `apps/web/src/lib/chat/turn.ts` (`runChatTurn`)
- Plan: `apps/web/src/lib/ai/handlers.ts` (`handlePlanRequest`); server inference: `packages/core/inference-client.ts` (`inferenceCall`)
- API: `apps/web/src/lib/model-ceilings-api.ts`, `apps/web/src/app/api/teams/[id]/model-ceilings/route.ts` (plus `me/` and `members/[userId]/`)
