# Cross-App Assertion Grant (SPEC)

> **Status: draft — awaiting approval.**
>
> **Scope:** Full design for buildd-signed assertion auth enabling workers to
> authenticate against buildd-owned MCP servers (Cue at `cue.buildd.dev`,
> dispatch, moa-ops) without pre-shared secrets per team. Adds
> `authMode: 'assertion'` to the connector system, defines the JWKS
> infrastructure, the assertion mint API, and the resource-server contract.
>
> **Supersedes:** The composite `DISPATCH_API_KEY#TENANT_ID` `x-api-key`
> workaround for Cue (memory ef8092bc). Once deployed, Cue's connector row
> migrates from `authMode: 'header'` to `authMode: 'assertion'` and the static
> API key path on the Cue server is deprecated.
>
> **Also supersedes:** `docs/design/id-jag-assertion-grant.md` (PR #1230 — parallel draft for the same feature; deleted in favour of this document).
>
> **Closes:** `docs/design/generic-mcp-connectors.md` §E for assertion-mode
> connectors — no pause/reconnect banner required; re-auth is runner-side and
> fully automatic. §E remains in force for `oauth`-mode connectors (user
> interaction still needed to renew an expired OAuth session).
>
> **Sources of truth read before this doc:**
> - `docs/design/generic-mcp-connectors.md` — connector schema (§C),
>   auth-mode ladder (§B), mid-task 401 handling (§E), runner injection (§D)
> - `docs/specs/mcp-connectors-and-roles.md` — unified connector model,
>   role `connectorRefs`, single injection path (§3)
> - `docs/credentials-architecture.md` — `secrets` table, `SecretPurpose`,
>   scoping precedence, refresh lock pattern
> - Memory ef8092bc — decision: Cue composite credential via `x-api-key`
> - Memory a0b81c4f — Cue (`cue.buildd.dev`) OAuth infra: refresh tokens,
>   `mcp_tokens.expires_at`, WWW-Authenticate, 1h access token TTL
> - IETF draft-ietf-oauth-identity-assertion-authz-grant-05
> - RFC 7523 — JWT Profile for OAuth 2.0 Authorization Grants
> - RFC 8693 — OAuth 2.0 Token Exchange (`act` claim)
> - RFC 9728 — OAuth 2.0 Protected Resource Metadata

---

## Background & Motivation

Buildd operates several first-party MCP servers (Cue/dispatch at
`cue.buildd.dev`, and future `moa-ops`) that workers connect to during task
execution. The current Cue auth path is a static `x-api-key` header carrying a
composite `DISPATCH_API_KEY#TENANT_ID` credential stored as an `mcp_credential`
secret. This path has regressed 5+ times (PRs #1206, #1207, #1215, #1223,
#1225) because:

1. It fights the connector system's single-`headerName` model.
2. It requires manual secret provisioning per team.
3. It provides no worker-scoped audit trail (the key is shared across all
   workers in a team).
4. It cannot express which task is performing the action on the remote service.

The assertion grant replaces this with a cryptographically verifiable,
worker-scoped, short-lived credential:

1. buildd signs a JWT naming the worker, task, and target audience.
2. The runner presents this JWT to the resource server's token endpoint.
3. The RS validates the JWT against buildd's public JWKS and mints a
   short-lived access token.
4. No pre-shared secret between buildd and Cue is required beyond the JWKS
   trust anchor.

---

## A. Assertion Format

### A.1 JWT structure

Each assertion is a compact JWS (RFC 7515) signed by buildd with the following
header and claims:

```jsonc
// Header
{
  "alg": "ES256",          // ECDSA P-256 + SHA-256
  "kid": "buildd-2026-01", // identifies the active signing key in buildd's JWKS
  "typ": "JWT"
}

// Payload
{
  "iss": "https://buildd.dev",               // buildd canonical origin — always this string
  "sub": "<accountId>:<teamId>",             // tenant identity; RS derives workspace from this
  "act": {                                   // RFC 8693 §4.1 actor claim
    "sub": "worker:<workerId>",              // worker executing the task
    "tid": "<taskId>"                        // task being executed
  },
  "aud": "https://cue.buildd.dev/api/mcp",  // the RS's configured audience — connector.assertionAudience
  "jti": "<128-bit random hex, e.g. uuid>", // replay protection — tracked by RS for 2× TTL window
  "iat": 1721000000,                         // issued-at (seconds)
  "exp": 1721000300                          // expiry = iat + 300 (5 minutes)
}
```

**`sub` format rationale:** The RS derives the tenant from `sub` — NEVER from a
request header or any client-supplied claim. Using a compound `accountId:teamId`
value provides both axes of resolution in a single claim without a separate
lookup round-trip. The RS splits on the first `:` character.

**`act` rationale:** RFC 8693 defines `act` as a structured claim representing
the acting party. Using it here (rather than custom claims `workerId`/`taskId`)
follows established practice for delegation chains and allows compliant token
introspection tooling to understand the actor structure.

### A.2 Grant type selection

The assertion is presented at the resource server's token endpoint using:

```
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
assertion=<compact JWS>
```

**Why `urn:ietf:params:oauth:grant-type:jwt-bearer` (RFC 7523) rather than the
Identity Assertion Authorization Grant draft URN?**

The IETF Identity Assertion Authorization Grant
(draft-ietf-oauth-identity-assertion-authz-grant) describes a higher-level
framework for exactly this pattern: a trusted third-party assertion issuer
presents JWTs on behalf of users at a resource server with a pre-established
trust relationship. Its wire format for JWT assertions converges on RFC 7523's
`jwt-bearer` grant type; the draft's primary contribution is semantic guidance
on `iss`, `sub`, `act`, `aud` claim semantics (which we adopt) and protocol
structure. The draft's own URN
(`urn:ietf:params:oauth:grant-type:identity-assertion`) is not yet an IANA
registration because the draft is not yet an RFC. Using it risks breakage as
the draft evolves.

RFC 7523 is stable, IANA-registered, widely implemented in standard OAuth
libraries, and already used by several major identity providers for
system-to-system assertion flows. We therefore adopt RFC 7523's grant type and
layer the Identity Assertion Authorization Grant draft's semantic guidance
(claim structure, trust model) on top of it.

---

## B. JWKS Endpoint & Key Management

### B.1 JWKS endpoint

```
GET https://buildd.dev/api/.well-known/jwks.json
```

Response body — JWKS document (RFC 7517):

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "buildd-2026-07",
      "use": "sig",
      "alg": "ES256",
      "x": "<base64url-encoded x coordinate>",
      "y": "<base64url-encoded y coordinate>"
    },
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "buildd-2026-06",
      "use": "sig",
      "alg": "ES256",
      "x": "<base64url-encoded x coordinate>",
      "y": "<base64url-encoded y coordinate>"
    }
  ]
}
```

The endpoint returns 2 keys (Active + Retiring) during a rotation overlap
window, and 1 key (Active only) otherwise. It MUST return only public key
material (`x`, `y` for EC; `n`, `e` for RSA — but we use EC only).

**Caching headers:**

```
Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
```

Resource servers MUST cache for at least `max-age` (1 hour) to avoid hammering
the JWKS endpoint. They MUST revalidate immediately when they encounter an
unknown `kid` (cache miss on `kid` → fresh fetch → retry validation). If the
`kid` is still absent after a fresh fetch, the assertion is rejected.

**Route:** `apps/web/src/app/api/.well-known/jwks.json/route.ts`

### B.2 Key storage

Signing keypairs (private + public) are stored in the `secrets` table:

```
purpose        = 'signing_key'                   ← new SecretPurpose value
label          = '<kid>'                          ← e.g. 'buildd-2026-07'
encryptedValue = encrypt(JSON.stringify({
  privateKeyJwk: { kty, crv, d, x, y, kid, alg },
  publicKeyJwk:  { kty, crv, x, y, kid, alg, use }
}))
tokenExpiresAt = <Retiring window end>           ← null for Active; set when key enters Retiring
```

Add `'signing_key'` to `SecretPurpose` in `packages/core/secrets/types.ts` and
the `$type<...>` union on `secrets.purpose` in `packages/core/db/schema.ts`.

The JWKS endpoint reads all `purpose='signing_key'` rows for the buildd team,
decrypts them, extracts public key material, and returns the JWKS document.
Private key material is NEVER included in the JWKS response.

**Key generation:** On first boot (or if no Active signing key exists), the
JWKS rotation cron (§B.3) or a startup hook generates a new P-256 keypair
using the Web Crypto API (`crypto.subtle.generateKey`), serialises both
components as JWK, and stores the row. A `kid` is assigned as
`buildd-<YYYY>-<MM>` (month-of-generation).

### B.3 Rotation policy

| Phase | Duration | Behaviour |
|---|---|---|
| **Active** | 30 days | Appears in JWKS; all new assertions signed with this `kid`. |
| **Retiring** | 10 days | Still appears in JWKS; no new assertions use this key; assertions already signed with it remain valid at the RS until their `exp`. |
| **Revoked** | — | Removed from JWKS. Assertions with this `kid` fail RS validation at the next JWKS cache miss + revalidation. |

**Rotation cron:** `apps/web/src/app/api/cron/jwks-rotation/route.ts`, runs
weekly (every 7 days). Algorithm:

1. Query `purpose='signing_key'` rows.
2. If any key's age exceeds 30 days, generate a new keypair, insert it as Active.
3. Move the previous Active key to Retiring: set `tokenExpiresAt = NOW() + 10d`.
4. Delete any key whose `tokenExpiresAt < NOW()` (Retiring window expired).
5. At most 2 keys are present in the JWKS at any time.

**Revocation story:** Dropping a `kid` from the JWKS (by deleting or expiring
the secrets row) causes fleet-wide revocation. Resource servers that cached the
JWKS see the key vanish at their next revalidation (≤ 1 hour). Any in-flight
assertions bearing the revoked `kid` expire naturally within their 5-minute
`exp` window. Combined effect: revocation is complete within 65 minutes.

For **immediate revocation** (e.g. a compromised signing key), an admin calls a
forced rotation endpoint (`POST /api/cron/jwks-rotation?force=true`, admin auth
required). The new key is active immediately; the compromised key is marked
Retiring with a shortened window (set `tokenExpiresAt = NOW() + 10min` instead
of 10 days) so it is absent from the JWKS within minutes. RS caches that
refreshed on `kid`-miss will pick up the removal within seconds; those that did
not miss a `kid` will re-fetch within their TTL.

---

## C. Assertion Mint API

Workers request an assertion from buildd before opening an MCP connection to an
assertion-mode connector. The runner handles this autonomously; no user
interaction is required.

### C.1 Endpoint

```
POST /api/connectors/[id]/assertion
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "workerId": "<workerId>",
  "taskId":   "<taskId>"
}
```

**Success response `200 OK`:**

```json
{
  "assertion":      "<compact JWS>",
  "audience":       "https://cue.buildd.dev/api/mcp",
  "tokenEndpoint":  "https://cue.buildd.dev/api/oauth/token",
  "expiresAt":      "2026-07-17T00:05:00Z"
}
```

`expiresAt` is `iat + 300s` in ISO 8601. The runner MUST NOT cache the
assertion beyond this time; it re-mints for subsequent exchanges.

### C.2 Auth & scope constraints

- The caller MUST present a valid worker token (the same token issued by the
  claim route). Worker tokens that have been revoked (task completed, errored,
  or cancelled) return `401`.
- The route validates that `workerId` belongs to the authenticated worker and
  that `taskId` is the active task for that worker. Cross-worker minting
  returns `403`.
- The connector `[id]` MUST have `authMode: 'assertion'` and MUST be enabled
  for the workspace of the task (`connectorWorkspaces.enabled = true`). A
  connector not enabled for the workspace returns `403`.
- The connector's `assertionAudience` and `assertionTokenEndpoint` MUST be
  non-null; a misconfigured connector returns `500` (operator error).
- **Rate limit:** 12 mint requests per worker per connector per minute (covers
  the 5-minute TTL with burst headroom for reconnects). Excess returns `429`.
- The route signs with the current Active key. It MUST NOT use a Retiring key
  for new mints.

### C.3 Route location

`apps/web/src/app/api/connectors/[id]/assertion/route.ts`

---

## D. Resource-Server Contract

This section is prescriptive for buildd-owned MCP servers (Cue, dispatch). It
defines what any server must implement to accept assertion grants from buildd.
Third-party servers not owned by buildd are out of scope.

### D.1 Token endpoint

The RS exposes a standard OAuth 2.0 token endpoint:

```
POST https://cue.buildd.dev/api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer
&assertion=<compact JWS>
```

No client authentication is required — the signed JWT authenticates the caller.

### D.2 Validation steps (MUST be performed in order)

1. **Parse JWT header.** Extract `kid`. Reject malformed JWTs with `400
   invalid_request`.

2. **JWKS key lookup.** Fetch `https://buildd.dev/api/.well-known/jwks.json`
   from cache; locate the key with matching `kid`. If absent, flush cache and
   re-fetch once. If still absent after fresh fetch, return `400
   invalid_client` (`error_description: "unknown signing key"`).

