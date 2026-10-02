---
status: approved
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "migration-precheck"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/migrate/precheck"
    file: "apps/web/src/app/api/workspaces/[id]/migrate/precheck/route.ts"
  - id: "migration-execute"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/migrate/execute"
    file: "apps/web/src/app/api/workspaces/[id]/migrate/execute/route.ts"
  - id: "migration-repair"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/migrate/repair"
    file: "apps/web/src/app/api/workspaces/[id]/migrate/repair/route.ts"
  - id: "migration-execute-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workspaces/[id]/migrate/execute/route.test.ts"
---

# workspace-migration

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/workspace-migration.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
