---
status: superseded
# Structural conformance only; passing does not certify every prose invariant.
superseded_by: docs/specs/credential-refresh-lifecycle.md
superseded_on: "2026-10-28"
superseded_reason: >-
  Server-side subscription-login storage and refresh was removed (seat-custody removal);
  the code surface these assertions pinned no longer exists.
assertions: []
---

# oauth-device-login

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/oauth-device-login.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
