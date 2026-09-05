---
title: OAuth Provider & Signing Keys
status: active
owner: max
last_verified: 2026-09-05
summary: buildd's OAuth provider surface MUST issue only workspace-scoped PKCE-protected tokens to registered clients, and its JWKS MUST publish the public half of every key that can verify a buildd assertion.
domain: auth
surfaces: [apps/web/src/app/api/oauth/token/route.ts, apps/web/src/lib/signing-keys.ts, apps/web/src/lib/signing-key-windows.ts, apps/web/src/app/api/.well-known/jwks.json/route.ts]
related: [auth-oauth-boundaries, credential-isolation, external-cron-triggers, mcp-action-contracts]
keywords: [rfc 7591, dynamic client registration, rfc 9728, resource_metadata, jwks, kid, es256, hs256, code_challenge, signing_key, assertion grant]
verified_by: [apps/web/src/lib/oauth/tokens.test.ts, apps/web/src/app/api/oauth/authorize/route.test.ts, apps/web/src/app/api/oauth/token/route.test.ts, apps/web/src/app/api/cron/jwks-rotation/route.test.ts, apps/web/src/app/api/connectors/[id]/assertion/route.test.ts, apps/web/src/lib/signing-key-windows.test.ts, apps/web/src/app/api/well-known-jwks-route.test.ts, apps/web/src/app/well-known-oauth-authorization-server-route.test.ts]
supersedes: []
---
# OAuth Provider & Signing Keys

**Capability statement**: When buildd acts as an identity provider — registering
OAuth clients, running the authorize/token endpoints, and publishing a JWKS —
every token it mints MUST be bound to exactly one workspace, and every public
key needed to verify a buildd-issued assertion MUST be retrievable from
`GET /api/.well-known/jwks.json`.

This spec covers the **provider** side only. How buildd authenticates *inbound*
credentials (`bld_*` key vs OAuth JWT, per-`authType` limits, level gating) is
`auth-oauth-boundaries.md`.

## Two disjoint signing systems

buildd signs two unrelated token families, and confusing them is the most
likely reader error:

| Token family | Algorithm | Key material | Verifier | Discoverable? |
|---|---|---|---|---|
| MCP access token (`/api/oauth/token`) | HS256 (symmetric) | `OAUTH_JWT_SECRET` → `AUTH_SECRET` → `NEXTAUTH_SECRET` env fallback chain (`apps/web/src/lib/oauth/config.ts:36-42`) | buildd itself only | No — never appears in JWKS |
| Cross-app assertion (`/api/connectors/[id]/assertion`) | ES256 (P-256 keypair) | `secrets` rows with `purpose = 'signing_key'` | third-party resource servers | Yes — JWKS |

The JWKS endpoint therefore says **nothing** about MCP access tokens. A reader
debugging a rejected MCP token by inspecting JWKS is looking at the wrong
system.

---

## Discovery & Dynamic Client Registration

**Invariants**:
- `GET /.well-known/oauth-authorization-server` MUST advertise
  `code_challenge_methods_supported: ['S256']` and
  `token_endpoint_auth_methods_supported: ['none']` — the provider registers
  public clients only and no code path issues a `client_secret`.
- `GET /.well-known/oauth-protected-resource/api/mcp-oauth/<workspace>` MUST
  return `resource` equal to `${issuer}/api/mcp-oauth/<workspace>` — the same
  string used as the `aud` claim by `getResourceUrl()`, so metadata and token
  audience cannot disagree.
- On an unauthenticated MCP call, `/api/mcp-oauth/[workspace]` MUST return HTTP
  401 carrying `WWW-Authenticate: Bearer realm="buildd",
  resource_metadata="<protected-resource URL>"` (RFC 9728) so a client can
  autodiscover the authorization server with no static configuration.
- `POST /api/oauth/register` MUST reject a body without at least one parseable
  URL in `redirect_uris` with HTTP 400 `invalid_client_metadata`.
