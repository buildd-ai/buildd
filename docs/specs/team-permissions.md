---
title: Team Permissions
status: active
owner: max
last_verified: 2026-10-08
summary: Every team-scoped permission decision MUST resolve through one named-permission registry that maps each permission to its team roles and minimum API-key level, failing closed.
domain: auth
surfaces: [apps/web/src/lib/permissions.ts, apps/web/src/lib/permission-registry.ts, apps/web/src/lib/team-access.ts, apps/web/src/lib/key-level-policy.ts]
related: [team-namespace-scoping, auth-oauth-boundaries, agent-capabilities, mcp-connectors-and-roles]
keywords: [owner, admin, member, team role, api key level, permission registry, permission overrides, rbac, ownership transfer, personal role, credential policy, key clamp]
verified_by: [apps/web/src/lib/permissions.test.ts, apps/web/src/lib/permission-overrides.test.ts, apps/web/src/lib/migrate-access.test.ts, apps/web/src/app/api/teams/[id]/permissions/route.test.ts, apps/web/src/lib/team-access-team-scope.test.ts, apps/web/src/app/api/teams/[id]/members/route.test.ts, apps/web/src/app/api/teams/[id]/members/[userId]/route.test.ts, apps/web/src/app/api/teams/[id]/ownership/route.test.ts, apps/web/src/app/api/teams/[id]/invitations/route.test.ts, apps/web/src/app/api/invitations/[token]/accept/route.test.ts, apps/web/src/lib/creator-key-clamp.test.ts, apps/web/src/lib/connector-team-auth.test.ts, apps/web/src/app/api/teams/[id]/route.test.ts, apps/web/src/app/api/roles/personal.test.ts, apps/web/src/app/api/roles/[id]/personal.test.ts, apps/web/src/app/api/roles/[id]/share/route.test.ts, apps/web/src/app/api/roles/[id]/promote/route.test.ts, packages/core/__tests__/role-visibility.test.ts, packages/core/__tests__/credential-policy.test.ts, apps/web/src/app/api/workers/claim/personal-credential-injection.test.ts]
supersedes: []
assertions:
  - id: "permission-registry"
    type: "symbol"
    name: "PERMISSIONS"
    path: "apps/web/src/lib/permission-registry.ts"
  - id: "permission-can"
    type: "symbol"
    name: "can"
    path: "apps/web/src/lib/permissions.ts"
  - id: "permission-role-has"
    type: "symbol"
    name: "roleHas"
    path: "apps/web/src/lib/permission-registry.ts"
  - id: "permission-team-ids-where"
    type: "symbol"
    name: "teamIdsWhere"
    path: "apps/web/src/lib/permissions.ts"
  - id: "permissions-test"
    type: "test_file"
    path: "apps/web/src/lib/permissions.test.ts"
  - id: "team-overrides-loader"
    type: "symbol"
    name: "getTeamPermissionOverrides"
    path: "apps/web/src/lib/permissions.ts"
  - id: "locked-permissions"
    type: "symbol"
    name: "LOCKED_PERMISSIONS"
    path: "apps/web/src/lib/permission-registry.ts"
  - id: "overrides-test"
    type: "test_file"
    path: "apps/web/src/lib/permission-overrides.test.ts"
  - id: "holds-in-workspace"
    type: "symbol"
    name: "holdsInWorkspace"
    path: "apps/web/src/lib/team-access.ts"
  - id: "creator-key-clamp"
    type: "symbol"
    name: "clampCreatorKeys"
    path: "apps/web/src/lib/creator-key-clamp.ts"
  - id: "creator-key-clamp-test"
    type: "test_file"
    path: "apps/web/src/lib/creator-key-clamp.test.ts"
  - id: "connector-write-gate"
    type: "symbol"
    name: "canWriteTeamConnectors"
    path: "apps/web/src/lib/connector-team-auth.ts"
  - id: "settings-permissions"
    type: "symbol"
    name: "settingsPermissions"
    path: "apps/web/src/app/app/(protected)/settings/_lib/settings-permissions.ts"
  - id: "personal-role-edit"
    type: "symbol"
    name: "mayEditPersonalRole"
    path: "apps/web/src/lib/personal-roles.ts"
  - id: "personal-role-config"
    type: "symbol"
    name: "validatePersonalRoleConfig"
    path: "apps/web/src/lib/personal-roles.ts"
  - id: "role-visibility-pick"
    type: "symbol"
    name: "pickVisibleRoleRow"
    path: "packages/core/role-visibility.ts"
  - id: "stated-role-gate"
    type: "symbol"
    name: "checkStatedRole"
    path: "apps/web/src/lib/stated-role.ts"
  - id: "credential-policy-reader"
    type: "symbol"
    name: "effectiveKeyPolicy"
    path: "packages/core/inference-key-policy.ts"
  - id: "personal-credential-decision"
    type: "symbol"
    name: "decidePersonalCredential"
    path: "apps/web/src/app/api/workers/claim/personal-credential-injection.ts"
