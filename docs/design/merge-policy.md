---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "merge-policy-resolution"
    type: "symbol"
    name: "resolvePolicy"
    path: "apps/web/src/lib/merge-policy.ts"
  - id: "auto-merge-safety"
    type: "symbol"
    name: "evaluateAutoMergeSafety"
    path: "apps/web/src/lib/auto-merge.ts"
  - id: "reviewer-task"
    type: "symbol"
    name: "createReviewerTask"
    path: "apps/web/src/lib/reviewer.ts"
  - id: "reviewer-policy-tests"
    type: "test_file"
    path: "apps/web/src/lib/reviewer.test.ts"
---

# merge-policy

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/merge-policy.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
