---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "worktree-base-resolution"
    type: "symbol"
    name: "resolveWorktreeBase"
    path: "apps/runner/src/worktree-utils.ts"
  - id: "ci-retry-task"
    type: "symbol"
    name: "buildCIRetryTask"
    path: "apps/web/src/lib/ci-retry.ts"
  - id: "retry-worktree-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/resume-branch-fallback.test.ts"
---

# retry-continuity

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/retry-continuity.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
