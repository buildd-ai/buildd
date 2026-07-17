# ID-JAG: Identity Assertion Grant for MCP Servers (SPEC)

> **Status: draft — awaiting approval.**
>
> **Scope:** JWT-bearer assertion grant that lets buildd-owned MCP servers
> cryptographically verify a worker's identity without receiving inline
> credentials. Covers signing-key storage, JWKS endpoint, assertion minting,
> claim-response extension, runner exchange flow, Cue acceptance model, OAuth
> AS metadata update, and key rotation.
>
> **Sources of truth read before this doc:**
> - `packages/shared/src/types.ts:811` — `ClaimTasksResponse` (no assertion field today)
> - `packages/core/db/schema.ts:1052` — `secrets` table + `purpose` enum
> - `apps/web/src/app/.well-known/oauth-authorization-server/route.ts` — AS
>   metadata (only `authorization_code` + `refresh_token` today; no `jwks_uri`)
> - `apps/web/src/lib/oauth/tokens.ts` — HS256 symmetric signing via `OAUTH_JWT_SECRET`
> - `apps/web/src/lib/oauth/config.ts` — `getIssuer()`, `getJwtSecret()`
> - `apps/runner/src/workers.ts:1884` — MCP credentials injected straight from claim
>   (`mcpConnectors`) with no exchange step
>
> **Decisions already made (do not reopen):**
> 1. Signing algorithm: ES256 (ECDSA P-256). Compact, widely supported by `jose`
>    and all major MCP server frameworks. Asymmetric so verifiers never touch the
>    private key.
> 2. Assertion TTL: 5 minutes. Single-use enforced by `jti` nonce validation at
>    the exchange endpoint.
> 3. Access token TTL from exchange: 10 minutes. Short enough to limit blast
>    radius; runner re-exchanges on 401 rather than caching stale tokens.
> 4. JWKS cache at verifier: 5 minutes. Re-fetch on unknown `kid` (allows zero-
>    downtime rotation).
> 5. Key rotation cadence: monthly cron. Previous key stays active for 5 minutes
>    (the maximum assertion TTL) after rotation to drain in-flight assertions.
> 6. Non-goal: existing `authorization_code` / `refresh_token` flows for claude.ai
>    are untouched. `mcpConnectors` (external, non-buildd-owned servers) continue
>    to use resolved connector credentials.

---

## Background

Today the claim route returns raw credentials inline:

```
serverApiKey, serverOauthToken, mcpSecrets, mcpConnectors (pre-resolved Bearer headers)
```

For buildd-owned MCP servers (e.g. Cue, the memory service) this means:
- The server has no way to verify *which* worker it is talking to.
- Credentials are long-lived and workspace-scoped; a leaked claim response
  grants broad access until the credential is rotated.
- There is no standard protocol for third-party MCP servers to verify caller
  identity without receiving buildd's internal secrets.

ID-JAG replaces inline credentials for buildd-owned servers with a
cryptographically verifiable short-lived assertion. The worker presents the
assertion to the MCP server's token endpoint; the server verifies it against
JWKS and returns a 10-minute access token scoped to the specific tenant.

---

## A. Assertion JWT Schema

The assertion is a standard JWT signed with buildd's ES256 private key.

### A.1 Header

```json
{
  "alg": "ES256",
  "kid": "<current-kid>",
  "typ": "JWT"
}
```

### A.2 Claims

| Claim | Type | Value |
|-------|------|-------|
| `iss` | string | `https://buildd.dev` (from `getIssuer()`) |
| `sub` | string | Worker ID (`<workerId>`) |
| `aud` | string | Target MCP server URL (e.g. `https://memory.buildd.dev`) |
| `jti` | string | Random UUID — nonce; exchange endpoint rejects duplicates within the assertion TTL window |
| `iat` | number | Unix timestamp when assertion was issued |
| `exp` | number | `iat + 300` (5 minutes) |
| `taskId` | string | UUID of the task being executed |
| `accountId` | string | UUID of the account that owns the task |
| `workspaceId` | string | UUID of the workspace |
| `teamId` | string | UUID of the team |

### A.3 Serialised example (decoded)

```json
{
  "alg": "ES256",
  "kid": "buildd-2026-07",
  "typ": "JWT"
}
.
{
  "iss": "https://buildd.dev",
  "sub": "worker-uuid",
  "aud": "https://memory.buildd.dev",
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "iat": 1753000000,
  "exp": 1753000300,
  "taskId": "task-uuid",
  "accountId": "account-uuid",
  "workspaceId": "workspace-uuid",
  "teamId": "team-uuid"
}
```