3. **Signature verification.** Verify the JWT signature using the P-256 public
   key. Return `400 invalid_grant` on failure.

4. **Claims validation (all MUST pass):**

   | Claim | Required value | Error on failure |
   |---|---|---|
   | `iss` | `"https://buildd.dev"` (exact) | `invalid_grant` |
   | `aud` | RS's own configured audience string (exact) | `invalid_grant` |
   | `exp` | `> NOW` | `invalid_grant` (`"assertion expired"`) |
   | `iat` | `<= NOW + 60s` (clock skew tolerance) | `invalid_grant` (`"assertion not yet valid"`) |
   | `sub` | parseable as `<uuid>:<uuid>` | `invalid_grant` |
   | `jti` | present, 16+ bytes hex/uuid | `invalid_request` |

   The RS validates `aud` against its own configured audience — NEVER against
   a client-supplied or request-header value.

5. **Replay check.** Look up `jti` in a TTL store with retention of at least
   10 minutes (2× the 5-minute assertion TTL). If found, return `400
   invalid_grant` (`error_description: "assertion already used"`). Store `jti`
   on first successful pass.

   The RS MUST reject assertions rather than skip the replay check if the
   store is unavailable (fail closed).

6. **Tenant derivation.** Parse `sub` as `<accountId>:<teamId>`. Resolve the
   dispatch workspace / Cue organisation from the team ID. If not found,
   return `400 invalid_grant` (`error_description: "unknown tenant"`). MUST
   NOT use `X-Tenant-Id` or any other request header for tenant resolution.

