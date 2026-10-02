---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "subject-extractor"
    type: "symbol"
    name: "extractSubjectAnchor"
    path: "packages/core/subject-anchor-extractor.ts"
  - id: "subject-claims-table"
    type: "symbol"
    name: "taskSubjectClaims"
    path: "packages/core/db/schema.ts"
  - id: "subject-claim-gate-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/subject-gate.test.ts"
---

# task-subject-anchors

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-subject-anchors.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
