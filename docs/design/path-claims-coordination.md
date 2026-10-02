---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "path-claim-api"
    type: "route"
    method: "POST"
    path: "/api/tasks/[id]/path-claim"
    file: "apps/web/src/app/api/tasks/[id]/path-claim/route.ts"
  - id: "path-claims-table"
    type: "symbol"
    name: "pathClaims"
    path: "packages/core/db/schema.ts"
  - id: "path-waiters-table"
    type: "symbol"
    name: "pathClaimWaiters"
    path: "packages/core/db/schema.ts"
  - id: "worker-message-tool"
    type: "symbol_reachable"
    symbol: "send_worker_message"
    entry: "apps/web/src/app/api/mcp/route.ts"
    as: "read"
---

# path-claims-coordination

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/path-claims-coordination.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
