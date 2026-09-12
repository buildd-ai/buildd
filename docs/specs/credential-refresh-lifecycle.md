---
title: Credential Refresh Lifecycle
status: active
owner: max
last_verified: 2026-09-09
summary: A rotating OAuth credential MUST be refreshed by one holder at a time from the runner, not the control plane, and a rotation whose outcome was never learned MUST end in one reconnect signal, not a retry loop.
domain: auth
surfaces: [apps/web/src/app/api/runner/credential-refresh/route.ts, apps/runner/src/broker.ts, apps/web/src/app/api/cron/codex-token-refresh/route.ts, packages/core/db/schema.ts]
related: [credential-isolation, auth-oauth-boundaries, codex-backend-spec]
keywords: [invalid_grant, refresh token rotation, credential_leases, rotation_started_at, refresh_locked_at, BUILDD_ALLOW_CONTROL_PLANE_REFRESH, nudge task, single-use refresh token]
verified_by: [apps/web/src/app/api/runner/credential-refresh/route.test.ts, apps/web/src/app/api/cron/codex-token-refresh/route.test.ts, apps/runner/__tests__/unit/credential-refresh.test.ts, apps/runner/__tests__/unit/broker.test.ts]
assertions:
  - id: credential-refresh-route-post
    type: route
    method: POST
    path: /api/runner/credential-refresh
    file: apps/web/src/app/api/runner/credential-refresh/route.ts
  - id: codex-token-refresh-route-get
    type: route
    method: GET
    path: /api/cron/codex-token-refresh
    file: apps/web/src/app/api/cron/codex-token-refresh/route.ts
  - id: credential-refresh-route-test
    type: test_file
    path: apps/web/src/app/api/runner/credential-refresh/route.test.ts
  - id: broker-test
    type: test_file
    path: apps/runner/__tests__/unit/broker.test.ts
supersedes: []
---

# Credential Refresh Lifecycle

**Capability statement**: For an OAuth credential whose provider rotates the
refresh token on every use, buildd MUST perform each rotation from a single
holder at the runner's stable egress IP, persist the rotated token before using
the access token it came with, and convert an unresolved rotation into exactly
one user-facing reconnect signal.

## Why this spec exists

`codex_credential` is the only purpose in this system whose provider issues
**single-use** refresh tokens: OpenAI rotates the refresh token on every call.
That single property is what makes the lifecycle hard, and every invariant below
follows from it:

- Two concurrent refreshers mean one of them presents a consumed token, so the
  credential family dies with `invalid_grant`.
- A rotation whose response is lost is **unrecoverable**. The provider has
  advanced to the next token; the database still holds the consumed one. No
  later retry can repair it — only a user reconnect can.

The second point is the one previously got wrong. An earlier design asserted
that a crash between the provider call and the write-back was safe because "the
next refresh window corrects them." For a rotating token there is no such
window: the next attempt presents a consumed token and fails identically,
forever. The system therefore needs to *detect* a lost rotation, not retry it.

## Invariants

- **INV-1 — one holder.** A rotation MUST be preceded by claiming a lock. The
  lock predicate lives on `refreshLockedAt`, never on `lastRefreshedAt`.
- **INV-2 — attempt is not success.** `lastRefreshedAt` MUST be written only
  when a rotation commits. A failed or abandoned attempt MUST NOT advance it,
  because it is the timestamp operators are shown.
- **INV-3 — rotations are marked in flight.** Claiming the lock MUST stamp
  `rotationStartedAt` if it is not already set, and committing MUST clear it.
  The stamp MUST NOT be overwritten by a later lock claim, because that erases
  the evidence that an earlier rotation was never resolved.
- **INV-4 — an unresolved rotation is terminal.** When `rotationStartedAt`
  predates the lost-rotation threshold, the stored refresh token MUST be treated
  as consumed: it MUST NOT be handed to a caller, the credential MUST move to a
  terminal health state, and the team MUST be notified once.
- **INV-5 — the marker survives ambiguity.** A failure that could have followed
  a successful provider response MUST leave `rotationStartedAt` set. Only a
  failure that provably preceded the provider issuing tokens — no response
  received, or a response that refused — may clear it.
- **INV-5a — an unused lock MUST be handed back.** A holder that claimed the
  lock and then exits *without* a successful provider response MUST release it:
  clear `rotationStartedAt` and walk `refreshLockedAt` back. This is the inverse
  of INV-5 and is equally load-bearing — an unreachable provider, a 5xx, a
  non-revoking 4xx, and an API-key credential with no refresh token to rotate all
  leave the lock held having rotated nothing. Left marked, each would be
  misread as a lost rotation by INV-4 and would destroy a working credential.
  When the runner drives the refresh, the control plane never observes the
  provider's answer, so only the runner can resolve these.
- **INV-6 — runner origin.** Post-grant token-endpoint calls MUST originate from
  the runner. Control-plane paths that call a provider token endpoint MUST be
  gated behind `BUILDD_ALLOW_CONTROL_PLANE_REFRESH`, including operator-triggered
  ones.
