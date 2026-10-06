---
title: Team Permissions
status: active
owner: max
last_verified: 2026-10-04
summary: Every team-scoped permission decision MUST resolve through one named-permission registry that maps each permission to its team roles and minimum API-key level, failing closed.
domain: auth
surfaces: [apps/web/src/lib/permissions.ts, apps/web/src/lib/permission-registry.ts, apps/web/src/lib/team-access.ts, apps/web/src/lib/key-level-policy.ts]
related: [team-namespace-scoping, auth-oauth-boundaries]
keywords: [owner, admin, member, team role, api key level, ADMIN_ROLES, canCallerAdminTeam, permission registry, rbac]
verified_by: [apps/web/src/lib/permissions.test.ts, apps/web/src/lib/permission-overrides.test.ts, apps/web/src/app/api/teams/[id]/permissions/route.test.ts, apps/web/src/lib/team-access-team-scope.test.ts]
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
  - id: "admin-team-wrapper"
    type: "symbol"
    name: "canCallerAdminTeam"
    path: "apps/web/src/lib/team-access.ts"
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
---
# Team Permissions

Who may do what inside a team. A team member holds one role — `owner`, `admin`
or `member`. An API key belongs to one team and carries a level — `trigger`,
`worker` or `admin` (scoped tokens map their scopes to a level first).

## Named permission registry

**Capability statement**: Each team-scoped permission decision MUST be
answerable as "does this caller hold permission P in team T", where P is an
entry in `PERMISSIONS` (`apps/web/src/lib/permission-registry.ts`) carrying a
description, its default team roles, and the minimum API-key level that holds
it (or none).

**Invariants**:
- A session user holds P in team T iff their role in T is one of the roles
  `effectiveRoles` returns for (T, P). Today that is the entry's
  `defaultRoles`; `effectiveRoles` is the one seam where per-team overrides
  will plug in. There is no override storage yet.
- A user's personal team (slug `personal-<userId>`) counts as owned by them,
  with or without a membership row, and wins over a membership row in it.
- An API key holds P only in its own team, and only when the entry's minimum
  level is set and the key's level ranks at or above it
  (trigger < worker < admin).
- An unknown role, an unknown or missing key level, or an empty team id holds
  nothing. An unregistered permission name does not type-check.
- The registry reproduces the call-site rules in the inventory below exactly.
  Changing a default is a behaviour change and MUST update this spec.

**Acceptance criteria**:
- AC-1: GIVEN a user who is `admin` of team T WHEN `can` is asked for
  `manage_team_settings` in T THEN it returns true.
- AC-2: GIVEN a user who is `admin` of team T WHEN `can` is asked for
  `delete_team` in T THEN it returns false.
- AC-3: GIVEN a user who is `member` of team T WHEN `roleHas` is asked for any
  registered permission THEN it returns false.
- AC-4: GIVEN an `admin`-level key of team K WHEN `can` is asked for
  `manage_releases` in another team THEN it returns false.
- AC-5: GIVEN an `admin`-level key WHEN `can` is asked for a permission whose
  minimum key level is none (e.g. `manage_team_members`) THEN it returns false.
- AC-6: GIVEN a key whose level is not one of trigger/worker/admin WHEN `can`
  is asked for any permission THEN it returns false.
- AC-7: GIVEN a membership row whose role is not owner/admin/member WHEN `can`
  is asked for any permission THEN it returns false.

**Code surface**:
- `apps/web/src/lib/permission-registry.ts` — `PERMISSIONS`, `roleHas`,
  `keyLevelHas`, `effectiveRoles`. No runtime imports, so pure modules and
  client code can check a role without loading the db.
- `apps/web/src/lib/permissions.ts` — `can`, `teamIdsWhere`,
  `getUserTeamRoles`; re-exports the registry.
- `apps/web/src/lib/team-access.ts` — `canCallerAdminTeam`,
  `getCallerAdminTeamIds`, `getUserAdminTeamIds`: thin wrappers over the
  registry's admin tier (owner/admin, or an admin-level key), kept until their
  call sites move to a named permission.
- `packages/core/db/schema.ts` — `teamMembers.role`, `accounts.level`.

**Out of scope**:
- Workspace reach (`verifyWorkspaceAccess` without a role,
  `verifyAccountWorkspaceAccess`): whether a caller can see a workspace at all.
