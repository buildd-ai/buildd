---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "workspace-release-config"
    type: "route"
    method: "PATCH"
    path: "/api/workspaces/[id]/config"
    file: "apps/web/src/app/api/workspaces/[id]/config/route.ts"
  - id: "mission-release-trigger"
    type: "symbol"
    name: "fireMissionReleaseIfComplete"
    path: "apps/web/src/lib/mission-release.ts"
  - id: "release-section"
    type: "symbol"
    name: "ReleaseSection"
    path: "apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/ReleaseSection.tsx"
---

# release-management-ui

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/release-management-ui.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
