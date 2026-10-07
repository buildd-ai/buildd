---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "predict-task-area"
    type: "symbol"
    name: "predictTaskArea"
    path: "packages/core/task-area-prediction-source.ts"
  - id: "task-area-config-resolution"
    type: "symbol"
    name: "resolveTaskAreaConfig"
    path: "packages/core/task-area-prediction.ts"
  - id: "task-area-events-table"
    type: "symbol"
    name: "taskAreaPredictionEvents"
    path: "packages/core/db/schema.ts"
  - id: "task-area-events-migration"
    type: "migration"
    number: "0000"
    contains: "task_area_prediction_events"
  - id: "claim-route-injects-prediction"
    type: "symbol_reachable"
    symbol: "predictTaskArea"
    entry: "apps/web/src/app/api/workers/claim/context-injection.ts"
  - id: "runner-reads-area-hint"
    type: "symbol_reachable"
    symbol: "readTaskAreaHint"
    entry: "apps/runner/src/task-memory-retrieval.ts"
  - id: "task-area-readout-cli"
    type: "test_file"
    path: "packages/core/__tests__/task-area-readout.test.ts"
  - id: "task-area-source-tests"
    type: "test_file"
    path: "packages/core/__tests__/task-area-prediction-source.test.ts"
  - id: "claim-injection-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/task-area-injection.test.ts"
---

# task-area-prediction

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-area-prediction.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