- **INV-7 — every action is team-scoped.** Every action on a credential MUST
  verify the credential belongs to the caller's team before acting on it or
  returning any part of it.
- **INV-8 — refresh is never delegated to an agent.** The system MUST NOT create
  a task whose body instructs a worker to perform a token exchange. An LLM
  driving the exchange can acquire the lock and lose the rotation, which by
  INV-4 destroys the credential.
- **INV-9 — discovery does not depend on work.** A runner with no claimable task
  MUST still learn which credentials it manages, so an idle runner refreshes on
  schedule. Announcement carries identifiers and expiry only, never token
  material.
- **INV-10 — unknown expiry is not healthy.** A credential with a NULL token
  expiry MUST remain eligible for the refresh sweep. Excluding it strands the
  row permanently.

## Acceptance criteria

- AC-1: GIVEN a valid API key for team A WHEN any action is invoked against a
  credential owned by team B THEN the request is rejected with HTTP 403 and no
  token material is returned.
- AC-2: GIVEN a credential with no matching row WHEN an action is invoked THEN
  the request is rejected with HTTP 404.
- AC-3: GIVEN a credential whose lock is held and unexpired WHEN a second caller
  attempts to claim it THEN the response reports the lock as unavailable and no
  provider call is made.
- AC-4: GIVEN a credential with `rotationStartedAt` older than the lost-rotation
  threshold WHEN a caller attempts to claim the lock THEN no refresh token is
  returned, the credential is marked terminal, and the response distinguishes
  this from ordinary lock contention.
- AC-5: GIVEN a rotation that received no provider response WHEN the attempt
  fails THEN `rotationStartedAt` is cleared and the lock is shortened for retry.
- AC-6: GIVEN a rotation whose provider response was received but whose commit
  failed THEN `rotationStartedAt` remains set.
- AC-6a: GIVEN a holder that claimed the lock and received no successful
  provider response WHEN it exits THEN `rotationStartedAt` is NULL and the lock
  is no longer held, and the credential's health state is unchanged.
- AC-7: GIVEN a successful rotation WHEN the commit lands THEN `lastRefreshedAt`
  advances, `rotationStartedAt` is NULL, and the token expiry moves forward.
- AC-8: GIVEN `BUILDD_ALLOW_CONTROL_PLANE_REFRESH` unset WHEN an operator invokes
  `/api/workspaces/[id]/codex-credential/refresh` THEN the request is rejected
  without calling the provider, and the response text explains that refresh is
  runner-originated.
- AC-9: GIVEN a claim poll that claims zero workers THEN the response still
  announces the caller's near-expiry credentials, scoped to the caller's team.
- AC-10: GIVEN an expiring credential and a refresh sweep WHEN the sweep runs
  with the control-plane flag unset THEN no task row is created.
- AC-11: GIVEN a credential whose token expiry is NULL WHEN the sweep runs THEN
  the credential is included rather than filtered out.

## Code surface

Route handlers:
- `/api/runner/credential-refresh` — lock / commit / revoke / bootstrap. Team
  ownership is resolved once before the action dispatch; `bootstrap` is
  additionally gated on holding an active lease.
- `/api/runner/credential-lease` — per-credential lease acquire / heartbeat /
  release, the mechanism that makes "one holder" true across runners.
- `/api/cron/codex-token-refresh` — the sweep. Observes and reports by default;
  performs provider calls only under the control-plane flag.
- `/api/workers/claim` — carries the credential announcement (INV-9).

Data model — `secrets` in `packages/core/db/schema.ts`: `refreshLockedAt`
(lock), `lastRefreshedAt` (success), `rotationStartedAt` (in-flight marker),
`tokenExpiresAt`, `healthStatus`. Leases live in `credentialLeases`.

Actions on `/api/runner/credential-refresh` are `lock`, `commit`, `revoke`,
`release` and `bootstrap`. The first four resolve team ownership before
dispatch; `bootstrap` is scoped by requiring an active lease instead.

Helpers: `refreshCodexCredential` and `refreshClaudeCredential` (control-plane,
flag-gated), `runnerRefreshCredential` (runner origin), `credentialBroker`
(lease holder and scheduler), `resolveAccountCredentialRefreshes` (announcement
scoping).

## Out of scope

- MCP connector credentials (`mcp_connector_credential`), which use standard
  OAuth 2.1 without single-use refresh tokens, and are swept by the same cron
  under different rules.
- The Claude `oauth_token` purpose, which is a static setup token verified by a
  liveness ping and never refreshed.
- Whether egress-IP rotation independently triggers provider anomaly detection.
  The runner-origin invariant (INV-6) is retained on its own merits — a single
  stable holder — but the IP causation itself is unmeasured and this spec makes
  no claim about it.
- Interactive grant and reconnect UX.
