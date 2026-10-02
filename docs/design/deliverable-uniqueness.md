---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "deliverable-manifest"
    type: "config_key"
    key: "deliverableManifest"
    file: "packages/core/db/schema.ts"
  - id: "deliverable-claims-table"
    type: "config_key"
    key: "deliverable_claims"
    file: "packages/core/db/schema.ts"
  - id: "deliverable-intake-result"
    type: "symbol_reachable"
    symbol: "deliverable_claimed"
    entry: "apps/web/src/app/api/tasks/route.ts"
    as: "read"
---

# deliverable-uniqueness

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/deliverable-uniqueness.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