---
# Team Permissions

Who may do what inside a team. A team member holds one role — `owner`, `admin`
or `member`. An API key belongs to one team and carries a level — `trigger`,
`worker` or `admin` (scoped tokens map their scopes to a level first).

## Roles

**Capability statement**: Every member of a team MUST hold exactly one of
`owner`, `admin`, `member`, and a team MUST always have at least one owner.

**Invariants**:
- `owner` holds every registered permission, whatever the team's overrides.
  Only an owner holds the locked permissions (see Overrides), so only an owner
  deletes the team, edits its permission overrides, manages billing, and
  creates, removes, promotes to or demotes from `owner`.
- `admin` holds the registry's owner/admin defaults: members, settings, keys,
  credentials, workspaces, connectors, agent roles, releases and the rest of
  the inventory below, subject to the team's overrides.
- `member` holds `create_personal_roles` by default and nothing else from the
  registry; a team MAY grant a member more through overrides. Membership alone
  still reaches the unrole-gated writes listed under Oddities.
- A user's personal team (slug `personal-<userId>`) counts as owned by them.
  It cannot be left, and ownership of it cannot be transferred.

**Who assigns what**:
- Moving a member between `member` and `admin` needs `assign_team_roles`
  (owner, admin by default). Any change to or from `owner` needs
  `assign_team_owner` (owners only, locked).
- Adding or inviting someone as `admin` needs `assign_team_roles`, as `owner`
  needs `assign_team_owner` — even when overrides widen `manage_team_members`.
- Removing someone else needs `manage_team_members`; removing an owner also
  needs `assign_team_owner`.
- Any member MAY leave (remove themselves) without `manage_team_members`,
  except from their personal team and except the team's last owner.
- No change MAY demote or remove the team's last owner, whoever asks; the
  check counts current owners, not whether the caller is the target.
- An owner MAY transfer ownership to an existing non-owner member
  (`POST /api/teams/[id]/ownership`): the target becomes owner, the caller
  becomes admin. Promote and demote go in one `db.batch`, promote first, and
  the demote only matches once the target is an owner, so a team never has
  zero owners.
- An invitation MAY be accepted only by a signed-in user whose email equals the
  invitation's (trimmed, case-insensitive); anyone else gets a 403 naming the
  masked address it was sent to.

**Keys follow their creator**: a key records the person who minted it
(`accounts.created_by_user_id`). When that person's role changes, they are
removed, they leave, or they transfer ownership, their keys in that team are
lowered to the level their new role may mint (`clampCreatorKeys`,
`apps/web/src/lib/creator-key-clamp.ts`): `admin` becomes `worker` and
admin-grant scopes are stripped. A clamp never raises a level and never
revokes a key; a key with no recorded creator is never clamped. A member MAY
delete a key they created without `manage_team_keys`.

**Acceptance criteria**:
- AC-R1: GIVEN an `admin` caller WHEN they PATCH a `member` to `admin` THEN the
  role is written; WHEN they PATCH anyone to or from `owner` THEN it is a 403
  and nothing is written.
- AC-R2: GIVEN the team's only owner WHEN anyone (themselves included) demotes
  or removes them THEN it is a 400 and nothing is written.
- AC-R3: GIVEN an owner WHEN they transfer ownership to a member THEN that
  member is owner and the caller is admin, and the team never had zero owners.
- AC-R4: GIVEN an admin who minted an admin-level key WHEN they are demoted to
  member THEN that key becomes worker-level; a key in the team with no
  recorded creator is unchanged.
- AC-R5: GIVEN an invitation sent to one address WHEN a user signed in with a
  different email accepts it THEN it is a 403 and no membership is written.

## Named permission registry

**Capability statement**: Each team-scoped permission decision MUST be
answerable as "does this caller hold permission P in team T", where P is an
entry in `PERMISSIONS` (`apps/web/src/lib/permission-registry.ts`) carrying a
description, its default team roles, and the minimum API-key level that holds
it (or none).

**Invariants**:
- A session user holds P in team T iff their role in T is one of the roles
  `effectiveRoles` returns for (T, P): the entry's `defaultRoles`, replaced by
  the team's override for P when one is stored (see Overrides).
- A user's personal team (slug `personal-<userId>`) counts as owned by them,
  with or without a membership row, and wins over a membership row in it.
- An API key holds P only in its own team, and only when the entry's minimum
  level is set and the key's level ranks at or above it
  (trigger < worker < admin).
