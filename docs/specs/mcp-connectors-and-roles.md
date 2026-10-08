---
title: MCP Connectors & Roles
status: active
owner: max
last_verified: 2026-10-08
summary: Every MCP server an agent reaches MUST be a team connectors row that a role opts into via connectorRefs and that the claim route injects with server-side decrypted credentials — no other mount path exists.
domain: mcp
surfaces: [apps/web/src/app/api/workers/claim/route.ts, apps/web/src/app/api/connectors/route.ts, apps/web/src/lib/connector-status.ts, apps/web/src/lib/mcp-connector-refresh.ts]
related: [credential-isolation, mcp-action-contracts, external-cron-triggers]
keywords: [connectorrefs, mcp_connector_credential, connector_shares, needsreconnect, mcpservers, requiredenvvars]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "create-connector"
    type: "route"
    method: "POST"
    path: "/api/connectors"
    file: "apps/web/src/app/api/connectors/route.ts"
  - id: "connector-status"
    type: "symbol"
    name: "deriveConnectorStatus"
    path: "apps/web/src/lib/connector-status.ts"
  - id: "refresh-connector-credential"
    type: "symbol"
    name: "refreshMcpConnectorCredential"
    path: "apps/web/src/lib/mcp-connector-refresh.ts"
  - id: "connector-catalog"
    type: "symbol"
    name: "CONNECTOR_CATALOG"
    path: "apps/web/src/lib/connector-catalog.ts"
  - id: "resolve-connector-icon"
    type: "symbol"
    name: "resolveConnectorIcon"
    path: "apps/web/src/lib/connector-icon.ts"
  - id: "merge-catalog"
    type: "symbol"
    name: "mergeCatalog"
    path: "apps/web/src/lib/connector-catalog-merge.ts"
  - id: "set-catalog-policy"
    type: "route"
    method: "PUT"
    path: "/api/connectors/catalog/policy"
    file: "apps/web/src/app/api/connectors/catalog/policy/route.ts"
  - id: "connector-block"
    type: "symbol"
    name: "connectorBlock"
    path: "apps/web/src/lib/connector-access-policy.ts"
  - id: "registration-refusal"
    type: "symbol"
    name: "ClientRegistrationRejectedError"
    path: "apps/web/src/lib/mcp-oauth.ts"
---
# MCP Connectors & Roles (unified model)

> **Status: approved — supersedes the two-system split.**
>
> **Supersedes:** `docs/design/generic-mcp-connectors.md` (team-connector mechanics
> remain valid; this doc adds the role relationship + kills the parallel
> role-level MCP system).
>
> **Problem this closes.** Two disjoint systems both mounted MCP servers onto
> agents and both were called "Connectors" in the UI:
>
> | | System A — role-level (legacy) | System B — team-level (new) |
> |---|---|---|
> | Storage | `workspace_skills.mcpServers` + `requiredEnvVars` | `connectors` + `connector_workspaces` |
> | Auth | env-var secrets (`mcp_credential`) | `none`/`header`/`oauth` (`mcp_connector_credential`) |
> | UI | RoleEditor "Connectors" + "Browse Registry" | Settings → MCP connectors (`/app/settings/connectors`) |
> | Injection | R2 role tarball → `.mcp.json` | claim route → `cw.mcpConnectors` |
> | Scope | per role | per workspace (role-blind, all workers) |
>
> They collided on name in `queryOptions.mcpServers` with no precedence, roles
> could not reference a team connector, and OAuth connectors could not be
> role-scoped. See the two screenshots in PR discussion.
>
> **Decisions (locked, from product):**
> 1. **Connectors are the single source of truth.** Every MCP server an agent can
>    reach is a row in `connectors`. `workspace_skills.mcpServers` /
>    `requiredEnvVars` are **removed** after migration.
> 2. **Roles opt in explicitly.** A role reaches a connector only if the role
>    lists its id in `connectorRefs`. No ref → not injected, even if the
>    workspace has the connector enabled. Least-privilege.
> 3. **Legacy data is auto-migrated in the same PR.** Existing role MCP configs +
>    env mappings become connector rows + connector refs via a data migration.
> 4. **"Browse Registry" creates a connector**, not an inline role config.
> 5. One injection path (claim route). The R2 `.mcp.json` role-config path for MCP
>    is retired.
> 6. **Connectors are shareable across teams.** `connectors.teamId` is the *owner*
>    team; an owner-team admin may grant other teams use of the connector (reusing
>    the single owner credential — no re-auth) and may transfer ownership. Sharing
>    is **Phase 2**, additive on top of Phase 1. See §1b. Phase 1 already keys
>    credential resolution on the *owner* team so Phase 2 only widens visibility.
>
> **Sources of truth read before this doc:**
> - `packages/core/db/schema.ts` — `connectors` (1442), `connectorWorkspaces`
>   (1466), `workspaceSkills.mcpServers`/`requiredEnvVars` (941–942),
>   `secrets.purpose` union (1014)
> - `apps/web/src/app/api/workers/claim/route.ts` — legacy role MCP assembly
>   (980–1009, 1174–1219) and connector injection block (1228–1327)
> - `apps/web/src/lib/role-config.ts` + `apps/web/src/app/api/workspaces/[id]/skills/route.ts`
>   (`packageRoleConfig`) — the R2 role bundle, which no longer carries MCP at
>   all: every caller passes `mcpConfig: {}` / `envMapping: {}` (skills/route.ts
>   213, 264) and `RoleConfigInput.mcpConfig`/`.envMapping` are `@deprecated`
>   (role-config.ts 8–24). The normalizer that folded `workspaceSkills.mcpServers`
>   into the bundle is deleted; there is no role-tarball MCP path left to read.
> - `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx`
>   — role "Connectors" + `McpRegistryBrowser` (243–406, 733–768)
> - `apps/web/src/app/api/connectors/*` + `apps/web/src/lib/mcp-oauth.ts` — team
>   connector CRUD, OAuth discovery + DCR (run inline from create and update —
>   there is no standalone probe route), OAuth callback, refresh
> - `docs/specs/SPEC-FORMAT.md` — this doc's format

