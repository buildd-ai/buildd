---
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "workspace-skills-table"
    type: "symbol"
    name: "workspaceSkills"
    path: "packages/core/db/schema.ts"
  - id: "team-role-list"
    type: "route"
    method: "GET"
    path: "/api/roles"
    file: "apps/web/src/app/api/roles/route.ts"
  - id: "role-scope-tests"
    type: "test_file"
    path: "apps/web/src/app/api/roles/route.test.ts"
---

# roles-scoping

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/roles-scoping.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
