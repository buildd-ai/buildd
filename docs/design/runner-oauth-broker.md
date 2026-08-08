---
status: proposed
assertions:
  # Current state — control-plane refresh (what we are REPLACING). These should pass today.
  - type: symbol
    name: refreshClaudeCredential
    path: apps/web/src/lib/claude-credential.ts
  - type: symbol
    name: refreshCodexCredential
    path: apps/web/src/lib/codex-credential.ts
  - type: route
    method: GET
    path: /api/cron/codex-token-refresh
    file: apps/web/src/app/api/cron/codex-token-refresh/route.ts
  - type: symbol
    name: materializeClaudeConfigDir
    path: apps/runner/src/claude-auth.ts
  # Phase 1 targets — will fail until the implementation PR ships.
  - type: symbol
    name: runnerRefreshCredential
    path: apps/runner/src/credential-refresh.ts
    skip_until: "2026-10-31"
    skip_reason: "Phase 1 runner-side refresh module — implementation task filed after spec approval"
  - type: route
    method: POST
    path: /api/runner/credential-refresh
    file: apps/web/src/app/api/runner/credential-refresh/route.ts
    skip_until: "2026-10-31"
    skip_reason: "Phase 1 write-back endpoint for runner-reported token rotation — not yet implemented"
  - type: symbol_reachable
    symbol: pendingCredentialRefreshes
    entry: apps/web/src/app/api/workers/claim/route.ts
    as: assign
    skip_until: "2026-10-31"
    skip_reason: "Phase 1 nudge field in claim response not yet implemented"
---
# Runner-Anchored OAuth Credential Custody

**Status:** Proposed  
**Related:**
`apps/web/src/lib/claude-credential.ts`,
`apps/web/src/lib/codex-credential.ts`,
`apps/web/src/app/api/cron/codex-token-refresh/route.ts`,
`apps/web/src/app/api/workers/claim/route.ts`,
`apps/runner/src/claude-auth.ts`,
`apps/runner/src/workers.ts`,
`docs/credentials-architecture.md`,
`docs/design/oauth-device-login.md`,
`docs/specs/auth-oauth-boundaries.md`,
`docs/specs/credential-isolation.md`

---

## Problem

OAuth credentials for Claude and Codex execute successfully for a period after the initial browser grant, then die — reliably, and with no intervening user action. Observed error strings:

- Claude: `"invalid_grant"` on token refresh; `healthStatus = 'revoked'` set in DB.
- Codex: `"Your access token could not be refreshed because you have since logged out or signed in to another account."` on the first or second proactive cron refresh.

The pattern is consistent: credentials work during the initial post-grant window (API calls originate from the runner at a static egress IP), then fail at the first control-plane–initiated refresh. The control plane runs on Vercel, whose outbound IPs rotate across Vercel's shared egress fleet. This means the first `POST /token` for a refresh arrives from a **different IP than every prior API call** — a location flip that trips provider anomaly detection (Anthropic and OpenAI both apply it).

The control plane calls the token endpoint in two places today:
1. `GET /api/cron/codex-token-refresh` — runs every 4 hours on Vercel; calls `refreshClaudeCredential()` / `refreshCodexCredential()`.
2. `apps/web/src/app/api/workers/claim/route.ts` (lines ~2067, ~2135) — claim-gate refresh; same Vercel IP.

Both callers share the same structural flaw: the token endpoint is reached from a serverless host with a rotating egress IP rather than from the runner where all usage originates.

---

## Current State

The refresh path:

```
[Vercel cron / claim route]
    → POST https://platform.claude.com/v1/oauth/token  (from rotating Vercel IP)
    → persist new tokens to secrets table
    → next claim: resolveClaudeCredential() reads access_token → claudeAccessToken on claim response
    → runner: materializeClaudeConfigDir(workerId, accessToken)
              writes ~/.claude/credentials.json with access_token ONLY (no refresh_token)
    → Claude Code SDK runs with access-only credential; never rotates token itself
```

Workers are already correctly isolated: `materializeClaudeConfigDir` (`apps/runner/src/claude-auth.ts:23`) writes access-token-only credentials and the runner deletes them on teardown. Workers cannot rotate tokens mid-run; that piece is correct.

