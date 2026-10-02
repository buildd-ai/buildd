---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "cbm-activation"
    type: "symbol"
    name: "buildCbmActivation"
    path: "apps/runner/src/cbm-enforcement.ts"
  - id: "cbm-tool-boundary"
    type: "symbol"
    name: "CBM_BLOCKED_TOOLS"
    path: "apps/runner/src/cbm-enforcement.ts"
  - id: "cbm-bootstrap-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/cbm-bootstrap.test.ts"
  - id: "worker-activates-cbm"
    type: "symbol_reachable"
    symbol: "buildCbmActivation"
    entry: "apps/runner/src/workers.ts"
    as: "read"
---

# codebase-memory-mcp-integration

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/codebase-memory-mcp-integration.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