---

## 1. Connector — source of truth

**Capability statement**: Every MCP server reachable by any agent MUST be
represented by exactly one `connectors` row scoped to a team; there is no other
mechanism by which an MCP server is mounted onto an agent.

**Invariants**:
- A `connectors` row is uniquely identified by `(teamId, name)`; `name`
  slugifies to the MCP server key used in `queryOptions.mcpServers`.
- `authMode ∈ {none, header, oauth}`. `header` MUST have a non-null `headerName`;
  `oauth` MUST have a `clientId`.
- `transport ∈ {http, stdio}`. `http` MUST have a non-null `url`. `stdio` MUST
  have a non-null `command`; `url`/`authMode`=`none` (stdio auth is env-only).
- Credentials never live on the connector row: header/oauth tokens live in
  `secrets` (`purpose='mcp_connector_credential'`, `label=connectorId`);
  stdio/env secrets live in `secrets` (`purpose='mcp_credential'`) referenced by
  `connectors.envMapping` (env var name → secret label).
- After migration, `workspace_skills.mcpServers` and
  `workspace_skills.requiredEnvVars` columns MUST NOT exist.

**Acceptance criteria**:
- AC-1: GIVEN a team with no connectors WHEN `GET /api/connectors` THEN returns
  `200` with `[]`.
- AC-2: GIVEN `authMode='header'` and `headerName=null` WHEN
  `POST /api/connectors` THEN rejects with `400` (`header_name_required`).
- AC-3: GIVEN `transport='stdio'` and `command=null` WHEN `POST /api/connectors`
  THEN rejects with `400` (`command_required`).
- AC-4: GIVEN two connectors with the same `(teamId, name)` WHEN the second is
  created THEN rejects with `409` (`connector_name_taken`).
- AC-5: WHEN the schema is loaded THEN `workspace_skills` has no `mcp_servers`
  or `required_env_vars` column (migration applied).

**Code surface**:
- Data model: `packages/core/db/schema.ts` → `connectors` (add `transport`,
  `command`, `args`, `envMapping`), drop `workspaceSkills.mcpServers` +
  `requiredEnvVars`.
- Route: `apps/web/src/app/api/connectors/route.ts` (POST validation).
- Migration: `packages/core/drizzle/00XX_*.sql`.

**Out of scope**: SSE transport; per-user (account-scoped) connectors — connectors
stay team-owned (multi-account OAuth is a future doc).

---

## 1b. Cross-team sharing (Phase 2)

**Capability statement**: A connector owned by one team MAY be shared to other
teams by an admin of the owner team; a shared-in connector is usable (enable per
workspace, opt-in per role, inject at claim) by the grantee team exactly as an
owned connector, WITHOUT re-running OAuth — the owner team's single credential
is reused.

**Invariants**:
- `connectors.teamId` is the OWNER team. Credentials (`secrets` rows) are always
  keyed on the owner team; grantees never store their own copy. **Phase 1 already
  resolves connector credentials by `connector.teamId`, not the workspace's team**,
  so sharing adds only a visibility widening — no injection rewrite.
- Grants live in `connector_shares (connectorId, sharedWithTeamId, grantedByAccountId,
  createdAt)`, unique `(connectorId, sharedWithTeamId)`. The owner team is implicit
  (never a self-share row).
- A workspace's *visible* connectors = connectors owned by the workspace's team ∪
  connectors shared to the workspace's team.
- **Slug-collision precedence**: if an owned and a shared-in connector slugify to
  the same MCP key, the OWNED connector wins; the shared-in one is not mounted
  (deterministic, no double-mount).
- Only an admin of the OWNER team may create/revoke shares or transfer ownership.
  Grantees may enable/disable per workspace and opt-in per role, but MUST NOT edit
  the connector config or its credential.
- Ownership transfer (`POST /api/connectors/[id]/transfer`) reassigns `teamId` to
  another team the actor administers; the credential is re-keyed to the new owner
  team and existing shares are preserved.
- Revoking a share removes the connector from every grantee workspace's mounted
  set at the next claim (no orphaned injection).

**Acceptance criteria**:
- AC-1: GIVEN connector C owned by team A, shared to team B WHEN a workspace in B
  enables C and a role opts in THEN a task in B mounts C using A's credential and
  no `secrets` row exists for team B.
- AC-2: GIVEN C not shared to team B WHEN a workspace in B attempts to enable C
  THEN the API rejects (`404`/`403` — not visible).
- AC-3: GIVEN team B owns `github` AND team A's `github` is shared to B WHEN a
  role in B references both THEN only B's owned `github` mounts (owned wins).
- AC-4: GIVEN a non-admin of the owner team WHEN `POST` a share THEN `403`.
- AC-5: GIVEN C shared to B WHEN the owner revokes the share THEN a subsequent
  claim in B does NOT mount C.

**Code surface**:
- Data model: `connectors.teamId` (documented owner) + new `connector_shares`
  table in `packages/core/db/schema.ts`.
