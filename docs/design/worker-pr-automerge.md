---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "auto-merge-safety"
    type: "symbol"
    name: "evaluateAutoMergeSafety"
    path: "apps/web/src/lib/auto-merge.ts"
  - id: "auto-merge-worker-pr"
    type: "symbol"
    name: "tryAutoMergeWorkerPr"
    path: "apps/web/src/lib/auto-merge.ts"
  - id: "webhook-auto-merge-tests"
    type: "test_file"
    path: "apps/web/src/app/api/github/webhook/route.test.ts"
---

# worker-pr-automerge

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/worker-pr-automerge.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
