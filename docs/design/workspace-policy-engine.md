---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "workspace-policies"
    type: "symbol"
    name: "workspacePolicies"
    path: "packages/core/db/schema.ts"
  - id: "structured-question-decision"
    type: "config_key"
    key: "decisionRecord"
    file: "packages/shared/src/types.ts"
  - id: "policy-management-action"
    type: "symbol_reachable"
    symbol: "manage_workspace_policies"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
---

# workspace-policy-engine

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/workspace-policy-engine.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
