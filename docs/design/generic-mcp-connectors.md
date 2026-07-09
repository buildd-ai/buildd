# Generic MCP Connectors (SPEC)

> **Status: draft — awaiting approval.**
>
> **Scope:** Full OAuth-discovery-based generic MCP connector system. Covers
> database schema, auth-mode ladder, runner injection, mid-task auth expiry,
> token refresh, UI route, and the optional Linear work-tracker layer.
>
> **Sources of truth read before this doc:**
> - `packages/core/db/schema.ts` — `secrets` table (lines 996–1020), existing
>   `mcp_credential` purpose, `tokenExpiresAt`/`lastRefreshedAt` columns
> - `apps/web/src/app/api/workers/claim/route.ts` — `mcpSecretsMap` assembly
>   (lines 1077–1144), codex credential refresh at claim time
> - `apps/web/src/lib/pusher.ts` — Pusher channel helpers + event catalogue
> - `apps/web/src/app/api/cron/codex-token-refresh/route.ts` — optimistic-lock
>   refresh cron pattern
> - `packages/core/secrets/` — `SecretsProvider`, `encrypt`/`decrypt`, `SecretPurpose`
> - Existing OAuth-server code (`apps/web/src/app/api/oauth/`) — buildd acts as
>   the OAuth **server** for claude.ai; the feature here makes buildd an OAuth
>   **client** connecting to external MCP servers.
>
> **Decisions already made (do not reopen):**
> 1. Single `connectors` table at team level; per-workspace toggle via join table.
> 2. Auth-mode ladder: `none → header → oauth`. One UI, one table.
> 3. OAuth callback route: single fixed path `/api/connectors/callback`.
> 4. PKCE: S256 only. No plain.
> 5. Token audience validation: `aud` claim must match connector `url` (the resource URL).
> 6. Mid-task 401: pause worker + banner. No automatic retry loop.

---

## A. Connection Flow (per MCP Authorization Specification)

This section defines the exact steps buildd performs when a user connects a
new OAuth-secured MCP server. The protocol follows the MCP Authorization
Specification (based on OAuth 2.1 + RFC 8414 + RFC 9728 + RFC 7591).

### A.1 Discovery probe

```
POST/GET <connector-url>   (unauthenticated)
→ 401 Unauthorized
   WWW-Authenticate: Bearer realm="...", resource_metadata="<rm-url>"
```

The client (buildd web) sends an unauthenticated request to the connector URL.
On `401`, it reads the `WWW-Authenticate` header and extracts the
`resource_metadata` URL from the `Bearer` challenge parameters.

If `resource_metadata` is absent, fall back to appending
`/.well-known/oauth-protected-resource` to the **origin** of the connector URL
(i.e. `https://example.com/.well-known/oauth-protected-resource`).

### A.2 Protected Resource Metadata (RFC 9728)

```
GET <resource_metadata-url>
→ 200 application/json
{
  "resource": "https://mcp.example.com",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": [...],
  "bearer_methods_supported": ["header"]
}
```

Buildd stores this object verbatim in `connectors.discoveredMetadata.protectedResource`.
The first entry in `authorization_servers` becomes the Authorization Server (AS) URL.

### A.3 Authorization Server Metadata (RFC 8414)

```
GET <as-url>/.well-known/oauth-authorization-server
  (fallback: <as-url>/.well-known/openid-configuration)
→ 200 application/json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "...",
  "token_endpoint": "...",
  "registration_endpoint": "...",   // optional — DCR
  "code_challenge_methods_supported": ["S256"],
  ...
}
```

Stored in `connectors.discoveredMetadata.authorizationServer`.

### A.4 Dynamic Client Registration (RFC 7591)

If `registration_endpoint` is present in AS metadata, buildd performs DCR
automatically before starting the OAuth flow:

