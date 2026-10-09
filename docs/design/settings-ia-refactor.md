---
status: authoritative
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "personal-settings-page"
    type: "symbol"
    name: "YouPage"
    path: "apps/web/src/app/app/(protected)/you/page.tsx"
  - id: "workspace-settings-page"
    type: "symbol"
    name: "WorkspaceSettingsPage"
    path: "apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/page.tsx"
---

# settings-ia-refactor

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/settings-ia-refactor.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
