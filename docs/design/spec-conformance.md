---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "evaluate-spec-documents"
    type: "symbol"
    name: "evaluateAllDocs"
    path: "packages/core/spec-conformance.ts"
  - id: "discrepancy-ledger-table"
    type: "symbol"
    name: "specDiscrepancies"
    path: "packages/core/db/schema.ts"
  - id: "checker-regression-tests"
    type: "test_file"
    path: "packages/core/__tests__/spec-conformance.test.ts"
  - id: "delta-gate-tests"
    type: "test_file"
    path: "scripts/spec-conformance-delta-gate.test.ts"
  - id: "promote-discrepancy-action"
    type: "symbol_reachable"
    symbol: "promote_discrepancy"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
  - id: "doc-fix-recheck-sweep"
    type: "symbol_reachable"
    symbol: "sweepSpecDiscrepancyRechecks"
    entry: "apps/web/src/app/api/cron/pr-reconcile/route.ts"
    as: "call"
  - id: "doc-fix-recheck-tests"
    type: "test_file"
    path: "apps/web/src/lib/spec-recheck.test.ts"
---

# spec-conformance

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/spec-conformance.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