```
POST <registration_endpoint>
Content-Type: application/json

{
  "client_name": "buildd",
  "redirect_uris": ["https://<app-domain>/api/connectors/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic",
  "code_challenge_method": "S256"
}

→ 201
{
  "client_id": "...",
  "client_secret": "...",   // optional
  ...
}
```

Store:
- `connectors.clientId = response.client_id`
- `connectors.encryptedClientSecret = encrypt(response.client_secret)` (if present)
- `connectors.discoveredMetadata.dcrResponse = response` (full response for audit)

**Fallback — pre-registered credentials:** If `registration_endpoint` is
absent, the UI presents two fields: `client_id` (plain text) and
`client_secret` (masked). The user pastes values from the MCP server's
developer console. These are stored the same way.

### A.5 Authorization Code + PKCE

1. **Generate PKCE pair** (server-side, stored in session/cookie):
   - `code_verifier` = 32 random bytes, base64url-encoded (no padding)
   - `code_challenge` = base64url(sha256(code_verifier))
   - `code_challenge_method` = `"S256"`

2. **Build authorization URL** from AS `authorization_endpoint`:
   ```
   ?response_type=code
   &client_id=<clientId>
   &redirect_uri=https://<app-domain>/api/connectors/callback
   &scope=<scopes from discoveredMetadata.protectedResource.scopes_supported, space-joined>
   &state=<random 32-byte hex, stored in session>
   &code_challenge=<challenge>
   &code_challenge_method=S256
   ```

3. **Redirect user** to the authorization URL.

4. **Callback handler** — `GET /api/connectors/callback`:
   - Validate `state` matches session.
   - Exchange `code` for tokens:
     ```
     POST <token_endpoint>
     Authorization: Basic base64(<clientId>:<clientSecret>)   // or client_secret_post
     Content-Type: application/x-www-form-urlencoded

     grant_type=authorization_code
     &code=<code>
     &redirect_uri=https://<app-domain>/api/connectors/callback
     &code_verifier=<verifier>
     ```
   - Parse response: `access_token`, `refresh_token`, `expires_in`, `token_type`.
   - **Audience validation**: decode `access_token` JWT (no verify, claims only).
     Assert `aud` contains or equals `connectors.url` (the resource URL from
     `discoveredMetadata.protectedResource.resource`). Reject if absent or
     mismatch — this prevents token substitution attacks.
   - Persist tokens (see §C.3).

---

## B. Auth-Mode Ladder

Every connector row has `authMode: 'none' | 'header' | 'oauth'`. The UI and
injection logic use this single field to determine how credentials are handled.

| Mode | Description | Credential storage |
|---|---|---|
| `none` | No auth. MCP server is public. | — |
| `header` | Static bearer token or API key sent as a fixed HTTP header. | `secrets` table, `purpose='mcp_credential'`, `label=connectorId` |
| `oauth` | OAuth 2.1 + PKCE with discovery. Access + refresh tokens. | `secrets` table, `purpose='mcp_connector_credential'`, `label=connectorId` |

**Auto-detection:** When the user pastes a URL and presses "Connect", the UI
probes the URL (§A.1). If the response is `401` with a `Bearer` challenge that
includes a `resource_metadata` parameter, the auth mode is set to `oauth` and
discovery proceeds automatically. If the response is `401` without a
conforming `Bearer` challenge, the UI falls back to `header` mode and shows
the header-name + value fields. If the response is `2xx`, mode is set to
`none` and no further auth flow is needed.

**Header mode credential path:** Header-mode connectors reuse the existing
`manage_secrets` / `mcp_credential` mechanism. The admin calls
`manage_secrets { action: "set", label: connectorId, value: token, purpose: "mcp_credential" }`.
At injection time (§D) the runner receives the token as an env var. The
connector entry's `headerName` field records which header the runner should
attach (e.g. `Authorization`, `X-Api-Key`).

---

## C. Schema Design

### C.1 `connectors` table

