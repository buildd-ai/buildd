---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "recall-handler"
    type: "symbol_reachable"
    symbol: "handleRecallAction"
    entry: "apps/web/src/app/api/mcp/route.ts"
    as: "read"
  - id: "learn-handler"
    type: "symbol_reachable"
    symbol: "handleLearnAction"
    entry: "apps/web/src/app/api/mcp/route.ts"
    as: "read"
  - id: "knowledge-tool-tests"
    type: "test_file"
    path: "apps/web/src/app/api/mcp/tools.test.ts"
---

# knowledge-tool-surface

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/knowledge-tool-surface.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