- Routes: `POST`/`DELETE /api/connectors/[id]/shares`,
  `POST /api/connectors/[id]/transfer`.
- Injection: `apps/web/src/app/api/workers/claim/route.ts` — visibility union +
  owner-keyed credential fetch (already Phase 1) + collision precedence.

**Out of scope**: sharing to a *specific workspace* in another team (grant is
team-granularity; the grantee enables per workspace); public/marketplace
connectors; per-grantee credential overrides.

---

## 2. Role opt-in (`connectorRefs`)

**Capability statement**: A role (a `workspace_skills` row with `isRole=true`)
MUST declare which team connectors it mounts via a `connectorRefs` list of
connector ids; a connector reaches the agent for a task iff the task's role
references it AND the connector is enabled for the task's workspace.

**Invariants**:
- `workspace_skills.connectorRefs` is `text[]` of `connectors.id` values,
  default `[]`.
- A ref to a connector id that does not exist, or belongs to another team, is
  ignored at injection time (never errors the claim).
- Deleting a connector removes its id from every role's `connectorRefs`
  (cleanup on delete; a dangling ref is tolerated but cleaned).
- Injection set for a task = `connectorRefs(role) ∩ enabledForWorkspace ∩ teamConnectors`.

**Acceptance criteria**:
- AC-1: GIVEN role R with `connectorRefs=[c1]`, workspace enables `{c1,c2}`
  WHEN a task routed to R is claimed THEN the claim payload mounts only `c1`.
- AC-2: GIVEN role R references `c1` but the workspace has NOT enabled `c1`
  WHEN a task routed to R is claimed THEN `c1` is NOT mounted.
- AC-3: GIVEN a task with no `roleSlug` (unrouted) WHEN claimed THEN no
  connectors are mounted (no role → no opt-in).
- AC-4: GIVEN role R references a deleted connector id WHEN claimed THEN the
  claim succeeds and mounts the remaining valid refs (no `500`).

**Code surface**:
- Data model: `packages/core/db/schema.ts` → `workspaceSkills.connectorRefs`.
- Route: `apps/web/src/app/api/workspaces/[id]/skills/[skillId]/route.ts`
  (accept `connectorRefs` on PATCH), `.../skills/route.ts` (create).
- Injection: `apps/web/src/app/api/workers/claim/route.ts` (§3).

