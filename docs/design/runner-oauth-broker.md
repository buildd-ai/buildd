---
status: superseded
superseded_by: docs/specs/credential-refresh-lifecycle.md
superseded_on: "2026-09-15"
superseded_reason: >-
  Both phases shipped: runnerRefreshCredential (Phase 1, apps/runner/src/credential-refresh.ts),
  the lock/commit/revoke/release/bootstrap endpoint (POST /api/runner/credential-refresh),
  pendingCredentialRefreshes announcement on every claim poll, and the Phase 2 broker with
  Postgres-backed credential_leases (apps/runner/src/broker.ts, /api/runner/credential-lease).
  The contract this design argued for is now the active spec, including the rotationStartedAt
  lost-rotation detection this document's own inline corrections describe.
assertions:
  # Current state — control-plane refresh (what this design replaced). Still pass, unchanged.
  - id: codex-token-refresh-cron-route
    type: route
    method: GET
    path: /api/cron/codex-token-refresh
    file: apps/web/src/app/api/cron/codex-token-refresh/route.ts
  # Phase 1 targets — shipped; skip_until suppressions lifted now that each passes.
---

# runner-oauth-broker

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/runner-oauth-broker.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