The invariant broken is where the rotation call itself originates. After the initial interactive grant (user browser → provider → Anthropic/OpenAI returns tokens to runner or control plane), all **subsequent** token endpoint calls must come from the same static IP as API usage. They do not today.

---

## Proposal

**Core principle (non-negotiable):** After the one-time interactive browser grant, every token-endpoint call (refresh) originates from the runner — the same static egress IP where all API usage already occurs. The control plane never calls the token endpoint post-grant; it only stores what the runner reports back.

### Phase 1 — Minimal runner-side refresh

Phase 1 ships first. It eliminates the IP-flip problem without introducing a long-running broker process.

**Crux:** The DB-level refresh lock must be acquired and the new tokens must be **persisted before they are used**. If the runner acquires the lock, calls the token endpoint, then crashes before writing back, the old tokens remain in the DB. On the next claim the control plane would serve the stale tokens, and the next runner-initiated refresh (locked out for 60 minutes) cannot start. The write-back call must complete and be confirmed before the runner uses the new access token to spawn a worker; any crash between refresh and write-back is safe (old tokens still work for the current run; the next refresh window corrects them).

#### 1a. Runner-side refresh module

A new module `apps/runner/src/credential-refresh.ts` exports `runnerRefreshCredential(secretId, purpose)`. It:

1. Calls `POST /api/runner/credential-refresh` (new control-plane endpoint — see §1c) with `{ secretId, action: 'lock' }`.
   - Control plane runs the same optimistic-lock `UPDATE secrets SET lastRefreshedAt = NOW() WHERE id = :id AND (lastRefreshedAt IS NULL OR lastRefreshedAt < NOW() - INTERVAL '60 minutes') RETURNING *`.
   - Response: `{ locked: true, encryptedBlob: '...' }` (the caller won the lock and receives the current blob to decrypt) or `{ locked: false }` (another caller holds the lock — do nothing).
2. If locked: decrypt the blob client-side (runner holds the decryption key via `BUILDD_SECRETS_KEY`), extract `refresh_token`, call the provider token endpoint directly.
3. Persist-before-use: call `POST /api/runner/credential-refresh` with `{ secretId, action: 'commit', accessToken, refreshToken, expiresAt }`. Control plane encrypts and writes the new blob atomically. Returns `{ ok: true }`.
4. If the provider returns `invalid_grant` (400/401): call `POST /api/runner/credential-refresh` with `{ secretId, action: 'revoke' }`. Control plane marks `healthStatus = 'revoked'`, `tokenExpiresAt = null` — identical to the existing revoke path in `refreshClaudeCredential`. Emits a Pushover alert (first failure only; subsequent cron calls skip revoked rows).
5. If the provider returns a transient error (5xx, network timeout): do NOT revoke. Increment a transient-failure counter on the row (new column `refreshFailures`). Alert when `refreshFailures >= 3` consecutive. Never revoke on transient errors.

Return values mirror `RefreshResult`: `'refreshed' | 'locked' | 'no_credential' | 'error'`.

**Secrets key on runner:** The runner already holds `BUILDD_SECRETS_KEY` (or equivalent) to decrypt task credentials. Decrypting the blob runner-side reuses this. Alternative (simpler for Phase 1): the control plane decrypts the blob and returns the plaintext `refresh_token` in the lock response over the existing mTLS/HTTPS channel — simpler, acceptable because the channel is already authenticated and the token is only in memory, not logged.

_Recommendation_: return plaintext `refresh_token` from the lock response for Phase 1 simplicity. Phase 2 can move to runner-side decryption when multi-runner lease isolation is needed.

#### 1b. Invocation points on the runner

Two invocation points, both in `apps/runner/src/workers.ts`:

**Claim-path refresh:** When the claim response includes `pendingCredentialRefreshes: [{ secretId, purpose }]` (see §1c), the runner calls `runnerRefreshCredential()` for each entry before starting the worker subprocess. This is the primary path — it guarantees the access token is fresh for every task launch.

