> **CANCELLED — 2026-08-21**
> Anthropic cancelled the Sep 1 2026 price increase on Aug 10–11 2026. The $2/$10 rate for Sonnet 5 is
> now the permanent standard price. Do NOT action the recommendation in section 3 (scaling
> `costBudgetUsd` by 1.5×) — it was premised on a price increase that will not occur.
> Superseded by PR #1735.

---

# Sonnet 5 Pricing Cutover Plan

**Deadline**: 2026-09-01 00:00 UTC  
**Change**: Sonnet 5 intro pricing ($2 in/$10 out per MTok) → standard pricing ($3 in/$15 out per MTok)  
**PR #1072**: Shipped date-based pricing in `packages/core/model-prices.ts`

## Audit Verdicts (all 6 areas)

### 1. `model-prices.ts` — ✅ Correct as-is

`SONNET_5_INTRO_CUTOFF = new Date('2026-09-01T00:00:00Z')`, `SONNET_5_INTRO = {input:2, output:10}`,
`SONNET_5_STANDARD = {input:3, output:15}`. Boundary logic: `atDate < cutoff → intro`. Correct.

### 2. Budget forecast — ✅ Correct as-is

`getBudgetForecast` reads stored `costUsd` rows from the last 24 h and extrapolates burn rate.
It does **not** call `priceForModel` — it works entirely on already-priced DB values.
After Sep 1, as new workers complete at standard rates, the trailing window self-corrects within 24 h.
No code change needed.

### 3. Mission `costBudgetUsd` — ⚠️ Needs Max's decision

Missions set a real-dollar cap. From Sep 1, Sonnet 5 costs 50 % more per token. A mission budgeted at
$10 under intro pricing will exhaust its cap ~33 % sooner (reaches $10 after 2/3 of the original compute).

**Recommendation (do not implement without sign-off):** Review active missions with `costBudgetUsd != null`
and decide whether to scale those caps by 1.5×. Do not silently rewrite existing caps — mission owners
set them intentionally. Notify via post_note or a task before Sep 1 if action is wanted.

### 4. Model tier registry — ✅ Correct as-is

Code-level `TIER_DEFAULTS`: `premium=claude-opus-4-8`, `standard=claude-sonnet-4-6`, `budget=claude-haiku-4-5`.
The tier ordering (capability → cost) still makes sense at any pricing.

**Note for consideration:** After Sep 1, `claude-sonnet-5` at $3/$15 costs the same as `claude-sonnet-4-6`
but is strictly more capable. Worth updating the `TIER_DEFAULTS.standard` fallback (or team registry row)
to `claude-sonnet-5` at that point. Not a correctness issue — a configuration upgrade decision for Max.

### 5. Worker cost attribution — ✅ Correct as-is

`effectiveCost` is computed once at terminal status time (SDK-reported cost, or `estimateCostUsd` fallback
using `priceForModel(modelId, new Date())` at completion time). Result is stored as `costUsd` in the
`workers` table and never re-derived. Historical rows are frozen. No retroactive repricing. Correct.

### 6. UI hardcoded price strings — ✅ Clean

Grep across `apps/web/src/**/*.{ts,tsx}` found no user-visible strings containing `$2/$10`, `$2 per MTok`,
or similar hard-coded pricing. Cost display is always dynamic from the DB `costUsd` field.

### 7. Cost alerting thresholds — ✅ Correct as-is

`BUDGET_ALERT_THRESHOLDS = [50, 80, 100]` are percentage-of-budget, not dollar amounts.
They fire against `monthlyCostUsd / budgetUsd`. Pricing-agnostic — no change needed.

## Summary

No code changes required. The one item that needs Max's decision is mission `costBudgetUsd` — whether
to scale existing caps by 1.5× before Sep 1. All other consumers are correctly handling the cutover.
