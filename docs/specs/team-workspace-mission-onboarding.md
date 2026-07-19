---
title: Team / Workspace / Mission Onboarding
status: active
owner: max
last_verified: 2026-07-18
supersedes: []
---
# Team → Workspace → Mission Onboarding

Capabilities the dashboard must fulfill for a user to take a freshly-created
team from empty to a running mission against a repo. Covers two entry use cases
that are currently confusing or unsupported in the UI:

1. **Connect an existing repo** into a team as a new workspace.
2. **Create a brand-new repo** for a team (workspace + GitHub repo in one flow).

Status legend: ✅ implemented · ⚠️ partial (backend exists, UI gap) · ❌ missing.

Model recap (from `packages/core/db/schema.ts`): `teams` own `workspaces`
(`workspaces.teamId`) and `missions` (`missions.teamId`). A workspace optionally
links a repo via `workspaces.githubRepoId` + `workspaces.githubInstallationId`.
A mission optionally targets a workspace via `missions.workspaceId` (nullable).
The repo always lives at the **workspace** level — missions never own or create
repos.

---

## Connect existing repo as a new workspace ✅

**Capability statement**: A user MUST be able to create a workspace in a chosen
team by selecting one or more repos from a connected GitHub installation, or by
pasting a repo URL, in a single form submission.

**Invariants**:
- A created workspace MUST belong to exactly one team (`workspaces.teamId` set).
- When a repo is selected from a GitHub installation, the workspace MUST persist
  both `githubRepoId` and `githubInstallationId` (not just the plain `repo` URL),
  so the workspace can later open PRs.
- Multi-select MUST create one workspace per repo, each named after its repo.

**Acceptance criteria**:
- AC-1: GIVEN a configured GitHub App with ≥1 installation, WHEN the user opens
  `/app/workspaces/new`, THEN a repo picker lists repos for the selected
  installation and a "enter repository URL manually" fallback is present.
- AC-2: WHEN the user selects a single repo and submits, THEN `POST /api/workspaces`
  is called with `{ repoUrl, githubRepo, githubInstallationId, teamId, accessMode }`
  and the new workspace row has non-null `githubRepoId` and `githubInstallationId`.
- AC-3: GIVEN ≥2 repos selected, WHEN the user submits, THEN one workspace is
  created per repo and a per-repo error list is shown for any that fail.
- AC-4 (error): GIVEN no team is resolvable, WHEN submitting, THEN the workspace
  is still created under the user's personal team (slug `personal-*`).
- AC-5 (error): WHEN `POST /api/workspaces` rejects, THEN the inline error region
  renders the API `error` string and no navigation occurs.

**Code surface**:
- UI: `apps/web/src/app/app/(protected)/workspaces/new/page.tsx`, `RepoPicker.tsx`
- Route: `apps/web/src/app/api/workspaces/route.ts` (POST)
- Teams source: `apps/web/src/app/api/teams/route.ts`
- Model: `packages/core/db/schema.ts` (`workspaces`, `teams`, `githubRepos`)

**Out of scope**: GitHub App installation/OAuth (see `/api/github/install`).

---

## Team selection during workspace creation ⚠️

**Capability statement**: When a user belongs to more than one team, the New
Workspace form MUST let them choose which team owns the workspace; the team they
"just created" MUST be selectable.

**Invariants**:
- The team selector MUST render whenever `userTeams.length > 1`.
- The default selected team MUST be deterministic (personal team first, else the
  first team returned).

**Acceptance criteria**:
- AC-1: GIVEN a user in 2+ teams, WHEN `/app/workspaces/new` loads, THEN a Team
  dropdown lists every team from `GET /api/teams` and submission includes the
  chosen `teamId`.
- AC-2: GIVEN a user in exactly 1 team, WHEN the form loads, THEN no Team
  selector renders and the workspace is created under that single team.
- AC-3 (gap): GIVEN a user arrives from a specific team's page, WHEN the form
  loads, THEN the Team selector MUST pre-select that team. *(Currently the form
  always defaults to the personal team regardless of entry context — see
  `workspaces/new/page.tsx` `loadTeams()`.)*

**Code surface**:
- UI: `apps/web/src/app/app/(protected)/workspaces/new/page.tsx` (`userTeams`,
  `selectedTeamId`, `loadTeams`)
- Route: `apps/web/src/app/api/teams/route.ts`

**Out of scope**: Team creation and membership management.

---

## Create a brand-new repo for a team ✅

**Capability statement**: A user MUST be able to create a new GitHub repository
for a team and link it to a workspace from the dashboard, without leaving the app
or using the CLI/MCP.

**Invariants**:
- Repo creation MUST go through the workspace's linked GitHub installation
  (`workspace.githubInstallationId`) or an installation matched by `org`.
- On success the workspace MUST be updated with `repo`, `githubRepoId`, and the
  `githubRepos` row MUST be upserted.
- If the GitHub App is not configured, the system MUST reject with a 422 and a
  hint to use `gh repo create` + link via update.

**Acceptance criteria**:
- AC-1: GIVEN a workspace with a linked installation, WHEN `POST /api/workspaces/[id]/create-repo`
  is called with `{ name, org?, private?, description? }`, THEN a repo is created
  (with `auto_init`) and `{ repoUrl, fullName }` is returned.
- AC-2: GIVEN GitHub App not configured, WHEN create-repo is called, THEN it
  rejects with HTTP 422 and a `hint` field.
- AC-3: GIVEN a workspace with no installation and no matching `org`, WHEN
  create-repo is called, THEN it rejects with HTTP 422.
