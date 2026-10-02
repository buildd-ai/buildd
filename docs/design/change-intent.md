---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "change-intents-table"
    type: "symbol"
    name: "changeIntents"
    path: "packages/core/db/schema.ts"
  - id: "migration-slot-reservation"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/migration-slot"
    file: "apps/web/src/app/api/workspaces/[id]/migration-slot/route.ts"
  - id: "change-intent-tests"
    type: "test_file"
    path: "apps/web/src/lib/change-intent.test.ts"
---

# change-intent

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/change-intent.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