- Registration is unauthenticated by design (RFC 7591 open registration). The
  registered `client_id` alone therefore proves nothing; client identity rests
  entirely on PKCE, exact `redirect_uri` matching, and the interactive consent
  step below.
- On Vercel production, `getIssuer()` MUST return the canonical
  `https://buildd.dev` and MUST NOT return a per-deploy `VERCEL_URL` host —
  clients cache the issuer, and a preview host rots when that deployment is
  replaced.

**Acceptance criteria**:
- AC-1: WHEN `GET /.well-known/oauth-authorization-server` is called THEN the
  JSON body contains `code_challenge_methods_supported: ["S256"]` and does NOT
  contain `plain`.
- AC-2: WHEN `POST /api/oauth/register` is called with `{}` THEN the server
  returns HTTP 400 with `error: "invalid_client_metadata"`.
- AC-3: WHEN `POST /api/oauth/register` is called with one valid
  `redirect_uris` entry THEN the server returns HTTP 201 with a `client_id`
  prefixed `c_` and `token_endpoint_auth_method: "none"`.
- AC-4: GIVEN no `Authorization` header WHEN `POST /api/mcp-oauth/<ws>` is
  called THEN the response is HTTP 401 and its `WWW-Authenticate` header
  contains `resource_metadata=`.
- AC-5: WHEN `GET /api/mcp-oauth/<ws>` is called THEN the server returns HTTP
  405 (stateless; no SSE).

**Code surface**:
- AS metadata: `apps/web/src/app/.well-known/oauth-authorization-server/route.ts:6-31`
- Protected-resource metadata: `apps/web/src/app/.well-known/oauth-protected-resource/api/mcp-oauth/[workspace]/route.ts:17-22`
- DCR: `apps/web/src/app/api/oauth/register/route.ts:10-16` (schema), `:33-49` (response)
- Client row: `apps/web/src/lib/oauth/storage.ts:16-29` — `createClient()`
- 401 hint + 405: `apps/web/src/app/api/mcp-oauth/[workspace]/route.ts:51-61`, `:254-257`
- Issuer resolution: `apps/web/src/lib/oauth/config.ts:12-26` — `getIssuer()`
- Schema: `packages/core/db/schema.ts:2076-2083` — `oauthClients`

---

## Authorize endpoint — consent binds exactly one workspace

**Invariants**:
- `client_id` and `redirect_uri` MUST both be present and the `redirect_uri`
  MUST satisfy `isRegisteredRedirectUri()` before any other validation runs;
  failures return a plain-text HTTP 400 and MUST NOT redirect (an unvalidated
  redirect target is never followed).
- `isRegisteredRedirectUri()` MUST match non-loopback URIs by exact string.
  Loopback URIs (`localhost`, `127.0.0.1`, `[::1]`, `::1`) MUST match only when
  protocol, port, path, and query are all equal — hostname is the only
  component allowed to differ.
- `response_type` other than `code`, a missing `code_challenge`, or
  `code_challenge_method !== 'S256'` MUST fail. `plain` PKCE is unreachable
  even though the parameter defaults to `'plain'` when omitted.
- An unauthenticated user MUST be sent through NextAuth signin with
  `callbackUrl` set to the same authorize URL — the authorization request is
  never dropped, and no code is minted before a session exists.
- A code MUST NOT be minted until the session user's workspace access is
  re-checked against `teamMembers` at authorize time
  (`workspacesForUser()`); a `workspace` param the user cannot reach returns
  HTTP 403.
- Every minted `oauthCodes` row MUST carry `(clientId, userId, workspaceId,
  redirectUri, codeChallenge)`. There is no "all workspaces" code: the column
  is `NOT NULL`.
- After minting, the user MUST see an interstitial naming the workspace the
  connector was scoped to before the redirect fires. This exists because of the
  2026-05-25 misroute incident, where a user with three buildd connectors could
  not tell which workspace they had just authorized.