- Token-scope route policy (`hasTokenRouteAdminAccess`,
  `apps/web/src/lib/token-route-policy.ts`) and MCP action token levels
  (`packages/core/mcp-tools.ts`): which routes/actions a token may call. These
  gate on key level/scope alone, never on team role, and run before any
  permission check.
- Key-level clamping by role (`maxKeyLevelForRole`, `levelForTeamRole`): the
  ceiling on a key a role may mint. Covered by `manage_team_keys` only in that
  owner/admin may mint admin keys.
- Platform admin (`apps/web/src/lib/platform-admin.ts`), a cross-team operator
  allowlist, not a team role.

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
  `seed_team_timezone` and `activate_chat_retro_dogfood` are locked: overrides for them are ignored on read and
  refused on write, so an admin can never widen their own power.
- Only `manage_team_permissions` (owner) writes, by signing in:
  `PUT /api/teams/[id]/permissions` replaces the whole set; an entry equal to
  the default is not stored and `{}` resets everything. Unknown or locked names
  and unknown roles are a 400 that names the problem. Any member may `GET`.
- Stored JSON is sanitized on every read; anything unknown is dropped, never
  trusted. A failed read is an error, not "defaults": an override can take a
  permission away, so guessing would widen access.
- Overrides govern signed-in sessions. API keys and OAuth sessions act at
  their key level (`minKeyLevel`; an owner's or admin's OAuth session acts as an
  admin-level key), which overrides do not change.

## Inventory

Every team-role permission decision at the time the registry was introduced.
"Session" lists the team roles allowed; "Key" lists the minimum API-key level,
or "—" when the route is session-only or rejects keys. Line numbers are as of
this spec's `last_verified` date.

### Team membership

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/teams/[id]/members/route.ts:92` | add a member | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/members/route.ts:108` | add a member as owner | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:34` | change a member's role | owner | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:113` | remove a member | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/members/[userId]/route.ts:150` | remove an owner | owner (admins refused) | — | `assign_team_owner` |
| `apps/web/src/app/api/teams/[id]/invitations/route.ts:27` | list invitations | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/invitations/route.ts:71` | invite (as admin or member) | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/api/teams/[id]/invitations/[invitationId]/route.ts:33` | revoke an invitation | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/app/(protected)/teams/[id]/page.tsx:67` | UI: show member management | owner, admin | — | `manage_team_members` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:297` | UI: role picker | owner | — | `assign_team_owner` |
| `apps/web/src/app/app/(protected)/settings/team/page.tsx:62` | UI: manage members | owner, admin | — | `manage_team_members` |

### Team settings

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/teams/[id]/route.ts:159` | PATCH team name, slug, AI features, chat budgets, key policy, timezone | owner, admin | — | `manage_team_settings` |
| `apps/web/src/app/api/teams/[id]/route.ts:307` | DELETE team | owner | — | `delete_team` |
| `apps/web/src/app/app/(protected)/teams/[id]/TeamDetailClient.tsx:253` | UI: delete team button | owner | — | `delete_team` |
| `apps/web/src/app/app/(protected)/settings/TimezoneSection.tsx:62` | UI: edit team timezone | owner, admin | — | `manage_team_settings` |
| `apps/web/src/app/app/(protected)/settings/_lib/settings-context.ts:53` | UI: settings admin sections | owner, admin, personal team | — | `manage_team_settings` |
| `apps/web/src/lib/team-timezone.ts:99` | own timezone change seeds owned teams | owner | — | `seed_team_timezone` |
| `apps/web/src/app/api/teams/[id]/chat-retro/route.ts:52` | read/write chat retro settings | owner, admin | admin (`:42`) | `manage_chat_retro` |
| `apps/web/src/app/api/teams/[id]/chat-retro/route.ts:110` | turn on chat retro account dogfood (every team the caller owns) | owner | — | `activate_chat_retro_dogfood` |
| `apps/web/src/app/app/(protected)/home/home-view.ts:114` | UI: operator Home | owner, admin | — | `view_team_usage` |
| `apps/web/src/app/app/(protected)/settings/budgets/page.tsx:61` | UI: per-person spend | via settings-context | — | `view_team_usage` |

