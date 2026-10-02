---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "collapsed-preview"
    type: "symbol"
    name: "getArtifactCollapsedPreview"
    path: "apps/web/src/components/artifact-helpers.ts"
  - id: "summary-deduplication"
    type: "symbol"
    name: "isSummaryDuplicate"
    path: "apps/web/src/components/artifact-helpers.ts"
  - id: "artifact-preview-tests"
    type: "test_file"
    path: "apps/web/src/components/artifact-helpers.test.ts"
---

# mobile-artifact-feed

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mobile-artifact-feed.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