7. **Mint access token.** Issue a short-lived access token:
   - TTL: 5–15 minutes (RS implementation choice; default 10 minutes).
   - Scopes: from `scope` claim in the assertion if present; otherwise RS
     default scope.
   - **NO refresh token** for this grant type. Mid-task refresh goes back to
     the buildd mint API (§C), not to the RS.
   - Token format: opaque or JWT (RS choice); buildd does not mandate format.

8. **Return `200 OK`:**

```json
{
  "access_token": "<token>",
  "token_type":   "Bearer",
  "expires_in":   600
}
```

### D.3 Error semantics (RFC 6749 §5.2)

| Condition | HTTP status | `error` |
|---|---|---|
| Malformed JWT (not parseable) | `400` | `invalid_request` |
| Missing `jti` | `400` | `invalid_request` |
| Invalid/expired signature | `400` | `invalid_grant` |
| `iss` mismatch | `400` | `invalid_grant` |
| `aud` mismatch | `400` | `invalid_grant` |
| Assertion expired (`exp < now`) | `400` | `invalid_grant` |
| Clock skew (`iat > now + 60s`) | `400` | `invalid_grant` |
| Replayed `jti` | `400` | `invalid_grant` |
| Tenant not found from `sub` | `400` | `invalid_grant` |
| Unknown `kid` (after JWKS refresh) | `400` | `invalid_client` |
| Replay store unavailable | `400` | `temporarily_unavailable` |
| RS rate limit | `429` | `slow_down` |