```sql
CREATE TABLE connectors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id               UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  url                   TEXT NOT NULL,                  -- MCP server root URL; also the OAuth resource URL
  auth_mode             TEXT NOT NULL DEFAULT 'none',   -- 'none' | 'header' | 'oauth'
  header_name           TEXT,                           -- e.g. 'Authorization', 'X-Api-Key'; null for non-header modes
  discovered_metadata   JSONB,                          -- AS metadata, DCR response, protected-resource metadata
  client_id             TEXT,                           -- OAuth client_id (DCR or pre-registered)
  encrypted_client_secret TEXT,                         -- AES-256-GCM encrypted client_secret (may be null)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX connectors_team_idx ON connectors(team_id);
```

**Drizzle (packages/core/db/schema.ts):**

```ts
export const connectors = pgTable('connectors', {
  id:                     uuid('id').primaryKey().defaultRandom(),
  teamId:                 uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  name:                   text('name').notNull(),
  url:                    text('url').notNull(),
  authMode:               text('auth_mode').$type<'none' | 'header' | 'oauth'>().notNull().default('none'),
  headerName:             text('header_name'),
  discoveredMetadata:     jsonb('discovered_metadata').$type<ConnectorDiscoveredMetadata>(),
  clientId:               text('client_id'),
  encryptedClientSecret:  text('encrypted_client_secret'),
  createdAt:              timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:              timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('connectors_team_idx').on(t.teamId),
}));

export interface ConnectorDiscoveredMetadata {
  protectedResource?: Record<string, unknown>;   // RFC 9728 response
  authorizationServer?: Record<string, unknown>; // RFC 8414 response
  dcrResponse?: Record<string, unknown>;         // RFC 7591 response
}
```

### C.2 `connectorWorkspaces` table

Per-workspace enable/disable toggle.

```sql
CREATE TABLE connector_workspaces (
  connector_id   UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (connector_id, workspace_id)
);

CREATE INDEX connector_workspaces_workspace_idx ON connector_workspaces(workspace_id);
```

**Drizzle:**

```ts
export const connectorWorkspaces = pgTable('connector_workspaces', {
  connectorId:  uuid('connector_id').references(() => connectors.id, { onDelete: 'cascade' }).notNull(),
  workspaceId:  uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  enabled:      boolean('enabled').notNull().default(true),
}, (t) => ({
  pk:           primaryKey({ columns: [t.connectorId, t.workspaceId] }),
  workspaceIdx: index('connector_workspaces_workspace_idx').on(t.workspaceId),
}));
```

Semantics: A connector row in this table means the workspace has explicitly
opted in. Absence means disabled for that workspace (not inherited from
team-level default — workspaces must actively enable each connector). This
mirrors the claude.ai per-chat connector toggle model.

### C.3 Token storage (`secrets` table — extended)

OAuth tokens for connectors are stored in the existing `secrets` table with a
new purpose value `mcp_connector_credential`.

```
secrets row for OAuth connector access token:
  teamId         = connector.teamId
  accountId      = NULL (team-wide)
  workspaceId    = NULL (team-wide; workspace scoping handled by connectorWorkspaces)
  purpose        = 'mcp_connector_credential'
  label          = connectorId                  ← links back to connectors row
  encryptedValue = encrypt(access_token)
  tokenExpiresAt = NOW() + expires_in seconds
  lastRefreshedAt = NULL (set on first successful refresh)
```

If the AS returns a `refresh_token`, store it as a **second** row:

```
secrets row for refresh token:
  purpose        = 'mcp_connector_credential'
  label          = connectorId + ':refresh'     ← convention: suffix ':refresh'
  encryptedValue = encrypt(refresh_token)
  tokenExpiresAt = NULL                         ← refresh tokens have no standard expiry
  lastRefreshedAt = NULL
```

**`SecretPurpose` union — add `mcp_connector_credential`:**