### API keys and runners

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/accounts/[id]/regenerate-key/route.ts:54` | regenerate a key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/[id]/host-runner/route.ts:50` | flag a host-runner key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:108` | mint an admin-level key | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:112` | grant admin scopes on a token | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/accounts/route.ts:124` | link a new token to a restricted workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/workspaces/[id]/accounts/route.ts:76` | link a key to a workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/workspaces/[id]/accounts/route.ts:171` | unlink a key from a workspace | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/api/auth/cli/route.ts:114` | CLI login key level (clamped) | owner, admin get admin | — | `manage_team_keys` |
| `apps/web/src/app/api/auth/device/approve/route.ts:79` | device-flow key level (clamped) | owner, admin get admin | — | `manage_team_keys` |
| `apps/web/src/lib/oauth/session-level.ts:11` | OAuth session acts at admin | owner, admin | — | `manage_team_keys` |
| `apps/web/src/lib/key-level-policy.ts:43` | `canAdministerTeamKeys` | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/app/(protected)/accounts/new/page.tsx:33` | UI: admin scope selectable | owner, admin | — | `manage_team_keys` |
| `apps/web/src/app/app/(protected)/settings/runners/page.tsx:36` | UI: host-runner toggle | owner, admin, personal team | — | `manage_team_keys` |

### Model access and spend

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/secrets/route.ts:103` | team model key | owner, admin, personal team | admin | `manage_team_model_keys` |
| `apps/web/src/app/api/inference-keys/route.ts:37` | team-scope inference keys | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/verify/route.ts:29` | verify a team-scope key | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/openrouter/start/route.ts:37` | start OpenRouter link | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/inference-keys/openrouter/callback/[state]/route.ts:40` | finish OpenRouter link | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/route.ts:26` | agent endpoint writes | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/models/route.ts:27` | agent endpoint model list | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/agent-endpoint/models/suggest/route.ts:24` | agent endpoint model suggest | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/app/api/teams/[id]/litellm-gateway/route.ts:22` | LiteLLM gateway writes | owner, admin, personal team | — | `manage_inference_providers` |
| `apps/web/src/lib/chat-availability.ts:47` | UI: may set up chat keys | owner, admin | — | `manage_inference_providers` |
| `apps/web/src/app/api/model-tiers/route.ts:87` | write model tiers | owner, admin | admin (route policy) | `manage_model_tiers` |
| `apps/web/src/lib/tier-pool-access.ts:22` | write model traffic pools | owner, admin | — | `manage_model_tiers` |
| `apps/web/src/app/app/(protected)/settings/models/page.tsx:28` | UI: edit model tiers | owner, admin, personal team | — | `manage_model_tiers` |
| `apps/web/src/lib/ai/account-budget.ts:55` | app account daily AI cap | owner, admin, personal team | admin | `manage_ai_budget` |
| `apps/web/src/lib/chat/turn.ts:385` | chat admin tool group | owner, admin | — | `use_chat_admin_tools` |

### Workspaces

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/workspaces/[id]/config/route.ts:147` | write workspace config | owner, admin | admin | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/[id]/route.ts:218` | PATCH git config, access mode, data class, connector gate, webhook | owner, admin | admin (route policy) | `manage_workspace_settings` |
| `apps/web/src/app/api/workspaces/[id]/route.ts:453` | DELETE workspace | owner | — | `delete_workspace` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/config/page.tsx:80` | UI: config admin sections | owner, admin | — | `manage_workspace_settings` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/page.tsx:156` | UI: connect a repo | owner, admin | — | `manage_workspace_settings` |
| `apps/web/src/app/app/(protected)/settings/workspaces/rows.ts:30` | UI: teams a workspace can be created in | owner, admin, personal team | — | `manage_workspace_settings` |
| `apps/web/src/lib/migrate-access.ts:44` | migrate a workspace (both teams) | owner, admin (see oddity 1) | admin (route policy) | `migrate_workspace` |
| `apps/web/src/app/api/github/installations/[id]/route.ts:41` | disconnect a GitHub installation | via the line below | — | `manage_github_installation` |
| `apps/web/src/lib/github-installation-access.ts:70` | manage a GitHub installation | owner, admin, personal team, or the installer | — | `manage_github_installation` |
| `apps/web/src/app/api/workspaces/[id]/memory/[memoryId]/route.ts:111` | review memories | owner, admin | admin, or `admin`/`knowledge:admin` scope | `review_memory` |
| `apps/web/src/app/app/(protected)/workspaces/[id]/memory/page.tsx:107` | UI: memory review | owner, admin | — | `review_memory` |

### Work in flight

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/workers/[id]/instruct/route.ts:69` | instruct a worker | owner, admin | admin (`workers:admin`) | `steer_workers` |
| `apps/web/src/app/api/tasks/[id]/messages/route.ts:65` | UI: may send steering message | owner, admin | admin (`workers:admin`) | `steer_workers` |
| `apps/web/src/app/api/tasks/[id]/reassign/route.ts:70` | force-reassign a task | owner, admin | any key with workspace access (oddity 3) | `force_reassign_task` |
| `apps/web/src/app/api/releases/trigger/route.ts:50` | trigger a release | owner, admin, personal team | admin | `manage_releases` |
| `apps/web/src/app/api/releases/status/route.ts:28` | release preflight | owner, admin, personal team | admin | `manage_releases` |