**Acceptance criteria**:
- AC-6: GIVEN a client registered with `http://localhost:41776/callback/x` WHEN
  authorize is called with `redirect_uri=http://127.0.0.1:41776/callback/x`
  THEN `isRegisteredRedirectUri` returns `true`.
- AC-7: GIVEN the same client WHEN the requested `redirect_uri` differs in port
  or path THEN `isRegisteredRedirectUri` returns `false` and the route returns
  HTTP 400 `redirect_uri not registered for this client`.
- AC-8: GIVEN a registered `redirect_uri` and a logged-in session WHEN
  `code_challenge_method=plain` is supplied THEN the response is a redirect to
  the client carrying `error=invalid_request` and no `oauthCodes` row is created.
- AC-9: GIVEN a logged-in user with no membership in the requested workspace's
  team WHEN authorize is called with that `workspace` THEN the server returns
  HTTP 403 and no code is minted.
- AC-10: GIVEN a logged-in user with ≥1 workspace and no `workspace` param
  WHEN authorize is called THEN the response is HTTP 200 `text/html` listing
  each accessible workspace (picker), not a redirect.

**Code surface**:
- Route: `apps/web/src/app/api/oauth/authorize/route.ts:83-176`
- Redirect-URI matcher: same file `:23-51` — `isRegisteredRedirectUri()`
- Access re-check: same file `:57-69` — `workspacesForUser()`
- Consent interstitial: same file `:230-268` — `renderAuthorizedInterstitial()`
- Code persistence: `apps/web/src/lib/oauth/storage.ts:36-59` — `createAuthCode()`
- Schema: `packages/core/db/schema.ts:2085-2099` — `oauthCodes`

---

## Token endpoint — single-use codes, rotating refresh, workspace-pinned JWT

**Invariants**:
- Only `authorization_code` and `refresh_token` grants are accepted; anything
  else returns HTTP 400 `unsupported_grant_type`. No `jwt-bearer` /
  assertion grant is implemented on buildd's own token endpoint.
- A content type that is neither `application/x-www-form-urlencoded` nor
  `application/json` MUST return HTTP 400 `invalid_request`.
- `consumeAuthCode()` MUST reject unless all of: the row exists with
  `consumedAt IS NULL`, `expiresAt` is in the future, `clientId` matches,
  `redirectUri` matches the value bound at authorize time, and
  base64url(SHA-256(`code_verifier`)) equals the stored `codeChallenge`. Every
  failure collapses to `invalid_grant` — the response MUST NOT distinguish
  which check failed.
- Redemption MUST set `consumedAt`, making the code single-use.
  `AUTH_CODE_TTL_SECONDS` is 600.
- `consumeRefreshToken()` MUST set `revokedAt` on the presented token before
  the caller mints a replacement, so refresh tokens rotate on every use.
  `REFRESH_TOKEN_TTL_SECONDS` is 90 days and bounds the absolute chain length.
- Every issued access token MUST carry `sub` (userId), `client_id`, `scope`,
  `workspace_id`, `iss = getIssuer()`, and
  `aud = getResourceUrl(workspaceId)`, and expire after
  `ACCESS_TOKEN_TTL_SECONDS` (3600).
- `verifyAccessToken(token, expectedWorkspaceId)` MUST return `null` when the
  signature is bad, the issuer differs, the audience is another workspace's
  resource URL, or `workspace_id !== expectedWorkspaceId`. A token minted for
  workspace A MUST NOT authenticate against workspace B.
- Both grants MUST call `ensureUserAccount()`, which provisions a
  `type: 'user'`, `authType: 'oauth'` account for the workspace's team when
  none exists, and MUST swallow its own failures — a provisioning error MUST
  NOT block the token response.
- All token responses MUST set `cache-control: no-store`.

**Acceptance criteria**:
- AC-11: GIVEN a signed access token for workspace A WHEN
  `verifyAccessToken(token, B)` is called THEN it returns `null`.