```ts
// packages/core/secrets/types.ts
export type SecretPurpose =
  | 'anthropic_api_key'
  | 'oauth_token'
  | 'codex_credential'
  | 'webhook_token'
  | 'custom'
  | 'mcp_credential'
  | 'mcp_connector_credential'   // ← NEW
  | 'vercel_token'
  | 'pushover'
  | 'notify_webhook';
```

Also add `mcp_connector_credential` to the `inArray` filter in the secrets
schema `pgTable` definition and the claim route query (§D.2).

**Header-mode tokens** are stored with `purpose = 'mcp_credential'` and
`label = connectorId` (same as existing env-var-injected secrets). The
`header_name` column on the connector row tells the runner which HTTP header
to set. No `tokenExpiresAt`; these are static.

---

## D. Runner Injection Contract

### D.1 What the runner receives

The claim route assembles an array of connector MCP entries and returns it
alongside the existing `mcpSecrets` map. The runner appends these entries to
its SDK `queryOptions.mcpServers` object before starting the agent.

**Shape of each entry (matches existing runner SDK convention —
`apps/runner/src/workers.ts:1684`):**

```ts
interface ConnectorMcpEntry {
  type: 'http';
  url: string;                         // connector.url (the MCP server URL)
  headers: Record<string, string>;     // { Authorization: 'Bearer <access_token>' }
                                       // or { [headerName]: headerValue } for header mode
}
```

Note: the runner uses `type: 'http'` (not `type: 'url'`). The MCP SDK key
for each entry is the connector's `name` (slugified: `name.toLowerCase().replace(/\s+/g, '-')`).

### D.2 Claim route additions

`apps/web/src/app/api/workers/claim/route.ts` — extend the existing MCP
secrets block (currently lines 1077–1144) with connector injection:

```ts
// After assembling mcpSecretsMap (existing code)...

// Connector MCP injection
const task = cw.task as any;
const workspaceId = task?.workspaceId;
const workspaceTeamId = task?.workspace?.teamId;

if (workspaceId && workspaceTeamId) {
  // 1. Find connectors enabled for this workspace
  const enabledConnectors = await db
    .select({ connector: connectors })
    .from(connectorWorkspaces)
    .innerJoin(connectors, eq(connectors.id, connectorWorkspaces.connectorId))
    .where(
      and(
        eq(connectorWorkspaces.workspaceId, workspaceId),
        eq(connectorWorkspaces.enabled, true),
        eq(connectors.teamId, workspaceTeamId),
      )
    );

  if (enabledConnectors.length > 0) {
    const connectorIds = enabledConnectors.map(r => r.connector.id);

    // 2. Fetch access tokens for oauth connectors
    const connectorSecrets = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, workspaceTeamId),
        eq(secrets.purpose, 'mcp_connector_credential'),
        inArray(secrets.label, connectorIds),            // label = connectorId
      ),
      columns: { id: true, label: true },
    });

    // 3. Also fetch header-mode tokens (purpose='mcp_credential', label=connectorId)
    const headerSecrets = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, workspaceTeamId),
        eq(secrets.purpose, 'mcp_credential'),
        inArray(secrets.label, connectorIds),
      ),
      columns: { id: true, label: true },
    });

    const allSecretsToDecrypt = [...connectorSecrets, ...headerSecrets];
    const decryptedValues = await Promise.all(
      allSecretsToDecrypt.map(s => provider.get(s.id))
    );

    const tokenMap: Record<string, string> = {};
    allSecretsToDecrypt.forEach((s, i) => {
      if (decryptedValues[i] && s.label) tokenMap[s.label] = decryptedValues[i]!;
    });

    // 4. Build MCP entries
    const connectorEntries: Record<string, ConnectorMcpEntry> = {};
    for (const { connector } of enabledConnectors) {
      const token = tokenMap[connector.id];
      if (!token && connector.authMode !== 'none') continue; // skip if no credential

      const slug = connector.name.toLowerCase().replace(/\s+/g, '-');
      const headerName = connector.authMode === 'oauth'
        ? 'Authorization'
        : (connector.headerName ?? 'Authorization');
      const headerValue = connector.authMode === 'oauth'
        ? `Bearer ${token}`
        : (connector.authMode === 'header' ? token! : '');

      connectorEntries[slug] = {
        type: 'http',
        url: connector.url,
        headers: connector.authMode === 'none' ? {} : { [headerName]: headerValue },
      };
    }

    if (Object.keys(connectorEntries).length > 0) {
      (cw as any).connectorMcpServers = connectorEntries;
    }
  }
}
```