### Team infrastructure

| Site | Gates | Session | Key | Permission |
|---|---|---|---|---|
| `apps/web/src/app/api/connectors/route.ts:162` | create a connector | owner, admin (oddity 1) | admin (route policy, oddity 2) | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/shares/route.ts:75` | manage connector shares | owner, admin (oddity 1) | admin (route policy, oddity 2) | `manage_connectors` |
| `apps/web/src/app/api/connectors/[id]/transfer/route.ts:83` | transfer a connector (both teams) | owner, admin (oddity 1) | admin (route policy, oddity 2) | `manage_connectors` |
| `apps/web/src/app/api/evidence-backends/route.ts:56` | create a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/route.ts:56` | edit a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/route.ts:99` | delete a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/app/api/evidence-backends/[id]/verify/route.ts:34` | verify a backend | owner, admin | admin | `manage_evidence_backends` |
| `apps/web/src/lib/experiments.ts:48` | `isExperimentAdmin`: create/start/pause/conclude, see admin-only | owner, admin | admin (`apps/web/src/lib/experiment-access.ts:72`) | `run_experiments` |

### Oddities, reproduced not fixed

1. **Absent membership passes.** The connector and migration helpers named
   isTeamAdmin return `membership?.role !== 'member'`, so a user with no
   membership row in the team passes. The routes scope `teamId` to the user's
   teams first, so in practice only the personal team reaches this — which the
   registry also treats as owned — but the helpers themselves fail open.
2. **Connector key level is enforced upstream.** The connector routes do no
   level check for API keys; the token-scope route policy requires the `admin`
   scope for connector writes. The registry records `admin`; a migration that
   moves the check into the route must confirm legacy (unscoped) keys are held
   to admin there too.
3. **Force-reassign for any key.** A session needs owner/admin to force a
   reassign, but any API key with access to the workspace may — including
   `trigger` keys. Reproduced as minimum level `trigger`.
4. **Personal-team fallback is uneven.** Sites built on
   `getUserAdminTeamIds` or the settings context treat the personal team as
   owned; sites that read the membership row directly (team settings, chat
   retro, members, invitations, evidence backends, experiments) do not. The
   registry always applies the fallback, so migrating a direct-read site adds
   it — harmless today because a personal team's owner has an owner row, but a
   reviewer should know.
5. **Artifacts widen an API key to its team owner's teams.**
   `apps/web/src/app/api/artifacts/route.ts:30` lists artifacts across every
   team the API key's team owner belongs to. That is reach, not a permission,
   so it is not in the registry; noted because it reads `role = 'owner'`.
6. **Writes with no role gate.** For a session, these need only membership:
   deleting an API key (`apps/web/src/app/api/accounts/[id]/route.ts`), editing
   or deleting a connector, deleting a memory, secrets other than the team
   model key, a workspace's name/repo/branch, and the mission, task, schedule
   and skill admin routes (those hold API keys to admin, but not sessions).
   They are not permission decisions today, so they are not in the registry.
7. **Owner-only where admin may be intended.** Deleting a workspace (an admin
   gets 404) and changing any member's role (an admin cannot even move
   member↔admin) are owner-only. Reproduced as `delete_workspace` and
   `assign_team_owner`.
8. **Three ways a key counts as admin.** Token-scope policy
   (`hasTokenRouteAdminAccess`, scope-aware), a raw `level` read (chat retro,
   AI budget, evidence backends, experiments), and a hand-built scope map
   (memory review). `can` reads `level` only, so a migrating call site keeps
   doing whatever scope-to-level mapping it does today.
