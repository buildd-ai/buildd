---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "readiness-compute"
    type: "symbol"
    name: "computeReadiness"
    path: "packages/core/workspace-readiness.ts"
  - id: "readiness-route"
    type: "route"
    method: "GET"
    path: "/api/workspaces/[id]/readiness"
    file: "apps/web/src/app/api/workspaces/[id]/readiness/route.ts"
  - id: "scaffold-route"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/onboarding/scaffold"
    file: "apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.ts"
  - id: "spec-route"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/onboarding/spec"
    file: "apps/web/src/app/api/workspaces/[id]/onboarding/spec/route.ts"
  - id: "scaffold-planner"
    type: "symbol"
    name: "planScaffold"
    path: "packages/core/onboarding-scaffold.ts"
  - id: "spec-author"
    type: "symbol"
    name: "authorSpec"
    path: "packages/core/onboarding-spec.ts"
  - id: "interview-definition"
    type: "symbol"
    name: "ONBOARDING_INTERVIEW"
    path: "packages/shared/src/onboarding-interview.ts"
  - id: "readiness-tests"
    type: "test_file"
    path: "packages/core/__tests__/workspace-readiness.test.ts"
---

# workspace-onboarding

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/workspace-onboarding.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