**Runner-side** (`apps/runner/src/workers.ts`) — after building
`queryOptions.mcpServers` with the `buildd` entry, merge in connector entries:

```ts
if ((claimedWorker as any).connectorMcpServers) {
  Object.assign(
    queryOptions.mcpServers,
    (claimedWorker as any).connectorMcpServers
  );
}
```

The runner does NOT decrypt anything — the web layer decrypts and passes
plaintext tokens in the claim response. The claim response is already
transport-encrypted (HTTPS) and scoped to the specific worker ID.

---

## E. Mid-Task 401 Handling

When the agent (Claude) receives a `401` from an MCP connector tool call mid-task:

### E.1 Runner behavior

1. The runner's MCP client receives a `401` response from the connector.
2. The runner emits a worker progress update with a structured `connectorAuthExpired` event:

```ts
// apps/runner/src/workers.ts
await this.reportProgress({
  type: 'connector_auth_expired',
  connectorUrl: <url that returned 401>,
  workerId: worker.id,
  taskId: task.id,
});
```

3. The runner **pauses** the agent (suspends tool execution) and marks itself
   as `paused_connector_auth`. It does NOT retry the failed tool call.
4. The runner invalidates its local cached token (clears the `Authorization`
   header from its in-memory `mcpServers` entry for that connector).

### E.2 Web layer — progress endpoint

`apps/web/src/app/api/workers/[id]/route.ts` — handle the new progress type:

```ts
if (body.type === 'connector_auth_expired') {
  const connectorUrl: string = body.connectorUrl;

  // Find which connector this URL belongs to
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.url, connectorUrl),
  });

  if (connector) {
    // Invalidate the access token in secrets table
    await db.delete(secrets).where(
      and(
        eq(secrets.purpose, 'mcp_connector_credential'),
        eq(secrets.label, connector.id),
      )
    );

    // Emit Pusher event to the task channel
    await triggerEvent(
      channels.task(task.id),
      'connector:auth_expired',
      {
        connectorId: connector.id,
        connectorName: connector.name,
        connectorUrl: connector.url,
        workerId: worker.id,
      }
    );

    // Update worker status
    await db.update(workers).set({ status: 'paused_connector_auth' }).where(eq(workers.id, worker.id));
  }
  return;
}
```

Add `'connector:auth_expired'` to the `events` catalogue in `apps/web/src/lib/pusher.ts`.

### E.3 Dashboard banner

In the task detail view, subscribe to `channels.task(taskId)` and listen for
`connector:auth_expired`. When received, show a non-dismissible banner:

```
⚠ [Connector name] session expired  [Reconnect]
```

Clicking "Reconnect" triggers the OAuth flow (§A) for that connector again
(starting from A.5, since discovery metadata is cached in `discoveredMetadata`).
After successful token save, send a `worker:resume` command to the paused
worker via `apps/web/src/app/api/workers/[id]/cmd/route.ts`.

The worker resumes with a fresh token injected (the runner re-fetches the
token from the claim endpoint or from a dedicated `/api/connectors/[id]/token`
endpoint).

---

## F. Scope Model

Connectors are **team-level resources** — one OAuth app registration is shared
across the whole team. The `connectors` table has `teamId` but no `accountId`
or `workspaceId` (unlike the `secrets` table pattern). This mirrors the
claude.ai account-level connector model.

