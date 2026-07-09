# Generic MCP Connectors

> **Status: proposed.** This doc specifies Phase 2 of the MCP connector system.
> Phase 1 (static `mcp_credential` secrets injected as env vars) is already shipped.
> Phase 2 makes buildd a generic MCP OAuth client — users add any remote MCP server
> by URL; buildd handles the full auth handshake; runners get connectors injected at
> claim time.

---

## Terminology disambiguation

Two OAuth flows coexist in this codebase and must not be confused:

- **buildd as OAuth server** — buildd's own `/api/mcp-oauth/[workspace]` endpoint lets
  external clients (e.g. claude.ai) authenticate *to* buildd's MCP server using OAuth 2.1.
  See `apps/web/src/lib/oauth/config.ts` and the `mcp-oauth` routes.
- **buildd as OAuth client** ← **this spec** — buildd authenticates *to* remote MCP
  servers on behalf of a workspace. The connector table, callback route, and token
  lifecycle below all belong to this second flow.

---

## Goals

1. Users add any remote MCP server by URL — no per-provider code in buildd.
2. buildd handles the complete OAuth 2.1 / DCR handshake.
3. Runners receive live access tokens injected into the agent MCP config at claim time.
4. Static/no-auth servers work through the same connector model (one table, three modes).
5. Mid-task 401s surface to the UI without retry-looping.

Out of scope: hosting MCP servers, per-provider adapters, stdio server bundling.

---

## 1. Connection flow

The connection flow follows the MCP Authorization spec
(OAuth 2.1 + RFC 8414 + RFC 7591). Steps happen in the browser (the user's tab
initiates the OAuth redirect); the callback lands back on buildd.

```
Browser                  buildd API               Remote MCP server
───────                  ──────────               ─────────────────
POST /api/connectors     ────probe GET──────────────────────────────►
  { url, name }
                         ◄── 401 WWW-Authenticate: Bearer realm=...,
                                   resource_metadata=<url> ──────────

                         GET <resource_metadata url>                 ►
                         ◄── { resource: ...,
                               authorization_servers: [...] } ───────

                         GET <as>/.well-known/oauth-authorization-server
                         ◄── AS metadata (authorization_endpoint,
                                          token_endpoint,
                                          registration_endpoint, ...) ──

                         POST <registration_endpoint>  (DCR RFC 7591) ►
                           { redirect_uris, client_name, ... }
                         ◄── { client_id, client_secret? } ──────────
                         [fallback: user provides client_id/secret manually]

                         Build authorization URL (PKCE S256, state, nonce)
                         ────────────────────────────────────────────────►
                         302 redirect → browser (stored in connector row)

User approves at remote IdP ───────────────────────────────────────────►
                         ◄── GET /api/connectors/callback?code=...&state=...

                         Verify state param (CSRF)
                         POST <token_endpoint>                         ►
                           { code, code_verifier, redirect_uri, ... }
                         ◄── { access_token, refresh_token?,
                                expires_in?, token_type }

                         Validate audience (§4)
                         Store in secrets table
                         Flip connector.status → connected
                         ────────────────────────────────────────────────►
                         302 → /connections (success)
```

### 1.1 Unauthenticated probe

Before starting OAuth the server probes the MCP URL with a bare GET (no auth). Three outcomes:

| Probe result | Interpretation |
|---|---|
| 200 | Server is `auth_mode = none`. No further auth needed. |
| 401 with `WWW-Authenticate: Bearer resource_metadata=<url>` | Standard MCP OAuth. Proceed with discovery. |
| 401 without `resource_metadata` | Likely static header auth. UI offers manual field. |

### 1.2 Protected Resource Metadata (PRM)

Fetch `resource_metadata` URL (typically `<server>/.well-known/oauth-protected-resource`).
Parse `authorization_servers[0]` as the authorization server base URL.

If PRM is missing but a `www-authenticate` bearer realm is present, treat the realm URL as
the authorization server directly and attempt `/.well-known/oauth-authorization-server`.

