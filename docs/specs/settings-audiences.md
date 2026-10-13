---
title: Settings Audiences
status: active
owner: max
last_verified: 2026-10-12
summary: Every setting MUST live on the page of whose it is (you, the team, one workspace), show a member one read-only line instead of controls, and never surface platform-operator machinery to a team.
domain: surfaces
surfaces: [apps/web/src/lib/settings-nav.ts, apps/web/src/app/app/(protected)/settings/_lib/settings-permissions.ts, apps/web/src/app/app/(protected)/settings/_components/SettingsPage.tsx, apps/web/next.config.mjs]
related: [team-permissions, mcp-connectors-and-roles, model-tier-ceilings, settings-models]
keywords: [settings ia, You, Team, read-only, Managed by your team admins, member view, admin view, operator view, route moves, SETTINGS_ROUTE_MOVES, Leave team, My maximum, Pause new starts, Deploy access, Repeat work, Agents page]
verified_by: [apps/web/src/lib/settings-nav.test.ts, apps/web/src/lib/settings-route-moves.test.ts, apps/web/src/app/app/(protected)/settings/_lib/settings-permissions.test.ts, apps/web/src/app/app/(protected)/settings/_components/SettingsPage.test.tsx, apps/web/src/app/app/(protected)/settings/team/no-grant-table.test.ts, apps/web/src/app/app/(protected)/settings/account/YourTeams.dom.test.tsx, apps/web/src/app/app/(protected)/settings/models/MyMaximumSection.dom.test.tsx, apps/web/src/app/app/(protected)/settings/models/page.test.ts, apps/web/src/app/app/(protected)/settings/agents/[slug]/edit/read-only.test.tsx, apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/PauseStartsSection.dom.test.tsx, apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/SubjectPolicySection.dom.test.tsx, apps/web/src/app/app/(protected)/health/member-scope.test.ts, apps/web/src/app/api/tasks/[id]/start/route.test.ts]
supersedes: []
---

# Settings Audiences

Settings has three audiences and one hidden one. **You**: the signed-in
person. **Team members** and **team admins** (owners and admins): the team's
shared settings, which a member reads and an admin changes. The **platform
operator** (whoever runs buildd, `team-permissions` § Platform operator) is not
a settings audience: operator machinery never becomes a team page.

Who may change what is `team-permissions`' contract. This spec is where each
thing lives and what each audience sees there.

## Placement

**Capability statement**: A setting MUST live on the page of whose it is:
yours under You, the team's under Team, one workspace's on that workspace's
page.

**Invariants**:
- `SETTINGS_NAV` (`apps/web/src/lib/settings-nav.ts`) is the one source for
  the desktop sub-nav, the phone index, the phone header's title and back link
  and the legacy anchor redirects. It has exactly two groups, You (`scope:
  'you'`) then Team (`scope: 'team'`); a group is a label, not a page.
- Every section is its own route with a `page.tsx`, so it is linkable.
- **You** holds what only the person sees and changes: Profile (including
  **Leave team** for each shared team), Keys (their own model keys and **My
  maximum**, the highest tier their own work may use), Notifications, and
  Connected apps (only the apps signed in to buildd as them).
