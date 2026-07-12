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
> | UI | RoleEditor "Connectors" + "Browse Registry" | Settings → Connectors, `/app/connections` |
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
>   (`normalizeMcpToConfig`, `packageRoleConfig`) — the R2 role-tarball MCP path
> - `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx`
>   — role "Connectors" + `McpRegistryBrowser` (243–406, 733–768)
> - `apps/web/src/app/api/connectors/*` + `apps/web/src/lib/mcp-oauth.ts` — team
>   connector CRUD, probe/discovery, OAuth callback, refresh
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
- Ownership transfer (`PATCH /api/connectors/[id]/transfer`) reassigns `teamId` to
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
- Route: `apps/web/src/app/api/workers/claim/route.ts` (replace the legacy
  980–1009 / 1174–1219 role-MCP assembly and generalize the 1228–1327 connector
  block to filter by role `connectorRefs` + support `stdio`/`env`).
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
- Installing a registry entry with a remote (`http`) transport probes the URL
  (existing `/api/connectors/probe`) and sets `authMode` from discovery.
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
  (`McpRegistryBrowser.onInstall` → calls connector create instead of local
  `setMcpServers`).
- Route: `apps/web/src/app/api/connectors/route.ts` (create-or-reuse),
  `apps/web/src/app/api/mcp/registry/route.ts` (unchanged search).

**Out of scope**: auto-running DCR for registry entries whose AS is unknown until
the user connects.

---

## 6. API & auth surface (unchanged mechanics, restated)

Team-connector CRUD, probe/discovery (RFC 9728/8414/7591 + PKCE S256), OAuth
callback, and refresh are defined in `docs/design/generic-mcp-connectors.md`
§A/§C/§G/§H and are unchanged. This doc only adds:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `PATCH` | `/api/workspaces/[id]/skills/[skillId]` | Workspace member | now accepts `connectorRefs: string[]` |
| `POST` | `/api/connectors` | Team admin | now accepts `transport`, `command`, `args`, `envMapping`; create-or-reuse by `(teamId,name)` |
| `PATCH` | `/api/connectors/[id]/workspaces/[wsId]` | Workspace member | enable/disable for workspace (existing) |

**AC**: GIVEN a non-admin member WHEN `POST /api/connectors` THEN `403`.

---

## 7. Out of scope (whole doc)

- Linear/work-tracker layer (`docs/design/generic-mcp-connectors.md` §I) — deferred.
- Mid-task 401 pause/resume — already specced, unchanged.
- Per-account (personal) connector tokens — connectors stay team-shared.
- SSE transport.
