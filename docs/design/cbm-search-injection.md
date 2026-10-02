---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "injector"
    type: "symbol"
    name: "CbmInjector"
    path: "apps/runner/src/cbm-injection.ts"
  - id: "graph-client"
    type: "symbol"
    name: "CbmGraphClient"
    path: "apps/runner/src/cbm-graph-client.ts"
  - id: "trigger-extraction"
    type: "symbol"
    name: "classifyBashSearch"
    path: "apps/runner/src/bash-classify.ts"
  - id: "decision"
    type: "symbol"
    name: "CBM_INJECTION_DECISION"
    path: "packages/core/cbm-injection-decision.ts"
  - id: "aggregate"
    type: "symbol"
    name: "aggregateCbmInjection"
    path: "apps/web/src/lib/cbm-insight.ts"
---

# cbm-search-injection

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cbm-search-injection.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
