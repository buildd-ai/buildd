---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "release-strategy"
    type: "symbol"
    name: "resolveReleaseStrategy"
    path: "packages/core/release-strategy.ts"
  - id: "release-executor"
    type: "symbol"
    name: "executeRelease"
    path: "apps/web/src/lib/release-executor.ts"
  - id: "workflow-run-dispatch"
    type: "symbol_reachable"
    symbol: "handleWorkflowRunEvent"
    entry: "apps/web/src/app/api/github/webhook/route.ts"
    as: "read"
---

# release-handoff-workflow

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/release-handoff-workflow.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
