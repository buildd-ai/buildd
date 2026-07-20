# In-UI OAuth Device-Code Login for Agent Backends

**Status:** Proposed (Codex device-code flow prototyped; see Implementation status)
**Related:** `apps/web/src/lib/codex-device-auth.ts`, `apps/web/src/app/api/workspaces/[id]/codex-credential/device/{start,poll}/route.ts`, `apps/web/src/lib/codex-credential.ts`, `apps/web/src/lib/claude-credential.ts`, `apps/web/src/app/app/(protected)/settings/AgentBackendsSection.tsx`, `docs/credentials-architecture.md`

## Problem

Connecting an agent backend to buildd is **paste-a-file** today: the user copies
`~/.codex/auth.json` (Codex) or `~/.claude/.credentials.json` (Claude) into the
dashboard, and buildd stores + centrally refreshes it. Observed failure (2026-07-19):
every Codex worker died with

```
Your access token could not be refreshed because you have since logged out or
signed in to another account. Please sign in again.
```

Root cause: the pasted `auth.json` is a **copy of the user's own machine session**.
OpenAI rotates the refresh token on every refresh; the moment the user's local
Codex CLI refreshes (or they re-login anywhere), the copy buildd holds is
superseded and dies. Three consecutive fresh pastes failed identically — the
paste is structurally a shared, self-invalidating credential. The same failure
mode applies to Claude OAuth. (API keys don't have this problem, but force
pay-per-token billing and aren't what subscription users have.)

## Proposal

Add an **OAuth device-code login flow, initiated from the buildd UI**, so buildd
mints and owns its **own** session instead of copying the user's:

1. User clicks **Sign in with device code** → buildd calls the provider's device
   authorization endpoint → shows a one-time code + verification URL.
2. User approves in a browser (any device). buildd **polls** the provider until
   authorized, exchanges the code, and stores the resulting tokens as a
   buildd-owned credential.
3. The existing central refresh cron (`refreshCodexCredential` /
   `refreshClaudeCredential`) keeps it alive.

Because buildd holds a first-class session (not a copied file), there is no stale
paste to invalidate. The remaining "one active session per account" is an OpenAI
constraint, not buildd's — solved operationally by giving buildd its own account
or accepting that signing in on buildd logs the user's other devices out.

**Crux:** the runner must stop letting the **worker's** Codex CLI refresh the
token in-session. Today the runner seeds the full `auth.json` (with
`refresh_token`) into the worker's `CODEX_HOME`, so the CLI rotates it mid-run —
re-introducing exactly the rotation collision we're eliminating at the UI layer.
The Claude path already solved this: it injects an **access-token-only**
credential (`materializeClaudeConfigDir`, no `refresh_token`) and refreshes
centrally. Codex must do the same. If the Codex CLI refuses to run without a
`refresh_token`, this whole approach only shifts the collision from paste-time to
run-time and the design fails.

## Current state

- `codex-credential.ts` already has central refresh (`refreshCodexCredential`,
  optimistic-locked) + a `codex-token-refresh` cron; `claude-credential.ts` has
  the equivalent plus an access-token-only worker injection.
- Both backends' UI cards are paste-only (`CodexPasteForm`, the Claude connected-
  account card).
- `secrets` already carries `tokenExpiresAt` / `lastRefreshedAt` / health.

## Implementation status (this PR)

Prototype of the **Codex** device-code flow, matching the Codex CLI's
`device_code_auth.rs` (client_id `app_EMoamEEZ…`; PKCE generated server-side):

- `codex-device-auth.ts` — `startCodexDeviceAuth()` (POST
  `…/api/accounts/deviceauth/usercode`) and `pollCodexDeviceAuth()` (poll
  `…/deviceauth/token`, then exchange at `/oauth/token`), returning a normalized
  `CodexAuthJson`.
- Routes `…/codex-credential/device/start` and `…/device/poll`; poll stores via
  the existing `storeCodexCredential` and triggers `requeueAuthFailedTasks`.
- UI: **Sign in with device code** in `CodexCard` with a background-polling panel.

NOT yet done: the crux (access-token-only worker injection for Codex), Claude
device-flow, and all-teams fan-out for device login.

## Open questions

- **Access-token-only Codex workers (the crux).** Lean: mirror the Claude path —
  write an `auth.json` without `refresh_token` into the worker `CODEX_HOME` and
  refresh centrally. Must verify codex-cli 0.140 tolerates a refresh-token-less
  `auth.json`; if not, fall back to short-TTL access tokens refreshed by the
  runner between runs.
- **Device-code enablement.** The flow 404s unless the account has "Allow device
  code login" enabled. Lean: detect the 404 and surface the exact setting to flip
  (done in the prototype) rather than trying to enable it programmatically.
- **Dedicated buildd account vs shared.** Lean: document that buildd should use an
  account not used interactively elsewhere; don't try to make one account serve
  both buildd and a user's laptop (OpenAI won't allow concurrent sessions).

## Non-goals

- Replacing API-key auth (still supported and recommended for pure automation).
- Programmatically enabling device-code login on the provider account.
- Changing the `secrets` scoping/precedence model.