- An unknown role, an unknown or missing key level, or an empty team id holds
  nothing. An unregistered permission name does not type-check.
- Every call site in the inventory below names its permission. Changing a
  default is a behaviour change and MUST update this spec.
- What a page offers matches what its route accepts: settings pages derive one
  flag per permission from `roleHas` with the team's overrides
  (`settingsPermissions`), and a failed overrides read holds nothing.

**Acceptance criteria**:
- AC-1: GIVEN a user who is `admin` of team T WHEN `can` is asked for
  `manage_team_settings` in T THEN it returns true.
- AC-2: GIVEN a user who is `admin` of team T WHEN `can` is asked for
  `delete_team` in T THEN it returns false.
- AC-3: GIVEN a user who is `member` of team T WHEN `roleHas` is asked for any
  registered permission other than `create_personal_roles` THEN it returns
  false.
- AC-4: GIVEN an `admin`-level key of team K WHEN `can` is asked for
  `manage_releases` in another team THEN it returns false.
- AC-5: GIVEN an `admin`-level key WHEN `can` is asked for a permission whose
  minimum key level is none (e.g. `manage_team_members`) THEN it returns false.
- AC-6: GIVEN a key whose level is not one of trigger/worker/admin WHEN `can`
  is asked for any permission THEN it returns false.
- AC-7: GIVEN a membership row whose role is not owner/admin/member WHEN `can`
  is asked for any permission THEN it returns false.
- AC-8: GIVEN a user with no membership row in team T (not their personal
  team) WHEN a connector write in T is attempted THEN it is a 403 and nothing
  is written.

**Code surface**:
- `apps/web/src/lib/permission-registry.ts` — `PERMISSIONS`, `roleHas`,
  `keyLevelHas`, `effectiveRoles`. No runtime imports, so pure modules and
  client code can check a role without loading the db.
- `apps/web/src/lib/permissions.ts` — `can`, `teamIdsWhere`,
  `getUserTeamRoles`, `getTeamPermissionOverrides`; re-exports the registry.