Per-workspace toggle is handled by the `connectorWorkspaces` join table (§C.2).
A workspace must explicitly enable a connector to receive it at task claim time.

**Summary:**

| Level | What it controls |
|---|---|
| Team | Connector exists, OAuth app registration (`clientId`, `clientSecret`), credential (`access_token` in `secrets`) |
| Workspace | Whether tasks in this workspace receive the connector (via `connectorWorkspaces.enabled`) |
| Task | Inherited from workspace — no per-task override |

**Admin enforcement:** Only team admins can create, edit, or delete connectors.
Any workspace member can enable/disable a connector for their workspace.

---

## G. UI — `/app/connections`

A new top-level route: `apps/web/src/app/app/(protected)/connections/`.

### G.1 Connections list page

URL: `/app/connections`

Layout: one card per connector. Each card shows:
- Connector name + URL (truncated)
- Auth mode badge (`Public` / `Header` / `OAuth`)
- Status badge: `connected` (green) / `expired` (amber) / `needs-reconnect` (red) / `disconnected` (gray)
- "Edit" icon → edit drawer
- "Disconnect" → confirmation → deletes `connectorWorkspaces` row and
  (for OAuth) deletes the access + refresh token `secrets` rows

**Status derivation:**
- `oauth` mode: check `secrets` row with `purpose='mcp_connector_credential'` and `label=connectorId`.
  - Row exists, `tokenExpiresAt > NOW() + 5min` → `connected`
  - Row exists, `tokenExpiresAt <= NOW() + 5min` → `expired`
  - Row absent → `disconnected`