---

## E. Connector Schema Extension

### E.1 New `authMode` value

The `authMode` column on the `connectors` table gains a new value `'assertion'`:

```ts
// packages/core/db/schema.ts
authMode: text('auth_mode')
  .$type<'none' | 'header' | 'oauth' | 'assertion'>()
  .notNull()
  .default('none'),
```

### E.2 New columns

```sql
-- Migration: add to connectors table
ALTER TABLE connectors
  ADD COLUMN assertion_audience      TEXT,
  ADD COLUMN assertion_token_endpoint TEXT;
```

```ts
// Drizzle additions
assertionAudience:      text('assertion_audience'),
assertionTokenEndpoint: text('assertion_token_endpoint'),
```

**Invariants:**

- `authMode = 'assertion'` MUST have non-null `assertionAudience` and
  `assertionTokenEndpoint`. The API rejects creation/update violating this
  with `400 assertion_audience_required` / `400 assertion_token_endpoint_required`.
- `authMode = 'assertion'` MUST NOT have a credential row in `secrets` for
  this connector — the assertion is minted on demand, no stored token exists.
- `assertionAudience` is used verbatim as the `aud` claim in every minted
  assertion and MUST match what the RS validates against. Mismatches cause RS
  rejection.
- `assertionTokenEndpoint` is the RS token endpoint URL used by the runner for
  the exchange step (§F.1 step 3).

