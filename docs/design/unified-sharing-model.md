---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "shared-connectors"
    type: "symbol"
    name: "connectorShares"
    path: "packages/core/db/schema.ts"
  - id: "workspace-connectors"
    type: "symbol"
    name: "connectorWorkspaces"
    path: "packages/core/db/schema.ts"
  - id: "connector-share-api"
    type: "route"
    method: "POST"
    path: "/api/connectors/[id]/shares"
    file: "apps/web/src/app/api/connectors/[id]/shares/route.ts"
---

# unified-sharing-model

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/unified-sharing-model.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