- `header` mode: check `secrets` row with `purpose='mcp_credential'` and `label=connectorId`.
  - Row exists → `connected` (headers don't expire)
  - Row absent → `disconnected`
- `none` mode: always `connected`

**Add connection button** (team admin only): opens the "Add connector" drawer.

### G.2 Add connector drawer

1. **URL field** — user pastes the MCP server URL.
2. **Probe** — on blur/submit, call `POST /api/connectors/probe` with `{ url }`.
   The API probes the URL (§A.1), runs discovery (§A.2–A.3), attempts DCR
   (§A.4), and returns the detected `authMode` + `discoveredMetadata`.
3. **Auth mode display** — auto-populated from probe result. User can override
   only downward (e.g. select `none` if they want unauthenticated access).
4. **OAuth mode** — shows a "Connect" button. Clicking initiates §A.5 redirect.
5. **Header mode** — shows `Header name` (default `Authorization`) and
   `Token value` (masked input).
6. **None mode** — no credential fields.
7. **Name field** — auto-suggested from `protectedResource.resource` hostname;
   editable.
8. **Save** — creates the `connectors` row.

### G.3 Workspace settings — connectors tab

In `apps/web/src/app/app/(protected)/workspaces/[id]/config/` add a
`ConnectorsSection.tsx` tab listing all team connectors with a toggle per
connector. Toggling writes to `connectorWorkspaces`.

### G.4 API routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/connectors/probe` | Team admin | Probe URL, run discovery, DCR |
| `GET` | `/api/connectors` | Team admin | List team connectors |
| `POST` | `/api/connectors` | Team admin | Create connector |
| `PATCH` | `/api/connectors/[id]` | Team admin | Update connector |
| `DELETE` | `/api/connectors/[id]` | Team admin | Delete connector + tokens |
| `GET` | `/api/connectors/callback` | Unauthenticated (state-validated) | OAuth callback — exchange code, save token |
| `POST` | `/api/connectors/[id]/reconnect` | Team admin | Re-initiate OAuth flow for expired connector |
| `GET` | `/api/connectors/[id]/status` | Team member | Return status badge value |
| `PATCH` | `/api/connectors/[id]/workspaces/[wsId]` | Workspace member | Enable/disable for workspace |

---

## H. Refresh Strategy

### H.1 Refresh cron

Extend the existing codex-token-refresh cron (
`apps/web/src/app/api/cron/codex-token-refresh/route.ts`) — or create a
dedicated `mcp-connector-token-refresh` cron — to handle
`mcp_connector_credential` tokens. Recommended schedule: every 15 minutes
(connectors may have shorter-lived tokens than Codex).

**Query:**

```ts
const expiringSoon = await db.query.secrets.findMany({
  where: and(
    eq(secrets.purpose, 'mcp_connector_credential'),
    lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '10 minutes'`),
    not(like(secrets.label, '%:refresh')),  // skip refresh-token rows
  ),
});
```

For each expiring access token:

1. Find the corresponding refresh token:
   ```ts
   const refreshSecret = await db.query.secrets.findFirst({
     where: and(
       eq(secrets.purpose, 'mcp_connector_credential'),
       eq(secrets.label, `${accessSecret.label}:refresh`),
     ),
   });
   ```
   If absent, the connector is `disconnected` — skip and emit a Pusher
   `connector:auth_expired` event on all active tasks in the team's workspaces
   that have this connector enabled (best-effort; the mid-task handler in §E
   is the primary signal path).

2. **Optimistic lock** — update `lastRefreshedAt` only if still NULL or older
   than 5 minutes (prevents concurrent cron runs from double-refreshing):
   ```sql
   UPDATE secrets
   SET last_refreshed_at = NOW()
   WHERE id = $refreshSecretId
     AND (last_refreshed_at IS NULL OR last_refreshed_at < NOW() - INTERVAL '5 minutes')
   RETURNING id
   ```
   If 0 rows updated, another process is already refreshing — skip.

3. **Execute token refresh** at the AS `token_endpoint`:
   ```
   POST <token_endpoint>
   Authorization: Basic base64(<clientId>:<clientSecret>)
   Content-Type: application/x-www-form-urlencoded

   grant_type=refresh_token
   &refresh_token=<decrypted refresh token>
   ```

4. **Atomic replacement** — if the AS returns a new `refresh_token` (rotating
   refresh tokens), atomically replace both:
   ```ts
   await db.transaction(async (tx) => {
     await tx.update(secrets).set({
       encryptedValue: encrypt(newAccessToken),
       tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
       updatedAt: new Date(),
     }).where(eq(secrets.id, accessSecretId));

     if (newRefreshToken) {
       await tx.update(secrets).set({
         encryptedValue: encrypt(newRefreshToken),
         lastRefreshedAt: new Date(),
         updatedAt: new Date(),
       }).where(eq(secrets.id, refreshSecretId));
     } else {
       await tx.update(secrets).set({
         lastRefreshedAt: new Date(),
       }).where(eq(secrets.id, refreshSecretId));
     }
   });
   ```

5. On HTTP error from the token endpoint:
   - 4xx (invalid_grant, revoked) → delete both access and refresh token rows.
     Mark connector as `disconnected`. Emit Pusher event if any task is active.
   - 5xx / network error → log, leave tokens unchanged, retry on next cron run.

### H.2 Proactive refresh at claim time

Mirror the codex credential pattern: in the claim route (§D.2), after fetching
connector secrets, check if any access token's `tokenExpiresAt < NOW()`. If
so, attempt a synchronous refresh before decrypting and returning the token.
Use the same optimistic-lock strategy. If refresh fails, exclude the connector
from injection (runner won't receive it) and the task will simply not have
access to that connector — no hard error.

---

## I. Appendix — Linear Work-Tracker Layer (Phase 3, optional)

> This section is a design placeholder. None of this is implemented yet.
> It is gated on Phase 1 (connectors schema + OAuth flow) and Phase 2 (runner
> injection + 401 handling) being shipped and stable.

### I.1 Workspace setting

```ts
// workspaces table — add column
workTracker: jsonb('work_tracker').$type<{
  connectorId: string;  // references connectors.id
  provider: 'linear' | 'github' | 'jira' | string;  // detected by URL pattern
} | null>()
```

Provider is detected from `connectors.url`, not hardcoded:
- URL contains `linear.app` or `api.linear.app` → `linear`
- URL contains `api.github.com` → `github`
- URL contains `atlassian.net` → `jira`
- Otherwise → opaque string (still wired up, just no special UI treatment)

### I.2 Outbound events

| Trigger | Action |
|---|---|
| Mission created | Offer to create or link a Linear project. Store `externalProjectId` on the mission. |
| Task `complete` + PR merged | Post a comment on the linked issue; transition issue state (e.g. `Done`). Store `externalIssueId` on the task. |
| Task created within a mission with a linked project | Auto-create a sub-issue in Linear; store `externalIssueId`. |

### I.3 Inbound (deferred)

Linear webhook → buildd creates a task when a Linear issue is labelled `buildd`.
Requires a public webhook endpoint + webhook secret in secrets table.
Not in Phase 3 scope; tracked separately.

### I.4 Interim path (available immediately after Phase 1)

A role skill instructs agents to update the linked Linear issue on
`complete_task` using Linear MCP tools they already receive via the connector.
This requires no additional code — it's a prompt-engineering solution that
works as soon as the connector is injected (§D).

Example skill instruction fragment:
```
When completing a task, if the task has a `linearIssueId` property, call the
Linear MCP tool `linear_update_issue` with state `Done` and post a comment
with a link to the merged PR.
```

### I.5 `externalIssueId` schema additions

```sql
-- tasks table
ALTER TABLE tasks ADD COLUMN external_issue_id TEXT;

