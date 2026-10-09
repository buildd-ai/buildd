---
title: GitHub Repository Access Remediation
status: active
owner: max
last_verified: 2026-10-08
summary: When Buildd's GitHub App cannot act on a workspace's existing repo, every PR door MUST refuse with a typed reason and fix, surface it once to whoever can fix it, and resume the waiting task once access is verified.
domain: integrations
surfaces: [apps/web/src/lib/github-repo-access.ts, apps/web/src/lib/github-repo-access-store.ts, apps/web/src/lib/github-repo-access-gate.ts, apps/web/src/app/api/workspaces/[id]/github-access/route.ts]
related: [pr-lifecycle-reconciliation, webhook-dataflow, team-permissions, mcp-action-contracts]
keywords: [Workspace not linked to GitHub repo, github_repo_access_required, Repository access required, Connection required, Check connection, Grant GitHub access, Ask a GitHub administrator, repository_selection, Resource not accessible by integration, githubAccessBlock, installation suspended]
verified_by: [apps/web/src/lib/github-repo-access.test.ts, apps/web/src/lib/github-repo-access-store.test.ts, apps/web/src/app/api/github/pr/route.test.ts, apps/web/src/app/api/workspaces/[id]/github-access/route.test.ts, apps/web/src/app/api/github/webhook/route.test.ts, apps/web/src/app/api/github/callback/route.test.ts, apps/web/src/lib/action-queue.test.ts, apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/RepoAccessCard.dom.test.tsx]
supersedes: []
assertions:
  - id: "diagnose-repo-access"
    type: "symbol"
    name: "diagnoseRepoAccess"
    path: "apps/web/src/lib/github-repo-access.ts"
  - id: "repo-access-error-body"
    type: "symbol"
    name: "repoAccessErrorBody"
    path: "apps/web/src/lib/github-repo-access.ts"
  - id: "pr-doors-gate-on-repo-access"
    type: "symbol_reachable"
    symbol: "ensureRepoAccessForPr"
    entry: "apps/web/src/app/api/github/pr/route.ts"
    as: "call"
  - id: "resume-after-installation-change"
    type: "symbol_reachable"
    symbol: "resumeAfterInstallationChange"
    entry: "apps/web/src/app/api/github/webhook/route.ts"
    as: "call"
  - id: "check-connection-route"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/github-access"
    file: "apps/web/src/app/api/workspaces/[id]/github-access/route.ts"
  - id: "repo-access-tests"
    type: "test_file"
    path: "apps/web/src/lib/github-repo-access.test.ts"
---
# GitHub Repository Access Remediation

**Capability statement**: When Buildd's GitHub App cannot act on a workspace's
**already-existing** repository, create_pr, get_pr, merge_pr and update_pr MUST
refuse with a typed reason that names the unmet requirement and the person who
can fix it; the ask MUST reach the workspace's admins once rather than every
agent and member; and a task refused for it MUST resume by itself once access
is verified, without a second PR and without ever creating a repository.

---

## Why

`create_pr` used to answer every one of these states with "Workspace not linked
to GitHub repo", and part of that guard read the legacy
`workspaces.github_installation_id` column (see `pickWorkspaceInstallationId`
for why that column is unreliable), so a workspace that could open the PR was
sometimes refused too. Agents then asked people to "create the repo", or a
person opened the PR with their own credential.

## Reasons

`diagnoseRepoAccess` judges facts loaded from the existing
`github_installations` / `github_repos` mirror — no second store — through the
same team-ownership rule as `syncInstallationRepos`. An installation another
team owns is never borrowed.

| reason | meaning | title | fix |
|---|---|---|---|
| `repo_not_selected` | installation on the owner exists, its selected-repos list leaves this repo out | Repository access required | GitHub installation settings |
| `workspace_not_linked` | a synced repo row under a team installation covers it; the workspace was never linked | Connection required | healed in place / Check connection |
| `installation_suspended` | the installation is suspended | Repository access required | GitHub installation settings |
| `permission_missing` | installation lacks the operation's permission (Pull requests, or Contents for merge) | Repository access required | accept the permission request |
| `app_permission_missing` | the App itself never requests it | Repository access required | deployment operator |
| `repo_not_found` | installation sees all repos; this one is not among them (renamed, moved, absent) | Repository access required | check the name, Check connection |
| `installation_missing` | no installation this team owns covers the owner | Repository access required | install the App |
| `no_repo` / `app_not_configured` | no repo declared / no App on this server | Connection required | choose a repo / operator |

**Invariants**

