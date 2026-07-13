# Work-tracker integration

> **Status: partially shipped — this doc makes it first-class + multi-provider.**
>
> **What already exists** (`dev`): workspace `workTrackerConfig`, mission-create
> note, PR-merge → Linear comment/transition (github webhook →
> `postLinearCompletionComment`), `externalIssueId`/`externalIssueUrl` on tasks +
> missions, and (PR #1195) the ability to set those via task/mission PATCH.
>
> **Decisions (locked, from product 2026-07-12):**
> 1. **GitHub uses the existing GitHub App installation** (`workspaces.githubInstallationId`),
>    NOT a connector. `workTrackerConfig.connectorId` is optional when
>    `provider='github'`. Linear continues via its connector (OAuth).
> 2. **Bidirectional webhooks**: outbound (buildd → tracker, exists) PLUS inbound
>    (tracker → buildd: labeled issue creates a task, closed issue cancels it).
>
> **Sequencing:** Step 1 = first-class **outbound** for Linear + GitHub (provider
> abstraction). Step 2 = **inbound** webhooks + config/status UI.
>
> **Sources of truth read first:**
> - `apps/web/src/lib/work-tracker.ts` — current Linear-only outbound helpers
> - `apps/web/src/app/api/github/webhook/route.ts` — `maybePostWorkTrackerIssueUpdate`
>   (Linear-only dispatch), `verifyWebhookSignature`, issue/PR event handling
> - `apps/web/src/lib/github.ts` — `githubApi(installationId, path, opts)`,
>   `getInstallationToken`, `verifyWebhookSignature`
> - `packages/core/db/schema.ts` — `WorkspaceWorkTrackerConfig` (366),
>   `workspaces.githubInstallationId`, `tasks/missions.externalIssueId/Url`

---

## 1. Config model (provider-agnostic)

**Capability statement**: A workspace MAY designate exactly one work tracker; the
config identifies a provider and how to reach it, and MUST be valid for that
provider before it is stored.

**Invariants**:
- `workTrackerConfig = { provider: 'linear' | 'github', connectorId?: string }`.
- `provider='linear'` MUST have a `connectorId` that (a) belongs to the
  workspace's team and (b) is enabled for the workspace.
- `provider='github'` MUST NOT require a `connectorId`; it resolves the
  workspace's `githubInstallationId`. If the workspace has no GitHub App
  installation, the config is rejected.
- `provider` is validated against the known set; unknown providers rejected.

**Acceptance criteria**:
- AC-1: GIVEN `provider='github'` and the workspace has a GitHub installation
  WHEN `PATCH /settings` with no `connectorId` THEN `200` and config stored.
- AC-2: GIVEN `provider='github'` and NO GitHub installation WHEN set THEN `400`
  (`github_app_not_installed`).
- AC-3: GIVEN `provider='linear'` and no `connectorId` WHEN set THEN `400`.
- AC-4: GIVEN an unknown provider WHEN set THEN `400` (`unsupported_provider`).

**Code surface**: `apps/web/src/app/api/workspaces/[id]/settings/route.ts`;
`WorkspaceWorkTrackerConfig` in `packages/core/db/schema.ts`.

---

## 2. Provider abstraction (Step 1 — outbound)

**Capability statement**: Outbound tracker updates MUST route through a single
`WorkTrackerProvider` interface dispatched by `workTrackerConfig.provider`; adding
a provider MUST NOT touch the webhook or task/mission lifecycle code.

**Invariants**:
- The interface exposes at least `postCompletionUpdate({ issueRef, prUrl, merged })`
  — posts a comment and transitions/closes the linked issue.
- `linear` provider: sources the OAuth token from its connector
  (`mcp_connector_credential`, owner-team keyed) and calls the Linear GraphQL API
  (existing `postLinearCompletionComment` logic, moved behind the interface).
- `github` provider: resolves the workspace's numeric installation id and calls
  `githubApi(installationId, …)` — `POST /repos/{owner}/{repo}/issues/{n}/comments`
  then `PATCH /repos/{owner}/{repo}/issues/{n}` `{ state: 'closed' }` on merge.
  The issue `{owner, repo, number}` is parsed from the task's `externalIssueUrl`
  (a `https://github.com/{owner}/{repo}/issues/{n}` URL); if it cannot be parsed,
  the update is skipped (never throws).
- All provider calls are best-effort: network/API errors are logged, never
  re-thrown into the webhook path.

**Acceptance criteria**:
- AC-1: GIVEN a merged PR whose task has `externalIssueUrl` on a GitHub-tracked
  workspace WHEN the webhook fires THEN a comment is posted and the issue is
  closed via `githubApi`, using the workspace installation (no connector token).
- AC-2: GIVEN a Linear-tracked workspace WHEN a PR merges THEN behaviour is
  unchanged from today (comment + transition to Done).
- AC-3: GIVEN a GitHub-tracked task whose `externalIssueUrl` is unparseable WHEN
  the webhook fires THEN no API call is made and the webhook returns normally.
- AC-4: GIVEN the provider API returns an error WHEN the webhook fires THEN the
  webhook still completes (error swallowed + logged).

**Code surface**: `apps/web/src/lib/work-tracker.ts` (provider interface +
`linear`/`github` impls); `apps/web/src/app/api/github/webhook/route.ts`
(`maybePostWorkTrackerIssueUpdate` → dispatch by provider).

**Out of scope (Step 1)**: creating issues from tasks; mission→project linking
beyond the existing note; providers other than linear/github.

---

## 3. Inbound webhooks (Step 2)

**Capability statement**: A tracker issue labeled with the workspace's configured
label MUST create a buildd task linked to that issue; closing the issue MUST
cancel the linked task (if still open).

**Invariants**:
- **GitHub** inbound reuses the existing webhook route (`issues` events:
  `labeled`, `closed`), gated on the repo's workspace having
  `workTrackerConfig.provider='github'`. Signature verified via
  `verifyWebhookSignature`.
- **Linear** inbound uses a new route `POST /api/webhooks/linear` with a
  per-workspace webhook secret (stored in `secrets`, `purpose='webhook_token'`),
  verifying Linear's signature.
- Task creation is idempotent per `(workspace, externalIssueId)` — a second
  `labeled` event for the same issue does not create a duplicate task.
- The created task is linked (`externalIssueId`/`externalIssueUrl` set) so the
  outbound path (§2) closes the loop on completion.
- `closed`/canceled issue → the linked task is cancelled only if not terminal.

**Acceptance criteria**:
- AC-1: GIVEN a GitHub issue labeled `buildd` in a github-tracked workspace WHEN
  the webhook fires THEN one task is created, linked to the issue.
- AC-2: GIVEN the same labeled event delivered twice THEN exactly one task exists.
- AC-3: GIVEN a linked issue is closed WHEN the webhook fires THEN the open linked
  task is cancelled; a completed task is left unchanged.
- AC-4: GIVEN an invalid webhook signature THEN `401` and no task mutation.

**Code surface**: `apps/web/src/app/api/github/webhook/route.ts` (issues events);
`apps/web/src/app/api/webhooks/linear/route.ts` (new); workspace config UI
(`WorkTrackerSection.tsx`) for label + inbound status.

**Out of scope**: syncing arbitrary field edits; comment mirroring; providers
beyond linear/github.