-- missions table
ALTER TABLE missions ADD COLUMN external_project_id TEXT;
```

---

## J. Implementation Phases

| Phase | Deliverables | Estimated complexity |
|---|---|---|
| **1 — Schema + OAuth flow** | `connectors` + `connectorWorkspaces` migrations; Drizzle schema additions; `SecretPurpose` extension; `/api/connectors/probe`; OAuth callback route; `/app/connections` UI | Large |
| **2 — Runner injection + 401 handling** | Claim route connector injection (§D.2); runner-side merge (§D.2 last block); mid-task 401 handling (§E); Pusher event + dashboard banner; cron refresh (§H.1); claim-time proactive refresh (§H.2) | Medium |
| **3 — Linear layer** | `workTracker` workspace setting; outbound event hooks; `externalIssueId` schema | Medium |

Phase 1 and Phase 2 can be worked in parallel by separate builders if the
interface contract (claim response shape, Pusher event payload) is locked
first. Phase 3 is optional and independent.

---

## K. Open Questions

These are not decisions for the spec author to make — they are flagged for
product review:

1. **Callback URL domain:** Is `/api/connectors/callback` on the same domain
   as the app? If the app runs on a custom domain per team, DCR needs to
   register `redirect_uris` per team. Current assumption: single canonical app
   domain for all teams.

2. **Multi-account connectors:** Can two team members each OAuth into the same
   connector with separate accounts (e.g. two GitHub accounts)? Current spec
   assumes one shared team token. If personal tokens are needed, add
   `accountId` to `connectors` and change the scoping model.

3. **Runner token freshness:** The claim response includes a decrypted access
   token. If a long-running task spans a token expiry, the runner holds a
   stale token. The mid-task 401 handler (§E) is the recovery path. This is
   acceptable given the proactive refresh at claim time (§H.2) minimizes the
   window.

4. **Token encryption in claim response:** The claim response already returns
   decrypted `mcpSecrets` (env vars) over HTTPS. Connector tokens follow the
   same pattern. If additional at-rest encryption of the claim response is
   desired, that is a separate infrastructure concern orthogonal to this spec.