### 1.3 Authorization Server Metadata (RFC 8414)

Fetch `<as>/.well-known/oauth-authorization-server`. Extract:
- `authorization_endpoint`
- `token_endpoint`
- `registration_endpoint` (optional — DCR)
- `code_challenge_methods_supported` (must include `S256`)
- `response_types_supported` (must include `code`)

Store the full AS metadata doc in `connector.discoveredMetadata`.

### 1.4 Dynamic Client Registration (RFC 7591)

If `registration_endpoint` is present:

```json
POST <registration_endpoint>
Content-Type: application/json

{
  "redirect_uris": ["https://buildd.dev/api/connectors/callback"],
  "client_name": "buildd",
  "token_endpoint_auth_method": "client_secret_post",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

Store `{ client_id, client_secret }` in `connector.clientRegistration` (encrypted JSONB).

**Fallback**: if no `registration_endpoint`, the connector UI surfaces manual "Client ID"
and "Client secret" fields. The user pastes pre-registered credentials; these are stored
identically to DCR output.

### 1.5 Authorization redirect (PKCE S256)

Generate per-session:
- `code_verifier`: 64 bytes, base64url, stored temporarily in a short-lived DB row (or
  signed cookie) keyed to `state`
- `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`
- `state`: 32 random bytes, base64url — doubles as CSRF token

Build authorization URL:
```
<authorization_endpoint>
  ?response_type=code
  &client_id=<client_id>
  &redirect_uri=https://buildd.dev/api/connectors/callback
  &scope=<scopes from AS metadata, or empty>
  &code_challenge=<code_challenge>
  &code_challenge_method=S256
  &state=<state>