### E.3 Claim route injection (exchange metadata)

For assertion-mode connectors the claim route does NOT decrypt or return a
bearer token. Instead it returns **exchange metadata** — the information the
runner needs to perform the mint + exchange flow itself:

```ts
// Shape returned in the claim payload for assertion-mode connectors
interface AssertionConnectorEntry {
  type: 'http';
  url: string;             // connector.url — MCP server root URL
  assertionMode: true;
  mintApiUrl: string;      // 'https://buildd.dev/api/connectors/<id>/assertion'
  audience: string;        // connector.assertionAudience
  tokenEndpoint: string;   // connector.assertionTokenEndpoint
}
```

The existing `ConnectorMcpEntry` shape (from `generic-mcp-connectors.md` §D.1)
is extended: when `assertionMode: true`, the runner performs the exchange flow
(§F) before constructing the final MCP entry with an `Authorization: Bearer
<access_token>` header. The runner MUST NOT forward `mintApiUrl`,
`assertionMode`, or `tokenEndpoint` to the MCP SDK — those are runner-internal
orchestration fields only.

**Claim route code surface:**
`apps/web/src/app/api/workers/claim/route.ts` — in the connector injection
block, detect `connector.authMode === 'assertion'` and construct an
`AssertionConnectorEntry` instead of fetching a secret.

---

## F. Runner Exchange Flow

### F.1 Connection open (happy path)

```
1. Runner reads AssertionConnectorEntry from claim payload.

2. POST {mintApiUrl}
   Authorization: Bearer <workerToken>
   { workerId, taskId }
   → { assertion, audience, tokenEndpoint, expiresAt }

3. POST {tokenEndpoint}
   Content-Type: application/x-www-form-urlencoded
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   &assertion={assertion}
   → { access_token, token_type, expires_in }

4. Runner opens MCP connection to connector.url with:
   Authorization: Bearer {access_token}

5. Runner stores { connectorId, accessToken, expiresAt: now + expires_in }
   in a per-session token cache (in-memory only; never persisted to disk).
```

Steps 2–3 occur once per connector per task claim. The resulting access token
is reused for the full task lifetime, subject to mid-task refresh (§F.2).

### F.2 Mid-task re-auth (401 from MCP server)

When the MCP server returns a `401` on any tool call mid-task:

```
1. Runner receives 401 from connector tool call.
2. Runner clears the cached access token for this connector.
3. Runner re-mints: POST {mintApiUrl} → new assertion (5-minute TTL).
4. Runner re-exchanges: POST {tokenEndpoint} → new access_token.
5. Runner reconnects to the MCP server with the new access_token.
6. Runner retries the failed tool call exactly once.
   If still 401, surface as a hard error on the tool call (do not loop).
```

**No user intervention is required.** This is the key distinction from the
`oauth` mid-task flow (`generic-mcp-connectors.md` §E), which pauses the worker
and shows a "session expired" banner because user consent is needed to renew the
OAuth session. Assertion-mode reconnects are fully automatic: the runner holds
its own worker token and can re-mint at any time without user involvement.

**Explicit scope closure.** This section CLOSES `docs/design/generic-mcp-connectors.md`
§E for `authMode: 'assertion'` connectors:

- The worker status `paused_connector_auth` MUST NOT be set for assertion-mode
  connector 401s.
- The Pusher event `connector:auth_expired` MUST NOT be emitted for
  assertion-mode connector 401s.
- The dashboard "Reconnect" banner MUST NOT appear for assertion-mode connector
  401s.

§E of `generic-mcp-connectors.md` remains in force, unchanged, for `authMode:
'oauth'` connectors.

### F.3 Proactive token refresh

The runner SHOULD re-mint and re-exchange before the cached access token
expires. Recommended heuristic: if `now + 60s >= accessToken.expiresAt`, treat
the token as expired and perform steps 2–5 of §F.1 before the next tool call.
This avoids expiry mid-tool-execution for slow operations.

