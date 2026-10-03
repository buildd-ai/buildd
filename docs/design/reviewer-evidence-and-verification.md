---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "reviewer-patch"
    type: "symbol"
    name: "renderReviewerPatch"
    path: "apps/web/src/lib/reviewer-patch.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped and stable (T1, #2107) — renderReviewerPatch exists and is exercised by reviewer-patch.test.ts. Kept for regression coverage, not promoting the whole design to 'implemented': T3, T4, T6, T7, T8, the rest of T9a, and T9c are still unbuilt (see Handoff)."
  - id: "reviewer-patch-tests"
    type: "test_file"
    path: "apps/web/src/lib/reviewer-patch.test.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped and stable (T1, #2107) — same rationale as reviewer-patch: this design stays 'partially' until T3, T4, T6, T7, T8, the rest of T9a, and T9c land (see Handoff)."
  - id: "request-changes-verifier"
    type: "config_key"
    key: "request-changes"
    file: "apps/web/src/lib/reviewer-verify.ts"
---

# reviewer-evidence-and-verification

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/reviewer-evidence-and-verification.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
