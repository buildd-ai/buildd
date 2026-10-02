---
status: draft
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "connector-registration"
    type: "route"
    method: "POST"
    path: "/api/connectors"
    file: "apps/web/src/app/api/connectors/route.ts"
  - id: "connector-records"
    type: "symbol"
    name: "connectors"
    path: "packages/core/db/schema.ts"
  - id: "workspace-connector-bindings"
    type: "symbol"
    name: "connectorWorkspaces"
    path: "packages/core/db/schema.ts"
  - id: "connector-refresh"
    type: "symbol"
    name: "refreshMcpConnectorCredential"
    path: "apps/web/src/lib/mcp-connector-refresh.ts"
---

# generic-mcp-connectors

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/generic-mcp-connectors.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