- AC-4: WHEN a user picks "Create new repo" mode on `/app/workspaces/new`, THEN
  the form collects name + GitHub account + visibility + description, creates a
  workspace shell, and calls `create-repo`; a failed `create-repo` reuses the
  same workspace on retry (no duplicate). *(Implemented in `workspaces/new/page.tsx`.)*
- AC-5: GIVEN a personal (User) GitHub installation, WHEN create-repo runs, THEN
  it targets `POST /user/repos` (not `/orgs/{org}/repos`). *(Fixed — endpoint is
  chosen by `installation.accountType`.)*

**Code surface**:
- Route: `apps/web/src/app/api/workspaces/[id]/create-repo/route.ts`
- MCP parity: `manage_workspaces action=create_repo` in `packages/core/mcp-tools.ts`
- Model: `packages/core/db/schema.ts` (`workspaces`, `githubRepos`, `githubInstallations`)

**Out of scope**: Org-level GitHub App permission grants (a known failure mode —
the App must have repo-creation permission for the target org).

---

## No-repo workspace with deferred repo linking ⚠️

**Capability statement**: A user MUST be able to create a workspace with no repo
and link a repo (new or existing) to it later from the UI.

**Invariants**:
- A no-repo workspace MUST be creatable (repo fields nullable in schema).
- Linking a repo via update MUST populate `githubRepoId`/`githubInstallationId`,
  not only the `repo` URL string.

**Acceptance criteria**:
- AC-1: WHEN `POST /api/workspaces` is submitted with no `repoUrl`, THEN a
  workspace is created with null repo fields.
- AC-2: GIVEN a no-repo workspace, WHEN its repo is set via update with a GitHub
  repo, THEN `githubRepoId` is populated so `create_pr` succeeds. *(Regression
  fixed in PR #757 — auto-link `githubRepoId` on `repoUrl` update.)*
- AC-3 (UI gap): GIVEN a no-repo workspace detail page, WHEN the user opens it,
  THEN a "Link repo" / "Create repo" affordance MUST be present.

**Code surface**:
- Route: `apps/web/src/app/api/workspaces/[id]/route.ts` (PATCH), `create-repo/route.ts`
- UI: `apps/web/src/app/app/(protected)/workspaces/[id]/`

**Out of scope**: Runner directory provisioning for no-repo workspaces.

---

## Create a mission within a team ✅ (workspace targeting ⚠️)

**Capability statement**: A user MUST be able to create a mission scoped to a
team from the dashboard with at minimum a title; the mission MAY target a
workspace and MAY carry a schedule.

**Invariants**:
- A mission MUST belong to a team (`missions.teamId`); `workspaceId` is optional.
- An `active` mission MUST auto-start an organizer planning task unless heartbeat
  is disabled.
- A mission with a `cronExpression` MUST create a backing task schedule.

**Acceptance criteria**:
- AC-1: WHEN the user submits `/app/missions/new` with a title, THEN `POST /api/missions`
  creates the mission and redirects to `/app/missions/[id]`.
- AC-2: GIVEN a `cronExpression` is set, WHEN the mission is created, THEN a
  schedule is created and the UI previews the next runs.
- AC-3 (error): WHEN `POST /api/missions` rejects, THEN the inline error renders
  and no redirect occurs.
- AC-4 (UI gap): The workspace picker is hidden under "Advanced options" and is
  optional, so a mission can be created with no workspace and therefore no repo
  to act on. WHEN a team has ≥1 workspace AND the mission description implies
  code delivery, THEN mission creation SHOULD surface the workspace target
  prominently (not buried) so the mission has a repo.
  *(See `NewMissionForm.tsx` — `WorkspaceDropdown` lives behind `showAdvanced`.)*
- AC-4b (documented behavior): A workspace-less mission (`workspaceId = null`)
  is intentionally valid for personal-agent missions (e.g., finance tracking,
  email triage, annual-cycle planning). For these missions:
  - `workingBranch` and `primaryPrUrl` are always null — expected, not broken.
  - Health shows "no tasks" when all activity is coordination-only — expected.
  - Each task the mission creates MUST carry an explicit `workspaceId`; there
    is no automatic inference from the mission to its tasks.

**Code surface**:
- UI: `apps/web/src/app/app/(protected)/missions/new/NewMissionForm.tsx`
- Route: `apps/web/src/app/api/missions/route.ts` (POST)
- Model: `packages/core/db/schema.ts` (`missions`, `taskSchedules`)

**Out of scope**: Organizer planning behaviour and task generation.

---

## Cross-cutting: discoverability of the onboarding path ✅

**Capability statement**: From a newly-created team with no workspaces, the UI
MUST present a clear path to "add a repo" (connect existing OR create new) before
a mission can do useful work.

**Acceptance criteria**:
- AC-1: GIVEN a team with zero workspaces, WHEN the user views the Settings
  Workspaces section, THEN it MUST render a header with a "+ New Workspace" link
  and an empty state linking to `/app/workspaces/new` that explains workspace =
  repo. *(Implemented — `settings/page.tsx` Workspaces section no longer hides
  when empty.)*
- AC-2: GIVEN the New Workspace form, WHEN the user has no GitHub App connected,
  THEN a "Connect GitHub" call-to-action MUST be shown (exists today via
  `/api/github/install`).
- AC-3: GIVEN the user wants a new repo, WHEN on the New Workspace form, THEN a
  visible "Create new repo" mode toggle MUST exist. *(Implemented.)*

**Code surface**:
- UI: `apps/web/src/app/app/(protected)/workspaces/page.tsx` (`+ New Workspace`),
  `workspaces/new/page.tsx`

**Out of scope**: Marketing/first-run tour.