---

## B. JWKS Endpoint

### B.1 Route

```
GET /.well-known/jwks.json
```

Public, unauthenticated. Returns current and previous signing key (overlap window).

### B.2 Response shape

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "buildd-2026-07",
      "use": "sig",
      "alg": "ES256",
      "x": "<base64url>",
      "y": "<base64url>"
    },
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "buildd-2026-06",
      "use": "sig",
      "alg": "ES256",
      "x": "<base64url>",
      "y": "<base64url>"
    }
  ]
}
```

Only **public** key material is served. Private keys never leave the `secrets`
table. The response omits keys rotated more than one cycle ago.

### B.3 Route file

`apps/web/src/app/.well-known/jwks.json/route.ts`

The handler reads all `assertion_signing_key` rows from the `secrets` table,
exports each private key as a public JWK via `jose`, and returns the set.
No authentication required; CORS wildcard allowed.

---

## C. Secrets Table Extension

Add `assertion_signing_key` to the `purpose` enum in
`packages/core/db/schema.ts:1057`.

```ts
purpose: text('purpose').notNull().$type<
  | 'anthropic_api_key'
  | 'oauth_token'
  | 'codex_credential'
  | 'webhook_token'
  | 'custom'
  | 'mcp_credential'
  | 'vercel_token'
  | 'pushover'
  | 'notify_webhook'
  | 'mcp_connector_credential'
  | 'assertion_signing_key'   // ← new
>()
```

**Row structure for `assertion_signing_key`:**

| Column | Value |
|--------|-------|
| `teamId` | NULL (global, shared across all teams) |
| `accountId` | NULL |
| `workspaceId` | NULL |
| `purpose` | `assertion_signing_key` |
| `label` | Key ID string — e.g. `buildd-2026-07` (matches `kid` in JWT header) |
| `encryptedValue` | Encrypted JSON: `{ "kid": "buildd-2026-07", "privateKeyPem": "-----BEGIN EC PRIVATE KEY-----\n...", "algorithm": "ES256" }` |
| `createdAt` | When the key was generated |

A migration adds a unique index on `(purpose, label)` for the
`assertion_signing_key` purpose.

**Key selection:** When minting an assertion, the server selects the
`assertion_signing_key` row with the highest `createdAt` (most recent active
key). During the 5-minute rotation overlap both old and new keys are present in
JWKS; workers always sign with the newest.

---

## D. ClaimResponse Extension

Add `assertionToken` to `ClaimTasksResponse` in
`packages/shared/src/types.ts:811`.

```ts
export interface ClaimTasksResponse {
  workers: Array<{
    // ... existing fields unchanged ...

    /** Short-lived (5 min) ES256-signed assertion JWT.
     *  Present when at least one buildd-owned MCP server is configured for
     *  the workspace. The runner exchanges this for a server-specific access
     *  token at MCP connect time. */
    assertionToken?: string;
  }>;
  // ...
}
```

The assertion is minted in the claim route (`apps/web/src/app/api/workers/claim/route.ts`)
after the worker row is created. It is only included when the workspace has at
least one buildd-owned MCP server configured (checked via role's `mcpServers`
config). If no assertion signing key is configured, the field is omitted and
the runner falls back to existing credential injection.

---

## E. Token Exchange Protocol

The JWT-bearer grant follows [RFC 7523 §2.1](https://www.rfc-editor.org/rfc/rfc7523).

### E.1 Exchange request

```
POST <mcp-server>/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer
&assertion=<assertion-JWT>
```

No `client_id` or `client_secret` — the signed assertion is self-authenticating.

### E.2 Successful response

```json
{
  "access_token": "<opaque-or-JWT>",
  "token_type": "Bearer",
  "expires_in": 600
}
```

### E.3 Error response

Standard OAuth 2.0 error envelope:

```json
{
  "error": "invalid_grant",
  "error_description": "Assertion is expired or has already been used"
}
```

Common error codes:

| `error` | Cause |
|---------|-------|
| `invalid_grant` | Assertion expired, `jti` already seen, or signature invalid |
| `invalid_request` | Malformed request body |
| `unauthorized_client` | `iss` or `aud` rejected by server policy |

### E.4 Jti replay protection

The exchange endpoint maintains a short-lived set of seen `jti` values. Any
`jti` received a second time within the assertion's validity window returns
`invalid_grant`. The window is `exp - iat` (max 5 minutes), so a Redis key
with 5-minute TTL (or equivalent in-memory store) is sufficient.

---

## F. Cue Acceptance Model (buildd-owned MCP servers)

This section defines what a buildd-owned MCP server (e.g. Cue / memory service)
must implement to accept the assertion grant.

### F.1 JWKS client

- On startup, fetch `https://buildd.dev/.well-known/jwks.json` and cache the
  key set in memory.