**Periodic sweep:** A lightweight interval (every 30 minutes) in the runner process iterates credentials the runner knows about (learned from recent claim responses) and refreshes any expiring within 2 hours. This provides a refresh window even when no task is being claimed. Implementation: `apps/runner/src/credential-refresh-sweep.ts`, started in `apps/runner/src/runner.ts` alongside the existing claim loop.

#### 1c. Control-plane changes

**New endpoint `POST /api/runner/credential-refresh`:**

Auth: `BUILDD_API_KEY` in `Authorization: Bearer` (runner identity). The runner's API key already authenticates runner→control-plane calls.

Actions:

| `action` | What it does |
|---|---|
| `lock` | Runs the optimistic `UPDATE ... RETURNING` lock. Returns `{ locked: true, refreshToken: '<plaintext>' }` or `{ locked: false }`. |
| `commit` | Writes new tokens (encrypted) + clears `lastVerificationError`, updates `tokenExpiresAt`, `lastRefreshedAt = NOW()`. Returns `{ ok: true }`. |
| `revoke` | Sets `healthStatus = 'revoked'`, `tokenExpiresAt = null`, fires first-failure Pushover. Returns `{ ok: true }`. |

**Claim response extended with `pendingCredentialRefreshes`:**

```ts
pendingCredentialRefreshes?: Array<{
  secretId: string;
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null; // ISO 8601 — runner decides whether to refresh now
}>;
```

The claim route populates this for any credential associated with the claimed task's workspace that expires within 2 hours (same threshold as the existing cron). This replaces the claim-gate `refreshClaudeCredential()` / `refreshCodexCredential()` calls in `route.ts` (lines ~2067, ~2135) — those calls are removed once Phase 1 ships.

**Control-plane cron becomes a nudge:**

The existing `GET /api/cron/codex-token-refresh` is changed from "call token endpoint" to "create lightweight credential-refresh tasks." For each credential expiring within 2 hours, the cron creates a task with `roleSlug = null` (system task), `tier = 'budget'`, title `[sys] refresh credential <secretId>`. These tasks are claimed by the runner's existing claim loop (or a dedicated claim path for system tasks) and result in `runnerRefreshCredential()` being called. This provides a refresh path when no regular tasks are being claimed (runner idle but online).

The cron's `refreshClaudeCredential()` and `refreshCodexCredential()` calls are **removed** once Phase 1 ships. The cron retains the zombie-detection log block (no credential calls, just queries).

**Runner-offline guard:**

If the runner has been offline and tokens lapse, they will be revoked on first use after reconnect (provider sees a cold refresh). The UI shows `healthStatus = 'revoked'` with a re-auth prompt. There is no control-plane fallback refresh — an off-IP refresh may be the trigger. Fallback is an opt-in flag `BUILDD_ALLOW_CONTROL_PLANE_REFRESH` (default `false`); when set, the control plane's cron retains the direct refresh call. The tradeoff is documented inline: opt-in fallback enables refresh when runner is offline but risks an IP-flip revocation on providers that enforce it strictly.

### Phase 2 — Dedicated broker (specify now, implement only if needed)

Phase 2 is triggered when either of these conditions is observed:
- A second physical runner is added to a team (multi-runner contention on credential refresh).
- Credential contention is observed (multiple workers racing the refresh lock within the same 60-minute window under high task volume).

Phase 2 introduces a dedicated broker process on the runner:

- **Credential leases:** a new DB table `credentialLeases` with columns `(secretId, runnerId, leasedAt, heartbeatAt, expiresAt)`. The broker acquires a per-credential lease (heartbeat-renewed every 60s) before any refresh. Only the lease holder refreshes.
- **Local token service:** the broker serves short-lived access tokens to local workers over a local HTTP endpoint (e.g. `http://localhost:9333/token?secretId=...`). Workers request tokens; the broker returns a fresh access token without ever exposing the refresh token.
- **Worker interface contract:** Workers never see refresh tokens. Claude Code workers: `CLAUDE_CODE_OAUTH_TOKEN` env var sourced from broker (or `credentials.json` access-only as today). Codex workers: `auth.json` access-only, written by the broker on each lease renewal. The existing `materializeClaudeConfigDir` pattern is preserved.
- **Bootstrap:** on lease acquire, broker fetches the decrypted credential blob from the control plane (via `POST /api/runner/credential-refresh` lock step), decrypts, holds `refresh_token` in memory only (never written to disk).
- **Crash recovery:** if the broker dies mid-rotation (after calling the token endpoint but before `commit`), the next broker instance calls `lock` — if the lock timestamp is < 60 minutes old (locked by the dead broker), the new broker uses the `commit` action with fresh tokens it obtained. The 60-minute lock window guarantees at most one stale-lock state before the next lease can proceed.
- **Memory-only storage:** refresh tokens live only in the broker process's heap + `/dev/shm` (tmpfs). They are never written to disk. The broker signals a clean shutdown (SIGTERM handler) that wipes the in-memory token and flushes the lease row.

