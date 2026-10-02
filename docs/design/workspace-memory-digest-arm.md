---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "composition-record"
    type: "symbol"
    name: "buildPromptCompositionRecord"
    path: "apps/runner/src/memory-digest-policy.ts"
  - id: "digest-policy-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/memory-digest-policy.test.ts"
  - id: "randomiser-extraction"
    type: "symbol"
    name: "assignExperimentArm"
    path: "packages/core/experiment-randomizer.ts"
---

# workspace-memory-digest-arm

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/workspace-memory-digest-arm.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
