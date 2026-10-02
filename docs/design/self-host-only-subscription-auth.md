---
status: proposed
# Draft assertions — Tier 3 weekly cron (docs/design/spec-conformance.md §Tier 3).
# The first two assertions cite pre-existing code quoted as *evidence* in this
# doc's Problem/Current-state sections (accounts.authType as a billing mode,
# codex's subscription-only credentialPurposes) — they were already true before
# this proposal existed and will stay true regardless of whether the proposal
# ships, so they always derive `implemented` against the declared `proposed`
# status (spec-conformance.md §2 case 2). That is not doc drift: the proposal's
# actual deliverable — the enforcement gate at
# scripts/hosted-capability-boundary.test.ts and the @buildd/subscription-auth
# package split (§6-7) — has not been started, so status correctly stays
# `proposed`. Suppressed below per §2's own resolution ("add a skip_until
# suppression if the mismatch is intentional") rather than promoting status;
# `hosted-capability-boundary-gate` is left live since it is the assertion that
# actually tracks this design's progress.
assertions:
  - id: "account-auth-type-billing-mode"
    type: "config_key"
    key: "authType"
    file: "packages/core/db/schema.ts"
    skip_until: "2026-12-15"
    skip_reason: "Passes, but it cites pre-existing code (accounts.authType as a billing/limits mode) quoted as motivating evidence in the Problem section — not this proposal's deliverable. It will always pass independent of whether the package split / enforcement gate ships, so it is suppressed to keep 'proposed' from contradicting rather than promoting status unilaterally."
  - id: "codex-subscription-only-credential-purpose"
    type: "config_key"
    key: "codex_credential"
    file: "packages/core/backend-policy.ts"
    skip_until: "2026-12-15"
    skip_reason: "Passes, but it cites pre-existing code (codex's single, subscription-only credential purpose) quoted as motivating evidence in the Problem section — not this proposal's deliverable. It will always pass independent of whether the package split / enforcement gate ships, so it is suppressed to keep 'proposed' from contradicting rather than promoting status unilaterally."
  - id: "hosted-capability-boundary-gate"
    type: "test_file"
    path: "scripts/hosted-capability-boundary.test.ts"
---

# self-host-only-subscription-auth

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/self-host-only-subscription-auth.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
