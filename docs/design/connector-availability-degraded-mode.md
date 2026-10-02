---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "connector-routing-gate"
    type: "symbol"
    name: "checkConnectorRouting"
    path: "apps/web/src/app/api/workers/claim/connector-gate.ts"
  - id: "required-connector-opt-in"
    type: "config_key"
    key: "requiredConnectors"
    file: "packages/core/db/schema.ts"
  - id: "degraded-claim-context"
    type: "symbol_reachable"
    symbol: "degradedConnectors"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "read"
---

# connector-availability-degraded-mode

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/connector-availability-degraded-mode.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