```

Redirect browser there. Store `{ connectorId, codeVerifier, workspaceId, teamId }` mapped
to `state` in a DB row with a 10-minute TTL (reuse the `deviceCodes` pattern).

### 1.6 Callback route: `GET /api/connectors/callback`

1. Look up `state` → retrieve `{ connectorId, codeVerifier, workspaceId, teamId }`.
   Return 400 if missing or expired.
2. Exchange code for tokens:
   ```
   POST <token_endpoint>
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code
   &code=<code>
   &redirect_uri=https://buildd.dev/api/connectors/callback
   &client_id=<client_id>
   &client_secret=<client_secret>    (if present)
   &code_verifier=<code_verifier>
   ```
3. Validate audience (§4).
4. Encrypt and store tokens in `secrets` (§3).
5. Flip `connector.status = 'connected'`, clear any `lastError`.
6. Delete the ephemeral `state` row.
7. `302 → /connections?connected=<connectorId>`.

---

## 2. Auth-mode ladder

One `connectors` table covers all three modes. The `authMode` column controls how
the claim-time injector builds the authorization header.

| `authMode` | How credentials are stored | Claim-time injection |
|---|---|---|
| `none` | — | No `Authorization` header added |
| `static_header` | `secrets` row (`purpose='mcp_connector_credential'`, `label='<header-name>'`) | Inject `Authorization: Bearer <value>` or `<label>: <value>` for x-api-key style |
| `oauth_discovered` | `secrets` row with `access_token` (+ optional `refresh_token`) | Inject `Authorization: Bearer <access_token>`; refresh if expired |

`static_header` reuses the existing `manage_secrets` path today — users paste a bearer
token; it is stored with `purpose='mcp_credential'` and a label matching the env var name.
Under this spec, those rows gain an optional FK to a `connectors` row. Existing static
secrets continue to work unchanged.

---

## 3. Schema

### 3.1 `connectors` table

```sql
CREATE TABLE connectors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = team-wide

  name            TEXT NOT NULL,
  url             TEXT NOT NULL,           -- base URL of the MCP server

  auth_mode       TEXT NOT NULL            -- 'none' | 'static_header' | 'oauth_discovered'
                  CHECK (auth_mode IN ('none', 'static_header', 'oauth_discovered')),

  -- OAuth discovery cache (oauth_discovered mode only).
  -- Full AS metadata doc as returned by RFC 8414 discovery.
  discovered_metadata  JSONB,

  -- Encrypted DCR output or user-supplied client creds.
  -- { client_id: string, client_secret?: string }
  -- Stored encrypted (AES-256-GCM via existing encrypt()).
  client_registration  TEXT,

  -- Connector lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'connected', 'expired', 'needs_reconnect', 'error')),
  last_error      TEXT,

  -- Workspace-level enable/disable toggle (vs team-level connection).
  -- NULL = inherits team default (enabled).
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX connectors_team_idx ON connectors(team_id);
CREATE INDEX connectors_workspace_idx ON connectors(workspace_id);
```

`workspace_id IS NULL` means the connector is registered at team level and visible to
all workspaces. A workspace can disable a team-level connector by flipping `enabled = false`
on a workspace-scoped row (see §5 scope resolution).

### 3.2 Token storage in `secrets`

Connector tokens are stored in the existing `secrets` table with:

| Column | Value |
|---|---|
| `purpose` | `'mcp_connector_credential'` (new purpose literal) |
| `label` | connector UUID (FK by value — no explicit FK column needed) |
| `teamId` | owning team |
| `workspaceId` | NULL for team-level connectors; set for workspace-scoped |
| `encryptedValue` | AES-256-GCM blob: `{ access_token, refresh_token?, token_type }` |
| `tokenExpiresAt` | derived from `expires_in` response field |
| `lastRefreshedAt` | updated on each token refresh (optimistic lock column) |

This reuses the full codex-credential refresh + rotation pattern
(`refreshCodexCredential` → generalized `refreshConnectorToken`). No new table; one new
`purpose` literal (added to the `$type<...>` union in `schema.ts`).

**Schema migration steps** (for implementers):

1. Add `connectors` table: `bun db:generate` → commit migration.
2. Add `'mcp_connector_credential'` to the `secrets.purpose` type union.
3. Add `connector_oauth_states` table for PKCE/state tracking (reuse `deviceCodes` shape
   but with `connectorId`, `codeVerifier`, `workspaceId`, `teamId`).

---

## 4. Token audience validation

After token exchange, verify the issued `access_token` is bound to the target resource
(MCP server URL). This prevents token confusion attacks where a user is tricked into
connecting to a malicious server that forwards tokens to the real server.

**Validation steps:**

1. Decode the JWT (without verifying signature — we trust our token endpoint HTTPS).
2. Check `aud` claim contains the target resource URL (from PRM `resource` field).
3. If `aud` is absent (non-JWT or opaque token), skip — the token was issued by the
   server's own token endpoint; audience is implicit.
4. If `aud` is present but does not include the resource URL, reject and set
   `connector.status = 'error'`, `lastError = 'Token audience mismatch'`.

Implementation: reuse `jwtExpSeconds()` from `codex-credential.ts` as a model for
lightweight JWT parsing without a crypto library dependency.

---

## 5. Runner injection contract

At claim time, for each connector in scope that is `enabled = true` and
`status = 'connected'`, append an entry to the agent's MCP server config:

```json
{
  "type": "url",
  "url": "<connector.url>",
  "authorization_token": "<decrypted access_token>"
}
```

This follows the Claude Code MCP `{ type: "url", url, authorization_token }` shape
that runners already use for injecting HTTP MCP servers.

### 5.1 Scope resolution

A task in workspace `W` (team `T`) receives connectors from:

1. Team-level connectors (`workspace_id IS NULL`, `enabled = true`).
2. Workspace-level connectors (`workspace_id = W`, `enabled = true`).

A workspace can disable a team-level connector by having a workspace-scoped connector
row pointing to the same `url` with `enabled = false` (override row pattern, same as
the secrets scoping model). This is an advanced case; the UI surfaces it as a
"workspace override" toggle.

**Conflict resolution**: if a team-level and workspace-level connector share the same
`url`, the workspace-level row wins (most-specific-wins, same as `secrets` precedence).

### 5.2 Claim-time implementation

In `apps/web/src/app/api/workers/claim/route.ts`, after the existing `mcpSecretsMap`
is built:

```typescript
// Inject oauth_discovered connectors
const connectorRows = await db.query.connectors.findMany({
  where: and(
    eq(connectors.teamId, workspaceTeamId),
    eq(connectors.enabled, true),
    eq(connectors.status, 'connected'),
    or(
      isNull(connectors.workspaceId),
      eq(connectors.workspaceId, task.workspaceId),
    ),
  ),
  columns: { id: true, url: true, workspaceId: true, authMode: true },
});