---

## Migration and Cutover

Order of operations with no credential-death window:

1. **Deploy Phase 1 code** (runner + control plane): the new `POST /api/runner/credential-refresh` endpoint ships. The claim route still calls `refreshClaudeCredential()`/`refreshCodexCredential()` as before — no behaviour change yet.

2. **Enable runner-side refresh** via config flag `BUILDD_RUNNER_REFRESH=true` on the runner. The runner begins doing claim-path refreshes via `runnerRefreshCredential()`. Control-plane cron still runs in parallel — safe because the DB lock prevents double-rotation.

3. **Remove control-plane direct refresh:** once `BUILDD_RUNNER_REFRESH=true` has been stable for one full cron cycle (4 hours), remove the `refreshClaudeCredential()`/`refreshCodexCredential()` calls from the claim route and change the cron to nudge-only. Deploy.

4. **Currently-flagged credentials need one manual re-auth.** Any credential currently in `healthStatus = 'revoked'` (killed by a prior Vercel IP-flip refresh) cannot be recovered by this change — the refresh token family is already dead. Users with revoked credentials will need to reconnect via the OAuth device-code flow (`docs/design/oauth-device-login.md`). The FIRST refresh after re-auth must already originate from the runner (step 2 complete before re-auth is prompted).

5. **Verify:** after cutover, monitor the cron log for `refreshed` counts dropping to zero (control plane no longer refreshing directly) and runner logs for successful `runnerRefreshCredential` calls. Credential health dashboard should show sustained `healthy` status.

---

## Security Posture

**Refresh tokens leave the control plane only once** (in the lock response to the runner, over the authenticated HTTPS channel). They are never written to runner disk; they are used and discarded from memory (or from the broker heap in Phase 2). This is a strict improvement over today, where refresh tokens transit Vercel request handlers and potentially land in Vercel log drains.

**Relationship to `credential-isolation.md`:** The capability-scoped worker environment spec (§3) already ensures workers never see `refresh_token`. Phase 1 does not change the worker-facing API; `claudeAccessToken` on the claim response continues to carry only the access token. Refresh tokens are now confined to the runner process, not even touching Vercel memory.

**Relationship to ID-JAG direction:** The cross-app assertion grant design (`docs/design/cross-app-assertion-grant.md`) positions the control plane as an issuer of short-lived grants rather than a distributor of long-lived secrets. Runner-anchored refresh is consistent: the control plane retains encrypted long-lived storage (single source of truth) but stops being the actor that calls external token endpoints. The control plane becomes a ledger; the runner becomes the sole party that interacts with provider token endpoints post-grant.

**Shared machinery with MCP credential handling:** `apps/web/src/lib/mcp-connector-refresh.ts` uses the same optimistic-lock pattern but for MCP OAuth credentials. Phase 1 does not move MCP credential refreshes to the runner (MCP servers are often not colocated with the runner). The `POST /api/runner/credential-refresh` endpoint is scoped to `purpose IN ('claude_credential', 'codex_credential')` and rejects other purposes.

**Secrets key exposure:** Returning plaintext `refresh_token` in the lock response is acceptable in Phase 1 because the runner→control-plane channel is authenticated (BUILDD_API_KEY) and TLS-encrypted, and the runner does not log the lock response body. Phase 2 moves to runner-side decryption if the memory-only guarantee must extend to the transport layer.

---