- Cache TTL: 5 minutes.
- On receiving a JWT with an unknown `kid`: immediately re-fetch JWKS (one
  attempt) before failing. This handles zero-downtime key rotation.

### F.2 Assertion verification steps

1. Parse the JWT header; extract `kid`.
2. Locate the matching JWK in the cached set (re-fetch once if not found).
3. Verify the ES256 signature.
4. Verify `iss === "https://buildd.dev"`.
5. Verify `aud === <this server's own URL>` (e.g. `https://memory.buildd.dev`).
6. Verify `exp > now`.
7. Check `jti` is not in the replay cache.
8. Mark `jti` as seen with TTL = `exp - now`.

All checks must pass before the exchange endpoint returns an access token.

### F.3 Access token scope → tenant mapping

The issued access token encodes the tenant context from the assertion claims:

| Assertion claim | Maps to |
|----------------|---------|
| `accountId` | Tenant account — scopes memory reads/writes to this account's data |
| `workspaceId` | Sub-tenant scope within the account |
| `teamId` | Team-level isolation for shared resources |

The access token may be an opaque random string (stored in a short-lived cache
keyed by token → tenant context) or a self-contained JWT signed by the MCP
server's own key. Either is acceptable; the tenant mapping must be enforced on
every authenticated request.

---

## G. Runner Exchange Flow

### G.1 At MCP connect time

For each buildd-owned MCP server in the worker's config:

1. Check `worker.assertionToken` is present and not expired (`exp - now > 30s`).
   If absent or near-expiry, log a warning and skip exchange (fall back to
   unauthenticated or skip the server).
2. POST to `<server-url>/auth/token` with the assertion.
3. On `200`: store the returned `access_token` locally; set an `Authorization:
   Bearer <access_token>` header on all subsequent requests to that server.
4. On non-`200`: log the error and abort (do not proceed with an
   unauthenticated connection to a server that requires auth).

### G.2 On 401 mid-session

1. The MCP client receives a `401 Unauthorized` from the server.
2. Runner attempts exactly one re-exchange using the original `assertionToken`.
   - If `assertionToken` is still within its validity window: POST to
     `/auth/token` again; if `200`, retry the failed request with the new token.
   - If `assertionToken` is expired: propagate the 401 as a mid-task auth
     failure (existing `mid-task-401` circuit breaker handles it — see
     `docs/design/generic-mcp-connectors.md` §E).
3. If the re-exchange also fails: propagate 401; do not loop.

### G.3 Pseudocode

