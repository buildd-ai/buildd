---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "cross-workspace-opt-in"
    type: "config_key"
    key: "crossWorkspaceDocs"
    file: "packages/core/db/schema.ts"
  - id: "readable-workspace-resolution"
    type: "symbol_reachable"
    symbol: "resolveReadableWorkspaces"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
---

# cross-workspace-retrieval

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cross-workspace-retrieval.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