- A refusal MUST NOT tell anyone to create a repository; no reason maps to the create-repo route.
- GitHub links MUST come from a real installation row (installation id, account login and type) or from the App identity GitHub returns for `GET /app`. With neither there is no link; an org name or App slug is never guessed.
- "Grant GitHub access" MUST be offered only when Buildd has evidence the person can change it on GitHub: they installed that installation, or it is on their own personal account (`users.github_id` = installation account id). A Buildd team role is not evidence. Everyone else gets "Ask a GitHub administrator" with copyable instructions naming the repo and the link.
- Check connection MUST require `manage_workspace_settings` (or an admin-level key of the workspace's team); reading the diagnosis requires team membership.
- A refused write MUST stamp `tasks.context.githubAccessBlock`; a refused read (get_pr) MUST NOT.
- Resume MUST re-verify access for `pr.create` first, MUST flip only tasks still `failed`, and MUST stamp `resumedAt` in the same UPDATE, so a repeated webhook or callback re-queues nothing.
- Buildd MUST NOT open the PR with a runner's personal token or gh CLI. The explicit, audited alternative is a person opening it and the agent recording it via create_pr `prUrl` (adoption, which needs no App access and is logged as `pr.adopt`).

**Acceptance criteria**

- AC-1: GIVEN a workspace linked to a repo whose installation is live and holds Pull requests: write, but whose legacy installation column is NULL WHEN create_pr is called THEN the PR is opened (no refusal).
- AC-2: GIVEN a synced repo row under a team-owned installation and an unlinked workspace naming it WHEN create_pr is called THEN the workspace is linked and the PR is opened.
- AC-3: GIVEN an installation on the owner with `repository_selection = selected` excluding the repo WHEN create_pr is called THEN it returns HTTP 409 with `code: github_repo_access_required`, `reason: repo_not_selected`, a `remediation` and `agentGuidance`, and makes no GitHub call.
- AC-4: GIVEN GitHub answers the PR create with 403 "Resource not accessible by integration" WHEN create_pr is called THEN it returns HTTP 409 with `reason: permission_missing` instead of a 500.
- AC-5: GIVEN a second task in the same workspace is refused while the first still waits WHEN create_pr is called THEN the body carries `alreadyReported: true`.
- AC-6: GIVEN tasks failed waiting on access WHEN `installation_repositories.added`, `installation.created`, `unsuspend` or `new_permissions_accepted` arrives, or the install callback returns THEN `resumeAfterInstallationChange` runs and the tasks go back to `pending` only if access now verifies.
- AC-7: GIVEN the same delivery arrives twice WHEN resume runs again THEN no task is woken a second time.
- AC-8: GIVEN the installation is still suspended or still lacks the permission WHEN resume runs THEN no task is re-queued.
- AC-9: GIVEN a member without `manage_workspace_settings` WHEN they POST `/api/workspaces/[id]/github-access` THEN it returns HTTP 403 and nothing is synced.
- AC-10: GIVEN three tasks in one workspace waiting on access WHEN Home builds Needs You for a workspace admin THEN exactly one FAILED card links to the workspace's GitHub access section; a member who cannot fix it sees none.
- AC-11: WHEN Check connection runs THEN only GET requests go to GitHub (no repository is created).

**Code surface**

- `apps/web/src/lib/github-repo-access.ts` — `diagnoseRepoAccess`, `describeRepoAccessProblem`, `viewerCanGrantOnGitHub`, `installationSettingsUrl`, `appInstallUrl`, `repoAccessErrorBody`, `REPO_ACCESS_ERROR_CODE`.
- `apps/web/src/lib/github-repo-access-store.ts` — `loadRepoAccessFacts`, `resolveWorkspaceRepoAccess`, `recordRepoAccessBlock`, `resumeRepoAccessBlockedTasks`, `resumeAfterInstallationChange`, `checkWorkspaceRepoConnection`, `getRepoAccessView`.
- `apps/web/src/lib/github-repo-access-gate.ts` — `ensureRepoAccessForPr`, `refuseForRepoAccess` (gate `GITHUB_REPO_ACCESS`).
- `apps/web/src/app/api/github/pr/route.ts` — the four PR doors.
- `apps/web/src/app/api/workspaces/[id]/github-access/route.ts` — diagnosis (GET) and Check connection (POST).
- `apps/web/src/app/api/github/webhook/route.ts`, `apps/web/src/app/api/github/callback/route.ts` — sync + resume on installation change.
- `apps/web/src/lib/action-queue.ts` — `buildFailedTaskItems` (one card per workspace, admins only).
- `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/RepoAccessCard.tsx` — the settings card.

**Out of scope**

- Creating repositories (the separate create-repo route, which maps its own 403 to a permission hint).
- Changing GitHub App installations on anyone's behalf; Buildd links to GitHub's page, it does not act there.
- Telling apart a private repo the App was never given from one that does not exist when no team installation covers the owner; GitHub's install page answers both.
- Resuming a worker that is still running or parked on a question; only `failed` tasks are re-queued.
