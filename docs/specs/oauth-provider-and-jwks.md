---
title: OAuth Provider & Signing Keys
status: active
owner: max
last_verified: 2026-10-25
summary: OAuth tokens MUST be PKCE-protected and confined to their grant or legacy workspace, connection changes MUST apply on the next request, and JWKS MUST publish public assertion keys.
domain: auth
surfaces: [apps/web/src/app/api/oauth/token/route.ts, apps/web/src/lib/signing-keys.ts, apps/web/src/lib/signing-key-windows.ts, apps/web/src/app/api/.well-known/jwks.json/route.ts]
related: [auth-oauth-boundaries, credential-isolation, external-cron-triggers, mcp-action-contracts]
keywords: [rfc 7591, dynamic client registration, rfc 9728, resource_metadata, jwks, kid, es256, hs256, code_challenge, signing_key, assertion grant]
verified_by: [apps/web/src/lib/oauth/tokens.test.ts, apps/web/src/lib/oauth/client-metadata-document.test.ts, apps/web/src/app/api/oauth/register/route.test.ts, apps/web/src/app/api/mcp/route.scope.test.ts, apps/web/src/lib/oauth/storage.test.ts, apps/web/src/app/api/oauth/authorize/route.test.ts, apps/web/src/app/api/oauth/token/route.test.ts, apps/web/src/app/api/cron/jwks-rotation/route.test.ts, apps/web/src/app/api/connectors/[id]/assertion/route.test.ts, apps/web/src/lib/signing-key-windows.test.ts, apps/web/src/app/api/well-known-jwks-route.test.ts, apps/web/src/app/well-known-oauth-authorization-server-route.test.ts, apps/web/src/app/api/auth/device/approve/route.test.ts, apps/web/src/app/app/device/page.test.tsx, apps/web/src/lib/self-origin.test.ts, apps/web/tests/db/agent-connection-owner.test.ts, apps/web/src/lib/worker-owner.test.ts, apps/web/tests/db/grant-scope-matrix.test.ts, apps/web/src/lib/grant-scope.test.ts, apps/web/tests/db/mcp-grant-management.test.ts, apps/web/src/app/api/mcp-grants/[id]/route.test.ts, apps/web/src/app/app/(protected)/settings/connections/ConnectionsSection.dom.test.tsx, apps/web/tests/db/mcp-canonical-transport.test.ts, apps/web/src/lib/mcp-grant-session.test.ts, apps/web/src/app/api/mcp/transport-parity.test.ts, apps/web/tests/db/mcp-oauth-grants.test.ts, apps/web/tests/db/mcp-oauth-consent.test.ts, apps/web/src/lib/oauth/account-consent.test.ts, apps/web/src/lib/oauth/resource-binding.test.ts, apps/web/src/app/well-known-oauth-protected-resource-mcp-route.test.ts, apps/web/src/lib/api-auth.test.ts, apps/web/tests/db/oauth-refresh-families.test.ts, apps/web/tests/db/mcp-grant-team-access.test.ts, apps/web/src/app/app/(protected)/settings/connections/connections-view.test.ts, packages/core/__tests__/list-workspaces-team-name.test.ts]
assertions:
  - id: jwks-route-get
    type: route
    method: GET
    path: /api/.well-known/jwks.json
    file: apps/web/src/app/api/.well-known/jwks.json/route.ts
  - id: oauth-token-route-post
    type: route
    method: POST
    path: /api/oauth/token
    file: apps/web/src/app/api/oauth/token/route.ts
  - id: get-active-signing-key
    type: symbol
    name: getActiveSigningKey
    path: apps/web/src/lib/signing-keys.ts
  - id: get-all-public-keys
    type: symbol
    name: getAllPublicKeys
    path: apps/web/src/lib/signing-keys.ts
  - id: imported-resolve-granted-workspaces
    type: "symbol"
    name: "resolveGrantedWorkspaces"
    path: "apps/web/src/lib/mcp-grants.ts"
  - id: imported-mcp-grant-tests
    type: "test_file"
    path: "apps/web/tests/db/mcp-oauth-grants.test.ts"
  - id: imported-account-consent-validate
    type: "symbol"
    name: "validateApproval"
    path: "apps/web/src/lib/oauth/account-consent.ts"
  - id: imported-account-consent-tests
    type: "test_file"
    path: "apps/web/tests/db/mcp-oauth-consent.test.ts"
  - id: imported-manage-connection-route
    type: "route"
    method: "PATCH"
    path: "/api/mcp-grants/[id]"
    file: "apps/web/src/app/api/mcp-grants/[id]/route.ts"
  - id: imported-manage-connection-tests
    type: "test_file"
    path: "apps/web/tests/db/mcp-grant-management.test.ts"
  - id: imported-assert-granted-workspace
    type: "symbol"
    name: "assertGrantedWorkspace"
    path: "apps/web/src/lib/grant-scope.ts"
  - id: imported-grant-scope-matrix-tests
    type: "test_file"
    path: "apps/web/tests/db/grant-scope-matrix.test.ts"
  - id: team-access-validate
    type: "symbol"
    name: "validateAccountApproval"
    path: "apps/web/src/lib/oauth/account-consent.ts"
  - id: team-access-tests
    type: "test_file"
    path: "apps/web/tests/db/mcp-grant-team-access.test.ts"
supersedes: []
---
# OAuth Provider & Signing Keys

**Capability statement**: When buildd acts as an identity provider (registering
OAuth clients, running the authorize/token endpoints, and publishing a JWKS),
every token it mints MUST be bound to exactly one thing: an account-level MCP
grant (`grant_id`, the default for a new connection) or, for an older
per-workspace connection, one workspace (`workspace_id`). Every public key
needed to verify a buildd-issued assertion MUST be retrievable from
`GET /api/.well-known/jwks.json`.

