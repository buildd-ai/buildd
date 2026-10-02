---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "implementation-anchor-extraction"
    type: "symbol_reachable"
    symbol: "extractImplementationAnchors"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
  - id: "spec-compare-evidence-tests"
    type: "test_file"
    path: "packages/core/__tests__/mcp-tools-spec-compare.test.ts"
---

# cbm-workspace-service

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cbm-workspace-service.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
