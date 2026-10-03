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
  - id: claude-credential-refresh-symbol
    type: symbol
    name: refreshClaudeCredential
    path: apps/web/src/lib/claude-credential.ts
  - id: codex-credential-refresh-symbol
    type: symbol
    name: refreshCodexCredential
    path: apps/web/src/lib/codex-credential.ts
  - id: codex-token-refresh-cron-route
    type: route
    method: GET
    path: /api/cron/codex-token-refresh
    file: apps/web/src/app/api/cron/codex-token-refresh/route.ts
  - id: materialize-claude-config-dir-symbol
    type: symbol
    name: materializeClaudeConfigDir
    path: apps/runner/src/claude-auth.ts
  # Phase 1 targets — shipped; skip_until suppressions lifted now that each passes.
  - id: runner-refresh-credential-symbol
    type: symbol
    name: runnerRefreshCredential
    path: apps/runner/src/credential-refresh.ts
  - id: runner-credential-refresh-route
    type: route
    method: POST
    path: /api/runner/credential-refresh
    file: apps/web/src/app/api/runner/credential-refresh/route.ts
  - id: pending-credential-refreshes-reachable
    type: symbol_reachable
    symbol: pendingCredentialRefreshes
    entry: apps/web/src/app/api/workers/claim/route.ts
    as: assign
---

# runner-oauth-broker

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/runner-oauth-broker.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