```ts
async function connectWithAssertion(serverUrl: string, assertionToken: string) {
  const exchanged = await exchangeAssertion(serverUrl, assertionToken);
  return createMcpClient(serverUrl, { bearer: exchanged.access_token });
}

async function exchangeAssertion(serverUrl: string, assertion: string) {
  const res = await fetch(`${serverUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new AssertionExchangeError(await res.json());
  return res.json() as { access_token: string; expires_in: number };
}
```

---

## H. OAuth AS Metadata Update

`apps/web/src/app/.well-known/oauth-authorization-server/route.ts` must be
updated to advertise the new capabilities:

```ts
return NextResponse.json({
  issuer,
  authorization_endpoint: `${issuer}/api/oauth/authorize`,
  token_endpoint: `${issuer}/api/oauth/token`,
  registration_endpoint: `${issuer}/api/oauth/register`,
  logo_uri: `${issuer}/logo.png`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,                       // ← new
  response_types_supported: ['code'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',                   // ← new
  ],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: OAUTH_SCOPES,
});
```

---

## I. Key Rotation

### I.1 Rotation cron

A monthly cron (`apps/web/src/app/api/cron/rotate-assertion-key/route.ts`):

1. Generate a new ES256 key pair via `jose`'s `generateKeyPair('ES256')`.
2. Derive `kid` from the current year-month: `buildd-YYYY-MM`.
3. Encrypt `{ kid, privateKeyPem, algorithm: "ES256" }` and insert into
   `secrets` with `purpose = 'assertion_signing_key'`.
4. Do **not** delete the previous key — leave it in place for 5 minutes (the
   assertion TTL) before pruning, so in-flight assertions signed with the old
   key remain valid.

### I.2 Key pruning

In the same cron (run after a 5-minute wait, or in the next scheduled run):
delete any `assertion_signing_key` rows whose `createdAt` is older than
`now - 1 rotation cycle - assertion_ttl` (i.e. older than ~35 days). This
ensures at most 2 keys are ever active simultaneously.

### I.3 Initial bootstrap

On first deploy, if no `assertion_signing_key` row exists, the claim route
falls back gracefully: `assertionToken` is omitted from the claim response and
the runner uses existing credential injection. The key-rotation cron generates
the initial key on its first run. Alternatively, a one-off admin script
`scripts/bootstrap-assertion-key.ts` can seed the first key before deploy.

### I.4 JWKS response during rotation overlap

While both old and new keys exist in the secrets table (5-minute overlap):

```json
{
  "keys": [
    { "kid": "buildd-2026-08", ... },   // new — workers sign with this
    { "kid": "buildd-2026-07", ... }    // old — still valid for 5 min
  ]
}
```

Verifiers that cached the JWKS before rotation will still validate assertions
signed with the old key until their 5-minute cache expires.

---

## J. Non-Goals

The following are explicitly out of scope for this spec:

1. **Existing `authorization_code` / `refresh_token` flows** — unchanged.
   `apps/web/src/lib/oauth/tokens.ts` HS256 signing is untouched; those tokens
   serve claude.ai, not MCP-to-worker auth.

2. **`mcpConnectors` (external, non-buildd-owned servers)** — continue to use
   the resolved connector credentials (Bearer header or OAuth access token)
   injected at claim time. The assertion grant is only for buildd-owned servers
   that implement the `/auth/token` exchange endpoint.

3. **Per-workspace signing keys** — a single global signing key is sufficient.
   Tenant isolation is enforced by the access token minted by the MCP server,
   not by issuing per-workspace keys.

4. **Runner-side key caching across tasks** — the runner is stateless between
   task claims. Each claim mints a fresh assertion; there is no long-lived key
   material in the runner process.

5. **Revocation** — assertion tokens are short-lived (5 min) and single-use
   (`jti`). Explicit revocation is not needed at this TTL.

---

## K. File Map

| File | Change |
|------|--------|
| `packages/core/db/schema.ts` | Add `assertion_signing_key` to `purpose` enum |
| `packages/core/drizzle/` | New migration for enum extension |
| `packages/shared/src/types.ts` | Add `assertionToken?: string` to `ClaimTasksResponse` |
| `apps/web/src/app/api/workers/claim/route.ts` | Mint and attach assertion token at claim time |
| `apps/web/src/app/.well-known/jwks.json/route.ts` | New — serve public JWK set |
| `apps/web/src/app/.well-known/oauth-authorization-server/route.ts` | Add `jwks_uri` + jwt-bearer grant type |
| `apps/web/src/app/api/cron/rotate-assertion-key/route.ts` | New — monthly key rotation cron |
| `apps/runner/src/workers.ts` | Exchange assertion at connect time; re-exchange on 401 |

---

## L. Open Questions

1. **Bootstrap timing** — Should the first signing key be created via migration
   seed data or the rotation cron? Migration seed is deterministic but requires
   generating a key at deploy time; cron is lazy but means a cold-start gap.
   Recommended: add a `bootstrapAssertionKey()` call in the claim route that
   generates a key on first use (once, with a `getOrCreate` pattern).

2. **`jti` store for buildd-owned servers** — Cue and the memory service run on
   Cloudflare Workers. The replay cache needs to be a KV store with per-entry
   TTL, not in-process memory (multiple instances). This is implementation detail
   for the Cue team; the spec defines the interface, not the storage.

3. **Assertion refresh mid-task** — If a task runs for longer than 5 minutes
   (which is expected), the original assertion will be expired when the runner
   needs to re-exchange on a 401. The runner should detect this case and report
   it as a mid-task auth failure rather than silently failing. A future spec
   could add a `refreshAssertion` endpoint on buildd that accepts the worker's
   API key and returns a fresh assertion — but that is out of scope here.