- AC-12: GIVEN a signed access token WHEN one character of its signature
  segment is altered and it is verified against its own workspace THEN
  `verifyAccessToken` returns `null`.
- AC-13: WHEN `POST /api/oauth/token` is called with
  `grant_type=client_credentials` THEN the server returns HTTP 400 with
  `error: "unsupported_grant_type"`.
- AC-14: GIVEN a workspace whose team has no `type: 'user'` account WHEN either
  grant succeeds THEN exactly one `accounts` row is inserted with
  `type: 'user'`, `authType: 'oauth'`, and a hashed `bld_` key.
- AC-15: GIVEN a workspace whose team already has a `type: 'user'` account WHEN
  either grant succeeds THEN no `accounts` row is inserted.
- AC-16: GIVEN a `workspaceId` that resolves to no `workspaces` row WHEN the
  grant succeeds THEN no account is created and the token is still returned.

**Code surface**:
- Route: `apps/web/src/app/api/oauth/token/route.ts:81-176`
- Account provisioning: same file `:27-60` — `ensureUserAccount()`
- Code + refresh redemption: `apps/web/src/lib/oauth/storage.ts:67-91`,
  `:118-139` — `consumeAuthCode()`, `consumeRefreshToken()`
- Signing/verification: `apps/web/src/lib/oauth/tokens.ts:16-87` —
  `signAccessToken()`, `verifyAccessToken()`, `verifyAccessTokenAnyAudience()`
- Lifetimes: `apps/web/src/lib/oauth/config.ts:6-10`
- Schema: `packages/core/db/schema.ts:2101-2115` — `oauthRefreshTokens`

---

## Signing keys — storage, lifecycle, and what JWKS publishes

**Invariants**:
- Signing keys are P-256 ECDSA keypairs stored as one `secrets` row per key
  with `purpose = 'signing_key'`, `label = <kid>`, and the JSON
  `{ privateKeyJwk, publicKeyJwk }` blob in the encrypted `encryptedValue`
  column. `tokenExpiresAt IS NULL` means **Active**; a future `tokenExpiresAt`
  means **Retiring**.
- `getActiveSigningKey()` MUST select the oldest row with
  `tokenExpiresAt IS NULL` and MUST return `null` when none exists. Callers
  MUST treat `null` as a hard failure rather than signing with a Retiring key.
- `getAllPublicKeys()` MUST return only `publicKeyJwk` material. No route
  returns `privateKeyJwk` to any caller.
- `GET /api/.well-known/jwks.json` MUST respond with an RFC 7517 `keys` array
  whose entries carry `kid`, `use: "sig"`, `alg: "ES256"`, and the public
  coordinates.
- The JWKS response MUST distinguish the relying party's cache lifetime from a
  shared cache's. `max-age` MAY be long (currently one hour) because relying
  parties are also required to flush on an unknown `kid`; `s-maxage` plus
  `stale-while-revalidate` MUST NOT, because an intermediary answers that flush
  from its own copy and so decides how long a new key stays unpublished and a
  revoked one stays trusted. Their sum MUST stay well below
  `RETIRING_WINDOW_FORCE_MS`, or forced revocation cannot deliver the
  "absent from the JWKS within minutes" property it exists for. Constants and
  the asserted relation live in `apps/web/src/lib/signing-key-windows.ts`.
- The authorization-server metadata document MUST advertise `jwks_uri`. The key
  set does not sit at root `/.well-known/`, so RFC 8414 discovery is the only
  way a client can locate it without hardcoding a path. It MUST also list the
  assertion grant in `grant_types_supported`.
- Assertion `iss` MUST come from `getIssuer()`, never a literal. A literal makes
  every deployment claim the production issuer while signing with the same
  production key set, which a resource server checking `iss` cannot distinguish.
