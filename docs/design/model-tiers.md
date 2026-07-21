# Model Tiers — Premium / Standard / Budget

**Status:** Proposed
**Related:** `packages/core/model-aliases.ts`, `packages/core/model-router.ts`, `packages/core/model-prices.ts`, `packages/core/db/schema.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `docs/design/backend-failover-policy.md`

---

## Problem

Model selection in Buildd is intention-shaped — "this task needs frontier intelligence" vs. "cheap is fine" — but the platform surfaces concrete model IDs in two places that create operational friction:

1. **Tier names are vendor-coupled.** `haiku / sonnet / opus` are Anthropic product names. The router (`packages/core/model-router.ts`) outputs them; roles accept them as floors (`SkillModel = 'sonnet' | 'opus' | 'haiku' | 'inherit' | (string & {})`). Flipping the "top" tier to Fable 5 requires updating the alias map and redeploying — a code change for an ops action.

2. **Model IDs escape into routing code.** The runner startup default in `apps/runner/src/index.ts:427` is the literal string `'claude-sonnet-4-6'`. When a new model ships, this must be patched in code.

3. **No multi-provider path.** A team running tasks on OpenRouter today needs schema changes; the registry has no slot for non-Anthropic providers.

The fix is a provider-neutral tier vocabulary (`premium / standard / budget`) backed by a team-level registry in the DB. Upgrading the top tier to a new model becomes a row update, not a deploy.

---

## Proposal

### 1. Tier vocabulary

Three tiers, expressing required intelligence level, not a vendor:

| Tier | Intent | Maps to today |
|------|--------|---------------|
| `premium` | Frontier — planning, hard engineering, design | `opus` |
| `standard` | General-purpose — most engineering and research | `sonnet` |
| `budget` | Fast / cheap — classification, observation, triage | `haiku` |

**Alternatives considered:**

- `frontier / capable / economy` — too jargony for user-facing MCP params
- `high / mid / low` — underspecified; low for what?
- Keeping `opus / sonnet / haiku` — easy migration but permanently vendor-locks the vocabulary

`premium / standard / budget` wins: readable in an MCP call (`tier: "premium"`), maps naturally to price expectations, and admits non-Anthropic fill.

### 2. Registry

#### Schema — new table `model_tier_registry`

```sql
CREATE TABLE model_tier_registry (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- NULL = team-wide default; non-NULL = workspace override
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL CHECK (tier IN ('premium', 'standard', 'budget')),
  provider    TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai-codex', 'openrouter')),
  -- Anthropic/Codex: the model ID passed to the SDK (e.g. 'claude-fable-5')
  -- OpenRouter: the openrouter.ai model string (e.g. 'mistralai/mistral-large')
  model       TEXT NOT NULL,
  -- Optional per-tier defaults; NULL means inherit runner/role config
  default_effort    TEXT CHECK (default_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  default_max_turns INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, workspace_id, tier)
);
```

`provider = 'openrouter'` entries carry the OpenRouter model string in `model`; the AgentBackend implementation for OpenRouter is **out of scope** for this spec but the schema admits it today so no future migration is needed.

#### Code-level fallback defaults

Used only when the DB registry has no row for a tier (e.g. new team, cold start). Defined in the resolver module — not scattered:

```ts
// packages/core/model-tier-registry.ts
export const TIER_DEFAULTS: Record<Tier, TierEntry> = {
  premium:  { provider: 'anthropic', model: 'claude-opus-4-8' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  budget:   { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
};
```

These are the **last resort** — a team that has configured its registry never sees them.

#### Lookup at claim time

```
resolveTierEntry(tier, teamId, workspaceId):
  1. SELECT … WHERE team_id=? AND workspace_id=? AND tier=?   -- workspace override
  2. SELECT … WHERE team_id=? AND workspace_id IS NULL AND tier=?  -- team default
  3. TIER_DEFAULTS[tier]                                           -- code fallback
```

The resolver uses a 60-second in-memory cache per (team, workspace) tuple, flushed on any registry write. This prevents per-claim DB hits without stale-config risk in practice.

### 3. Resolution chain and timing

**Resolution happens at DISPATCH/CLAIM time** (`apps/web/src/app/api/workers/claim/route.ts`), not at task-creation time. This means a registry update takes effect on already-queued tasks the next time the claim loop runs — no backfill, no task restart.

Full chain (first match wins):

```
task.context.model  (explicit full model ID)
  → skip resolution entirely, pass to runner as-is

task.tier
  → role.defaultTier     (new field; falls back to tier floor implied by role.model alias)
  → workspace tier default (registry row with workspace_id)
  → team tier default      (registry row with workspace_id IS NULL)
  → 'standard'             (hardcoded last resort)

  resolved_tier → resolveTierEntry(tier, teamId, workspaceId)
               → { provider, model, defaultEffort?, defaultMaxTurns? }
```

**The `task.tier` column** is new (`TEXT CHECK (tier IN ('premium', 'standard', 'budget'))`). It is set at task-creation time from the `tier` param (MCP / API) and is immutable after that. Resolution at claim time reads it; it does not change.

**Why claim time, not creation time?** Registry rows can be updated between when a task is created and when it's claimed (e.g. the team admin swaps `premium` from Opus 4.8 to Fable 5 after filing a batch of tasks). Resolution at claim time means those already-queued tasks pick up the new model without any operator intervention. Creation-time resolution would silently lock in the stale model.

This property must be documented in the registry management UI and MCP help text so operators understand that changing a registry row affects in-flight queues.

### 4. Escape hatch

The existing `model` param on `create_task` (and `context.model` already written by runners for retry continuity) is unchanged and takes precedence unconditionally:

```
task.context.model is set AND is a full model ID (not a tier name)
  → explicitModel = task.context.model → resolveEffectiveModel passes it through as explicit_override
```

Tier and model are mutually exclusive from the caller's perspective:
- `tier: "premium"` → resolution chain
- `model: "claude-fable-5"` → bypass, use directly
- Both absent → resolution chain resolves `'standard'`
- Both set → `model` wins (log a warning; don't error so existing tooling that sets both isn't broken)

The model-router (`packages/core/model-router.ts`) is unchanged except that its output tier aliases (`haiku / sonnet / opus`) are mapped to the new vocabulary at the claim-route boundary before the registry lookup:

```
router output → tier mapping → registry lookup
'opus'    → 'premium'
'sonnet'  → 'standard'
'haiku'   → 'budget'
```

This keeps the router's internal logic stable; the vocabulary change is at the integration boundary.

### 5. Surface area inventory

Produced by:
```bash
grep -rn "claude-haiku\|claude-sonnet\|claude-opus\|claude-fable\|gpt-4\|gpt-3\." \
  --include="*.ts" --include="*.tsx" \
  . | grep -v "node_modules\|.next\|dist\|.git\|__tests__\|\.test\."
```

#### Routes through the resolver → must change

| File | Line | What | Action |
|------|------|------|--------|
| `apps/runner/src/index.ts` | 427 | `model: process.env.MODEL \|\| savedConfig.model \|\| 'claude-sonnet-4-6'` | Replace fallback literal with resolver call: `resolveTierEntrySync('standard')` — keeps env override working |

#### Tier aliases used as floors (in `SkillModel`) → grandfathered, no change needed

`SkillModel = 'sonnet' | 'opus' | 'haiku' | 'inherit' | (string & {})` on `workspace_skills.model` currently doubles as both a tier floor and an escape hatch for full IDs. Under this design:
- `'sonnet'` → treated as `tier: 'standard'` floor at claim time
- `'opus'`   → treated as `tier: 'premium'` floor at claim time
- `'haiku'`  → treated as `tier: 'budget'` floor at claim time
- Full model ID (e.g. `'claude-fable-5'`) → escape hatch, passes through as `explicitModel`

No `SkillModel` column changes are required for phase-1 implementation. A follow-up can add `'premium' | 'standard' | 'budget'` to the type once callers migrate.

#### Internal / legitimately exempt

| File | Line | What | Why exempt |
|------|------|------|-----------|
| `packages/core/model-aliases.ts` | 21–23 | Default alias map (`haiku/sonnet/opus → full IDs`) | IS the registry fallback; only entry point for alias resolution |
| `packages/core/model-prices.ts` | 41+ | Pricing table keyed by model substring | Billing, not routing; model-specific by necessity |
| `apps/web/src/app/api/qa/judge/route.ts` | 15 | `const MODEL = 'claude-haiku-4-5-20251001'` | Internal eval judge, not user-visible routing; budget model pinned intentionally for cost predictability |
| `packages/core/model-router.ts` | (all) | Router outputs `'haiku'/'sonnet'/'opus'` aliases | The router; mapped to new vocabulary at claim boundary |

#### Display-only (UI dropdowns / placeholder text) → exempt

These enumerate available concrete models for human selection and are not on the dispatch path:

| File | Lines | Notes |
|------|-------|-------|
| `apps/runner/src/index.ts` | 488–493 | Runner UI model list |
| `apps/web/src/lib/config-helpers.ts` | 15–16 | Shared model options array |
| `apps/web/src/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx` | 14–15 | Role editor dropdown |
| `apps/web/src/app/(protected)/team/new/TeamRoleForm.tsx` | 14–15 | Team role form dropdown |
| `apps/web/src/app/(protected)/workspaces/[id]/skills/SkillForm.tsx` | 13–14 | Skill form dropdown |
| `apps/web/src/app/(protected)/team/[slug]/settings/TeamRoleEditor.tsx` | 16–17 | Team role editor dropdown |
| `apps/web/src/app/(protected)/workspaces/[id]/config/GitConfigForm.tsx` | 378 | Placeholder text only |

These should be updated to also show tier-level options, but are not blocking the routing fix.

### 6. CI guard

Add a lint step to `.github/workflows/build.yml` (or a standalone `scripts/lint-model-ids.sh`) that fails if new hardcoded model-ID literals appear outside the allowlist.

**Guard script** (`scripts/lint-model-ids.sh`):

```bash
#!/usr/bin/env bash
# Fail if model-ID literals (claude-X-Y, gpt-4, etc.) appear outside the allowlist.
# Run in CI after checkout.

ALLOWLIST=(
  "packages/core/model-aliases.ts"
  "packages/core/model-prices.ts"
  "packages/core/model-tier-registry.ts"   # the resolver's fallback defaults
  "apps/web/src/app/api/qa/judge/route.ts" # internal eval judge — pinned intentionally
  "apps/runner/src/index.ts"               # UI model list (display only)
  "apps/web/src/lib/config-helpers.ts"
  "apps/web/src/app"                       # UI dropdowns broadly
)

PATTERN='claude-(haiku|sonnet|opus|fable|sonnet-5|fable-5|opus-4)-[0-9]|claude-[0-9]|gpt-4[0-9o-]|gpt-3\.5'

violations=$(grep -rn -E "$PATTERN" --include="*.ts" --include="*.tsx" \
  . | grep -v "node_modules\|.next\|dist\|.git\|__tests__\|\.test\.")

for path in "${ALLOWLIST[@]}"; do
  violations=$(echo "$violations" | grep -v "^$path" | grep -v "^\./$path")
done

if [ -n "$violations" ]; then
  echo "ERROR: hardcoded model IDs found outside allowlist:"
  echo "$violations"
  echo ""
  echo "Use tier ('premium'/'standard'/'budget') or register a new allowlist entry."
  exit 1
fi
echo "lint-model-ids: OK"
```

The allowlist entries for UI dropdown files use path-prefix matching (`apps/web/src/app`), accepting that the UI is exempt wholesale. The narrow exemptions (`model-aliases.ts`, `model-prices.ts`, `model-tier-registry.ts`, `qa/judge`) are exact file matches.

**Failure signal:** any new `.ts`/`.tsx` file that hard-codes a model version string — e.g. `'claude-sonnet-5-20260101'` — causes CI to fail and forces the author to either route through the tier system or add a justified allowlist entry.

### 7. MCP shape

#### `create_task` — new `tier` param

```ts
tier?: 'premium' | 'standard' | 'budget'
// Selects an intelligence tier resolved at dispatch time via the team registry.
// Wins over role default tier but loses to explicit `model`.
// Absent → resolution chain (role → workspace → team → 'standard').
```

Propagated identically on:
- **Scheduled task definitions** — `taskSchedules.context` stores `tier` the same way it stores `model`
- **Organizer task-creation** — the Organizer role's output schema gains a `tier` field alongside `model`; the claim route injects it at creation

#### `manage_model_tiers` — new MCP action on the `buildd` server

Recommend extending `manage_workspaces` is **rejected**: tiers are team-level config, not workspace config, and mixing them into `manage_workspaces` obscures scope. A dedicated surface is clearer.

```ts
manage_model_tiers: {
  action: 'list' | 'set' | 'delete';

  // list: returns effective registry (workspace override → team default → code fallback)
  //   required: workspaceId OR teamId
  //   returns: { premium: TierEntry, standard: TierEntry, budget: TierEntry }
  //            each entry annotated with its source ('workspace' | 'team' | 'default')

  // set: upsert a registry row
  //   required: tier ('premium'|'standard'|'budget'), provider, model
  //   optional: workspaceId (if absent → team-wide), defaultEffort, defaultMaxTurns
  //   effect: takes effect on next claim cycle (within 60s cache TTL)

  // delete: remove an override row, falling back to next level in chain
  //   required: tier
  //   optional: workspaceId (if absent → delete team default, exposing code fallback)
}
```

**`get_task` response enrichment:** the task peek includes the resolved tier entry in effect at the time of claiming, so operators can audit what model a queued task will actually run on. Stored in `tasks.context.resolvedTier: { tier, provider, model, source }`.

**`get_workspace` / `manage_workspaces` list:** include a `modelRegistry` field showing the effective tier map for the workspace, so operators can see configuration without a separate call.

### 8. Migration

**Existing tasks with `context.model` set to a full model ID** (e.g. `'claude-sonnet-4-6'`) are grandfathered as explicit overrides. The escape hatch path (`explicitModel` → `explicit_override`) is already exercised and tested. No backfill needed; these tasks skip the registry lookup.

**Existing roles with `model: 'sonnet' | 'opus' | 'haiku'`** are grandfathered as tier-floor aliases. The claim route already maps them via the `TIER_ALIASES` set (`apps/web/src/app/api/workers/claim/route.ts:720`). Under this design, `'sonnet'` → `'standard'`, `'opus'` → `'premium'`, `'haiku'` → `'budget'` for the purpose of the registry lookup. The `SkillModel` type retains these values; a follow-up can add the new vocabulary.

**Roles with `model` set to a full ID** (e.g. `'claude-fable-5'`) already hit the `roleIsFullId` path and are passed as `explicitModel`. Behaviour is unchanged.

**No backfill of `tasks.tier` on existing rows.** `tier IS NULL` means "use the resolution chain starting from the role." This is exactly the current behaviour, so NULL is the correct representation of "not set."

**Team registry rows for existing teams:** seeded with the code-level defaults on first `manage_model_tiers list` call (lazy seeding). Teams can immediately override without a migration script.

---

## Open questions

1. **Should the model-router output `premium/standard/budget` directly, or keep `opus/sonnet/haiku` internally?** This spec keeps the router output as `haiku/sonnet/opus` and maps at the claim boundary. Changing the router itself is a clean-up for implementation but not blocking. *Lean: keep router internal vocabulary unchanged; map at the boundary. Router is a pure function and tests are well-established — avoid gratuitous churn.*

2. **Cache TTL for registry reads.** 60s in-memory is proposed. A busy cluster with 10 pods means a registry change takes up to 60s to propagate on each pod. Is that acceptable? *Lean: yes — the primary use case (model upgrade) is an infrequent operator action, not real-time switching.*

3. **Should `tier` be surfaced in the task list UI?** Currently only `predictedModel` is shown. Adding a `tier` badge lets operators understand why a task got a particular model. *Lean: yes, but out of scope for this design.*

---

## Non-goals

- **AgentBackend implementation for OpenRouter** — the registry schema admits it, but the runner-side code to call OpenRouter APIs is a separate task.
- **Per-task dynamic tier changes** — tier is set at creation and immutable. Downshifting at claim time is already handled by the budget/spike gates in `model-router.ts`.
- **Backfilling `tasks.tier` on historical records** — NULL reads as "resolution chain from role," which is correct for all historical tasks.
- **Removing `haiku/sonnet/opus` from `SkillModel`** — backward-compat aliases stay until callers migrate.
- **UI for the model-tiers registry** — admin MCP action is sufficient for phase 1.