The proactive check runs at tool-call dispatch time, not on a background timer,
to avoid token churn on idle connections.

---

## G. Rollout

### G.1 Phase 1 — Cue (immediate)

Deploy order (each step must complete before the next):

1. **JWKS infrastructure** — `GET /api/.well-known/jwks.json` route; key
   generation in `secrets` table (`purpose='signing_key'`); rotation cron.
   Verify the endpoint returns valid JWK public keys.

2. **Schema migration** — add `assertion_audience` + `assertion_token_endpoint`
   columns; extend `authMode` check constraint to include `'assertion'`; add
   `'signing_key'` to `SecretPurpose`.

3. **Mint API** — `POST /api/connectors/[id]/assertion`; worker auth; rate
   limiting; sign with Active key.

4. **Claim route** — detect `authMode='assertion'`; return
   `AssertionConnectorEntry` (exchange metadata) instead of a decrypted token.

5. **Runner exchange flow** — implement §F.1 and §F.2 in
   `apps/runner/src/workers.ts`; handle `assertionMode: true` entries in
   `mcpConnectors`.

6. **Cue/dispatch server (cue.buildd.dev)** — implement §D.1–D.3: accept
   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant at the token endpoint;
   JWKS validation; replay store; tenant derivation from `sub`. Deploy and
   smoke-test.

7. **Connector row migration** — update the Cue connector row:
   `authMode: 'assertion'`, `assertionAudience: 'https://cue.buildd.dev/api/mcp'`,
   `assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token'`. Verify
   via a new task claim that the payload contains `AssertionConnectorEntry`.

### G.2 Phase 2 — dispatch / moa-ops

After Cue is stable (at least one week of clean task runs), apply §D to other
buildd-owned servers. No buildd-side changes are required — the JWKS
infrastructure, mint API, and claim route already support multiple
assertion-mode connectors.

### G.3 Static `x-api-key` deprecation timeline

| Date | Action |
|---|---|
| Phase 1 deploy + 0 days | `x-api-key` static path logs a deprecation warning on each use in Cue server. Cue connector row migrated to `authMode: 'assertion'`. |
| Phase 1 deploy + 30 days | `x-api-key` static path removed from Cue/dispatch server. All remaining teams using static keys are migrated. |
| Phase 1 deploy + 30 days | `DISPATCH_API_KEY` + `TENANT_ID` `mcp_credential` secrets deleted from DB after confirming no worker claims rely on them. |

The `mcp_credential` injection path in `claim/route.ts` remains for other
(non-Cue) `mcp_credential` secrets. Only the Cue-specific composite credential
is retired.

### G.4 Migration & backcompat notes

- **In-flight tasks at migration time** retain their `header`-mode claim
  payload for the duration of the task (claim payloads are immutable per
  issued worker). They complete normally via `x-api-key`. The static path must
  remain on the Cue server until the runner version supporting assertion
  exchange is fully deployed (step 5 above must precede step 7).

- **Runner version gate.** The runner update (step 5) MUST be deployed before
  the connector row migration (step 7). A runner that does not understand
  `assertionMode: true` would receive exchange metadata it cannot use and fail
  to mount the connector. Deploy runner first; verify with a canary claim.

- **Rollback plan.** If the connector row migration is reverted (row set back
  to `authMode: 'header'`), the claim route immediately resumes injecting the
  static `x-api-key` header from `mcp_credential` secrets. The static path on
  the Cue server must still be present during this window (do not remove it
  until the assertion path is confirmed stable).

---

## H. Threat Model

### H.1 Assertion replay (`jti`)

**Attack.** An adversary intercepts a signed assertion and presents it to the
RS token endpoint a second time to obtain a second access token.

**Mitigation.** The RS tracks each `jti` in a TTL store for 10 minutes (2× the
5-minute TTL). A replayed `jti` returns `400 invalid_grant`. Even if the replay
store is momentarily unavailable, the assertion's 5-minute `exp` bounds the
abuse window.

**Fail-closed.** If the replay store is unavailable, the RS MUST reject all
assertions (§D.2 step 5). Accepting without replay check turns a
store outage into a replay window — that tradeoff is unacceptable.

### H.2 Audience confusion