// Resolve scope: workspace-scoped beats team-level for same URL
const byUrl = new Map<string, typeof connectorRows[0]>();
for (const c of connectorRows.sort(r => r.workspaceId ? 1 : 0)) {
  byUrl.set(c.url, c);
}

const injectedServers: McpServerEntry[] = [];
for (const [url, connector] of byUrl) {
  if (connector.authMode === 'none') {
    injectedServers.push({ type: 'url', url });
    continue;
  }
  const credRow = await resolveConnectorToken(connector.id, workspaceTeamId, task.workspaceId);
  if (!credRow) continue;
  const token = decrypt(credRow.encryptedValue); // then parse blob → access_token
  injectedServers.push({ type: 'url', url, authorization_token: token });
}

if (injectedServers.length > 0) {
  (cw as any).connectorServers = injectedServers;
}
```

The runner merges `connectorServers` into the `.mcp.json` it writes before spawning the
agent process.

### 5.3 Pre-flight token refresh

Before injecting, if `tokenExpiresAt` is within 5 minutes of now, refresh inline
using the same `refreshConnectorToken()` helper (generalised from
`refreshCodexCredential()`). If refresh fails, skip that connector and log a warning;
do not block task claim.

---

## 6. Mid-task 401s

If the agent receives a 401 from an MCP server during task execution:

1. The runner detects it via `isAuthError()` in `claim-breaker.ts` (the existing
   `'401 unauthorized'` pattern already catches this). The runner does not retry the
   MCP call.
2. The runner emits a `connector_auth_error` event via `emit_event` with
   `{ connectorId, url }` in metadata.
3. The API handler for this event:
   - Sets `connector.status = 'needs_reconnect'`.
   - Invalidates (deletes) the stale token from `secrets`.
4. The existing `ContextBreaker` pauses claim attempts for the affected auth context
   (prevents the task from immediately retrying and burning the same bad token).
5. In the UI, connectors with `status = 'needs_reconnect'` show a prominent
   "Reconnect" badge on the Connections page (§7).

**No retry loop.** The runner surfaces the 401 as a task failure event; the task
itself may succeed with degraded MCP access depending on the agent's handling.

---

## 7. Connections UI (`/connections`)

New top-level page at `buildd.dev/connections`. Entry in the sidebar nav below Settings.

### 7.1 Connector list

Each connector card shows:
- Name + URL
- Status badge: `connected` (green), `expired` (yellow), `needs_reconnect` (red),
  `pending` (grey), `error` (red)
- Auth mode pill: `OAuth` / `API Key` / `No auth`
- Scope: `Team` / `Workspace: <name>`
- Actions: **Reconnect**, **Disconnect**, **Edit**

### 7.2 Add connector flow

"Add connector" button → drawer/modal:

1. **URL field** (required). On blur, fire `POST /api/connectors/probe` with `{ url }`:
   - Returns `{ authMode: 'none' | 'static_header' | 'oauth_discovered', hint? }`.
   - UI adapts: hides OAuth fields for `none`; shows "Bearer token" input for
     `static_header`; shows "Connect with OAuth" button for `oauth_discovered`.
2. **Name field** (auto-suggested from PRM `resource` field or URL hostname).
3. **Advanced toggle** — reveals manual Client ID / Client Secret fields
   (overrides DCR for `oauth_discovered`; sets bearer token for `static_header`).
4. **Scope selector** — "All workspaces (team)" vs "This workspace only".
5. **Connect** button:
   - For `oauth_discovered`: initiates the OAuth redirect flow (§1.5).
   - For `static_header`: saves the token directly, sets `status = 'connected'`.
   - For `none`: saves the connector row, sets `status = 'connected'`.

### 7.3 API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/connectors` | List connectors (scoped to team + workspace) |
| `POST` | `/api/connectors` | Create connector, initiate probe |
| `POST` | `/api/connectors/probe` | Probe URL, return auth-mode hint (no auth required) |
| `GET` | `/api/connectors/callback` | OAuth callback (public, validates state) |
| `PATCH` | `/api/connectors/[id]` | Update name, enabled, scope |
| `DELETE` | `/api/connectors/[id]` | Remove connector + associated secrets |
| `POST` | `/api/connectors/[id]/reconnect` | Restart OAuth flow for expired connector |

