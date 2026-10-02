---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "canonical-seed"
    type: "symbol"
    name: "seedFromCanonical"
    path: "apps/runner/src/cbm-bootstrap.ts"
  - id: "canonical-db-name"
    type: "symbol"
    name: "deriveCbmDbName"
    path: "apps/runner/src/cbm-bootstrap.ts"
  - id: "canonical-seed-called"
    type: "symbol_reachable"
    symbol: "seedFromCanonical"
    entry: "apps/runner/src/cbm-bootstrap.ts"
    as: "read"
---

# cbm-v2-warm-start

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cbm-v2-warm-start.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