**Attack.** A compromised runner mints an assertion legitimately for audience A
(e.g. `cue.buildd.dev`) then presents it to audience B's token endpoint to gain
unauthorised access.

**Mitigation.** The RS validates `aud` against its own locally-configured
audience string — never against a client-supplied value. An assertion bearing
`aud: "https://cue.buildd.dev/..."` is rejected by any other RS whose
configured audience differs. The RS audience configuration is operator-controlled
and not accessible to the runner.

**Defense in depth.** The mint API (§C.2) validates that the connector whose
audience is being requested is enabled for the task's workspace. A runner cannot
mint an assertion for a connector its workspace has not opted into.

### H.3 JWKS poisoning / cache TTL abuse

**Attack 1 — JWKS poisoning.** An adversary serves a malicious JWKS at
`buildd.dev/api/.well-known/jwks.json` by compromising the CDN, a DNS hijack,
or an MITM on the RS's outbound fetch.

**Mitigation.** The RS pins the JWKS URL to `https://buildd.dev/...` in its
configuration — it is never taken from the assertion itself. The fetch uses
TLS; the RS validates the server certificate. TLS certificate pinning is
optional but recommended for production Cue deployments.

**Attack 2 — cache TTL abuse.** An adversary steals a signing private key and
then delays the RS's JWKS revalidation by exploiting the 1-hour `max-age`, so
the compromised key remains accepted after rotation.

**Mitigation.** Max cache TTL is 1 hour. Forced rotation (§B.3) shortens the
compromised key's Retiring window to 10 minutes. RS deployments SHOULD support
a forced JWKS cache flush endpoint accessible to the buildd ops team. Combined
effect: compromised key no longer accepted within 70 minutes of forced rotation.
Outstanding access tokens minted with assertions from the compromised key expire
within their 5–15 minute TTL.

### H.4 Clock skew

**Attack.** A worker or RS with a sufficiently skewed clock accepts expired
assertions or rejects valid ones, causing either a security gap or an
availability failure.

**Mitigation.** The RS enforces ±60s clock tolerance on `iat` (§D.2 step 4).
The 5-minute `exp` window provides adequate slack for NTP-synchronized
deployments where skew is typically < 5 seconds. Assertion expiry
(`exp < now - 60s`) is never forgiven — a stale assertion always fails.

### H.5 Compromised worker blast radius

**Attack.** A worker token is exfiltrated; an adversary uses it to mint
assertions indefinitely without detection.

**Mitigation:**

1. Worker tokens are revoked when a task completes, errors, or is cancelled
   (existing behaviour). A revoked token returns `401` from the mint API
   immediately, cutting off assertion minting.

2. The mint API validates that `workerId + taskId` belongs to the
   authenticated worker. An adversary holding a token for worker W cannot mint
   assertions for worker W2's task.

3. Even if minting succeeds before revocation, each resulting access token has a
   5–15 minute TTL. The blast radius of a compromised worker token is bounded
   by the time between compromise and task completion (plus one TTL window).

4. The `act.sub` claim in every assertion records the worker ID, providing an
   audit trail at the RS. The RS can log minting events correlated to the
   assertion's `act.sub` + `jti`, enabling forensic analysis.

5. The mint rate limit (§C.2) constrains token volume from a compromised worker.

---

## I. Open Questions

The following are flagged for product/operator review; they are not decisions
for the spec author to resolve:

1. **Replay store technology (Cue/dispatch-side).** Redis is the preferred
   backing store for multi-instance deployments. An in-process LRU is
   acceptable for development but creates a replay gap across instances in
   production. For Cue deployments on Cloudflare Workers, a KV store with
   per-entry TTL is required — in-process state is per-isolate and leaks
   replay protection across the fleet. Cue team to confirm deployment topology
   and choose accordingly.

2. **`sub` stability.** Using `accountId:teamId` couples the assertion `sub`
   to buildd's internal UUIDs. If account merges or ID recycling ever occur,
   the RS may resolve the wrong tenant. A stable opaque `sub` derived from a
   hash (or a stable `sub` + a separate `tenant` claim) would decouple this.
   Deferred — no migration is needed today, but noted for a v2 assertion format.

3. **Scope parameterisation.** The spec allows a `scope` claim in the assertion
   for RS-side scoping. Should the mint API accept a `scope` parameter from the
   runner, or should scope be hardcoded to full-access? Cue team to confirm
   what scopes they expose before the runner calls the mint API with a scope.