---

## 8. Security

### 8.1 Encrypted-at-rest tokens

All access tokens, refresh tokens, and client secrets use the existing `encrypt()` /
`decrypt()` helpers (`packages/core/secrets.ts` — AES-256-GCM with `ENCRYPTION_KEY`).
Token values never appear in:
- Application logs (never log `encryptedValue`, `access_token`, `refresh_token`)
- Task output (runner does not echo injected token to stdout)
- Error messages returned to the client (log sanitized `[REDACTED]` forms)

### 8.2 Redirect URI allowlisting

The `redirect_uri` used in DCR and authorization requests is always the fixed value
`https://buildd.dev/api/connectors/callback`. There is no dynamic redirect URI.
The callback route rejects any `redirect_uri` mismatch from the AS.

### 8.3 CSRF / state param

The `state` parameter is a 32-byte random value generated per authorization request and
stored in the DB. The callback route:
1. Looks up `state` → retrieves stored `{ connectorId, codeVerifier, workspaceId, teamId }`.
2. Returns 400 if the row is missing or expired (10-minute TTL).
3. Deletes the row immediately after use (one-time nonce).

The user's session must be authenticated to initiate the OAuth flow (`POST /api/connectors`
requires a valid buildd session cookie or API key). The callback route does not require
session auth — only a valid, unexpired `state` param.

### 8.4 Scope and access control

- Only team admins may add or remove team-level connectors.
- Any workspace member may add workspace-scoped connectors.
- `GET /api/connectors` filters to the authenticated user's visible workspaces.
- Token values are never returned by any API response — only metadata (status,
  `lastRefreshedAt`, connector name/URL).

### 8.5 Token rotation

For connectors that issue refresh tokens, the refresh follows the same
optimistic-lock rotation pattern as codex credentials:

```sql
UPDATE secrets
   SET last_refreshed_at = NOW(), updated_at = NOW()
 WHERE id = $1
   AND (last_refreshed_at IS NULL
        OR last_refreshed_at < NOW() - INTERVAL '60 minutes')
RETURNING *
```

Only the winner of the lock refreshes; others get `'locked'` and skip. The new
refresh token (if rotated) is always persisted to prevent silent logouts.

### 8.6 Probing untrusted URLs

`POST /api/connectors/probe` fetches the user-supplied URL. Risks:
- **SSRF**: block private IP ranges and link-local addresses (`10.x`, `172.16-31.x`,
  `192.168.x`, `127.x`, `169.254.x`, `::1`, `fc00::/7`). Use an allowlist of URL
  schemes: `https` only in production; `http` allowed only on `localhost` in
  development.
- **Redirect following**: do not follow redirects during the probe — this prevents
  open-redirect chains that reach internal resources.

---

## 9. Token refresh cron

Generalize the existing `GET /api/cron/codex-token-refresh` to also cover
`mcp_connector_credential` secrets:

```typescript
// In the cron route, after refreshing codex secrets:
const expiringConnectorSecrets = await db.query.secrets.findMany({
  where: and(
    eq(secrets.purpose, 'mcp_connector_credential'),
    lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
  ),
  columns: { id: true, label: true }, // label = connectorId
});

for (const s of expiringConnectorSecrets) {
  await refreshConnectorToken(s.id); // generalised from refreshCodexCredential
}
```