- **Team** holds what the whole team shares, Members first: Members, Agents,
  Billing and budgets, Models, Workspaces, Runners, Alerts, Integrations,
  Apps (the team's connectors and agent access), Features.
- A setting that belongs to one workspace is on that workspace's settings page
  (`/app/settings/workspace/[workspaceId]`), not on a team page or on Health:
  the concurrency cap, **Pause new starts** (under Where work runs) and
  **Repeat work**. Health › Runners only shows that a workspace is paused.
- A page that moved keeps resolving at its old path through a non-permanent
  redirect in `SETTINGS_ROUTE_MOVES` (`apps/web/next.config.mjs`), and the old
  `page.tsx` is gone, so one concern never renders twice.

**Acceptance criteria**:
- AC-L1: WHEN `SETTINGS_NAV` is read THEN its groups are You then Team, every
  item's href has a `page.tsx`, and ids and hrefs are unique.
- AC-L2: WHEN a person opens You › Keys THEN My maximum is there, and Settings
  › Models renders no My maximum section.
- AC-L3: GIVEN a shared team WHEN a person opens Profile THEN it offers Leave
  for that team; GIVEN their personal team THEN it offers no Leave; GIVEN they
  are the last owner THEN Leave is disabled with the reason.
- AC-L4: WHEN anyone requests `/app/settings/roles`, `/app/settings/roles/<any
  path>`, `/app/team` or `/app/settings/connectors` THEN they are redirected to
  the matching `/app/settings/agents…` or `/app/settings/apps` path.
- AC-L5: WHEN Health › Runners renders a paused workspace THEN it shows the
  pause and offers no control to pause or resume; the workspace settings page
  does.

## What a member sees

**Capability statement**: A team page MUST show a viewer without the
permission to change it the values as text under one line, never disabled
editors or controls they cannot use.

**Invariants**:
- Each Team item names the permissions behind its controls (`manage`); a You
  item names none. A viewer holding none of a page's `manage` permissions in
  the team sees it read-only (`settingsReadOnly`).
- A read-only team page says so once, at the top, in `TEAM_MANAGED_LINE`
  ("Managed by your team admins."). Nothing else on it explains permissions.
- A read-only section renders its values as text: Deploy access (an agent's
  deploy rights) is one line naming the workspaces it may deploy from; Repeat
  work is its value, not a switch.
- A control whose action the viewer would be refused is not rendered. The
  task start refusal for a full workspace carries `canRaiseCap` (from
  `manage_workspace_settings`), and the "raise the workspace limit" control
  renders only when it is true.
- The flags come from `settingsPermissions`, which reads `roleHas`; a personal
  team counts as owned. No page reads a per-team grant (`team-permissions`
  § No per-team grants).

**Acceptance criteria**:
- AC-M1: GIVEN a `member` WHEN they open any Team section THEN it is
  read-only and `TEAM_MANAGED_LINE` is shown once; GIVEN an `admin` THEN it is
  editable and the line is absent.
- AC-M2: GIVEN a `member` WHEN they open an agent's edit page THEN Deploy
  access is one plain line with no editor; GIVEN an `admin` THEN the team
  limit and workspace grants save.
- AC-M3: GIVEN a caller without `manage_workspace_settings` WHEN a start is
  refused with `workspace_cap_reached` THEN `canRaiseCap` is false; GIVEN an
  admin THEN it is true.
- AC-M4: GIVEN a `member` WHEN they open Settings › Members THEN no
  permission grant table renders.

## What stays out of team settings

**Capability statement**: Platform-operator machinery MUST NOT appear on any
team page, and team-facing copy MUST NOT name the operator.

**Invariants**:
- An operator-only control (model traffic pools, the decision model, soak
  timing, `overCapAuto`, experiments, decision shadows, per-feature AI modes,
  chat retro) renders only after the operator check
  (`isPlatformOperator` / `isPlatformOperatorCaller`), never after a team
  permission. For a team admin, Models shows each tier's primary model and an
  Automatic or Manual upgrade policy, nothing more.
- Health › Operator is the operator's one page in the app. It is
  `operatorOnly` in `HEALTH_NAV`, absent from `SETTINGS_NAV`, and its page
  calls `requirePlatformOperator`.
- No rendered settings copy names the platform operator, and no source names
  a separate admin site: a team member cannot learn from the product that one
  exists. Code comments may say "platform operator" where they explain a gate.
- In product copy, "role" means a person's team role (owner, admin, member).
  An agent role (`workspace_skills.is_role`) is an **agent**, on the Agents
  page.

**Acceptance criteria**:
- AC-O1: GIVEN a team owner who is not an operator WHEN they open Settings ›
  Models THEN no pool, decision-model, soak or over-maximum control renders.
- AC-O2: WHEN Health's sub-nav is built for a non-operator THEN Operator is
  not in it, and the page refuses them.
- AC-O3: WHEN an agent's edit page renders for any viewer THEN its text never
  names the platform operator.

## Code surface

- `apps/web/src/lib/settings-nav.ts`: `SETTINGS_NAV`, `TEAM_MANAGED_LINE`,
  `settingsReadOnly`, `settingsItemFor`, `settingsBackHref`.
- `apps/web/src/app/app/(protected)/settings/_lib/settings-permissions.ts`:
  `settingsPermissions`, `permsInAnyTeam`.
- `apps/web/src/app/app/(protected)/settings/_components/SettingsPage.tsx`:
  the read-only line.
- `apps/web/next.config.mjs`: `SETTINGS_ROUTE_MOVES`.
- `apps/web/src/lib/nav-config.tsx`: `HEALTH_NAV` (`teamAdminOnly`,
  `operatorOnly`).
- `apps/web/src/app/app/(protected)/settings/account/YourTeams.tsx`: Leave.
- `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/PauseStartsSection.tsx`,
  `SubjectPolicySection.tsx`.
- `apps/web/src/app/app/(protected)/settings/agents/[slug]/edit/OperatorAccessSection.tsx`:
  Deploy access.
- `apps/web/src/app/api/tasks/[id]/start/route.ts`: `canRaiseCap`.

## Out of scope

- Who holds each permission: `team-permissions`.
- What the Models page computes and stores: `settings-models`,
  `model-tier-ceilings`.
- Team apps and agent access behaviour: `mcp-connectors-and-roles` § 5c.