- The endpoint MUST self-bootstrap: when zero `signing_key` rows exist it
  creates an Active key and serves it in the same request. Bootstrapping
  requires `BUILDD_SIGNING_KEY_TEAM_ID`; without it `createActiveSigningKey()`
  throws and the endpoint returns HTTP 500 `internal_error`.
- `GET /api/cron/jwks-rotation` MUST return HTTP 401 unless the Bearer token
  equals `CRON_SECRET`, and HTTP 500 when `CRON_SECRET` is unset.
- Rotation MUST mint a new Active key when there is no Active key, when the
  Active key's `createdAt` is older than 30 days, or when `force=true`; and
  MUST move the previous Active key to Retiring by setting `tokenExpiresAt` to
  now + 10 days (now + 10 minutes under `force=true`, the fast-revocation path).
- Rotation MUST delete every row whose `tokenExpiresAt` is already in the past.
  Deletion of expired keys happens **only** here.
- **The rotation cron is staged dark.** `cron-manifest.json` carries
  `/api/cron/jwks-rotation` with `enabled: false` and the standing comment that
  no trigger has ever existed — so in production no signing key has ever
  rotated, no Active key has ever aged out, and no expired key has ever been
  deleted. Every property in the two invariants above is unit-tested and
  unexercised in production. An unrotated key widens the window in which a key
  that leaked at any point stays trusted by every resource server, indefinitely.

**Acceptance criteria**:
- AC-17: GIVEN zero `signing_key` rows WHEN the rotation cron runs with a valid
  `CRON_SECRET` THEN the response is HTTP 200 with `rotated: true` and exactly
  one keypair is generated and stored.
- AC-18: GIVEN an Active key created 20 days ago WHEN the rotation cron runs
  THEN the response has `rotated: false` and no keypair is generated.
- AC-19: GIVEN an Active key created 31 days ago WHEN the rotation cron runs
  THEN `rotated: true`, one new keypair is stored, and the previous row's
  `tokenExpiresAt` is set.
- AC-20: GIVEN a Retiring key whose `tokenExpiresAt` passed 1 day ago WHEN the
  rotation cron runs THEN that secret is deleted and `deletedExpiredKeys` is 1.
- AC-21: GIVEN a Retiring key whose `tokenExpiresAt` is 5 days in the future
  WHEN the rotation cron runs THEN no secret is deleted and
  `deletedExpiredKeys` is 0.
- AC-22: GIVEN an Active key created 20 days ago WHEN the rotation cron runs
  with `force=true` THEN `rotated: true` and a new keypair is generated.
- AC-23: WHEN the rotation cron is called with a Bearer token that is not
  `CRON_SECRET` THEN the server returns HTTP 401.

**Code surface**:
- Key service: `apps/web/src/lib/signing-keys.ts:33-53` (`generateSigningKeypair`),
  `:59-90` (`getActiveSigningKey`), `:96-117` (`getAllPublicKeys`),
  `:135-145` (`createActiveSigningKey`), `:148-185` (`signAssertion`)
- JWKS route: `apps/web/src/app/api/.well-known/jwks.json/route.ts:15-46`
- Rotation cron: `apps/web/src/app/api/cron/jwks-rotation/route.ts:42-127`
- Dark-staged trigger: `cron-manifest.json` — `"Buildd: JWKS Rotation"`,
  `enabled: false`
- Encryption at rest: `packages/core/secrets/postgres-provider.ts:86-92`,
  `packages/core/secrets/crypto.ts:20-43`
- Schema: `packages/core/db/schema.ts:1490-1544` — `secrets.purpose`
  (`'signing_key'`), `secrets.label`, `secrets.tokenExpiresAt`

---

## Assertion minting — the only consumer of the signing key

**Invariants**:
- `POST /api/connectors/[id]/assertion` MUST authenticate with a `bld_*`
  account key, MUST verify the named worker belongs to that account, MUST
  reject workers in `completed | error | cancelled` (worker credential
  revocation), and MUST reject a `taskId` that is not the worker's active task.