`refreshConnectorToken(secretId)` reads the connector's `token_endpoint` from
`discoveredMetadata`, sends `grant_type=refresh_token`, persists the rotated tokens,
and updates `connector.status`. If the server rejects the refresh token (400/401),
set `connector.status = 'needs_reconnect'`.

Recommended cron schedule: every 4 hours (same as codex-token-refresh).

---

## Appendix A — Linear work-tracker layer (Phase 3, optional)

> Phase 3 is optional per workspace. It builds on generic connectors and is activated
> by a workspace setting. Nothing in Phase 2 is designed exclusively for Linear.

### A.1 Workspace setting

```typescript
workTracker: {
  connectorId: string;     // connector.id pointing at a Linear (or other) MCP server
  provider: 'linear';      // inferred from URL (linear.app domain → 'linear')
} | null
```

Provider is detected at connector-add time by URL pattern:
- `linear.app` → `'linear'`
- (others added as needed without schema changes — the `provider` field is a hint,
  not an enum that gates functionality)

### A.2 Outbound sync (mission → project link)

When a mission is created with `workTracker` enabled:
- Create a Linear project via the connector's MCP tool.
- Store the returned project ID in `missions.externalProjectId` (new nullable column).

When a task completes or a PR merges:
- Post a comment to the linked Linear issue via MCP tool.
- Transition the issue state to "Done" (or equivalent).
- Store the issue ID in `tasks.externalIssueId` (new nullable column).

### A.3 Inbound webhook → task (later)

Inbound Linear webhooks create buildd tasks — gated by a `'buildd'` label on the issue.
This is a separate webhook receiver (`/api/integrations/linear/webhook`) and is
intentionally excluded from Phase 2. It requires a separate Linear OAuth app registration
(webhook subscriptions need additional scopes).

### A.4 Interim approach

Until Phase 3 ships, teams can use the existing role `mcpServers` field to add a
Linear MCP server manually (paste URL + bearer token via `manage_secrets`). The generic
connector spec does not break this — it is an additive UI wrapper over the same
underlying injection mechanism.

---

## Appendix B — Phase 2 build tasks

These tasks should be filed as dependents after spec approval. Listed in execution
order with rough boundaries:

| # | Title | Rough scope |
|---|---|---|
| B-1 | Schema: add `connectors` table + `connector_oauth_states` + new secrets purpose | `packages/core/db/schema.ts` → `bun db:generate` |
| B-2 | `lib/connector-credential.ts` — store, resolve, refresh, delete (generalised from `codex-credential.ts`) | New lib file; unit tests |
| B-3 | `POST /api/connectors/probe` — URL probe, auth-mode detection | Route + tests |
| B-4 | `POST /api/connectors` — create row, DCR, build auth URL, redirect | Route + tests |
| B-5 | `GET /api/connectors/callback` — PKCE exchange, audience validation, token store | Route + tests |
| B-6 | `GET|PATCH|DELETE /api/connectors/[id]` — CRUD + reconnect | Routes + tests |
| B-7 | Extend `GET /api/cron/codex-token-refresh` to cover `mcp_connector_credential` | Update cron route |
| B-8 | Claim-time injection — extend `POST /api/workers/claim` to append `connectorServers` | Claim route + tests |
| B-9 | Runner — merge `connectorServers` into `.mcp.json` before agent spawn | `apps/runner/src/workers.ts` or overlay logic |
| B-10 | `connector_auth_error` event handler — flip `needs_reconnect`, invalidate token | Event handler + circuit breaker integration |
| B-11 | Connections UI — `/connections` page: list, add drawer, status badges | Next.js page + components |
| B-12 | Smoke tests for the full connect → claim → inject path | Integration tests |

Tasks B-1 through B-6 can run sequentially (each depends on the previous). B-7 and
B-8 depend on B-2. B-9 depends on B-8. B-10 depends on B-2. B-11 can run in parallel
with B-7 through B-10.
