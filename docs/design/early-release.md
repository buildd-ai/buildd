---
status: proposed
assertions:
  - id: "early-release-mode-resolver"
    type: "symbol"
    name: "resolveEarlyReleaseMode"
    path: "apps/web/src/lib/early-release-mode.ts"
  - id: "early-release-decision-tests"
    type: "test_file"
    path: "apps/web/src/lib/early-release-decision.test.ts"
  - id: "early-release-decision-kind"
    type: "symbol"
    name: "EARLY_RELEASE_KIND"
    path: "apps/web/src/lib/early-release-decision.ts"
---

# early-release

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/early-release.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