- The connector MUST have `authMode = 'assertion'` and non-null
  `assertionAudience` + `assertionTokenEndpoint`; a missing
  `connectorWorkspaces` row counts as enabled, an explicit `enabled = false`
  MUST return HTTP 403 (identical convention to the claim route).
- Minting MUST fail closed with HTTP 500 `No active signing key` when
  `getActiveSigningKey()` returns `null`. This is the one place in the signing
  chain with an explicit "no key" guard.
- The assertion MUST be ES256, MUST carry the Active key's `kid` in its header,
  and MUST have claims `iss`, `sub = "<accountId>:<teamId>"`,
  `act = { sub: "worker:<workerId>", tid: <taskId> }`, `aud =
  connector.assertionAudience`, a 128-bit random `jti`, and `exp - iat = 300`.
- Every mint MUST use a fresh `jti`.
- Mint rate is limited to 12 per (worker, connector) per minute via Redis, and
  MUST fail open when Redis is unconfigured or erroring.

**Acceptance criteria**:
- AC-24: GIVEN no Active signing key WHEN a mint is requested THEN the server
  returns HTTP 500 and no assertion is returned.
- AC-25: GIVEN a valid worker/task/connector triple WHEN a mint is requested
  THEN the response carries `assertion`, `audience`, `tokenEndpoint`, and an
  `expiresAt` between 270s and 310s in the future.
- AC-26: GIVEN a worker whose `status` is `completed` WHEN a mint is requested
  THEN the server returns HTTP 401 `Worker token has been revoked`.
- AC-27: GIVEN two consecutive mints for the same worker and connector THEN the
  two assertions carry different `jti` values.
- AC-28: GIVEN a connector with `authMode !== 'assertion'` WHEN a mint is
  requested THEN the server returns HTTP 403.

**Code surface**:
- Route: `apps/web/src/app/api/connectors/[id]/assertion/route.ts:45-188`
- No-key guard: same file `:148-153`
- Rate limit: same file `:28-40` — `checkRateLimit()`
- Signer: `apps/web/src/lib/signing-keys.ts:148-185` — `signAssertion()`
- Design origin: `docs/design/cross-app-assertion-grant.md` §A–§C

---

## CLI and device-code key issuance

**Invariants**:
- `GET /api/auth/cli` MUST reject any `callback` whose hostname is not
  `localhost` or `127.0.0.1` with HTTP 400, and MUST require a NextAuth session
  before issuing anything.
- The CLI flow returns a **plaintext `bld_*` API key in the redirect query
  string**, and MUST store only `hashApiKey()` output in `accounts.apiKey`.
  Re-running the flow for an existing account name MUST rotate that account's
  key (the prior plaintext is unrecoverable), so a second CLI login invalidates
  the first machine's key.
- `POST /api/auth/device/code` is unauthenticated and MUST issue a 15-minute
  `deviceCodes` row with a unique human `userCode` and an opaque `deviceToken`;
  the requested `level` MUST be normalised into `trigger | worker | admin`.
- `POST /api/auth/device/approve` MUST require a session and MUST transition
  the row via an atomic `UPDATE ... WHERE status = 'pending'` so a code is
  approved at most once. An approved-but-expired row MUST be flipped to
  `expired` and rejected with HTTP 400.
- `POST /api/auth/device/token` MUST return HTTP 428 while `pending`, HTTP 400
  for unknown/expired tokens, and on the first successful poll MUST return the
  plaintext key and immediately null `deviceCodes.apiKey` — one-time retrieval.

**Acceptance criteria**:
- AC-29: WHEN `GET /api/auth/cli?callback=https://evil.example/cb` is called
  THEN the server returns HTTP 400 `Callback must be localhost`.
- AC-30: GIVEN a `pending` device code WHEN the CLI polls
  `/api/auth/device/token` THEN the server returns HTTP 428
  `authorization_pending` and no key is returned.
