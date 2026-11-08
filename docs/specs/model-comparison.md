---
title: Model Comparison
status: active
owner: max
last_verified: 2026-11-08
summary: The model comparison MUST label production data observational, keep controlled replay runs apart, report unknowns as unknown, decline small samples, and never promote a model.
domain: surfaces
surfaces: [packages/core/model-comparison.ts, packages/core/local-eval.ts, apps/web/src/app/api/model-comparison/route.ts, apps/web/src/app/app/(protected)/settings/models/comparison/page.tsx]
related: [model-routing-and-tiers, settings-models, mcp-action-contracts]
keywords: [model observations, model comparison, get_model_comparison, matched pairs, benchmark priors, small sample, minimum n]
verified_by: [packages/core/__tests__/local-eval.test.ts, scripts/local-eval/local-eval.test.ts, apps/web/src/app/api/model-observations/replay/route.test.ts, packages/core/__tests__/model-comparison.test.ts, packages/core/__tests__/mcp-tools-model-comparison.test.ts, apps/web/src/app/api/model-comparison/route.test.ts, apps/web/src/app/app/(protected)/settings/models/comparison/ModelComparisonView.test.tsx]
supersedes: []
assertions:
  - id: "compare-quality"
    type: "symbol"
    name: "compareQuality"
    path: "packages/core/model-comparison.ts"
  - id: "min-resolved"
    type: "symbol"
    name: "MIN_RESOLVED"
    path: "packages/core/model-comparison.ts"
  - id: "comparison-route"
    type: "route"
    method: "GET"
    path: "/api/model-comparison"
    file: "apps/web/src/app/api/model-comparison/route.ts"
  - id: "mcp-action"
    type: "config_key"
    key: "get_model_comparison"
    file: "packages/core/mcp-tools.ts"
  - id: "replay-rules"
    type: "symbol"
    name: "scoreRun"
    path: "packages/core/local-eval.ts"
  - id: "replay-route"
    type: "route"
    method: "POST"
    path: "/api/model-observations/replay"
    file: "apps/web/src/app/api/model-observations/replay/route.ts"
  - id: "comparison-core-test"
    type: "test_file"
    path: "packages/core/__tests__/model-comparison.test.ts"
---

# Model Comparison

**Capability statement**: A workspace member can compare models and setups on the
workspace's own work, from per-attempt model observations, without the page or the
API ever choosing or promoting a model.

It extends the experiment readout (`wilsonInterval` and `newcombeInterval` in
`packages/core/experiment-readout.ts`); it is not a second analytics system.

## Invariants

- Every response says `autoPromote: false`. Nothing here writes routing, a tier or a default.
- Quality and delivery come from independent records (`correctnessOf`): review, CI, spec verdict, merge. A worker's own completion is never an input.
- A completed attempt with no independent record counts as unknown, outside every denominator.
- A missing metric is unknown, never zero. Cost is the sum of known costs only, with the count of attempts that had none.
- Production data is labelled `observational`. Same-task pairs are labelled `matched_observational`. Neither is called controlled; controlled comparisons are experiment readouts.
- A comparison needs `MIN_RESOLVED` attempts with a recorded result on both sides and a Newcombe interval that excludes zero. Otherwise the verdict is `insufficient_n` or `no_detectable_difference`. A matched comparison needs `MIN_DISCORDANT_PAIRS` pairs with different results.
- Controlled replay runs (past, already-fixed bugs replayed with identical prompt, budgets and context per model) carry `evaluation` attribution (suite, case, trial, configuration) and are reported only under `replay`, never in a production rate or pair. They are labelled `controlled_replay`, and every case records that public history may be in a model's training data. The replay verdict is `not_computed`.
- A replay case is admitted only after its hidden regression failed on the pre-fix tree and passed on the reference fix. The agent gets the problem text and a one-commit, no-remote export of the pre-fix tree; hidden tests and reference patches stay outside it and are injected after the run. Any edit that disables, deletes or weakens a test makes the run `invalid`, and exact patch equality is never required.
- External benchmark priors are returned in their own block and feed no rate or verdict.
- Access follows workspace access: a workspace the caller cannot reach answers 404 like one that does not exist.

## Acceptance criteria

- AC-1: GIVEN a configuration with 5 attempts supported and another with 5 contradicted WHEN compared THEN the verdict is `insufficient_n` and no difference is returned.
- AC-2: GIVEN completed attempts with no review, CI, spec or merge record WHEN summarised THEN quality `n` is 0, the rate is null and they are counted as unknown.
- AC-3: GIVEN attempts without a cost WHEN summarised THEN `knownUsd` is null, not 0.
- AC-4: GIVEN a task attempted under two setups with different results in at least `MIN_DISCORDANT_PAIRS` tasks WHEN matched THEN a verdict is returned from a Wilson interval on the share favouring one setup; with fewer the verdict is `insufficient_n`.
- AC-5: WHEN `GET /api/model-comparison` is called for a workspace the caller cannot access THEN it returns 404 and reads no rows.
- AC-6: WHEN the MCP action `get_model_comparison` is called with an unknown window THEN it returns an error without calling the API.
- AC-7: GIVEN benchmark priors for a listed model WHEN the comparison is built THEN they appear only under `priors`.
- AC-8: WHEN the page renders an unrecorded value THEN it reads "Not recorded", with no zero and no em dash.
- AC-9: GIVEN replay runs and production attempts WHEN the comparison is built THEN production figures exclude the replay rows and `replay` lists per-configuration, per-case trials and passes.
- AC-10: GIVEN two configurations replayed on one case WHEN ingested THEN both rows share the case's chain, and re-sending a run updates its one row.
- AC-11: WHEN a replay run is graded THEN a skipped, deleted or assertion-weakened test, a runner edit, or any leak of hidden material makes it `invalid`, and a harness failure is `error`, not a model failure.
- AC-12: WHEN `POST /api/model-observations/replay` is called for a workspace the key cannot reach THEN it returns 404 and writes nothing.

## Code surface

- `packages/core/model-comparison.ts`: `buildModelComparison`, `compareQuality`, `matchedComparisons`, `filterRows`
- `apps/web/src/app/api/model-comparison/route.ts`, `apps/web/src/lib/model-comparison-query.ts`
- `packages/core/local-eval.ts`, `scripts/local-eval/`, `eval/local-suite/v1/`, `POST /api/model-observations/replay`; runbook `docs/local-model-evaluation.md`
- `get_model_comparison` in `packages/core/mcp-tools.ts`
- `apps/web/src/app/app/(protected)/settings/models/comparison/`

## Out of scope

Randomised evaluation, promoting a model, editing routing, and bundling benchmark scores.
