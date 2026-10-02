---
status: phase
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "active-team-resolution"
    type: "symbol"
    name: "resolveActiveTeamId"
    path: "apps/web/src/lib/team-access.ts"
  - id: "workspace-filter"
    type: "symbol"
    name: "WorkspaceFilter"
    path: "apps/web/src/components/WorkspaceFilter.tsx"
---

# unified-app-ia

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/unified-app-ia.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