- `apps/web/src/lib/team-access.ts` — `holdsInWorkspace` (a permission in a
  workspace's team). There is no generic "team admin" helper: every call site
  names its permission, so the team's overrides apply to it.
  `apps/web/src/lib/team-access-team-scope.test.ts` fails if a hard-coded
  owner/admin helper is exported, called or stubbed again.
- `apps/web/src/lib/key-level-policy.ts` — `maxKeyLevelForRole`,
  `clampKeyLevel`, `canAdministerTeamKeys`: the ceiling on a key a role may
  mint (`admin` iff the role holds `manage_team_keys`, else `worker`).
- `apps/web/src/lib/creator-key-clamp.ts` — the same ceiling applied to a
  person's existing keys when their role drops.
- `apps/web/src/lib/connector-team-auth.ts` — connector reads and writes.
- `apps/web/src/lib/personal-roles.ts`, `packages/core/role-visibility.ts` —
  personal roles (see Personal roles).
- `packages/core/db/schema.ts` — `teamMembers.role`, `accounts.level`,
  `accounts.createdByUserId`, `teams.permissionOverrides`,
  `teams.credentialPolicy`, `workspaceSkills.ownerUserId` / `visibility`.

**Out of scope**:
- Workspace reach (`verifyWorkspaceAccess` without a role,
  `verifyAccountWorkspaceAccess`): whether a caller can see a workspace at all,
  including the opt-in `gitConfig.memberRepoAccess` GitHub check
  (`apps/web/src/lib/member-repo-access.ts`, see `docs/SPEC.md`).
- Token-scope route policy (`hasTokenRouteAdminAccess`,
  `apps/web/src/lib/token-route-policy.ts`) and MCP action token levels
  (`packages/core/mcp-tools.ts`): which routes/actions a token may call. These
  gate on key level/scope alone, never on team role, and run before any
  permission check.
- Platform admin (`apps/web/src/lib/platform-admin.ts`), a cross-team operator
  allowlist, not a team role.
- Agent capability grants on a role (`docs/specs/agent-capabilities.md`); who
  may edit a role's grant is `manage_agent_roles`, below.

## Overrides

A team owner MAY change which team roles hold a permission. The grants live in
`teams.permission_overrides` (permission → team roles; an absent key is the
registry default) and are read through `getTeamPermissionOverrides(teamId)`,
cached per request.

- Every decision passes the team's overrides: `roleHas(role, permission, overrides)`
  takes them as a required argument, so a call site cannot silently use the
  defaults. `null` is for locked permissions or a context with no team.
- `owner` always holds every permission, so a team cannot lock itself out.
- `assign_team_owner`, `delete_team`, `manage_team_permissions`,
  `seed_team_timezone`, `activate_chat_retro_dogfood` and `manage_billing` are
  locked: overrides for them are ignored on read and refused on write, so an
  admin can never widen their own power and no team can hand a member the card.
- Only `manage_team_permissions` (owner) writes, by signing in:
  `PUT /api/teams/[id]/permissions` replaces the whole set; an entry equal to
  the default is not stored and `{}` resets everything. Unknown or locked names
  and unknown roles are a 400 that names the problem. Any member may `GET`.
- Stored JSON is sanitized on every read; anything unknown is dropped, never
  trusted. A failed read is an error, not "defaults": an override can take a
  permission away, so guessing would widen access.
- Overrides govern signed-in sessions. API keys and OAuth sessions act at
  their key level (`minKeyLevel`; an owner's or admin's OAuth session acts as an
  admin-level key, `levelForTeamRole`), which overrides do not change.

## Personal roles

**Capability statement**: A member MUST be able to own an agent role that runs
only on their own tasks until they share it, and no one else MUST be able to
see, edit or run another member's private role.

A personal role is a `workspace_skills` row with `owner_user_id` set: always
team-level, `visibility` `private` (its owner only) or `team` (shared).

**Invariants**:
- Any member holding `create_personal_roles` creates one for themselves with
  `POST /api/roles { personal: true }`; it starts private. The target team is
  `body.teamId` (one of the caller's teams, else 404) or the active team.
- Its owner may always edit, delete and share it. Once shared, a
  `manage_agent_roles` holder may too. Another member's private role is
  invisible to everyone else (404), admins included, and is never listed.
- Team roles and shared personal roles share one slug namespace per team,
  enforced by a unique index; a share or promote that would collide is a 409.
  A private personal role may reuse a team role's slug.
- `POST /api/roles/[id]/promote` (`manage_agent_roles`) turns a shared personal
  role into a team role, keeping the slug.
- A personal role never holds an operator grant, carries no raw `mcpServers`,
  maps `requiredEnvVars` only to secrets with `user_id` = its owner (runner
  provided vars excepted), and mounts only connectors its team owns or was
  shared (catalog policy is enforced at claim time, as for team roles). Each
  refusal is a 400 naming the field. It has no workspace overrides (400), and
  the workspace skills routes neither create nor list it.
- A role slug resolves to one row per task through `pickVisibleRoleRow`
  (`packages/core/role-visibility.ts`), whose candidates are the workspace
  override, the team default, shared personal rows and the task requester's
  own rows; precedence is workspace override > requester's own > shared
  (lowest id) > team default. Every site that turns a slug into a row (claim,
  role inference, connector routing, planning context, derived tasks) uses it.
- Creating or editing a task with a `roleSlug` that names only another
  member's private role is a 400 with `gateReason: role_not_visible`
  (`checkStatedRole`). Tasks derived from a plan carry its requester.

## Credential policy

**Capability statement**: A team MUST opt in explicitly before any agent run
uses a person's own model key, and then a run MUST use only the key of the
person the task is for.

**Invariants**:
- `teams.credential_policy` is one of `team`, `personal_first`,
  `personal_only`, or NULL (not opted in). It is written through
  `PATCH /api/teams/[id]` or `PATCH /api/providers` (both `manage_team_settings`)
  as `credentialPolicy`. The
  legacy chat-only name `inferenceKeyPolicy` keeps it in step only once it is
  set; it never opts a team in.
- With NULL or `team`, agent runs use team credentials and nothing personal is
  read. Under `personal_first` / `personal_only` the claim resolves the
  requester's own key (`decidePersonalCredential`); `personal_only` defers the
  task when there is none.
- A personal key reaches only a runner that declares `personal_credentials`,
  and that runner never caches it across workers or people.
- Writing a team- or workspace-wide credential needs `manage_team_credentials`
  (`manage_team_model_keys` for the team model key); a member writes only
  their own personal keys.
- A key agent runs read that is also a chat key (an Anthropic or OpenAI key in
  canonical `inference_key` storage) needs both `manage_team_model_keys` and
  `manage_team_credentials`, on every route that writes or removes it
  (`/api/providers`, `/api/secrets`, `/api/inference-keys`, MCP
  `manage_providers`). Each applies the API-key prefix (a pasted subscription
  token is refused) and re-queues auth-failed tasks once it is stored. The rule
  is `storedWritePermissions` / `writePermissions` in
  `packages/core/providers/manage.ts`; the Providers page reads it from
  `GET /api/providers` (`writesTo[scope].permissions`).

Storage, delivery and the per-policy table: `docs/credentials-architecture.md`
→ "Personal keys on agent runs".

## Inventory

Every team-role permission decision. "Session" lists the team roles allowed by
default; "Key" lists the minimum API-key level, or "—" when the route is
session-only or rejects keys. Line numbers are as of this spec's
`last_verified` date.

### Team membership

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/teams/[id]/members/route.ts:86` | add a member | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/members/route.ts:101` | add a member as owner | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/members/route.ts:106` | add a member as admin | owner, admin | — | `assign_team_roles` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:54` | change a role between member and admin | owner, admin | — | `assign_team_roles` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:79` | change a role to or from owner | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:158` | remove a member | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:176` | remove an owner | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/ownership/route.ts:41` | transfer ownership | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/invitations/route.ts:29` | list invitations | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/invitations/route.ts:74` | invite | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/invitations/route.ts:91` | invite as admin | owner, admin | — | `assign_team_roles` |
| `apps/web/src/app/api/teams/[id]/invitations/[invitationId]/route.ts:34` | revoke an invitation | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/app/(protected)/teams/[id]/page.tsx:70` | UI: show member management | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:69` | UI: edit team button | owner, admin | — | `manage_team_settings` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:71` | UI: owner in the role picker, transfer ownership, remove an owner | owner | — | `assign_team_owner` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:72` | UI: role picker (member/admin, not on owner rows), invite as admin | owner, admin | — | `assign_team_roles` |
| `apps/web/src/app/app/(protected)/settings/team/page.tsx:74` | UI: manage members | owner, admin | — | `manage_team_members` |

### Team settings

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/teams/[id]/route.ts:156` | PATCH team name, slug, AI features, chat budgets, credential policy, timezone | owner, admin | — | `manage_team_settings` |
| `apps/web/src/app/api/teams/[id]/route.ts:317` | DELETE team | owner | — | `delete_team` |
| `apps/web/src/app/api/teams/[id]/permissions/route.ts:88` | write permission overrides | owner | — | `manage_team_permissions` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:70` | UI: delete team button | owner | — | `delete_team` |
| `apps/web/src/app/app/(protected)/settings/TimezoneSection.tsx:63` | UI: edit team timezone | owner, admin | — | `manage_team_settings` |
| `apps/web/src/app/app/(protected)/settings/_lib/settings-permissions.ts:21` | UI: every settings control, one flag per permission | per permission, personal team | — | all |
| `apps/web/src/lib/team-timezone.ts:79` | own timezone change seeds owned teams | owner | — | `seed_team_timezone` |
| `apps/web/src/app/api/teams/[id]/chat-retro/route.ts:52` | read/write chat retro settings | owner, admin | admin (`:42`) | `manage_chat_retro` |
| `apps/web/src/app/api/teams/[id]/chat-retro/route.ts:110` | turn on chat retro account dogfood | owner | — | `activate_chat_retro_dogfood` |
| `apps/web/src/app/api/teams/[id]/notifications/route.ts:30` | PUT team notification settings (GET open to members, booleans only) | owner, admin | — | `manage_team_notifications` |
| `apps/web/src/app/app/(protected)/home/home-view.ts:118` | UI: operator Home | owner, admin | — | `view_team_usage` |
| `apps/web/src/app/api/insights/flow/route.ts:42` | team flow insights | owner, admin | — | `view_team_usage` |
| `apps/web/src/app/app/(protected)/health/insights/page.tsx:45` | UI: insights | owner, admin | — | `view_team_usage` |
| `apps/web/src/app/app/(protected)/settings/budgets/page.tsx:61` | UI: per-person spend | owner, admin | — | `view_team_usage` |
| `apps/web/src/lib/billing/team-billing-access.ts:64` | open Checkout / the billing portal / change seats | owner, admin | — | `manage_billing` |
| `apps/web/src/app/app/(protected)/settings/billing/page.tsx:55` | UI: billing actions | owner, admin, personal team | — | `manage_billing` |

### API keys and runners

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/accounts/[id]/route.ts:84` | delete someone else's key (a key you created is yours to delete) | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/[id]/route.ts:143` | change a key's concurrent-worker cap | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/[id]/regenerate-key/route.ts:55` | regenerate a key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/[id]/host-runner/route.ts:51` | flag a host-runner key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:110` | mint an admin-level key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:114` | grant admin scopes on a token | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:126` | link a new token to a restricted workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/workspaces/[id]/accounts/route.ts:77` | link a key to a workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/workspaces/[id]/accounts/route.ts:172` | unlink a key from a workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/auth/cli/route.ts:116` | CLI login key level (clamped) | owner, admin get admin | — | `manage_team_keys` |
| `apps/web/src/app/api/auth/device/approve/route.ts:96` | device-flow key level (clamped) | owner, admin get admin | — | `manage_team_keys` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts` | clamp the target's keys after a role change, removal or leave | follows the new role | — | `manage_team_keys` |
| `apps/web/src/app/api/teams/[id]/ownership/route.ts` | clamp the former owner's keys to admin | follows the new role | — | `manage_team_keys` |
| `apps/web/src/lib/oauth/session-level.ts:10` | OAuth session acts at admin (fixed, not overridable) | owner, admin | — | — |
| `apps/web/src/lib/key-level-policy.ts:47` | `canAdministerTeamKeys` | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/app/(protected)/accounts/new/page.tsx:34` | UI: admin scope selectable | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/app/(protected)/settings/runners/page.tsx:38` | UI: host-runner toggle | owner, admin, personal team | — | `manage_team_keys` |

### Model access and spend

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/secrets/route.ts:112` | team model key, decision key, Cloudflare token | owner, admin, personal team | admin | `manage_team_model_keys` |
| `apps/web/src/app/api/secrets/route.ts:112` | an Anthropic or OpenAI key in canonical storage (`inference_key` + provider label; agent runs read it) | owner, admin, personal team | admin | `manage_team_model_keys` and `manage_team_credentials` |
| `apps/web/src/app/api/secrets/route.ts:112` | any other team-, workspace- or account-wide secret | owner, admin, personal team | admin | `manage_team_credentials` |
| `apps/web/src/app/api/providers/route.ts:73` | set/delete a team or workspace provider credential stored as a chat-only key (`inference_key`, `decision_key`) | owner, admin, personal team | admin | `manage_team_model_keys` |
| `apps/web/src/app/api/providers/route.ts:73` | set/delete a team or workspace Anthropic or OpenAI key (canonical storage, read by chat and agent runs) | owner, admin, personal team | admin | `manage_team_model_keys` and `manage_team_credentials` |
| `apps/web/src/app/api/providers/route.ts:73` | set/delete a team or workspace agent credential (`anthropic_api_key`, `openai_api_key`, `oauth_token`) | owner, admin, personal team | admin | `manage_team_credentials` |
| `apps/web/src/app/api/providers/route.ts:73` | set/delete the LiteLLM gateway or a custom endpoint | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/providers/route.ts:207` | set the team credential policy (as PATCH /api/teams/[id]) | owner, admin, personal team | — | `manage_team_settings` |
| `apps/web/src/lib/team-credential-access.ts:13` | connect, replace or delete a workspace Claude/Codex credential (refresh and verify stay open to members) | owner, admin, personal team | — | `manage_team_credentials` |
| `apps/web/src/app/app/(protected)/settings/runners/page.tsx:39` | UI: runner credentials | owner, admin, personal team | — | `manage_team_credentials` |
| `apps/web/src/app/app/(protected)/settings/runners/page.tsx:40` | UI: Cloudflare token | owner, admin, personal team | — | `manage_team_model_keys` |
| `apps/web/src/app/app/(protected)/settings/github/page.tsx:20` | UI: Vercel and other team credentials | owner, admin, personal team | — | `manage_team_credentials` |
| `apps/web/src/app/api/inference-keys/route.ts:76` | team-scope chat-only inference keys (OpenRouter) | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/route.ts:76` | team-scope Anthropic or OpenAI key (agent runs read it) | owner, admin, personal team | — | `manage_team_model_keys` and `manage_team_credentials` |
| `apps/web/src/app/api/inference-keys/verify/route.ts:31` | verify a team-scope key | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/openrouter/start/route.ts:38` | start OpenRouter link | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/openrouter/callback/[state]/route.ts:41` | finish OpenRouter link | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/route.ts:34` | agent endpoint writes | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/models/route.ts:28` | agent endpoint model list | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/models/suggest/route.ts:25` | agent endpoint model suggest | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/litellm-gateway/route.ts:23` | LiteLLM gateway writes | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/lib/chat-availability.ts:50` | UI: may set up chat keys | owner, admin | — | `manage_inference_providers` |
| `apps/web/src/lib/model-tier-access.ts:88` | write model tiers and the upgrade policy | owner, admin | admin (route policy) | `manage_model_tiers` |
| `apps/web/src/lib/tier-pool-access.ts:23` | write model traffic pools | owner, admin | — | `manage_model_tiers` |
| `apps/web/src/app/app/(protected)/settings/models/page.tsx:32` | UI: edit model tiers | owner, admin, personal team | — | `manage_model_tiers` |
| `apps/web/src/app/api/accounts/[id]/ai-budget/route.ts:24` | app account daily AI cap | owner, admin, personal team | admin | `manage_ai_budget` |
| `apps/web/src/lib/chat/turn.ts:391` | chat admin tool group | owner, admin | — | `use_chat_admin_tools` |

### Workspaces

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/workspaces/[id]/config/route.ts:148` | write workspace config | owner, admin | admin | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/[id]/route.ts:221` | PATCH git config (incl. merge policy, member repo access), access mode, data class, connector gate, webhook | owner, admin | admin (route policy) | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/[id]/settings/route.ts:53` | PATCH work tracker config | owner, admin | admin | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/[id]/github-access/route.ts:48` | POST re-check the GitHub App's repo access and link the repo (GET open to members) | owner, admin | admin (route policy) | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/route.ts:217` | POST create a workspace in the target team (a member is refused, not moved to their personal team) | owner, admin, personal team | admin | `create_workspace` |
| `apps/web/src/app/api/workspaces/[id]/route.ts:534` | DELETE workspace | owner | — | `delete_workspace` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/config/page.tsx:74` | UI: config admin sections | owner, admin | — | `manage_workspace_settings` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/config/page.tsx:202` | UI: delete workspace | owner | — | `delete_workspace` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/page.tsx:157` | UI: connect a repo | owner, admin | — | `manage_workspace_settings` |
| `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/page.tsx:86` | UI: workspace settings, merge policy | owner, admin | — | `manage_workspace_settings` |
| `apps/web/src/app/app/(protected)/settings/workspaces/page.tsx:23` | UI: New workspace | owner, admin, personal team | — | `create_workspace` |
| `apps/web/src/app/app/(protected)/settings/workspaces/rows.ts:99` | UI: teams a workspace can move to | owner, admin, personal team | — | `migrate_workspace` |
| `apps/web/src/lib/migrate-access.ts:47` | migrate a workspace (both teams) | owner, admin, personal team | admin (route policy) | `migrate_workspace` |
| `apps/web/src/app/api/github/installations/[id]/route.ts:40` | disconnect a GitHub installation | via the line below | — | `manage_github_installation` |
| `apps/web/src/lib/github-installation-access.ts:62` | manage a GitHub installation | owner, admin, personal team, or the installer | — | `manage_github_installation` |
| `apps/web/src/app/api/workspaces/[id]/schedules/[scheduleId]/route.ts:66` | set or clear a schedule's delegation | owner, admin | admin | `delegate_schedule_access` |
| `apps/web/src/app/api/workspaces/[id]/memory/[memoryId]/route.ts:79` | review memories | owner, admin | admin, or `admin`/`knowledge:admin` scope (`:81`) | `review_memory` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/memory/page.tsx:109` | UI: memory review | owner, admin | — | `review_memory` |

### Work in flight

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/workers/[id]/instruct/route.ts:80` | instruct a worker | owner, admin | admin (`workers:admin`) | `steer_workers` |
| `apps/web/src/app/api/tasks/[id]/messages/route.ts:70` | UI: may send steering message | owner, admin | admin (`workers:admin`) | `steer_workers` |
| `apps/web/src/app/api/tasks/[id]/reassign/route.ts:70` | force-reassign a task | owner, admin | any key with workspace access (oddity 2) | `force_reassign_task` |
| `apps/web/src/app/api/workers/[id]/release-slot/route.ts:60` | release an interactive worker's slot | owner, admin | — | `force_reassign_task` |
| `apps/web/src/app/api/releases/trigger/route.ts:58` | trigger a release | owner, admin, personal team | admin (`:53`) | `manage_releases` |
| `apps/web/src/app/api/releases/status/route.ts:35` | release preflight | owner, admin, personal team | admin (`:31`) | `manage_releases` |

### Team infrastructure

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/lib/connector-team-auth.ts:49` | `canManageTeamConnectors`: every connector session gate below | owner, admin, personal team | — | `manage_connectors` |
| `apps/web/src/lib/connector-team-auth.ts:65` | `canWriteTeamConnectors`: own team only, asked at admin after route policy (oddity 1) | — | admin | `manage_connectors` |
| `apps/web/src/app/api/connectors/route.ts:162` | create a connector | owner, admin | admin (route policy) | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/route.ts:101` | edit a connector (incl. its header credential) | owner, admin | admin | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/route.ts:207` | delete a connector | owner, admin | admin | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/connect/route.ts:71` | connect (writes the team-wide credential) | owner, admin | admin (route policy) | `manage_connectors` |
| `apps/web/src/app/api/connectors/callback/route.ts:89` | finish a connector OAuth connect | owner, admin | — | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/disconnect/route.ts:66` | disconnect | owner, admin | admin | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/shares/route.ts:65` | manage connector shares (owner team; target team `:153`) | owner, admin | admin (route policy) | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/transfer/route.ts:73` | transfer a connector (source; target `:96`) | owner, admin | admin (route policy) | `manage_connectors` |
| `apps/web/src/app/api/workspaces/[id]/connectors/route.ts:136` | enable or disable a connector in a workspace | owner, admin | admin (in-route) | `manage_connectors` |
| `apps/web/src/app/api/roles/route.ts:185` | create a team-level role | owner, admin, personal team | — (session only) | `manage_agent_roles` |
| `apps/web/src/app/api/roles/[id]/route.ts:55` | edit or delete a team role (incl. its operator grant), or make a skill one | owner, admin, personal team | — (session only) | `manage_agent_roles` |
| `apps/web/src/app/api/roles/[id]/overrides/route.ts:94` | write a role's workspace override | owner, admin, personal team | — (session only) | `manage_agent_roles` |
| `apps/web/src/app/api/workspaces/[id]/skills/route.ts:57` | create or upsert a workspace role (skill CRUD, `isRole`) | owner, admin | admin (in-route) | `manage_agent_roles` |
| `apps/web/src/app/api/workspaces/[id]/skills/[skillId]/route.ts:55` | edit or delete a workspace role, or make a skill one | owner, admin | admin (in-route) | `manage_agent_roles` |
| `apps/web/src/app/api/roles/route.ts:177` | create a personal role (`personal: true`) | owner, admin, member | — (session only) | `create_personal_roles` |
| `apps/web/src/lib/personal-roles.ts:66` | edit, delete or re-share another member's **shared** personal role | owner, admin, personal team | — (session only) | `manage_agent_roles` |
| `apps/web/src/app/api/roles/[id]/promote/route.ts:34` | promote a shared personal role to a team role | owner, admin, personal team | — (session only) | `manage_agent_roles` |
| `apps/web/src/app/app/(protected)/team/page.tsx:92` | UI: New role (personal; team role `:93`) | per permission | — | `create_personal_roles` |
| `apps/web/src/app/app/(protected)/team/[slug]/settings/page.tsx:142` | UI: team role editor and Operator access | owner, admin | — | `manage_agent_roles` |
| `apps/web/src/app/api/evidence-backends/route.ts:51` | create a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/route.ts:56` | edit a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/route.ts:99` | delete a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/verify/route.ts:35` | verify a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/lib/experiments.ts:59` | `isExperimentAdmin`: create/start/pause/conclude, see admin-only | owner, admin | admin (`apps/web/src/lib/experiment-access.ts:72`) | `run_experiments` |

### Oddities, reproduced not fixed

1. **Connector key level is enforced upstream.** The connector write routes ask
   `can` at `admin` level for an API key only after the token-scope route
   policy has established admin access (`hasTokenRouteAdminAccess`). A route
   that adopted `canWriteTeamConnectors` without that policy in front would
   admit any key of the team.
2. **Force-reassign for any key.** A session needs owner/admin to force a
   reassign, but any API key with access to the workspace may — including
   `trigger` keys. Reproduced as minimum level `trigger`.
3. **Personal-team fallback is uneven.** Sites built on `can` /
   `teamIdsWhere` / `holdsInWorkspace` or the settings permissions treat the
   personal team as owned; sites that read the membership row directly (team
   settings, chat retro, members, invitations, evidence backends, experiments)
   do not. Harmless while a personal team's owner has an owner row.
4. **Artifacts widen an API key to its team owner's teams.**
   `apps/web/src/app/api/artifacts/route.ts:31` lists artifacts across every
   team the API key's team owner belongs to. That is reach, not a permission,
   so it is not in the registry; noted because it reads `role = 'owner'`.
5. **Writes with no role gate.** For a session, these need only membership:
   deleting a memory, a workspace's name/repo/branch/concurrency cap, plain
   skill CRUD (`isRole` false), and the mission, task and schedule admin routes
   (those hold API keys to admin, but not sessions). They are not permission
   decisions, so they are not in the registry.
6. **Deleting a workspace is owner-only.** An admin gets 404. Reproduced as
   `delete_workspace` (overridable).
7. **Three ways a key counts as admin.** Token-scope policy
   (`hasTokenRouteAdminAccess`, scope-aware), a raw `level` read (chat retro,
   AI budget, evidence backends, experiments), and a hand-built scope map
   (memory review). `can` reads `level` only, so a call site keeps doing
   whatever scope-to-level mapping it does today.
8. **Refusal text names the defaults.** Several 403 messages say "owner or
   admin" even when a team's overrides moved the permission. The decision
   follows the overrides; only the wording does not.
9. **Keys with no recorded creator are never clamped.** A key minted before
   creators were recorded, or by the shared OAuth session account, keeps its
   level when any person's role changes.
