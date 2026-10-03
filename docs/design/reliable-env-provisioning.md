---
status: phases
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "environment-verifier"
    type: "symbol"
    name: "runEnvVerify"
    path: "apps/runner/src/env-verify.ts"
  - id: "provision-gate"
    type: "symbol"
    name: "runProvisionGate"
    path: "apps/runner/src/env-verify.ts"
  - id: "environment-verifier-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/env-verify.test.ts"
---

# reliable-env-provisioning

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/reliable-env-provisioning.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