**Out of scope**: per-task connector overrides; delegation-time connector
inheritance (a delegated sub-task uses its own role's refs).

---

## 3. Runtime injection (single path)

**Capability statement**: The claim route MUST be the only place connectors are
resolved into a worker payload; it decrypts credentials server-side and returns
a `mcpConnectors` array the runner merges verbatim into
`queryOptions.mcpServers`.

**Invariants**:
- The R2 role-config bundle MUST NOT carry MCP server config or env mappings for
  MCP (`role-config.ts` `mcpConfig`/`envMapping` no longer sourced from
  `mcpServers`/`requiredEnvVars`).
- Each injected entry: `{ name, transport, url?, command?, args?, headers?, env? }`
  where `name = slugify(connector.name)`.
- `oauth`: `headers = { Authorization: 'Bearer <access_token>' }`; an expired
  access token (`tokenExpiresAt < now`) is refreshed at claim time (optimistic
  lock) or, on failure, the connector is silently omitted.
- `header`: `headers = { [headerName]: <secret value> }`.
- `none`: no `headers`.
- `stdio`: `env` resolved from `envMapping` against `mcp_credential` secrets;
  never `headers`.
- **Credentials are resolved by `connector.teamId` (the owner team), NOT the
  task's workspace team.** Today they are equal; keying on the owner now makes
  cross-team sharing (§1b) a pure visibility widening with no injection rewrite.
- Within a single team's own connectors, two rows slugifying to the same key is
  impossible (uniqueness AC-4 §1). Cross-team collisions are resolved by §1b
  precedence (owned wins) — a Phase 2 concern.

**Acceptance criteria**:
- AC-1: GIVEN an `oauth` connector with a valid token, referenced+enabled WHEN
  claimed THEN payload entry has `headers.Authorization = 'Bearer …'` and no
  token appears in any DB read by the runner.
- AC-2: GIVEN an `oauth` connector whose access token expired and whose refresh
  succeeds WHEN claimed THEN the refreshed token is injected and `secrets` is
  updated (new `tokenExpiresAt`).
- AC-3: GIVEN an `oauth` connector whose refresh FAILS (invalid_grant) WHEN
  claimed THEN the connector is omitted from the payload and the claim still
  returns `200`.
- AC-4: GIVEN a `header` connector missing its secret row WHEN claimed THEN the
  connector is omitted (not mounted with an empty header).
- AC-5: WHEN a task is claimed THEN the R2 role bundle for that role contains no
  `mcpServers` key.

**Code surface**:
- Route: `apps/web/src/app/api/workers/claim/route.ts` — entry point only; the
  legacy inline role-MCP assembly is gone. Injection lives in the sibling
  modules it calls: `apps/web/src/app/api/workers/claim/mcp-connector-injection.ts`
  (`attachMcpConnectors` — role `connectorRefs` filter, credential decrypt,
  `stdio`/`env`), `apps/web/src/app/api/workers/claim/connector-prefilter.ts`
  (`runConnectorPreFilter` — visibility + credential taxonomy) and
  `apps/web/src/app/api/workers/claim/connector-gate.ts`.
- Runner: `apps/runner/src/workers.ts` (merge `mcpConnectors` — already consumes
  `cw.mcpConnectors`; extend to `stdio`/`env`).
- Helper: `apps/web/src/lib/mcp-connector-refresh.ts` (claim-time refresh).

**Out of scope**: mid-task 401 pause/resume (already specced in
`docs/design/generic-mcp-connectors.md` §E; unchanged by this doc).

---

## 4. Legacy migration (same PR)

**Capability statement**: A data migration MUST convert every existing
`workspace_skills.mcpServers` entry and `requiredEnvVars` mapping into
`connectors` rows (deduplicated per team) and populate the owning role's
`connectorRefs`, with zero MCP access lost for existing roles.

**Invariants**:
- For each distinct MCP server config across a team's roles, exactly one
  connector row is created (dedup key = server name + url/command).
- A role's `connectorRefs` after migration lists exactly the connector ids for
  the servers it had in `mcpServers`.
- Legacy `string[]` form (`["github","slack"]`) → `header`/`none` connectors by
  name with `url` unknown are created as `authMode='none'` placeholders flagged
  `needsReview=true` in `discoveredMetadata` (a human completes the URL).
- `requiredEnvVars` (env→secret label) is copied onto the connector's
  `envMapping` for `stdio` transport connectors; the referenced `mcp_credential`
  secrets are left in place.
- **Reach of pre-existing team connectors is NOT auto-preserved** (product
  decision, 2026-07-12: manual re-opt-in via the role picker is cheaper and
  safer than an automated backfill). Today's default-on injection ends at
  deploy; admins opt roles into existing connectors via the role picker. The
  backfill only converts legacy `role.mcpServers` entries (which DO get refs,
  since the role explicitly listed them).
- The migration is idempotent (re-running creates no duplicates).

**Acceptance criteria**:
- AC-1: GIVEN a role with `mcpServers={ linear: {type:'http',url:'…'} }` WHEN the
  migration runs THEN a `connectors` row `linear` exists for the team and the
  role's `connectorRefs` contains its id.
- AC-2: GIVEN two roles in the same team both referencing an identical `github`
  http server WHEN migrated THEN exactly one `github` connector exists and both
  roles reference it.
- AC-3: GIVEN a role with legacy `mcpServers=["slack"]` WHEN migrated THEN a
  `slack` connector with `authMode='none'`, `discoveredMetadata.needsReview=true`
  is created and referenced.
- AC-4: WHEN the migration runs twice THEN the second run creates 0 new rows and
  changes 0 `connectorRefs`.
- AC-5 (removed): auto reach-preservation for pre-existing team connectors was
  considered and rejected — manual re-opt-in via the role picker is the accepted
  path. A post-deploy checklist item replaces the automated guarantee.

**Code surface**:
- Migration script: `packages/core/drizzle/00XX_migrate_role_mcp_to_connectors.sql`
  (+ a TS backfill in `packages/core/scripts/` if data reshaping exceeds SQL).
- Verified against: `apps/web/src/app/api/workers/claim/route.ts` post-migration
  producing the same mounted set for a sampled role.

**Out of scope**: migrating connectors across teams; reconstructing OAuth tokens
for legacy servers that were never OAuth (they become `none`/`header`).

---

## 5. Registry browse → connector

**Capability statement**: Browsing the MCP registry from the role editor MUST
create (or reuse) a team `connectors` row and add its id to the role's
`connectorRefs`; it MUST NOT write an inline server config onto the role.

**Invariants**:
- Installing a registry entry with a remote (`http`) transport MUST resolve
  `authMode` from OAuth discovery of the URL.
  **Not implemented as a separate endpoint.** No /api/connectors/probe route
  exists in the tree — the pre-create probe described in
  `docs/design/generic-mcp-connectors.md` §A/§C was never built, and nothing
  may call it. What ships instead: `discoverOAuthMetadata` (plus `registerClient`
  for DCR) runs *inline* inside `POST /api/connectors`, and again on
  `PATCH /api/connectors/[id]` when the caller sends a new url or asks to
  rediscover. Both call sites are gated on the caller *already* declaring
  `authMode: 'oauth'` with a url, so discovery cannot currently be used to
  *decide* `authMode` before the row exists. Closing this needs either a probe
  endpoint or an unconditional discovery attempt on create; until then a
  registry entry's `authMode` is whatever the caller asserted.
- Installing a registry entry with an npm/stdio package creates a
  `transport='stdio'` connector with `command`/`args` from the registry entry
  and `envMapping` seeded from the entry's declared `environmentVariables`.
- Re-installing an entry that maps to an existing `(teamId, name)` connector
  reuses it (adds the ref) rather than erroring.

**Acceptance criteria**:
- AC-1: WHEN a user installs an http registry entry THEN a connector row is
  created for the team and returned to the editor, and `connectorRefs` gains it.
- AC-2: WHEN a user installs an npm registry entry THEN a `stdio` connector with
  `command` set and `envMapping` seeded from `environmentVariables` is created.
- AC-3: GIVEN a connector already exists for the entry's `(teamId,name)` WHEN
  installed again THEN no duplicate row is created (`409`-free reuse).

**Code surface**:
- UI: `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx`
  (`McpRegistryBrowser.onInstall` is wired to `installConnector` (424–450),
  which POSTs `/api/connectors` and appends the returned connector id to the
  role's `connectorRefs` via `setConnectorRefs`; the editor holds no local
  mcpServers state — see the note at RoleEditor.tsx:84).
- Route: `apps/web/src/app/api/connectors/route.ts` (create-or-reuse),
  `apps/web/src/app/api/mcp/registry/route.ts` (unchanged search).

**Out of scope**: auto-running DCR for registry entries whose AS is unknown until
the user connects.

---

## 5b. Built-in catalog + connector icons

**Capability statement**: Settings → MCP connectors → Add connection MUST open
on a built-in catalog of remote MCP servers; picking one MUST create an
ordinary team `connectors` row through the same `POST /api/connectors` path a
custom URL uses. Every http connector SHOULD carry a display icon.

**Invariants**:
- The catalog is static code (`CONNECTOR_CATALOG`), not a table. An entry is a
  preset (name, url, expected authMode, icon), never a second connector store.
- An entry is listed only if its URL completes `discoverOAuthMetadata` (+ DCR)
  or serves anonymously; servers that fail discovery stay out. Exception: an
  official server whose vendor admits only reviewed MCP clients stays listed
  with `clientSupport: { status: 'needs_approved_client', … }` (Vercel today,
  §5a), so the UI says why instead of omitting it.
- Creation stays team-admin only (`manage_connectors`, §6); the catalog does
  not widen who can add a connector.
- `connectors.iconUrl` is resolved best-effort — catalog icon, then MCP
  `serverInfo.icons` (light/unthemed over dark, png/svg over ico, larger over
  smaller), then `<link rel=icon>` and `/favicon.ico` on `serverInfo.websiteUrl`,
  then on the server origin and its apex domain. It runs at create time
  (anonymous `initialize`, or with the header credential), again after OAuth
  connect with the fresh bearer, and lazily from `GET /api/connectors` for rows
  without an inlined icon, at most once per `ICON_RECHECK_MS` per row
  (`connectors.iconCheckedAt`). Resolution never fails a create; NULL renders a
  letter avatar.
- A connector's stored icon MUST be a `data:` URL of at most `MAX_ICON_BYTES`
  of an allowlisted image type, so the dashboard never requests a third-party
  host. Every icon fetch is https-only and re-checks each redirect hop with
  `validatePublicEndpoint` (no private, loopback or link-local addresses). An
  icon is only ever rendered via `<img>`, never as inline SVG markup.
- buildd's own MCP `serverInfo` carries `icons` and `websiteUrl`.
- `POST /api/connectors` rejects a non-http(s) url with `400 invalid_url`, and
  a discovery throw with `422 discovery_failed` + `message`, never a bare 500.

**Acceptance criteria**:
- AC-1: WHEN an admin picks a catalog entry THEN the create body carries the
  entry's url and an OAuth entry goes straight to the connect redirect.
- AC-2: GIVEN the team already has a connector at a catalog url WHEN the
  catalog opens THEN that entry shows "Added" and is disabled.
- AC-3: WHEN a custom url's MCP server returns `serverInfo.icons` THEN the
  created connector's `iconUrl` is that icon.
- AC-4: WHEN the url is `ttps://…` THEN the response is `400 invalid_url`
  and the modal shows its message.
- AC-5: GIVEN a connector with no inlined icon WHEN the connectors list loads
  THEN a lookup is scheduled after the response, and a remote icon that will
  not download is cleared rather than hotlinked.
- AC-6: WHEN an icon URL or a redirect hop resolves to a private address THEN
  it is not fetched.

**Code surface**:
- Catalog: `apps/web/src/lib/connector-catalog.ts`, `apps/web/src/lib/connector-catalog-merge.ts`,
  `apps/web/src/lib/connector-catalog-store.ts`, `apps/web/src/lib/connector-catalog-input.ts`
- Provisioning: `apps/web/src/lib/connector-provision.ts`
- Data model: `packages/core/db/schema.ts` → `connectorCatalogEntries`, `connectorCatalogTeamPolicies`
- Icon resolver: `apps/web/src/lib/connector-icon.ts`, `apps/web/src/lib/connector-icon-refresh.ts`,
  `apps/web/src/lib/public-endpoint.ts`, `apps/web/src/lib/mcp-server-info.ts`
- UI: `apps/web/src/app/app/(protected)/settings/connectors/AddConnectionModal.tsx`,
  `apps/web/src/app/app/(protected)/settings/connectors/CatalogSection.tsx`,
  `apps/web/src/components/ConnectorIcon.tsx`
- Route: `apps/web/src/app/api/connectors/route.ts`, `apps/web/src/app/api/connectors/catalog/route.ts`,
  `apps/web/src/app/api/connectors/catalog/policy/route.ts`, `apps/web/src/app/api/admin/connector-catalog/route.ts`

**Verified by**:
- `apps/web/src/lib/connector-catalog.test.ts`
- `apps/web/src/lib/connector-icon.test.ts`, `apps/web/src/lib/connector-icon-refresh.test.ts`,
  `apps/web/src/lib/mcp-server-info.test.ts`
- `apps/web/src/app/app/(protected)/settings/connectors/AddConnectionModal.dom.test.tsx`
- `apps/web/src/app/api/connectors/route.test.ts`
- `apps/web/src/lib/connector-catalog-merge.test.ts`, `apps/web/src/lib/connector-provision.test.ts`,
  `apps/web/src/lib/connector-catalog-input.test.ts`
- `apps/web/src/app/api/connectors/catalog/route.test.ts`, `apps/web/src/app/api/connectors/catalog/policy/route.test.ts`,
  `apps/web/src/app/api/admin/connector-catalog/route.test.ts`
- `apps/web/src/app/app/(protected)/settings/connectors/CatalogSection.dom.test.tsx`
- `apps/web/tests/db/connector-catalog.test.ts` (partial unique indexes, real Postgres)

**Catalog layers (DB, team policy, preinstall)**:
- The catalog a team sees = built-in presets (code) < platform rows
  (`connector_catalog_entries.team_id IS NULL`) < that team's rows, merged by
  slug in `mergeCatalog` (`apps/web/src/lib/connector-catalog-merge.ts`). A
  platform row with a built-in's slug overrides it; `enabled=false` withdraws
  it for everyone. Assertion-mode rows are never offered.
- Platform rows are written only through `/api/admin/connector-catalog`
  (platform-admin API key, `lib/platform-admin.ts`). Team rows and team
  policies are written only by a team member holding `manage_connectors`,
  through `/api/connectors/catalog`, and are always scoped to the caller's
  active team.
- Every catalog write MUST pass `verifyCatalogServer`: https only, and an oauth
  entry must complete discovery (an anonymous server is stored as `none`).
- `connector_catalog_team_policies` (team, slug) → `blocked` | `available`
  (default, no row) | `preinstalled`. Members never receive blocked entries.
  `preinstalled` creates (or reuses, by URL then name) the team connector and
  enables it in every team workspace BEFORE the policy is recorded; a new
  workspace gets the team's preinstalled connectors at creation, best effort.
  Changing a policy never deletes a connector. Roles still opt in via
  `connectorRefs` (§2): preinstalled means mounted for the workspace, not
  granted to every role.
- Policy states are the coarse admin layer under per-role opt-in and the
  agent access-request flow (task `d5a27699`, design pending): blocked =
  forbidden, available = needs a person, preinstalled = already on.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/connectors/catalog` | Team member | merged catalog + policy (+`canManage`) |
| `POST` | `/api/connectors/catalog` | Team admin | add a team-private entry |
| `PATCH`/`DELETE` | `/api/connectors/catalog/[id]` | Team admin | edit/remove own team's entry |
| `PUT` | `/api/connectors/catalog/policy` | Team admin | set blocked/available/preinstalled |
| `GET`/`POST` | `/api/admin/connector-catalog` | Platform admin key | list/add platform entries |
| `PATCH`/`DELETE` | `/api/admin/connector-catalog/[id]` | Platform admin key | edit/withdraw platform entries |

**Out of scope**: managing platform rows from the dashboard (API key only for
now); the agent access-request flow (task `d5a27699`).

---

## 5a. Catalog policy at runtime + provider compatibility

**Capability statement**: A team's `blocked` catalog policy MUST deny agents
every connector on that entry's host — including one installed and connected
before the block — at every boundary that hands a connector to an agent,
without deleting the connector or its provider credential. Connecting a team
connector MUST be a team-admin act bound to that team. A provider that will
not register buildd as an OAuth client MUST surface as `needs_approved_client`,
never as a generic failure and never worked around.

**Invariants**:
- A connector is *blocked for a task* when its URL's host equals the host of
  a `blocked` entry in the merged catalog of EITHER the task's workspace team
  (consumer) OR the connector's owner team (`connectorBlock`,
  `apps/web/src/lib/connector-access-policy.ts`). Path, scheme, port, query
  and case do not matter: respelling the URL never escapes a block, whether
  the team created the connector itself or another team shared it in. A
  different host (including a sibling subdomain) is not covered. One team's
  block never affects another team's own connectors.
- Enforced at: the claim pre-filter and `checkConnectorRouting` (failure mode
  `blocked_by_policy`, ordered after `never_mounted`, before
  `expired_or_revoked`; a blocked connector is never HTTP-probed); claim-time
  injection (never mounted; its credential never decrypted or refreshed); the
  assertion mint (`403 blocked_by_policy`, re-checked on every mint); the
  mounted list (`status: 'blocked'`); OAuth connect (`403`) and callback
  (redirect `error=blocked_by_policy`, nothing stored).
- Loading policy fails closed: a DB error fails the claim / mounts nothing.
- Blocking never deletes. `PUT …/policy` with `blocked` returns
  `retainedConnectorIds`; `GET /api/connectors` keeps the row with
  `blockedByPolicy: true`. Unblocking restores access with no reconnect.
- `preinstalled` ≠ agent permission: it creates and enables the connector per
  workspace; only a role's `connectorRefs` (§2) mounts it for an agent.
- `POST /api/connectors/[id]/connect` requires `manage_connectors` on the
  connector's team (`canManageTeamConnectors`); the callback re-checks that
  the signed-in user is the one who started the flow (`session_mismatch`),
  still holds `manage_connectors` there (`forbidden`), and the connector is not
  blocked — all before the code exchange.
- The assertion mint additionally requires the connector to be owned by or
  shared to the task's team (cross-team isolation; else 404).
- DCR requests the `refresh_token` grant when the AS advertises it in
  `grant_types_supported`; otherwise an AS that enforces registered grants
  refuses the claim-time refresh at first expiry.
- A DCR refusal that means "client not approved" (`invalid_redirect_uri`,
  `invalid_client_metadata`, software-statement errors, 401/403) is
  `ClientRegistrationRejectedError.needsApprovedClient`; create and preinstall
  answer `422 needs_approved_client` with the catalog's `detail`/`actionUrl`.
  buildd MUST NOT reuse another client's id, a global admin token, or a copied
  credential to get past it.

**Provider compatibility (live-probed 2026-10-08, buildd as client)**:

| Provider | Discovery | DCR with buildd's web callback | State |
|---|---|---|---|
| Axiom `https://mcp.axiom.co/mcp` | RFC 9728 → `authorization.axiom.co` (S256, `refresh_token`, `offline_access`) | 201, client issued | Supported (OAuth) |
| Vercel `https://mcp.vercel.com` | RFC 9728 → `vercel.com` (S256, DCR endpoint) | 400 `invalid_redirect_uri` ("not approved for use by this authorization server"); loopback redirects accepted | `needs_approved_client` — owner submits Vercel's client review |

No supported server-side alternative exists for Vercel today: buildd's
Operator `deploy` covers Cloudflare only, and pasting a token minted for an
approved client would be impersonation. Re-run the probe with
`BUILDD_LIVE_PROVIDER_PROBE=1 bun test apps/web/tests/integration/mcp-provider-discovery.test.ts`.

**Acceptance criteria**:
- AC-1: GIVEN a connected Axiom connector in a role's `connectorRefs` WHEN the
  team blocks `axiom` THEN the next claim holds the task with
  `blocked_by_policy` (or, advisory mode with other connectors healthy,
  claims without Axiom mounted) AND the credential row is unchanged.
- AC-2: WHEN the owner team of a shared connector blocks it THEN grantee
  teams' tasks lose it too; WHEN an unrelated team blocks it THEN nothing changes.
- AC-3: WHEN a member without `manage_connectors` calls connect THEN 403 and
  no state cookie.
- AC-4: WHEN Vercel is added or preinstalled THEN `422 needs_approved_client`
  with Vercel's review link, and no connector row is created.

**Code surface**:
- Policy: `apps/web/src/lib/connector-access-policy.ts`, `apps/web/src/lib/connector-team-auth.ts`
- Boundaries: `apps/web/src/app/api/workers/claim/connector-prefilter.ts`,
  `apps/web/src/app/api/workers/claim/connector-gate.ts`,
  `apps/web/src/app/api/workers/claim/mcp-connector-injection.ts`,
  `apps/web/src/lib/connector-queries.ts`,
  `apps/web/src/app/api/connectors/[id]/assertion/route.ts`,
  `apps/web/src/app/api/connectors/[id]/connect/route.ts`,
  `apps/web/src/app/api/connectors/callback/route.ts`
- DCR: `apps/web/src/lib/mcp-oauth.ts`, `apps/web/src/lib/connector-provision.ts`

**Verified by**:
- `apps/web/src/lib/connector-access-policy.test.ts`, `apps/web/src/lib/connector-team-auth.test.ts`
- `apps/web/src/app/api/workers/claim/connector-prefilter.test.ts`,
  `apps/web/src/app/api/workers/claim/connector-gate.test.ts`,
  `apps/web/src/app/api/workers/claim/mcp-connector-injection.test.ts`
- `apps/web/src/lib/connector-queries.test.ts`
- `apps/web/src/app/api/connectors/[id]/assertion/route.test.ts`,
  `apps/web/src/app/api/connectors/[id]/connect/route.test.ts`,
  `apps/web/src/app/api/connectors/callback/route.test.ts`
- `apps/web/src/lib/mcp-oauth.test.ts`, `apps/web/src/lib/connector-provision.test.ts`
- `apps/web/tests/integration/mcp-provider-discovery.test.ts` (opt-in, live)

**Out of scope**: per-tool / per-call checks inside a running agent session
for http connectors whose bearer token was injected at claim (the runtime
grant work, task `d6b7501a`, consumes `status: 'blocked'` from the mounted
list); the access-request UI (task `a35d01f0`).

---

## 6. API & auth surface (as shipped)

Team-connector CRUD, discovery/DCR (RFC 9728/8414/7591 + PKCE S256), OAuth
callback, and refresh follow `docs/design/generic-mcp-connectors.md`
§A/§C/§G/§H, **except that two routes in that design doc do not exist in the
tree** — see "Design-doc routes that never shipped" below. Treat the design doc
as the intended mechanics, not as an inventory of callable endpoints.

This doc adds:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `PATCH` | `/api/workspaces/[id]/skills/[skillId]` | Workspace member | now accepts `connectorRefs: string[]` |
| `POST` | `/api/connectors` | Team admin | now accepts `transport`, `command`, `args`, `envMapping`; create-or-reuse by `(teamId,name)` |
| `PATCH` | `/api/workspaces/[id]/connectors` | Workspace member | enable/disable one connector for one workspace; body `{ connectorId, enabled }`; upserts `connector_workspaces`; rejects `404` for a connector neither owned by nor shared to the caller's team (§1b AC-2) |

**AC**: GIVEN a non-admin member WHEN `POST /api/connectors` THEN `403`.

### Design-doc routes that never shipped

Both were previously described here as "existing". They are not. A reader may
not call either one; building the behaviour means building the route.

| Design-doc path | Reality |
|---|---|
| POST /api/connectors/probe | **Does not exist.** Discovery is inline in `POST /api/connectors` / `PATCH /api/connectors/[id]` (§5). There is no way to probe a URL before creating a connector row. |
| PATCH /api/connectors/[id]/workspaces/[wsId] | **Does not exist.** Per-workspace enable/disable ships as `PATCH /api/workspaces/[id]/connectors` with the connector id in the body, i.e. keyed on workspace-then-connector, not connector-then-workspace. |

These two survived because the spec linter existence-checked *file* paths and
backticked symbols, but not route URLs. It now resolves route URLs as well
(SPEC-FORMAT rule 8): a backticked `/api/...` path in an `active` spec must
resolve to a `route.ts`, so asserting a route nobody serves fails `specs:lint`.
That is why the two paths in the table above are written as plain text —
backticks are the linter's signal for "this is live, go check it", so a route
being asserted as ABSENT must not carry them.

**Code surface**:
- Role refs: `apps/web/src/app/api/workspaces/[id]/skills/[skillId]/route.ts`
- Connector CRUD: `apps/web/src/app/api/connectors/route.ts`,
  `apps/web/src/app/api/connectors/[id]/route.ts`
- Per-workspace enablement: `apps/web/src/app/api/workspaces/[id]/connectors/route.ts`
- Discovery/DCR helper: `apps/web/src/lib/mcp-oauth.ts`

---

## 6b. Credential health surfacing

A connector credential can go stale (`oauth` token expired, or refresh failed and
the refresher nulled `tokenExpiresAt` while recording `lastVerificationError`).
§3 AC-3 keeps the claim working by silently omitting the connector — correct for
the claim, wrong for the human.

**Status derivation** is single-source in `apps/web/src/lib/connector-status.ts`:

| Credential state | Status |
|---|---|
| no secret row | `not_connected` |
| `tokenExpiresAt <= now` | `expired` |
| `tokenExpiresAt IS NULL` and `lastVerificationError IS NOT NULL` | `expired` |
| otherwise | `connected` |

**Alerting is NOT keyed on status.** A token approaching (or just past) expiry is
not a human problem — the refresh sweep renews it. `needsReconnect()` is true only
when the credential can no longer heal itself:

1. `lastVerificationError IS NOT NULL` — refresh definitively failed, or
2. the token has been expired for a full sweep cycle and still is — nothing is
   renewing it.

The first cut of this warned on "expires within 24h", which was permanently true
for a 24h-lifetime token: a never-clearing Home card plus an alert after every
reconnect. Approaching expiry is deliberately silent.

**Refresh sweep** (`/api/cron/codex-token-refresh`):

- The lookahead is **derived from the cron's own cadence**
  (`lib/cron-cadence.ts`, `MCP_REFRESH_LOOKAHEAD_MINUTES` overrides), never
  hand-typed. It was 10 minutes on a 4-hourly cron, so a credential expiring in
  (10min, 4h] was only picked up after it had already died.
- `tokenExpiresAt IS NULL` rows are **included**. That is where the refresher
  parks a credential it marked dead, and where an AS omitting `expires_in` leaves
  one; excluding them meant neither was ever retried.
- `lastRefreshedAt` is stamped by the lock on every **attempt**;
  `lastRefreshSucceededAt` records success. Only the latter answers "is refresh
  working".

**Surfaces** (all read the same derivation — no second copy of the rule):

1. Settings → MCP connectors — `Connected` / `Expired` badge + `Reconnect`.
2. Home action queue — a `RECONNECT` chip per connector where
   `needsReconnect()`, ranked above `REVIEW`, linking to `/app/settings/connectors`.
3. Push — `/api/cron/connector-block-notify` fires
   `notifyTeam(…, 'connectorBlocked')` once per broken episode, deduped by
   `secrets.expiryNotifiedAt`, cleared by the reconnect and refresh-success paths.

**Invariants**:
- The expiry alert is independent of task flow: it fires whether or not any task
  requires the connector.
- A successful re-auth MUST clear `lastVerificationError` and `expiryNotifiedAt`;
  otherwise an AS that omits `expires_in` leaves the connector reading `expired`
  forever.
- A credential whose connector row was deleted is orphaned and never alerts.
- Both cron routes above are externally triggered — see
  `docs/specs/external-cron-triggers.md`. Neither may be moved to `vercel.json`,
  where it would not fire.

**Acceptance criteria**:
- AC-1: GIVEN a credential with `lastVerificationError` set and
  `expiryNotifiedAt IS NULL` WHEN the notify cron runs THEN one alert is sent and
  `expiryNotifiedAt` is stamped.
- AC-2: GIVEN the same credential on the next run THEN no alert is sent.
- AC-3: GIVEN a credential expiring in 4h THEN no alert is sent.
- AC-4: GIVEN a credential expired 1h ago (inside the sweep cycle) THEN no alert
  is sent; GIVEN one expired beyond a full cycle THEN an alert is sent.
- AC-5: GIVEN no task is blocked THEN the expiry scan still runs.
- AC-6: GIVEN the sweep cron's schedule changes THEN the lookahead re-derives and
  `cron-cadence.test.ts` fails until the mirrored constant matches the manifest.

**Code surface**:
- Derivation: `apps/web/src/lib/connector-status.ts`
- Cadence: `apps/web/src/lib/cron-cadence.ts`, `cron-manifest.json`
- Queue: `apps/web/src/lib/action-queue.ts` (`reconnect` kind → `RECONNECT` chip)
- Home: `apps/web/src/app/app/(protected)/home/page.tsx`
- Sweep: `apps/web/src/app/api/cron/codex-token-refresh/route.ts`
- Notify: `apps/web/src/app/api/cron/connector-block-notify/route.ts`
- Alert copy: `apps/web/src/app/api/workers/claim/connector-block-notify.ts`
- Refresh: `apps/web/src/lib/mcp-connector-refresh.ts`
- Schema: `packages/core/db/schema.ts` (`secrets.expiryNotifiedAt`,
  `secrets.lastRefreshSucceededAt`)

---

## 7. Out of scope (whole doc)

- Linear/work-tracker layer (`docs/design/generic-mcp-connectors.md` §I) — deferred.
- Mid-task 401 pause/resume — already specced, unchanged.
- Per-account (personal) connector tokens — connectors stay team-shared.
- SSE transport.
