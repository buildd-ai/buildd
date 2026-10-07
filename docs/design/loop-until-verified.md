---
status: implemented
assertions:
  - id: loop-config-migration
    type: migration
    number: "0000"
    contains: loop_config
  - id: parse-loop-config-symbol
    type: symbol
    name: parseLoopConfig
    path: packages/core/loop-config.ts
  - id: loop-state-assigned-in-completion-route
    type: symbol_reachable
    symbol: loopState
    entry: apps/web/src/app/api/workers/[id]/route.ts
    as: assign
  - id: workers-id-patch-route
    type: route
    method: PATCH
    path: /api/workers/[id]
    file: apps/web/src/app/api/workers/[id]/route.ts
---

# loop-until-verified

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/loop-until-verified.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
