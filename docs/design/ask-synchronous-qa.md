---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "synchronous-ask"
    type: "route"
    method: "POST"
    path: "/api/ask"
    file: "apps/web/src/app/api/ask/route.ts"
  - id: "ask-records"
    type: "symbol"
    name: "asks"
    path: "packages/core/db/schema.ts"
---

# ask-synchronous-qa

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/ask-synchronous-qa.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