## Multi-Runner Assumption

Phase 1 assumes **effectively one runner per team**. This is the current state for all production deployments. The single-runner assumption is documented here and in code comments; it is not enforced by the system.

The DB lock provides basic multi-runner correctness: if two runners race on a refresh, only one wins the `UPDATE ... RETURNING` and calls the token endpoint; the other gets `locked` and skips. However, with two runners the nudge mechanism (cron creates a task; any runner claims it) could be claimed by the runner not currently handling tasks for that credential's workspace — the "winning" runner may be a cold runner that hasn't been used recently, and its IP may differ from the "hot" runner in some edge configurations (e.g., two runners on different hosts).

**Phase 2 trigger condition:** the first time a team deploys a second physical runner, or when credential contention (multiple `locked` results per cron window) is observed in the logs. Phase 2's lease table ensures exactly one runner holds any credential at a time and refreshes it.

---

## Open Questions

**Q1: Lock response — plaintext `refresh_token` vs runner-side decryption?**  
Lean: plaintext in Phase 1 (simpler, acceptable security posture). Reason: the control plane already decrypts credentials at claim time for other purposes; the channel is authenticated and encrypted. Document as a Phase 2 migration target.

**Q2: Nudge via task queue vs embedded in claim response?**  
The proposal embeds `pendingCredentialRefreshes` in the claim response (claim-path trigger) and uses task-queue nudges for the cron path. This is two mechanisms where one would do. Alternative: use only the task-queue path (cron creates a task, runner claims it, refreshes, completes). That removes the embedded field but means a task is in the queue for every credential refresh — adds noise to the task feed and requires a role/category to route these system tasks away from users.  
Lean: keep the embedded field for claim-path (zero task noise, immediate freshness guarantee at spawn time) and use task-queue nudge only as a fallback from the cron for idle-runner refreshes.

**Q3: `refreshFailures` column vs existing `healthStatus` escalation?**  
The existing credential health system (`credential-health.ts` → `healthStatus: degraded | revoked`) already tracks failure counts via `recordCredentialAuthFailure`. The proposal adds a `refreshFailures` column for transient-error counting to avoid the existing degraded/revoked path being triggered by network hiccups. Alternative: reuse the existing `recordCredentialAuthFailure` escalation threshold.  
Lean: reuse existing escalation. The `refreshFailures` column is unnecessary if the existing `healthStatus` threshold already distinguishes transient from permanent failure correctly. Verify in implementation — if the threshold is too aggressive, add the column then.

**Q4: `BUILDD_ALLOW_CONTROL_PLANE_REFRESH` opt-in — expose in UI?**  
Lean: env-var only, documented here and in the runner README. This is an escape hatch for unusual deployments; surfacing it in the UI risks normalising a dangerous fallback. Teams should understand the IP-flip tradeoff before opting in.

---

## Non-Goals

- **Implementing Phase 2 broker proactively.** Phase 2 is specced here for planning purposes; it ships only when the Phase 2 trigger conditions are met.
- **Moving MCP connector credentials to runner-side refresh.** MCP servers are often remote, not colocated with the runner. Scope: `claude_credential` and `codex_credential` purposes only.
- **Changing the `secrets` table scoping/precedence model.** The team/account/workspace scoping in `docs/credentials-architecture.md` is unchanged.
- **Changing the worker-facing injection contract.** Workers continue to receive an access-only credential (`claudeAccessToken` on claim, `materializeClaudeConfigDir` in the runner). No worker-facing protocol changes.
- **Enforcing static egress IPs on the control plane.** This design fixes the problem by moving the call; it does not fix the control plane's IP situation, which would require a Vercel Enterprise feature or a proxy layer.
- **Handling the case where the runner's IP itself is dynamic.** Phase 1 assumes the runner has a stable egress IP (a persistent VM or container with a fixed IP or NAT gateway). Runners on dynamic-IP hosts (e.g., a developer laptop) should not be the credential-refresh runner for production credentials; that is an operational constraint, not a system-enforced one.
- **Per-task credential rotation.** Credentials are refreshed at the team/workspace scope, not per-task. Task-level credential isolation is out of scope for this design.