Tokens are account-level. A grant (`mcp_oauth_grants`) names the workspaces a
person chose at consent, across teams; the token carries the grant id, not a
workspace, and its reach is the grant's workspaces intersected with the
person's current memberships, read on every request. The grant model, consent
and per-request confinement are defined below ("Account-level MCP
grants", "Account-level consent", "Canonical MCP transport").

This spec covers the **provider** side only. How buildd authenticates *inbound*
credentials (`bld_*` key vs OAuth JWT, per-`authType` limits, level gating) is
`auth-oauth-boundaries.md`.

## Two disjoint signing systems

buildd signs two unrelated token families, and confusing them is the most
likely reader error:

| Token family | Algorithm | Key material | Verifier | Discoverable? |
|---|---|---|---|---|
| MCP access token (`/api/oauth/token`) | HS256 (symmetric) | `OAUTH_JWT_SECRET`, then `AUTH_SECRET`, then `NEXTAUTH_SECRET` (`apps/web/src/lib/oauth/config.ts`, `getJwtSecret()`) | buildd itself only | No, never appears in JWKS |
| Cross-app assertion (`/api/connectors/[id]/assertion`) | ES256 (P-256 keypair) | `secrets` rows with `purpose = 'signing_key'` | third-party resource servers | Yes, JWKS |

The JWKS endpoint therefore says **nothing** about MCP access tokens. A reader
debugging a rejected MCP token by inspecting JWKS is looking at the wrong
system.

---

## Discovery & Dynamic Client Registration

**Invariants**:
- `GET /.well-known/oauth-authorization-server` MUST advertise
  `code_challenge_methods_supported: ['S256']` and
  `token_endpoint_auth_methods_supported: ['none']` — the provider registers
  public clients only and no code path issues a `client_secret`. It MUST also
  advertise `client_id_metadata_document_supported: true` (see "Client ID
  metadata documents" below): Claude's hosted apps and Claude Code identify
  themselves that way only when both values are present.
- Protected-resource metadata for `/api/mcp` MUST be served at
  `/.well-known/oauth-protected-resource/api/mcp` and at the root fallback
  `/.well-known/oauth-protected-resource` (the order an MCP client probes when
  it has no `resource_metadata` hint). Every metadata `GET` MUST carry
  `Access-Control-Allow-Origin: *` so browser-based clients can read it.
- `GET /.well-known/oauth-protected-resource/api/mcp-oauth/<workspace>` MUST
  return `resource` equal to `${issuer}/api/mcp-oauth/<workspace>` — the same
  string used as the `aud` claim by `getResourceUrl()`, so metadata and token
  audience cannot disagree.
- On an unauthenticated MCP call, `/api/mcp-oauth/[workspace]` MUST return HTTP
  401 carrying `WWW-Authenticate: Bearer realm="buildd",
  resource_metadata="<protected-resource URL>"` (RFC 9728) so a client can
  autodiscover the authorization server with no static configuration. On
  `/api/mcp` this holds for an unauthenticated `GET` and `HEAD` as well as
  `POST`: a connector setup check probes with them before signing in. A
  signed-in `GET` stays 405 (stateless; no SSE).
- `POST /api/oauth/register` MUST reject a body without at least one parseable
  URL in `redirect_uris` with HTTP 400 `invalid_client_metadata`.
- Registration is unauthenticated by design (RFC 7591 open registration). The
  registered `client_id` alone therefore proves nothing; client identity rests
  entirely on PKCE, exact `redirect_uri` matching, and the interactive consent
  step below.
- Registration is limited to 10 per caller IP per hour (Redis). When that
  limiter is unavailable it MUST NOT lift the limit and MUST NOT refuse
  everyone: it falls back to a global cap of 100 registrations per hour counted
  in `oauth_clients`, and answers a retryable 503 only above that cap or when
  the count itself fails.
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
- AS metadata: `apps/web/src/app/.well-known/oauth-authorization-server/route.ts` (`GET`)
- Protected-resource metadata: `apps/web/src/app/.well-known/oauth-protected-resource/api/mcp-oauth/[workspace]/route.ts` (`GET`)
- DCR: `apps/web/src/app/api/oauth/register/route.ts`: `RegisterSchema`, `POST`
- Client row: `apps/web/src/lib/oauth/storage.ts`: `createClient()`, `isSafeRedirectUri()`
- 401 hint + 405: `apps/web/src/app/api/mcp-oauth/[workspace]/route.ts`: `unauthorized()`, `GET`
- Issuer resolution: `apps/web/src/lib/oauth/config.ts`: `getIssuer()`
- Schema: `packages/core/db/schema.ts`: `oauthClients`

---

## Authorize endpoint: consent binds one grant or one workspace

**Invariants**:
- `client_id` and `redirect_uri` MUST both be present and the `redirect_uri`
  MUST satisfy `isRegisteredRedirectUri()` before any other validation runs;
  failures return a plain-text HTTP 400 and MUST NOT redirect (an unvalidated
  redirect target is never followed).
- `isRegisteredRedirectUri()` MUST match non-loopback URIs by exact string.
  Loopback URIs (`localhost`, `127.0.0.1`, `[::1]`, `::1`) MUST match when
  protocol, path, and query are all equal — hostname and port may differ
  (RFC 8252 §7.3: a native app binds an ephemeral port per sign-in, and Claude
  Code's metadata document declares `http://localhost/callback` with no port).
- `response_type` other than `code`, a missing `code_challenge`, or
  `code_challenge_method !== 'S256'` MUST fail. `plain` PKCE is unreachable
  even though the parameter defaults to `'plain'` when omitted.
- An unauthenticated user MUST be sent through NextAuth signin with
  `callbackUrl` set to the same authorize URL — the authorization request is
  never dropped, and no code is minted before a session exists.
- A code MUST NOT be minted until the session user's workspace access is
  re-checked against `teamMembers` at authorize time: for an older
  per-workspace resource, `legacyWorkspaceForUser()` on the workspace the
  resource names (a workspace the user cannot reach returns HTTP 403); for the
  account level, the grant's workspaces (`validateApproval()`). Which consent a
  request gets is decided by its `resource` (`classifyResource()`, see
  auth-oauth-boundaries.md, "Resource routing, older addresses and sunset").
- Every minted `oauthCodes` row MUST carry `(clientId, userId, redirectUri,
  codeChallenge)` and exactly one of `workspaceId` (older per-workspace
  address) or `grantId` (account level). There is no "all workspaces" code.
- `GET` MUST NOT mint a code. With a valid request, a session and a reachable
  workspace it renders a consent page naming the client, the workspace, and
  the access the connection will have (the user's team role, via
  `levelForTeamRole()`). The page MUST NOT be frameable
  (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
- A code is minted only by a `POST` of that consent form with
  `decision=approve`, an `Origin` equal to this site's origin, and a consent
  token (HMAC over the session user and every authorize parameter, 10-minute
  lifetime) that matches the submitted parameters. Anything else is HTTP 403
  and mints nothing. `decision=deny` redirects (303) with
  `error=access_denied`.
- After minting, the user MUST see an interstitial naming what the connector
  was scoped to (the grant's workspaces, or the one workspace of an older
  address) before the redirect fires, so a user with several buildd
  connectors can tell what they just authorized.

**Acceptance criteria**:
- AC-6: GIVEN a client registered with `http://localhost:41776/callback/x` WHEN
  authorize is called with `redirect_uri=http://127.0.0.1:41776/callback/x`
  THEN `isRegisteredRedirectUri` returns `true`.
- AC-7: GIVEN the same client WHEN the requested `redirect_uri` differs in
  path THEN `isRegisteredRedirectUri` returns `false` and the route returns
  HTTP 400 `redirect_uri not registered for this client`; a different port
  alone is accepted.
- AC-8: GIVEN a registered `redirect_uri` and a logged-in session WHEN
  `code_challenge_method=plain` is supplied THEN the response is a redirect to
  the client carrying `error=invalid_request` and no `oauthCodes` row is created.
- AC-9: GIVEN a logged-in user with no membership in the team of the
  workspace an older per-workspace address names WHEN authorize is called
  THEN the server returns HTTP 403 and no code is minted.
- AC-10: GIVEN a logged-in user with at least one workspace and no `resource`
  WHEN authorize is called THEN the response is HTTP 200 `text/html`: the
  account consent page listing the workspaces they can reach, not a redirect.
- AC-33: GIVEN a valid request WHEN `GET` is called THEN no `oauthCodes` row
  is created and the response is a consent form.
- AC-34: GIVEN that consent form WHEN it is POSTed without its token, with a
  token for different parameters, from another origin, or with no `Origin`
  THEN the server returns HTTP 403 and no code is minted.

**Code surface**:
- Route: `apps/web/src/app/api/oauth/authorize/route.ts`: `GET`, `validateRequest()`
- Redirect-URI matcher: same file, `isRegisteredRedirectUri()`
- Access re-check: same file, `legacyWorkspaceForUser()`; account level,
  `validateApproval()` in `apps/web/src/lib/oauth/account-consent.ts`
- Consent decision: same file, `POST`, `verifyConsentToken()`,
  `isSameOriginPost()`, `accountConsentPost()`; pages in
  `apps/web/src/lib/oauth/account-consent.ts`: `renderLegacyConsentPage()`,
  `renderAccountConsentPage()`
- Post-approval interstitials: `renderLegacyInterstitial()`,
  `renderGrantInterstitial()` (same module)
- Code persistence: `apps/web/src/lib/oauth/storage.ts`: `createAuthCode()` (`TokenBinding`: a `workspaceId` or a `grantId`, never both)
- Schema: `packages/core/db/schema.ts`: `oauthCodes`

---

## Token endpoint: single-use codes, rotating refresh, grant-bound JWT

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
- Redemption MUST claim the code with one conditional
  `UPDATE ... SET consumed_at WHERE consumed_at IS NULL RETURNING` before the
  other checks run, so the code is single-use even under concurrent exchanges
  (neon-http has no interactive transactions). `AUTH_CODE_TTL_SECONDS` is 600.
- `consumeRefreshToken()` MUST revoke the presented token the same way
  (`WHERE token = <sha256> AND client_id = <client> AND revoked_at IS NULL RETURNING`)
  before the caller mints a replacement, so refresh tokens rotate on every use
  and mint at most once. Tokens are stored hashed and rotate as one family per
  sign-in; reuse handling and the absolute lifetime are specified in
  `auth-oauth-boundaries.md` ("Refresh tokens: hashed, one family per
  sign-in").
- A code or refresh token carries the same binding as the code it came from
  (`TokenBinding`), so a refresh can never widen or change what a connection
  reaches. For a grant binding, both OAuth grant types MUST confirm the grant
  is still the user's, issued to this client, and still reaches at least one
  workspace (`resolveGrant()`), else `invalid_grant` and the grant's refresh
  tokens are revoked (`revokeRefreshTokensForGrant()`). For an older workspace
  binding, they MUST confirm the user still has a `team_members` row on the
  workspace's team (`userHasWorkspaceMembership()`); a refresh that fails this
  returns `invalid_grant` and revokes the user's remaining refresh tokens for
  that workspace (`revokeRefreshTokensForUserWorkspace()`). Error
  descriptions never name a workspace or a grant.
  `REFRESH_TOKEN_TTL_SECONDS` (sliding) and
  `REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS` (from sign-in) are both 90 days.
- Every issued access token MUST carry `sub` (userId), `client_id`, `scope`
  and `iss = getIssuer()`, and expire after `ACCESS_TOKEN_TTL_SECONDS` (3600).
  A grant token (`signGrantAccessToken()`) carries `grant_id` and
  `aud = getAccountResourceUrl()`; it names no workspace. An older workspace
  token (`signAccessToken()`) carries `workspace_id` and
  `aud = getResourceUrl(workspaceId)`. No token carries both.
- `verifyAccessToken(token, expectedWorkspaceId)` (the per-workspace endpoint)
  MUST return `null` when the signature is bad, the issuer differs, the
  audience is another workspace's resource URL, `workspace_id !==
  expectedWorkspaceId`, or the token carries a `grant_id`. A token minted for
  workspace A MUST NOT authenticate against workspace B.
  `verifyAccessTokenAnyAudience()` (the account-level path) accepts a grant
  token only at the account audience.
- Both OAuth grant types MUST make sure the team has a session account: for a
  grant, `ensureTeamSessionAccount()` for every team the grant reaches; for a
  workspace binding, `ensureUserAccount()` for the workspace's team. Each
  provisions a `type: 'user'`, `authType: 'oauth'` account when none exists,
  and the workspace path swallows its own failures: a provisioning error MUST
  NOT block the token response.
- All token responses MUST set `cache-control: no-store`.

**Acceptance criteria**:
- AC-11: GIVEN a signed workspace access token for workspace A WHEN
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
- Route: `apps/web/src/app/api/oauth/token/route.ts`: `POST`, `issuePair()`
- Account provisioning: same file, `ensureUserAccount()`;
  `apps/web/src/lib/oauth/ensure-session-account.ts`, `ensureTeamSessionAccount()`
- Grant resolution: `apps/web/src/lib/mcp-grants.ts`: `resolveGrant()`,
  `revokeRefreshTokensForGrant()`
- Code + refresh redemption: `apps/web/src/lib/oauth/storage.ts`:
  `consumeAuthCode()`, `consumeRefreshToken()`
- Signing/verification: `apps/web/src/lib/oauth/tokens.ts`:
  `signAccessToken()`, `signGrantAccessToken()`, `verifyAccessToken()`,
  `verifyAccessTokenAnyAudience()`
- Lifetimes: `apps/web/src/lib/oauth/config.ts`: `ACCESS_TOKEN_TTL_SECONDS`,
  `AUTH_CODE_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`,
  `REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS`
- Schema: `packages/core/db/schema.ts`: `oauthRefreshTokens`, `mcpOauthGrants`

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
- The rotation cron runs weekly: `cron-manifest.json` carries
  `/api/cron/jwks-rotation` with `enabled: true`. A weekly tick is enough
  because rotation only acts once the Active key is older than 30 days. It
  was staged dark until a first rotation had been performed and observed by
  hand.

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
- Key service: `apps/web/src/lib/signing-keys.ts`: `makeKid`,
  `generateSigningKeypair`, `getActiveSigningKey`, `getAllPublicKeys`,
  `createActiveSigningKey`, `signAssertion`
- JWKS route: `apps/web/src/app/api/.well-known/jwks.json/route.ts` (`GET`)
- Rotation cron: `apps/web/src/app/api/cron/jwks-rotation/route.ts`: `rotate()`
- Trigger: `cron-manifest.json`, `"Buildd: JWKS Rotation"`, `enabled: true`
- Encryption at rest: `packages/core/secrets/postgres-provider.ts` (`set`,
  `get`), `packages/core/secrets/crypto.ts` (`getEncryptionKey`)
- Schema: `packages/core/db/schema.ts`: `secrets.purpose`
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
- Route: `apps/web/src/app/api/connectors/[id]/assertion/route.ts`: `POST`
  (its no-key guard returns `No active signing key`)
- Rate limit: same file, `checkRateLimit()`
- Signer: `apps/web/src/lib/signing-keys.ts`: `signAssertion()`
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
- A device code MUST be approved only by an explicit confirm. Loading
  `/app/device` (with or without `?code=`) MUST NOT approve anything; it shows
  the code, the requesting client, when it was requested and the account/team
  it would connect, and approval is the page's confirm button. The approve
  route MUST be POST-only and MUST reject a body without `confirm: true` with
  HTTP 400, and every approval MUST be logged with the requester's IP and
  user agent.
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
- AC-35: GIVEN a signed-in user WHEN they load `/app/device?code=<pending>`
  THEN no request is sent and the row stays `pending`; WHEN approve is called
  without `confirm: true` THEN the server returns HTTP 400 and nothing changes.

**Code surface**:
- CLI flow: `apps/web/src/app/api/auth/cli/route.ts` (`GET`)
- Device flow: `apps/web/src/app/api/auth/device/code/route.ts` (`POST`),
  `apps/web/src/app/api/auth/device/approve/route.ts`,
  confirm page `apps/web/src/app/app/device/page.tsx` +
  `apps/web/src/lib/device-confirm.ts`,
  `apps/web/src/app/api/auth/device/token/route.ts` (`POST`)
- Key hashing: `apps/web/src/lib/api-auth.ts`: `hashApiKey()`,
  `extractApiKeyPrefix()`
- Schema: `packages/core/db/schema.ts`: `deviceCodes`

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
> statement about a security primitive. The JWKS test entry is the instructive one: it
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
   (`packages/core/secrets/crypto.ts`, `getEncryptionKey`), a wiped or rotated
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

6. **The HS256 secret has no rotation story.** `getJwtSecret()` falls back
    through `OAUTH_JWT_SECRET → AUTH_SECRET → NEXTAUTH_SECRET`
    (`apps/web/src/lib/oauth/config.ts`, `getJwtSecret()`). Access tokens carry no `kid`
    and there is no two-key overlap window, so changing that secret invalidates
    every outstanding MCP access token at once — and where the fallback lands on
    `AUTH_SECRET`, the same value signs NextAuth sessions.

### Recently closed

Kept as a record so a reader who remembers the longer list can see where the
entries went, and so the same claims are not re-derived from an older copy.

- *"Registration accepts private-use schemes and non-loopback HTTP."* Registration
  and authorization now require HTTPS or loopback HTTP and reject fragments and
  credentials. Open registration, reserved names, consent identity, rate limiting
  and unused-client pruning are specified in
  [Auth & OAuth Boundaries](auth-oauth-boundaries.md#open-dynamic-client-registration).

- *"Single-use codes and refresh rotation are untested."* Covered by
  `apps/web/src/lib/oauth/storage.test.ts` (`consumeAuthCode`,
  `consumeRefreshToken`, the membership helpers).
- *"No test covers registration or discovery."* Covered by
  `apps/web/src/app/api/oauth/register/route.test.ts`,
  `apps/web/src/app/well-known-oauth-authorization-server-route.test.ts` and
  `apps/web/src/app/well-known-oauth-protected-resource-mcp-route.test.ts`.
- *"The authorize-time workspace access check is not tested."* Covered by
  `apps/web/src/app/api/oauth/authorize/route.test.ts` (an older address
  naming a workspace outside the user's teams is refused; no resource opens
  the account consent page).
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

## Renumbered

Renumbered on 2026-10-15 so every criterion parses: AC-10a to AC-33, AC-10b to AC-34, AC-32a to AC-35. Verification gaps renumbered after three moved to Recently closed: old 8 is now 6, old 9 is now 7.

## MCP grants and connection confinement

Moved from the former auth aggregate on 2026-10-15. Incoming acceptance ids
use the next free numbers in this contract; the original aggregate remains
linked for billing and account-level authentication.

## Account-level MCP grants

**Capability statement**: One MCP OAuth connection MUST be able to reach a
chosen set of workspaces across the user's teams. The token names a grant, not
workspaces; what it reaches is decided server-side on every request.

**Model** (`packages/core/db/schema.ts`):
- `mcp_oauth_grants`: `id`, `user_id`, `client_id`, `acts_as`
  (`'person' | 'agent'`, required), `scopes` (non-empty subset of
  `["read","write"]`), `expires_at`, `revoked_at`, `created_at`, `updated_at`.
- `mcp_oauth_grant_workspaces`: one row per workspace granted one by one
  (`grant_id`, `workspace_id`), cascading on either side.
- `mcp_oauth_grant_teams`: one row per team the grant covers as a whole, all
  current and future workspaces (`grant_id`, `team_id`), cascading on either
  side. See "Team access modes".
- `mcp_oauth_grants.revision`: bumped by every edit in Settings; an edit names
  the revision it was made against.
- `mcp_oauth_grant_events`: append-only history of a connection (created,
  updated, revoked) with the acting user and the reach before and after, as
  ids and modes only.
- `oauth_codes` and `oauth_refresh_tokens` carry exactly one of
  `workspace_id` (legacy) or `grant_id` (CHECK `num_nonnulls(...) = 1`).

**Invariants**:
- A grant access token's claims are `sub` (user), `client_id`, `scope` and
  `grant_id`, with the account-level audience. It never carries a workspace
  list. A token with both `workspace_id` and `grant_id`, or neither, is
  refused, and the workspace-bound verifier refuses any grant token.
- What a grant reaches is `resolveGrantedWorkspaces(grantId, userId)`: (the
  grant's workspaces ∪ every non-internal workspace of a team the grant covers
  as a whole) ∩ workspaces whose team the user is a member of now, for a grant
  that is the user's, not revoked and not expired. It is evaluated at every
  refresh, and on every request through the caller cache
  (`resolveCallerGrant` in `apps/web/src/lib/api-auth.ts`): an entry rests on
  the grant, the user, each reached workspace and each whole team
  (`callerDep.teamWorkspaces`), and every change to one clears it, so a revoked
  grant, a removed membership, a deleted workspace, a workspace moved out of or
  into a team, or a workspace created in a whole team takes effect on the next
  call. Nothing outlives the 60 s cache bound.
- A grant is also bound to its client: a code or refresh token presented by
  another client does not resolve.
- A grant never gains a team implicitly. A workspace joins what a grant
  reaches without an edit only by being created in, or moved into, a team the
  grant already covers as a whole. Creating a grant refuses any workspace the
  user cannot reach and any team they are not on, writes nothing, and names
  none.
- A grant session is confined to the workspaces it currently reaches
  (`account.workspaceIds`), so a self-call naming another workspace, even one
  in the same team, is refused. A grant that reaches workspaces in more than
  one team does not pick a team on the generic auth path; it authenticates
  only where the request names its workspace (`x-buildd-workspace`, see
  "Canonical MCP transport").
- Refusals at the token endpoint and in auth never name a grant, workspace or
  team id.
- A refresh mints a token for the same grant. The grant's workspaces and
  `acts_as` live only on the grant row, so a refresh cannot widen the set or
  change the kind. A refresh whose grant no longer resolves is refused and
  revokes every refresh token issued under that grant.
- `acts_as = 'person'`: the session carries `sessionUserId`, so
  `requestingPerson()` (`apps/web/src/lib/request-person.ts`) returns the user
  and person-only actions are allowed as `human:<userId>`.
- `acts_as = 'agent'`: the session is attributed to the user (`oauthUserId`,
  actor `agent:oauth:<userId>`) but carries no `sessionUserId`, and
  `requestingPerson()` returns null for it, so every person-only action
  (Abandon, forced review, landing override, merge override) refuses it.
- A legacy token (a `workspace_id` claim from the per-workspace connection) is
  an implicit single-workspace `'person'` grant, resolved with the same
  membership check as before and its historical reach (`workspaceIds = null`).
  Per-task `bldt_` tokens and `bld_` API keys are unchanged.

**Acceptance criteria**:
- AC-36: GIVEN a grant on workspaces in two teams WHEN
  `resolveGrantedWorkspaces` runs THEN it returns exactly those workspaces and
  no other workspace of either team.
- AC-37: GIVEN a live grant token WHEN the user leaves the team, or the grant
  is revoked, THEN the next `authenticateApiKey` call returns `null`.
- AC-38: GIVEN a grant refresh token WHEN the grant has been revoked, or the
  user has lost membership, THEN `/api/oauth/token` returns 400
  `invalid_grant`, the body names no id, and the grant's other refresh tokens
  are revoked.
- AC-39: GIVEN an `'agent'` grant WHEN its token is refreshed (even with an
  `acts_as` form field) THEN the new token names the same grant and the kind is
  still `'agent'`.
- AC-40: GIVEN an `'agent'` grant WHEN it asks to Abandon a closed PR, or to
  force a review, THEN the request is refused (403 / 409) and the delivery is
  unchanged; GIVEN a `'person'` grant THEN both are allowed, as
  `human:<userId>`.
- AC-41: GIVEN a legacy workspace-claim token WHEN it authenticates THEN it
  acts as the person with `workspaceIds = null`, and its refresh still rotates
  a workspace-bound pair.

**Code surface**:
- Resolver: `apps/web/src/lib/mcp-grants.ts`: `createGrant()`,
  `resolveGrantedWorkspaces()`, `resolveGrant()`, `resolveTokenGrant()`,
  `grantPrincipal()`, `revokeGrant()`
- Tokens: `apps/web/src/lib/oauth/tokens.ts`: `signGrantAccessToken()`,
  `verifyAccessTokenAnyAudience()`; storage bindings in
  `apps/web/src/lib/oauth/storage.ts`
- Per-request auth: `apps/web/src/lib/api-auth.ts`: `authenticateOauthJwt()`
- Token endpoint: `apps/web/src/app/api/oauth/token/route.ts`
- Tests: `apps/web/tests/db/mcp-oauth-grants.test.ts` (real Postgres)

**Out of scope here**: the account-level MCP transport is specified under
"Canonical MCP transport" below; the grant management UI is a separate task. Refresh-token storage is covered in
"Refresh tokens: hashed, one family per sign-in" above; the consent page that
creates grants is below.

---

## Account-level consent

**Capability statement**: A person MUST be able to connect one MCP client to a
chosen set of workspaces across their teams from a single consent page, and
the server MUST grant exactly what the client asked for and the person chose,
re-validated on submit.

**Entry point**: `/api/oauth/authorize` with `resource=<issuer>/api/mcp`
(RFC 8707), or with no `resource` at all: the account level is the default for
every new connection. An older per-workspace resource gets single-workspace
consent instead, and any other resource is refused; see "Resource routing,
older addresses and sunset" below. There is no multi-workspace picker that
mints a workspace-bound code any more.
Protected-resource metadata for the account resource is served at
`/.well-known/oauth-protected-resource/api/mcp`; the per-workspace metadata,
the authorization-server metadata and dynamic client registration are
unchanged apart from the advertised scopes.

**Scopes** (`apps/web/src/lib/oauth/account-consent.ts`):
- `mcp` or `buildd:write`: read and write. `buildd:read` alone: read only. No
  read/write scope: read and write, as before. Unknown scopes are ignored and
  never granted.
- `buildd:act-as-person`: the client asks for a connection that acts as the
  person (`buildd install --oauth` sends it). It is accepted but deliberately
  not listed in `scopes_supported`, so a generic client that requests every
  advertised scope does not ask to act as the person by default.
- The code and token carry the granted scope string (`buildd:read`, plus
  `buildd:write`, plus `buildd:act-as-person` for a person grant). The grant
  row stays the authority.

**Invariants**:
- The page lists every team the user is a member of now, each with its
  workspaces, sorted by name. Each team is a collapsible group paged at 20
  workspaces; search filters by workspace, team or repository name. Select all
  (or all matches while searching), Clear all, and per-team select/clear are
  available. Search, page turns and selection actions are form posts that
  carry the selection, so the page needs no script. The selected count is a
  CSS counter and follows the checkboxes without script.
- Internal workspaces (`isSystemWorkspace`: a `__` name prefix, e.g. one
  `__coordination` per team) are not offered (`pickerTeams`), and a team left
  with none is not listed. The one exception is explicitly scoped admin
  access: the workspace the client named with `workspace=`, when the person is
  an owner or admin of its team, is offered (as "Organizer"). The same filter
  runs on submit, so an internal workspace that was not offered is refused like
  any unreachable one. Grants that already include one are unaffected.
- A workspace is labelled by its name with its repository (`owner/repo`)
  underneath. A full workspace id is never printed as text; a short id is added
  only when two workspaces of one team share both name and repository.
- The heading is "Authorize <app>" and the lede "Choose the teams and
  workspaces <app> can access." The app's name is shown as verified only for
  a known app whose redirect is its own https host (`clientIdentity`:
  ChatGPT at `chatgpt.com`, Claude at `claude.ai` / `claude.com`); any other
  registration shows its self-declared name with the return host. The
  actions are **Allow access** and **Cancel**; the summary with them stays in
  view at the bottom on a phone. The kind choice is shown only when the client
  asked for `buildd:act-as-person`; otherwise the form carries
  `acts_as=agent`. No copy suggests one connection per workspace.
- Each team has one access choice, a radio group named `tmode.<teamId>`: **No
  access**, **All current and future workspaces** or **Specific workspaces**
  (see "Team access modes"). The workspace list of a team shows only while it
  is on specific workspaces; ticks elsewhere are not part of the approval.
  There is no page-wide Select all on the account page: **Tick all listed** in
  a team ticks the ids of now and says so; future workspaces are only ever the
  team choice. The runner login picker keeps its workspace-only form.
- A team is chosen up front only when the page need not guess: the team of the
  `workspace` hint (all current and future workspaces, or specific with the
  hint ticked when the hint is an internal workspace), or the only team. With
  several teams and no hint, no team is chosen.
- The summary lists each chosen team by name with its mode and a count that
  does not read as fixed ("all current and future workspaces, 12 workspaces
  now"; "3 ticked, none added later"), with read or read and write and the kind.
  A team the search hides keeps its choice and ticks as hidden fields and a
  static summary row.
- The kind defaults to **Agent working for you**. **Acts as you** is selectable
  only when the client sent `buildd:act-as-person`; it is then preselected and
  the person can downgrade it. Write is preselected only when requested and
  can be unticked.
- Every post (page action or decision) needs a same-origin `Origin` and a
  consent token: an HMAC over the signed-in user and every authorize
  parameter (client, redirect, PKCE challenge and method, scope, state,
  workspace hint, resource), valid for 10 minutes. Changing any parameter,
  another user's token, or a forged one is refused with 403.
- PKCE is S256 only, checked before the page renders; the token endpoint
  verifies the verifier.
- On approval the server re-reads the user's teams and refuses the whole
  approval when any chosen workspace is not reachable now or any team choice
  names a team not offered (403), when a team choice is unknown or repeated, when the kind
  is `person` without `buildd:act-as-person`, when the kind is unknown, or when
  write is chosen but was not requested (400). Nothing is dropped silently,
  nothing is written, and no refusal names an id. No team chosen, or a team on
  specific workspaces with none ticked, shows the page again with a message.
- Approval creates one grant (`createGrant`, with the whole teams and the
  specific workspaces) and one code bound to it
  (`createAuthCode({ grantId })`); the token endpoint binds the code to the
  grant as in "Account-level MCP grants". Cancel redirects with
  `access_denied` and the client's `state`.

**Client ID metadata documents (CIMD)**: supported
(`apps/web/src/lib/oauth/client-metadata-document.ts`,
`storage.ts: resolveClient()`). An HTTPS `client_id` with a path is fetched at
authorize time: default port only, a DNS name (never an IP literal) whose every
address is public, no redirects followed, 5 s timeout, 5 KB cap, good
documents cached in process for five minutes. The document's `client_id` MUST
equal the URL, its `redirect_uris` MUST pass `isSafeRedirectUri()`, its
`token_endpoint_auth_method` MUST be absent or `none`, and a reserved
`client_name` is held to its hosts as at registration. The client is then
upserted into `oauth_clients` under the URL, so codes, grants and refresh
tokens reference it like a registered client. The document never makes a
client verified: that stays decided by redirect host (`clientIdentity()`).
A document that cannot be fetched or validated is `unknown client_id` (400).

**Acceptance criteria**:
- AC-42: GIVEN an authorize request for the account resource WHEN the page
  renders THEN it lists only the user's teams' workspaces, chooses a team only
  for a reachable hint or a single team, selects the agent kind and issues no
  code.
- AC-43: GIVEN an approval naming a workspace outside the user's teams WHEN it
  is posted THEN the response is 403, names no id, and no grant row exists.
- AC-44: GIVEN a request without `buildd:act-as-person` WHEN an approval posts
  `acts_as=person` THEN the response is 400 and no grant row exists.
- AC-45: GIVEN a request with `buildd:act-as-person` WHEN the person approves
  as agent with write unticked THEN the grant is `agent` with `["read"]`.
- AC-46: GIVEN a consent post with a missing or forged consent token, another
  user's token, a changed `state` or `scope`, or a foreign or missing Origin
  THEN it is refused with 403 and nothing is written.
- AC-47: GIVEN a team on specific workspaces with more than one page WHEN the
  person turns the page and ticks another THEN both the earlier and the new
  choice are in the grant, and every team's choice is carried.

**Code surface**:
- Consent logic and page: `apps/web/src/lib/oauth/account-consent.ts`:
  `parseRequestedAccess()`, `initialConsentState()`, `applyNav()`,
  `validateAccountApproval()` (`validateApproval()` for the runner picker),
  `renderAccountConsentPage()`
- Authorize endpoint: `apps/web/src/app/api/oauth/authorize/route.ts`
- Metadata: `apps/web/src/app/.well-known/oauth-protected-resource/api/mcp/route.ts`
- Fixture for visual review: `/app/dev/oauth-consent` (fake data)
- Tests: `apps/web/tests/db/mcp-oauth-consent.test.ts` (real Postgres),
  `apps/web/src/lib/oauth/account-consent.test.ts`


---

## Team access modes

**Capability statement**: Per team a connection covers, the person MUST choose
between all current and future workspaces and specific workspaces. A new
consent MUST default a chosen team to all current and future workspaces, and
existing connections MUST keep exactly what they reach until their owner
changes it.

**Model**: a team row in `mcp_oauth_grant_teams` is "all current and future
workspaces"; no team row is "specific workspaces", the
`mcp_oauth_grant_workspaces` rows of that team. Grants made before this
existed have no team rows, so the rollout changes nothing they reach (no
backfill).

**Invariants**:
- Choosing a team stays a separate, deliberate act from ticking a workspace.
  The page never chooses a team the person did not pick, apart from the hint's
  team or a single team (see "Account-level consent"), and never adds a team to
  an existing grant.
- All current and future workspaces covers every workspace of the team whose
  name does not start with `__` (internal workspaces are never part of it, but
  one granted one by one stays granted), while the user is a member, at the
  grant's own read/write scopes and `acts_as`, and at the user's role there.
  The consent page, the confirmation and Settings say so.
- **Move-in** is defined as joining: a workspace moved into a team covered as a
  whole is reached on the next request, exactly as one created there. A
  workspace moved out, or deleted, is not. A team on specific workspaces gains
  nothing from either. Team membership is still required in both cases, so a
  move never lets a connection reach a team its user is not on.
- Creating a workspace (`POST /api/workspaces`), deleting one
  (`DELETE /api/workspaces/[id]`) and moving one (the migration's
  `workspace_team` phase) clear `callerDep.teamWorkspaces` for the teams
  involved; the 60 s cache bound covers any other path.
- A team covered as a whole whose session account does not exist yet gets it
  when Settings turns it on (`ensureTeamSessionAccount`), at code exchange, or
  on the first `/api/mcp` call naming one of its workspaces.
- Membership loss, revoke and expiry end access to a whole team exactly as to
  specific workspaces.
- Settings (`PATCH /api/mcp-grants/[id]`, `teams: [{ teamId, mode }]`):
  `all` adds the team row; `specific` with `workspaceIds` freezes exactly
  those (each in that team): they are written first, then the team row and the
  team's other rows go, so a workspace that stays is reachable throughout;
  `none` takes the team out. Every team and workspace is re-checked against
  membership (403, nothing written, no id echoed). Removing one workspace a
  whole-team choice still covers is refused (409 `inherited_from_team`)
  instead of appearing to work.
- Concurrency: an edit sends `ifRevision`; the grant row update is conditional
  on it. A stale edit is refused (409 `stale_connection`) with the connection
  as it is now, and nothing is written.
- History: creating, editing and revoking a connection append a
  `mcp_oauth_grant_events` row with the acting user and the reach before and
  after (`access`, `actsAs`, `wholeTeamIds`, `specificWorkspaceIds`).
- A team is never shown without a name: a blank name reads "Unnamed team" with
  the first 8 characters of its id (`displayTeamName`), on the consent page, in
  Settings and in `list_workspaces`. `list_workspaces` on the generic transport
  reads the team name `GET /api/workspaces` sends (`teamName`).

**Acceptance criteria**:
- AC-85: GIVEN a consent approving team A on all current and future
  workspaces WHEN the grant is created THEN it has a team row for A and no
  workspace rows, and resolves to every non-internal workspace of A and none
  of another team the user is on.
- AC-86: GIVEN that grant and a warm cache WHEN a workspace is created in A
  through `POST /api/workspaces` THEN the next `list_workspaces` on the same
  access token includes it; a grant with specific workspaces of A does not.
- AC-87: GIVEN that grant WHEN a workspace is moved into A THEN the next call
  reaches it; WHEN one is moved out of A or deleted THEN it does not.
- AC-88: GIVEN a whole-team grant WHEN the user is removed from the team, or the
  grant is revoked or expires, THEN the next call is refused.
- AC-89: GIVEN a consent choosing a team on specific workspaces THEN only the
  ticked workspaces are granted and no team row is written; GIVEN one with
  nothing ticked, or no team chosen, THEN the page asks again (400) and nothing
  is written.
- AC-90: GIVEN a consent or a Settings edit naming a team the user is not on,
  or a workspace of another team under a team's specific choice, THEN it is
  refused with 403, nothing is written and no id is echoed.
- AC-91: GIVEN a grant made with specific workspaces only WHEN a workspace is
  created in its team THEN what it reaches is unchanged.
- AC-92: GIVEN a grant on specific workspaces WHEN Settings sets its team to all
  THEN the next call on the same access token reaches every workspace of the
  team, and a history row records the actor with before and after.
- AC-93: GIVEN a team on all workspaces WHEN Settings sets it to specific with
  the reviewed list THEN exactly that list remains and a later workspace is not
  reached; WHEN a remove names a workspace the team still covers THEN 409
  `inherited_from_team` and nothing changes.
- AC-94: GIVEN an edit with an `ifRevision` older than the grant's THEN 409
  `stale_connection` with the current connection, and nothing is written.
- AC-95: GIVEN a team with a blank name THEN the consent page, Settings and
  `list_workspaces` show "Unnamed team <id8>", never an empty name.

**Code surface**:
- Resolution: `apps/web/src/lib/mcp-grants.ts`: `resolveGrantedWorkspaces()`,
  `grantTeamIds()`, `createGrant()`, `recordGrantEvent()`;
  cache deps: `apps/web/src/lib/api-auth.ts` `resolveCallerGrant()`,
  `apps/web/src/lib/caller-cache.ts` `callerDep.teamWorkspaces`
- Hooks: `apps/web/src/app/api/workspaces/route.ts`,
  `apps/web/src/app/api/workspaces/[id]/route.ts`,
  `apps/web/src/lib/workspace-migration.ts`
- Consent: `apps/web/src/lib/oauth/account-consent.ts`:
  `validateAccountApproval()`, `describeGrantedTeams()`
- Settings: `apps/web/src/lib/mcp-grant-admin.ts` `updateUserGrant()`,
  `apps/web/src/lib/mcp-grant-patch.ts` `parseGrantPatch()`;
  `apps/web/src/app/app/(protected)/settings/connections/TeamAccessEditor.tsx`,
  `connections-view.ts` `reviewTeamEdit()`
- Names: `packages/shared/src/types.ts` `displayTeamName()`
- Tests: `apps/web/tests/db/mcp-grant-team-access.test.ts` (real Postgres),
  `apps/web/tests/db/mcp-oauth-consent.test.ts`,
  `apps/web/src/lib/oauth/account-consent.test.ts`,
  `apps/web/src/app/api/oauth/authorize/route.test.ts`,
  `apps/web/src/app/app/(protected)/settings/connections/ConnectionsSection.dom.test.tsx`,
  `apps/web/src/app/app/(protected)/settings/connections/connections-view.test.ts`,
  `packages/core/__tests__/list-workspaces-team-name.test.ts`
- Fixtures: `/app/dev/oauth-consent?view=chosen|paged|unnamed`,
  `/app/dev/fixtures?state=mcp-connections`

---

## Resource routing, older addresses and sunset

**Capability statement**: The authorize and token endpoints MUST bind every
code and token to the resource the client asked for: the account level for a
new connection, the one named workspace for an older per-workspace address,
and nothing for an unknown resource. A connection made through an older
address MUST keep working, and refreshing, until the sunset below.

**Why**: hosted clients send `resource` set to the connector address they
were given (ChatGPT documents that it appends `resource=<connector URL>` to
both the authorization and the token request). A connector that was created
with `<issuer>/api/mcp-oauth/<id>` therefore keeps arriving with that
resource. Before this section the endpoint ignored that resource and showed a
picker of every workspace, which could mint a token for a workspace other
than the address and told the person to add one connector per workspace.

**Routing** (`classifyResource` in `apps/web/src/lib/oauth/account-consent.ts`,
same origin as the issuer only):

| `resource` | Consent | Code / token bound to |
|---|---|---|
| none | account consent page | a new grant, audience `<issuer>/api/mcp` |
| `<issuer>/api/mcp` (trailing slash or `?workspace=` / `?repo=` hint allowed) | account consent page | a new grant, audience `<issuer>/api/mcp` |
| `<issuer>/api/mcp-oauth/<id>` | that one workspace only, plus the canonical address | workspace `<id>`, audience `<issuer>/api/mcp-oauth/<id>` |
| anything else (another host, another path, a fragment) | none: `error=invalid_target` to the client | nothing |

**Invariants**:
- The older-address page offers exactly the workspace in the resource, named
  by workspace, team and repository, with the person's access there. A
  `workspace` parameter naming any other workspace is refused (400), and the
  code's workspace comes from the resource, never from a form field. A
  workspace outside the person's teams is refused (403) without naming it.
- The older-address page shows `<issuer>/api/mcp` as the way to choose
  several workspaces in one connection. Approving it never creates a grant
  and never upgrades, redirects or re-audiences the connection: migrating is
  a fresh sign-in at the canonical address, with its own consent, which the
  client starts when the person changes the connector address.
- At the token endpoint (`resourceMatchesBinding` in
  `apps/web/src/lib/oauth/resource-binding.ts`) a `resource` the client sends
  must match the binding: a grant code or refresh only the account resource; a
  workspace code only its own older address. A mismatch is
  `invalid_target`. No resource defers to the binding.
- A workspace-bound **refresh** is not checked against `resource`, so
  connections made before the account resource existed (some send
  `<issuer>/api/mcp` with a workspace token) keep refreshing. Their binding and
  membership re-check are unchanged.
- `/api/mcp-oauth/<id>`, its protected-resource metadata and its deprecation
  headers are unchanged. `buildd install --oauth` keeps writing the older
  address only against a server that does not offer the account resource.
  `bldt_` task tokens and `bld_` keys are not OAuth and are unaffected.

**Sunset** (each step needs the evidence named; none is dated in advance):
1. *Now*: new connections default to the account level; older addresses get
   single-workspace consent with the canonical address; the endpoint serves
   with `Deprecation: true`.
2. *Stop new older-address sign-ins* when, over a trailing 30 days, no
   workspace-bound code has been issued for a client that has not also
   completed an account-level sign-in, and the hosted-client smoke test
   (`docs/mcp-connect-operators.md`) has passed on ChatGPT and Claude at the
   canonical address. Then the older-address resource answers
   `invalid_target` with the canonical address in `error_description`, and the
   endpoint adds a `Sunset` header (RFC 8594) 90 days out.
3. *Remove the endpoint* no earlier than 90 days after step 2 (the absolute
   refresh lifetime, so every older refresh family has ended), and only when no
   live workspace-bound refresh token remains and the endpoint has served no
   request for 14 days. Then remove `/api/mcp-oauth/[workspace]`, its metadata,
   the workspace branch of the token endpoint and the installer fallback.

**Acceptance criteria**:
- AC-78: GIVEN an authorize request with no `resource` WHEN the page renders
  THEN it is the account consent page.
- AC-79: GIVEN `resource=<issuer>/api/mcp-oauth/<A>` WHEN the page renders THEN
  it offers only A, shows the canonical address and no workspace checkbox, and
  approval issues a code bound to A whose token verifies for A and not for B,
  with no grant row.
- AC-80: GIVEN that resource with `workspace=<B>` THEN the response is 400 and
  names no id; GIVEN a workspace outside the person's teams THEN 403.
- AC-81: GIVEN a resource on another host or path WHEN authorize runs THEN the
  client gets `error=invalid_target` with its `state`, and nothing is issued.
- AC-82: GIVEN a workspace code exchanged with another workspace's address,
  or a grant code exchanged with an older address, THEN the token endpoint
  answers `invalid_target`; GIVEN a workspace refresh token sent with
  `<issuer>/api/mcp` THEN it still refreshes, bound to its workspace.
- AC-83: GIVEN a team with a `__coordination` workspace WHEN the account page
  renders THEN it is not offered and a post naming it is refused (403); GIVEN
  the client named it and the person is a team admin THEN it is offered.
- AC-84: GIVEN redirect `https://chatgpt.com/...` THEN the page reads
  "Authorize ChatGPT" marked verified; GIVEN a client naming itself ChatGPT
  with any other redirect THEN it is unverified and shows the return host.

**Code surface**:
- `apps/web/src/lib/oauth/account-consent.ts`: `classifyResource()`,
  `clientIdentity()`, `pickerTeams()`, `workspaceDetail()`,
  `renderLegacyConsentPage()`
- `apps/web/src/lib/oauth/resource-binding.ts`: `resourceMatchesBinding()`
- Authorize and token endpoints: `apps/web/src/app/api/oauth/authorize/route.ts`,
  `apps/web/src/app/api/oauth/token/route.ts`
- Tests: `apps/web/src/lib/oauth/account-consent.test.ts`,
  `apps/web/src/lib/oauth/resource-binding.test.ts`,
  `apps/web/src/app/api/oauth/authorize/route.test.ts`,
  `apps/web/tests/db/mcp-oauth-consent.test.ts` (real Postgres),
  `apps/web/tests/integration/mcp-multi-workspace.test.ts` (live)
- Fixture: `/app/dev/oauth-consent?view=…` (fake data)

---

## Canonical MCP transport

**Capability statement**: `<issuer>/api/mcp` MUST serve a grant token (an
account-level OAuth connection) by resolving every request to exactly one
workspace the grant reaches, never a default; the per-workspace endpoint
`/api/mcp-oauth/[workspace]` keeps serving legacy tokens and says it is
deprecated.

**Invariants**:
- An unauthenticated call, or one with a credential that does not
  authenticate, gets 401 with
  `WWW-Authenticate: Bearer realm="buildd", resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/mcp"`.
  That metadata's `resource` is exactly `<issuer>/api/mcp`. API keys and task
  tokens that do authenticate are unaffected.
- A grant token is resolved on every request (granted ∩ current membership).
  The workspace a request acts in is, in order: the workspace a tool call
  names (`params.workspaceId`, or `workspaceId` on `recall` / `learn`), the
  connection's `?workspace=` / `?repo=`, the workspace of its `?worker=`, the
  only granted workspace. A reference (UUID, `owner/repo`, repo name or
  workspace name) is matched among the granted workspaces only.
- No reference with more than one granted workspace is refused
  (`workspace_required`); a name matching several granted workspaces is
  refused (`workspace_ambiguous`); anything else is `workspace_not_granted`.
  Each refusal lists granted workspaces only and never echoes the reference,
  so an ungranted or unknown workspace reads the same. A connection URL naming
  an ungranted workspace is one generic 403. One request acts in one
  workspace.
- The resolved id replaces the reference before any handler runs, so no
  second, wider name lookup can happen behind it.
- The session is that workspace's team account, at the user's role in that
  team, confined to that one workspace. Every internal self-call sends the
  binding as `x-buildd-workspace`; `authenticateApiKey` honours it for a grant
  token only, and only when the workspace is in the grant (anything else is no
  session). It never widens a grant, and legacy tokens, `bld_` keys and
  `bldt_` task tokens ignore it.
- A grant without `write` is a read-scoped session (`tasks:read`,
  `analytics:read`): write actions are refused on MCP and write routes refuse
  it on REST. A grant with `write` keeps the user's role-level permissions.
- `acts_as` is unchanged by the transport: an `'agent'` grant still has no
  `sessionUserId` in every bound workspace, so person-only actions refuse it.
  A `'person'` grant (requested with `buildd:act-as-person`, which stays out
  of `scopes_supported`) acts as the user.
- `list_workspaces` (a `buildd` action on every transport, `tasks:read`)
  lists the workspaces a connection can act in, grouped by team, with the
  level and access in each, paginated. On a grant session it is the grant ∩
  membership set and nothing else; elsewhere it is what `GET /api/workspaces`
  returns for the caller. It needs no workspace.
- `/api/mcp-oauth/[workspace]` keeps working for legacy tokens and still
  refuses grant tokens. Its responses carry `Deprecation: true` and
  `Link: <<issuer>/api/mcp>; rel="successor-version"`, and its instructions
  tell the client to reconnect to `/api/mcp`.
- Every `buildd` action is served by every transport (`/api/mcp` group and
  legacy surfaces, `/api/mcp-oauth/[workspace]`) through the one shared
  handler, and has a token scope.
- The self-calls both transports make carry the caller's bearer, so they go
  to this server only. The origin comes from its own configuration:
  `VERCEL_URL` on Vercel, else `NEXTAUTH_URL` / `AUTH_URL`, else, outside
  production only, the request's own origin when its host is loopback. There
  is no hardcoded fallback host: when none resolves, the route answers 500
  `self_origin_unconfigured` before any outbound call.

**Acceptance criteria**:
- AC-48: GIVEN no credential, or one that does not authenticate, WHEN
  `/api/mcp` is called THEN it answers 401 with `resource_metadata` naming
  `/.well-known/oauth-protected-resource/api/mcp`, whose `resource` is
  `<issuer>/api/mcp`.
- AC-49: GIVEN a grant over workspaces in two teams WHEN `list_workspaces`
  runs THEN it returns exactly those, with the level per team, and after the
  user leaves one team, only the other.
- AC-50: GIVEN that grant WHEN a call names no workspace THEN it is refused
  with `workspace_required` and the two granted choices, and nothing is
  written.
- AC-51: GIVEN a name shared by two granted workspaces and two ungranted ones
  WHEN a call names it THEN the refusal lists only the two granted; GIVEN a
  name unique among granted workspaces THEN it resolves even though an
  ungranted workspace shares it.
- AC-52: GIVEN an ungranted or unknown workspace id WHEN a call names it THEN
  the refusal is `workspace_not_granted` and does not contain that id.
- AC-53: GIVEN a call naming workspace B WHEN it reads B's task THEN it
  succeeds and every self-call carries B; WHEN it reads A's task naming B THEN
  it reaches nothing.
- AC-54: GIVEN a read-only grant WHEN it calls `create_task` THEN it is
  refused (`requiredScope: tasks:write`) and a write route refuses it, while
  reads succeed.
- AC-55: GIVEN an `'agent'` grant spanning two teams WHEN a request bound to
  one asks to Abandon THEN it is refused; GIVEN a `'person'` grant THEN it is
  allowed.
- AC-56: GIVEN a legacy token WHEN it calls its per-workspace endpoint THEN it
  works and the response carries the deprecation headers and notice; GIVEN a
  `bldt_` token sending another workspace's binding THEN it stays bound to its
  own task's workspace.
- AC-76: GIVEN a production server with no `VERCEL_URL`, `NEXTAUTH_URL` or
  `AUTH_URL` WHEN either MCP transport serves a call THEN it answers 500
  `self_origin_unconfigured` and makes no outbound request; GIVEN
  `NEXTAUTH_URL` THEN every self-call goes to that origin, whatever host the
  request named; GIVEN a non-loopback request host and no configuration THEN
  the request's host is never used.

**Code surface**:
- Transport: `apps/web/src/app/api/mcp/route.ts`: `handleGrantMcpRequest()`
- Resolution: `apps/web/src/lib/mcp-grants.ts`: `describeGrantWorkspaces()`,
  `resolveGrantWorkspaceRef()`, `grantTokenScopes()`
- Refusals and deprecation: `apps/web/src/lib/mcp-grant-session.ts`
- Binding: `apps/web/src/lib/api-auth.ts`: `authenticateGrantSession()`,
  `GRANT_WORKSPACE_HEADER`
- Action: `packages/core/mcp-tools.ts`: `list_workspaces`
- Self-call origin: `apps/web/src/lib/self-origin.ts`: `resolveSelfOrigin()`
- Tests: `apps/web/tests/db/mcp-canonical-transport.test.ts` (real Postgres),
  `apps/web/src/lib/mcp-grant-session.test.ts`,
  `apps/web/src/app/api/mcp/transport-parity.test.ts`,
  `apps/web/src/lib/self-origin.test.ts`,
  `apps/web/src/app/api/mcp/route.scope.test.ts` (self-call origin)

**Not covered here**: what a grant session may reach on REST is the next
section.

## Grant sessions on REST

**Capability statement**: A grant session MUST reach, on every REST surface,
exactly the workspaces it was granted that the user still belongs to, and
nothing its team's shared session account, that account's links or the
team's other workspaces would otherwise allow.

**Invariants**:
- A grant session authenticates as its team's shared session account, so
  `account.teamId`, the account's `account_workspaces` links and "the worker
  is on my account" say nothing about which workspace it may touch. Its
  reach is `account.workspaceIds` (grant ∩ current membership, this request;
  one workspace under the `x-buildd-workspace` binding), checked by one rule:
  `assertGrantedWorkspace(account, workspaceId, 'read' | 'write')` in
  `apps/web/src/lib/grant-scope.ts`. A write needs the grant's `write` scope.
- Restricted mode: a grant session reaches a granted workspace whatever its
  `access_mode`, with no `account_workspaces` link. A grant is an explicit
  per-workspace consent by a current member of that workspace's team, so it
  does not also need the shared account to be linked. This exception is for
  grant sessions only: `bld_` keys, legacy OAuth tokens and `bldt_` task
  tokens keep the restricted-mode rule (a restricted workspace admits only
  linked accounts), and a same-team key with no link still cannot reach a
  restricted workspace.
- A write grant carries no scopes (it acts at the member's role level) and
  is still workspace-confined on every route, exactly as a scoped token is: a
  path, query or body naming another workspace is no session; a team-wide
  collection (`/api/tasks`, `/api/missions`, `/api/prs`, analytics) must name
  a granted workspace; `/api/artifacts`, `/api/workers/active` and
  `/api/roles` are refused; a mission, initiative or release create must name
  its workspace.
- Team administration is refused to a grant session whatever the user's role:
  secrets, providers, accounts and keys, team settings and members,
  connectors, model tiers, experiments, evidence backends and workspace
  creation. So is runner plumbing: `/api/runner/*` (credential and token
  minting), heartbeats, local-session presence, Quality Scout and knowledge
  ingest job claims, inbound webhooks, and the team-wide stale-worker sweep.
  Reading a Scout run's command log stays open (it is `read_evidence`).
- Every handler that picks a workspace for the caller (a PR number, a worker,
  a repo URL, a default when none is named) picks among the granted
  workspaces only: PR-number resolution, PR review, explain, worker
  ownership, `workers/mine`, repo matching, bulk task edits, and a task create
  with no `workspaceId` (the one granted workspace, never a link of the shared
  account).
- `verifyAccountWorkspaceAccess` is handed the authenticated session, not its
  id: the id alone judges the shared account. A unit test fails any production
  call that passes `<account>.id`.
- Claims: a grant session claims only from its granted workspaces.
  `claimAcrossAccessible` is honoured only as the literal `true`, and then
  spans the granted workspaces only; without it, a session granted more than
  one workspace and naming none is refused (the multi-workspace guard, counted
  over the grant).
- An agent connection's workers belong to the person who connected it.
  Every grant session in a team is the same shared account, and an `agent`
  grant carries no `sessionUserId` (it is never a person), so the account
  cannot tell one member's agent from another's. A claim therefore records
  the connecting user on the worker (`workers.claimed_by_user_id`): the
  person for a `person` grant, the grant's user (`oauthUserId`) for an
  `agent` grant (`claimingUserId()` in `apps/web/src/lib/worker-owner.ts`).
  Every "is this my worker" check compares that user, not the account:
  acting as the worker (`callerOwnsWorker`, and its SQL form
  `ownedByCaller` for park/resume), `workers/mine`, the interactive-claim
  session user that keeps an MCP claim alive, and acting on the worker's PR
  as its own run (create/adopt, update, close, merge, supersede:
  `notThisAgentsWorker()` in
  `apps/web/src/lib/agent-capabilities/worker-pr.ts`). On the shared
  account an agent connection's own worker is one its user claimed;
  another member's worker, or one a key claimed there, is not.
  An agent connection is still not a person: person-only actions refuse it.
  `bld_` keys and `bldt_` task tokens own by account as before.

**Acceptance criteria**:
- AC-64: GIVEN a grant to a `restricted` workspace with no account link WHEN
  the session creates a task there THEN it succeeds; GIVEN a `bld_` key of the
  same team with no link THEN it is refused 403.
- AC-65: GIVEN a session granted one workspace of team A WHEN it names an
  open sibling in A, or a workspace of team B the user also belongs to, in a
  path, query or body THEN there is no session; the sibling's task, mission,
  memory, schedules, skills and artifacts are unreachable.
- AC-66: GIVEN the same PR number in the granted workspace and in an
  ungranted sibling WHEN it is resolved THEN only the granted one is found;
  GIVEN a worker of the shared account in the sibling THEN the session may not
  act on it, and `workers/mine` does not list it.
- AC-67: GIVEN a same-named repo in another team, or a sibling renamed to the
  granted workspace's name WHEN listing, repo matching or name resolution
  runs THEN only the granted workspace comes back.
- AC-68: GIVEN a team owner's write grant WHEN it calls a team-administration
  or runner-plumbing route THEN there is no session.
- AC-69: GIVEN a grant revoked, a membership removed, or the granted
  workspace moved to a team the user is not in WHEN the next call arrives
  THEN it reaches nothing and writes nothing.
- AC-70: GIVEN a one-team grant of two workspaces and a pending task in each
  and in an ungranted sibling WHEN it claims with no workspace THEN it is
  refused, also with `claimAcrossAccessible: "true"`; WITH
  `claimAcrossAccessible: true` THEN it claims the two granted tasks and not
  the sibling's.
- AC-71: GIVEN users A and B of one team, each with an agent connection to
  the same workspace WHEN A claims a task THEN the worker is on the shared
  account and records A as its claimer.
- AC-72: GIVEN that worker WHEN B's connection lists `workers/mine`, reads
  it, or reports progress or completion on it THEN it is not listed and the
  read and writes are refused 403 with the worker unchanged; A's connection
  lists, reads and updates it.
- AC-73: GIVEN that worker with a PR WHEN B's connection creates a PR for it
  or closes or merges its PR as its own run THEN it is refused, before
  anything reaches GitHub; A's connection is allowed.
- AC-74: GIVEN a worker a key claimed on the shared account WHEN an agent
  connection checks ownership THEN it does not own it.
- AC-75: GIVEN person connections of A and B WHEN A claims THEN A owns the
  worker and B (in person or through B's agent connection) does not.

**Code surface**:
- Ownership: `apps/web/src/lib/worker-owner.ts`: `claimingUserId()`,
  `agentConnectionUserId()`, `callerOwnsWorker()`;
  `apps/web/src/lib/worker-park.ts`: `ownedByCaller()`;
  `apps/web/src/lib/agent-capabilities/worker-pr.ts`:
  `notThisAgentsWorker()`; `apps/web/src/app/api/workers/mine/route.ts`
- Rule: `apps/web/src/lib/grant-scope.ts`: `assertGrantedWorkspace()`,
  `constrainToGranted()`, `isGrantSession()`
- Route confinement: `apps/web/src/lib/token-route-policy.ts`:
  `canAccessTokenRoute()`
- Reach: `apps/web/src/lib/workspace-reach.ts`, `apps/web/src/lib/team-access.ts`
  (`verifyAccountWorkspaceAccess`), `apps/web/src/lib/workspace-access.ts`
- Confinement helpers: `apps/web/src/lib/task-token-auth.ts`
  (`taskScopeAllowsWorkspace`, `taskScopeAllowsWorker`),
  `apps/web/src/lib/worker-pr-access.ts`, `apps/web/src/lib/pr-resolve.ts`
- Claims: `apps/web/src/app/api/workers/claim/route.ts`
- Tests: `apps/web/tests/db/grant-scope-matrix.test.ts` (real Postgres),
  `apps/web/tests/db/agent-connection-owner.test.ts` (real Postgres, AC-71..60),
  `apps/web/src/lib/grant-scope.test.ts`, `apps/web/src/lib/worker-owner.test.ts`
---

## Managing connections

**Capability statement**: A person MUST be able to see every MCP connection
they made, what each one reaches and how it acts, set each team to all current
and future workspaces or specific workspaces, add or remove workspaces, switch
read/write, downgrade it to an agent, or revoke it, from Settings › Connected
apps. Every change applies on the app's next request.

**API** (`apps/web/src/app/api/mcp-grants/`, `apps/web/src/lib/mcp-grant-admin.ts`):
- `GET /api/mcp-grants` → `{ connections, legacy, teams }`: the person's
  active grants (app name, `actsAs`, `read` | `read-write`, last token issue,
  `revision`, reachable workspaces with team names, `teams` with each team's
  `mode` and the workspaces reached there now, and counts of granted
  workspaces and whole teams no longer reachable); their legacy per-workspace
  connections (app, workspace, last active); and their teams with every
  workspace, for the picker.
- `PATCH /api/mcp-grants/[id]` `{ addWorkspaceIds?, removeWorkspaceIds?,
  teams?: [{ teamId, mode: 'all' | 'specific' | 'none', workspaceIds? }],
  access?, actsAs?: 'agent', ifRevision? }` → `{ connection }`. Unknown fields
  are refused. See "Team access modes" for `teams`, `ifRevision` and the 409s.
- `DELETE /api/mcp-grants/[id]` → `{ revoked: true }`.

**Invariants**:
- Dashboard session only (`getCurrentUser`). An API key, a task token or an
  MCP grant token cannot read or change connections, so a connection cannot
  widen itself.
- A person reads and edits only their own grants. Every statement carries the
  owner in its `WHERE`; another user's grant, a revoked one and an unknown id
  all answer the same 404 and change nothing, refresh tokens included.
- Adding a workspace re-checks membership at the edit, never trusting the list
  the page was shown. One unreachable id refuses the whole change (403
  `workspace_not_accessible`), nothing is written, and no refusal repeats an
  id from the request.
- An added workspace works on the next request even when its team has no
  session account yet (a team joined after connecting). The PATCH provisions
  that team's `type='user'` account, the same one the token endpoint creates
  at code exchange and refresh (`ensureTeamSessionAccount`). A refused change
  provisions nothing. `/api/mcp` also provisions it when a granted
  workspace's team has none, rather than answering 401: an MCP client reads a
  401 as signed out of the whole connection.
- A connection keeps at least one reachable workspace; removing the last one
  is refused (400), and the person revokes it instead.
- `acts_as` can go from `'person'` to `'agent'` here, never back. A PATCH
  with `actsAs: 'person'` is refused (403 `person_needs_consent`) before
  anything is read, even bundled with an otherwise valid change. Acting as
  the person needs a fresh consent with `buildd:act-as-person`.
- The grant row stays the authority. Every edit clears the grant's cached
  session, so a shrink, a read-only switch or a downgrade applies on the next
  request on an access token already issued. The scope string on the grant's outstanding
  refresh tokens is rewritten to match, so the next token response does not
  claim a person scope the grant no longer has.
- Revoke marks the grant revoked and revokes every refresh token under it, in
  every family, scoped to the owner (`revokeGrant`). The access token stops
  resolving on its next request and every refresh token is refused.
- Legacy per-workspace connections are listed, not edited, with a hint to
  move to the one account-level connection.
- The page lives in Settings under "You", apart from MCP
  connectors (the outside tools agents call). Each team shows its mode with an
  Edit access control (`TeamAccessEditor`): the review before Save states what
  changes and, for any widening, the permission and kind it inherits; a team
  on all workspaces shows no per-workspace Remove. The specific-workspace
  picker reuses the consent page's state model and reducer (`applyNav`,
  `filteredWorkspaces`, `CONSENT_PAGE_SIZE`), so ticks survive search and
  paging. One request at a time per connection; a failed save keeps the edit.

**Acceptance criteria**:
- AC-57: GIVEN a signed-in person WHEN `GET /api/mcp-grants` runs THEN it lists
  only their own active grants and their own teams, never another user's grant
  or an outside team's workspace.
- AC-58: GIVEN another user's grant id WHEN PATCH or DELETE names it THEN the
  answer is 404 with no id in the body, and the grant, its workspaces and its
  refresh tokens are unchanged.
- AC-59: GIVEN an add naming a workspace outside the person's teams, an
  unknown id, or a workspace whose team they just left WHEN PATCH runs THEN it
  is refused with 403, nothing is written, and no id is echoed.
- AC-60: GIVEN a live grant token WHEN a workspace is added, a workspace is
  removed, or access is switched to read only THEN the next request on the
  same token reaches the added workspace, no longer reaches the removed one,
  and is a read-scoped session.
- AC-61: GIVEN a `'person'` grant WHEN PATCH sets `actsAs: 'agent'` THEN the
  next request is not a person (`requestingPerson()` is null) and the next
  token response has no person scope. GIVEN an `'agent'` grant WHEN PATCH
  sets `actsAs: 'person'` THEN it is refused with 403 and the row stays
  `'agent'`.
- AC-77: GIVEN a grant on team A and a team D the person joined later, with
  no session account WHEN PATCH adds a D workspace THEN the next call on the
  same access token naming it succeeds (no refresh), D has exactly one
  session account, and later edits create none; GIVEN a granted workspace
  whose team has no session account by any other path WHEN `/api/mcp` serves
  a call naming it THEN it succeeds instead of answering 401.
- AC-62: GIVEN a grant with refresh tokens in two families WHEN DELETE runs
  THEN every refresh token under it is revoked, each refresh is refused, the
  access token stops resolving, and a second DELETE is 404.
- AC-63: GIVEN legacy per-workspace refresh tokens WHEN the person lists
  connections THEN each reachable app and workspace is listed once, and one
  in a team they are not on is not.

**Code surface**:
- API: `apps/web/src/app/api/mcp-grants/route.ts`,
  `apps/web/src/app/api/mcp-grants/[id]/route.ts`
- Library: `apps/web/src/lib/mcp-grant-admin.ts`: `listUserConnections()`,
  `updateUserGrant()`, `consentTeamsForUser()`;
  `apps/web/src/lib/mcp-grant-patch.ts`: `parseGrantPatch()`;
  `apps/web/src/lib/mcp-grants.ts`: `revokeGrant()`
- Session account provisioning: `apps/web/src/lib/oauth/ensure-session-account.ts`
  `ensureTeamSessionAccount()` (also used by `apps/web/src/app/api/oauth/token/route.ts`
  and `apps/web/src/app/api/mcp/route.ts`)
- UI: `apps/web/src/app/app/(protected)/settings/connections/`:
  `ConnectionsSection.tsx`, `WorkspacePicker.tsx`; dev fixture
  `/app/dev/fixtures?state=mcp-connections`
- Tests: `apps/web/tests/db/mcp-grant-management.test.ts` (real Postgres),
  `apps/web/src/app/api/mcp-grants/[id]/route.test.ts`,
  `apps/web/src/app/api/mcp-grants/route.test.ts`,
  `apps/web/src/app/app/(protected)/settings/connections/ConnectionsSection.dom.test.tsx`

### Live end-to-end check and docs

The sections from "Account-level MCP grants" to here are also checked over
HTTP against a running production build by
`apps/web/tests/integration/mcp-multi-workspace.test.ts`: discovery and the
401 challenge, DCR, authorize with PKCE, the consent POST, code exchange, MCP
calls in two teams, the four workspace refusals, both kinds (an agent refused
Abandon and a landing-override grant, a person allowed both), refresh
rotation and replay, read-only, shrink and expand, membership loss, revoke,
reconnect, and the legacy endpoint with its deprecation headers. It is opt-in
(`BUILDD_LIVE_MCP_E2E=1`), loopback only, and not in CI's integration list;
the recipe is in `docs/mcp-connect-operators.md`. User guide:
`docs/mcp-connect.md`.

It also covers a workspace added in Settings in a team joined after
connecting, which has no session account until one is provisioned (AC-77).
---