- AC-31: GIVEN an `approved` device code with a stored key WHEN the CLI polls
  twice THEN the first response carries `api_key` and the second returns HTTP
  400 (`apiKey` was cleared).
- AC-32: GIVEN a device code already in `approved` status WHEN approve is
  called again with the same `userCode` THEN the server returns HTTP 400
  (the `status = 'pending'` predicate matched no row).

**Code surface**:
- CLI flow: `apps/web/src/app/api/auth/cli/route.ts:35-159`
- Device flow: `apps/web/src/app/api/auth/device/code/route.ts:30-63`,
  `apps/web/src/app/api/auth/device/approve/route.ts:16-113`,
  `apps/web/src/app/api/auth/device/token/route.ts:12-78`
- Key hashing: `apps/web/src/lib/api-auth.ts` — `hashApiKey()`,
  `extractApiKeyPrefix()`
- Schema: `packages/core/db/schema.ts:1547-1562` — `deviceCodes`

---

## Out of scope

- Inbound authentication and per-`authType` limits for tokens once issued —
  `auth-oauth-boundaries.md` (that spec's "OAuth 2.1 PKCE" and "CLI
  Device-Code Auth" sections are the caller-facing summary of the flows
  specified here in provider detail).
- The MCP action surface reachable with an OAuth token —
  `mcp-action-contracts.md`.
- buildd as an OAuth **client** against third-party MCP servers (connector
  credential storage, refresh sweeps) — `mcp-connectors-and-roles.md` and
  `credential-isolation.md`.
- The resource-server half of the assertion grant (JWT validation, replay
  cache, tenant provisioning), which lives in the consuming app, not this repo.
- Cron delivery mechanics and the manifest reconciler —
  `external-cron-triggers.md`.
- NextAuth session/provider configuration (`/api/auth/[...nextauth]`).

---

## Verification gaps

Each entry is an invariant above with no automated test, or a place where code
and the design doc disagree. None of these are speculative — each is read
directly off the files cited.

> **On reading this list.** Eight of the fifteen entries here described defects
> that had already been fixed, and one of them claimed the opposite of the
> truth (that JWKS publishes expired keys). A stale gap list is worse than no
> gap list: an agent either re-fixes solved problems or trusts an inverted
> statement about a security primitive. Entry 3 is the instructive one — it
> asserted a gap by naming a path that does not exist
> (`.well-known/jwks.json/route.test.ts`), and the test had all along been
> deliberately placed elsewhere, because the unit-test runner skips dot
> directories. **Asserting a file's absence is not the same as asserting a
> behaviour is untested.** Closed entries are recorded under "Recently closed"
> below rather than deleted, so this does not read as an unexplained shrink.

1. **No self-check or alert for "no usable signing key".** Rotation now fires
   weekly and reports its own failures as a `critical` ops alert, but nothing
   probes the *health* of the key set between rotations. Because
   `provider.get()` decrypts with `ENCRYPTION_KEY`
   (`packages/core/secrets/crypto.ts:20-43`), a wiped or rotated
   `ENCRYPTION_KEY` makes `getAllPublicKeys()` throw and JWKS return HTTP 500
   for every caller — the failure mode is total, and the precedent exists: a
   production incident once returned JWKS 500 because the entire Vercel
   production environment had been wiped. The first signal would still be a
   third party's failed verification.

2. **Signing-key creation is not serialised.** The invariant is that creation
   of a signing key MUST be serialised, so that two callers racing on the
   bootstrap path cannot each insert an Active key and leave key selection
   ambiguous. No test asserts it. Specifics are tracked privately until the
   guard lands.

3. **Nothing asserts "at most 2 keys in JWKS".** Publication is correctly
   gated on expiry, and rotation retires exactly one predecessor, so the
   property holds by construction on the normal path. It is not enforced:
   repeated `?force=true` calls within one retiring window, or a raced
   bootstrap, can publish more, and no test or constraint bounds the count.