4. **JWKS edge caching.** The `/api/.well-known/jwks.json` route is read-heavy
   during periods of many simultaneous worker claims. Vercel's edge cache or a
   CloudFront distribution in front of the origin is recommended to keep latency
   low. No spec change needed — this is an infrastructure decision orthogonal to
   the protocol.

5. **Third-party assertion mode.** If a non-buildd MCP server wants to accept
   buildd assertions (e.g. a partner service), the JWKS endpoint and RS contract
   in §D are fully sufficient — no buildd changes required. The partner operator
   registers `buildd.dev` as a trusted issuer, validates per §D, and creates a
   connector row with `authMode: 'assertion'`. Document this as a connector
   integration guide when the first external case arises.

---

## J. OAuth AS Metadata Update

`apps/web/src/app/.well-known/oauth-authorization-server/route.ts` must be
updated to advertise the JWKS endpoint and the jwt-bearer grant type:

```ts
return NextResponse.json({
  issuer,
  authorization_endpoint: `${issuer}/api/oauth/authorize`,
  token_endpoint:          `${issuer}/api/oauth/token`,
  registration_endpoint:   `${issuer}/api/oauth/register`,
  logo_uri:                `${issuer}/logo.png`,
  jwks_uri:                `${issuer}/api/.well-known/jwks.json`,                 // ← new
  response_types_supported: ['code'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',                               // ← new
  ],
  code_challenge_methods_supported:        ['S256'],
  token_endpoint_auth_methods_supported:   ['none'],
  scopes_supported: OAUTH_SCOPES,
});
```

This is a non-breaking additive change. The `jwks_uri` points to buildd's JWKS
endpoint (§B.1). Advertising `urn:ietf:params:oauth:grant-type:jwt-bearer`
allows compliant OAuth clients and MCP servers to discover the grant type
without out-of-band documentation.

---

## K. Non-Goals

The following are explicitly out of scope for this spec:

1. **Existing `authorization_code` / `refresh_token` flows** — unchanged.
   `apps/web/src/lib/oauth/tokens.ts` HS256 signing is untouched; those tokens
   serve claude.ai, not MCP-to-worker auth.

2. **External (`mcpConnectors`) non-buildd-owned servers** — continue to use
   resolved connector credentials (Bearer header or OAuth access token) injected
   at claim time. The assertion flow applies only to connectors with
   `authMode: 'assertion'` that implement a token endpoint per §D.

3. **Per-workspace signing keys** — a single global signing key is sufficient.
   Tenant isolation is enforced by the RS access token, not by issuing
   per-workspace keys.

4. **Runner-side key caching across tasks** — the runner is stateless between
   claims. Each claim returns fresh `AssertionConnectorEntry` metadata; no
   long-lived key material resides in the runner process.

5. **Explicit assertion revocation** — assertions are short-lived (5 min) and
   single-use (`jti`). Explicit revocation is not needed at this TTL. Worker
   token revocation (§H.5) cuts off the ability to re-mint new assertions,
   which is the effective revocation path.

---

## L. File Map

| File | Change |
|------|--------|
| `packages/core/db/schema.ts` | Add `'assertion'` to `authMode`; add `assertionAudience` + `assertionTokenEndpoint` columns; add `'signing_key'` to `SecretPurpose` |
| `packages/core/drizzle/` | Migration for new columns and `authMode` check constraint |
| `packages/shared/src/types.ts` | Add `AssertionConnectorEntry` interface |
| `apps/web/src/app/api/.well-known/jwks.json/route.ts` | New — serve public JWK set (§B.1) |
| `apps/web/src/app/api/connectors/[id]/assertion/route.ts` | New — assertion mint API (§C) |
| `apps/web/src/app/api/workers/claim/route.ts` | Detect `authMode='assertion'`; return `AssertionConnectorEntry` instead of decrypted token (§E.3) |
| `apps/web/src/app/api/cron/jwks-rotation/route.ts` | New — weekly key rotation cron (§B.3) |
| `apps/web/src/app/.well-known/oauth-authorization-server/route.ts` | Add `jwks_uri` + jwt-bearer grant type (§J) |
| `apps/runner/src/workers.ts` | Exchange assertion at connect time; re-mint + re-exchange on 401 (§F) |