4. **JWKS is served from a path RFC 8414 clients cannot guess.** The document
   lives at `/api/.well-known/jwks.json` rather than root `/.well-known/`.
   Discovery now works because the metadata advertises `jwks_uri`, but a client
   that probes the conventional root path still gets a 404.

5. **The shared-cache bound is a policy, not a measurement.** The cache
   directives are asserted against the key lifecycle in
   `apps/web/src/lib/signing-key-windows.test.ts`, which is what makes the
   numbers meaningful. Nothing verifies that the CDN in front of production
   actually honours them. The old directives were measured — after the first
   live rotation the edge served a one-key document while origin served two,
   first fresh and then as `STALE` for hours past `max-age`, until a request
   triggered the background refresh. That is evidence about the values being
   replaced, not about the replacements.

6. **Single-use codes and refresh rotation are untested.**
    `apps/web/src/lib/oauth/storage.ts` has no test file. The `consumedAt`
    single-use guard, PKCE `code_challenge` comparison, `redirectUri` rebinding
    check, and `revokedAt` rotation are all asserted only by inspection.
    `auth-oauth-boundaries.md` AC-11/AC-12 state these as criteria; no test
    implements them.

7. **No test covers registration or discovery.** There is no test file for
    `/api/oauth/register`, `/.well-known/oauth-authorization-server`, or
    `/.well-known/oauth-protected-resource/...`. AC-1 through AC-5 are
    currently manual checks.

8. **Registered `redirect_uris` are not constrained to an allowed scheme
    set.** The invariant is that a redirect URI MUST be accepted at
    registration only within an allowed scheme set: `https:` plus loopback
    `http:`, with non-loopback `http:` and any non-HTTP scheme rejected at
    registration time. No test asserts it. Specifics are tracked privately
    until the guard lands.

9. **The HS256 secret has no rotation story.** `getJwtSecret()` falls back
    through `OAUTH_JWT_SECRET → AUTH_SECRET → NEXTAUTH_SECRET`
    (`apps/web/src/lib/oauth/config.ts:36-42`). Access tokens carry no `kid`
    and there is no two-key overlap window, so changing that secret invalidates
    every outstanding MCP access token at once — and where the fallback lands on
    `AUTH_SECRET`, the same value signs NextAuth sessions.

10. **The authorize-time workspace access check is not tested.** Only
    `isRegisteredRedirectUri` has coverage in
    `apps/web/src/app/api/oauth/authorize/route.test.ts`. AC-9 and AC-10 (403
    on unreachable workspace, picker on omitted workspace) have no test, and the
    route's session and DB paths are never exercised.

### Recently closed

Kept as a record so a reader who remembers the longer list can see where the
entries went, and so the same claims are not re-derived from an older copy.

- *"No signing key has ever rotated in production."* Rotation was enabled, and a
  first rotation was then performed and observed by hand: the key set went from
  one key to two, the predecessor retiring rather than disappearing.
- *"JWKS publishes every `signing_key` row, including already-expired ones."*
  Inverted, and had been for some time — `getAllPublicKeys()` filters on
  `tokenExpiresAt IS NULL OR > now()`, so an expired key is never published even
  if the deleter has not run.
- *"The JWKS endpoint has no test file at all."* It has one; the entry looked
  for it beside the route, where the runner would never have collected it.
- *"JWKS can return HTTP 200 with an empty `keys` array."* An unusable document
  now returns 503 with `no-store`.
- *"`kid` is not unique."* `makeKid()` appends a millisecond-of-month stamp plus
  random suffix, so two rotations in one calendar month no longer collide.
- *"`jwks_uri` is missing from authorization-server metadata."* Advertised, along
  with the assertion grant in `grant_types_supported`.
- *"Assertion `iss` is a hardcoded literal."* Derived from `getIssuer()`;
  unchanged in production, fixed everywhere else.
- *"Forced rotation is HTTP GET, not POST."* `POST` is now accepted for the
  operator path. `GET` remains because the external scheduler can issue nothing
  else.
