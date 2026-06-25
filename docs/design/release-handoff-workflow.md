# Release Handoff Workflow — Design Spec

> **Status:** Proposed — review artifact before implementation begins.
> **Task:** d24283d7 · Branch: `buildd/d24283d7-recon-spec-audit-release-code-`

---

## Recon Findings

### Two independent release paths today

There are two distinct release code paths. They can **conflict** for the same workspace.

**Path A — `executeRelease` (workers PATCH, `apps/web/src/lib/release-executor.ts`)**

Triggered when an agent reports `status: 'completed'` to `PATCH /api/workers/[id]`. Runs inside the Vercel serverless runtime.

- Only handles `branch_merge` strategy; returns `skipped` for `workflow_dispatch`/`script`.
- Two sub-paths:
  - **releaseBranch path** (PR #993): looks for an open PR from `releaseBranch → prodBranch`, checks CI, merges it.
  - **worker-branch path**: merges the agent's feature branch directly into `prodBranch` via the GitHub `/merges` API.
- After merging, polls `https://api.vercel.com/v6/deployments` for up to 5 minutes.
- Reads `process.env.VERCEL_TOKEN` (global, single-tenant).
- PR #982: missing `VERCEL_TOKEN` now returns `{ state: 'SKIPPED' }` (unverified) instead of failing hard.
- 8 s pre-poll delay to let Vercel pick up the push; skipped when token absent.
- The 5-min Vercel poll window runs inside a serverless function with a 5-min execution cap — fragile at the boundary.

**Path B — webhook `pull_request.closed` handler (`apps/web/src/app/api/github/webhook/route.ts`)**

Triggered when a worker's PR merges to the default branch. Also runs in the Vercel serverless runtime.

- Dispatches `release.yml` by **hardcoded filename** — does NOT call `resolveReleaseStrategy`.
- Uses `workspace.gitConfig.defaultBranch ?? 'dev'` as the `ref`, ignoring `releaseConfig.ref`.
- Fires for any workspace with `releaseConfig.enabled === true`, regardless of strategy.
- No run readback — fire-and-forget; `runId`/`runUrl` are not persisted anywhere.

**Conflict:** a `branch_merge` workspace with `enabled: true` currently triggers both Path A (merges directly to prod) and Path B (dispatches `release.yml`). This double-fires the release.

---

### Vercel coupling inventory

| Location | Coupling |
|---|---|
| `release-executor.ts:18` | `process.env.VERCEL_TOKEN` (global singleton) |
| `release-executor.ts:30` | `https://api.vercel.com/v6/deployments` REST API |
| `release-executor.ts` | 8 s pre-poll delay (absent when token missing) |
| `release-executor.ts` | `deploy.state !== 'READY' && !== 'SKIPPED'` failure guard |
| `WorkspaceReleaseConfig.deployTarget` | `{ type: 'vercel', projectId?, teamId? }` (JSONB) |
| `health-watcher.ts:154` | `process.env.VERCEL_API_TOKEN` — **different var name** than above |
| `health-watcher.ts:157–173` | `checkProdReleaseHealth` → Vercel REST API via `health-watcher-vercel.ts` |
| `packages/core/db/schema.ts:819` | `watchedProjects.vercelTokenSecretId` (per-row secret) |
| `apps/web/src/instrumentation.ts:1` | `@vercel/otel` import (platform telemetry — not release-related) |

Two distinct Vercel token env vars exist: `VERCEL_TOKEN` (release-executor) and `VERCEL_API_TOKEN` (health-watcher). Both frequently point to the same physical Vercel token. The health watcher already supports per-row token secrets (`vercelTokenSecretId`); the release executor does not.

---

### Other known bugs

- GitHub `/merges` API → "Head does not exist" (404) when branch was already deleted. PR #982 made this a no-op success, but the root cause is buildd doing Git operations on behalf of repos it shouldn't own.
- Webhook Path B hardcodes `release.yml` — breaks for repos with differently-named release workflows.
- No run-ID readback in Path B — no way to track whether the dispatched workflow succeeded.
- `VERCEL_TOKEN` is global: cannot serve `buildd-ai/buildd` and `moa-ops` (different Vercel teams) without credential cross-contamination.

---

## Spec

### 1. Reusable Workflow Contract

All repos call a single `workflow_call` workflow containing all release logic. Individual repos' `release.yml` files are thin wrappers (~10 lines).

**Proposed reusable workflow — `.github/workflows/release-handoff.yml`:**

```yaml
# Proposed home: buildd-ai/.github/.github/workflows/release-handoff.yml
# (or a public repo for cross-org callers like moa-ops)
on:
  workflow_call:
    inputs:
      source_branch:
        type: string
        default: dev
      target_branch:
        type: string
        default: main
      force:
        type: boolean
        default: false
    secrets:
      DEPLOY_TOKEN:      # platform cred — Vercel token, Fly token, etc.
        required: false
      SMOKE_URL:         # URL to GET post-deploy (expects 2xx)
        required: false

jobs:
  merge-gate:
    runs-on: ubuntu-latest
    steps:
      # 1. Assert source CI is green (unless force=true)
      # 2. Assert source is ahead of target (empty-diff guard, bypass with force)

  deploy:
    needs: merge-gate
    steps:
      # 3. Merge source → target (PR merge or direct, repo decides)
      # 4. Trigger platform deploy (Vercel push hook fires automatically on push)

  wait-for-ready:
    needs: deploy
    steps:
      # 5. Poll platform until READY / timeout → fail
      #    Uses DEPLOY_TOKEN from calling repo's secrets

  smoke-check:
    needs: wait-for-ready
    if: inputs.SMOKE_URL != ''
    steps:
      # 6. curl -f SMOKE_URL — 2xx = healthy
```

**Per-repo calling wrapper (10 lines):**

```yaml
# buildd-ai/buildd — .github/workflows/release.yml
on:
  workflow_dispatch:
    inputs:
      force: { type: boolean, default: false }

jobs:
  release:
    uses: buildd-ai/.github/.github/workflows/release-handoff.yml@main
    with:
      source_branch: dev
      target_branch: main
      force: ${{ inputs.force }}
    secrets:
      DEPLOY_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      SMOKE_URL:    ${{ secrets.SMOKE_CHECK_URL }}
```

**Cross-org note:** GitHub `workflow_call` does not work across organizations. For `moa-ops` (different org), publish the reusable workflow in a public repo (e.g. `buildd-ai/release-workflows`) and reference it as `buildd-ai/release-workflows/.github/workflows/release-handoff.yml@main`. Alternatively, copy the file into each org's `.github` repo — acceptable for ≤2 orgs given the file's size.

**DRY invariant:** the reusable workflow is the single source of truth for release logic. Per-repo files contain only inputs and `uses:`. No merge or deploy logic is copy-pasted.

---

### 2. `releaseConfig` Migration

#### New default strategy

All **new** workspaces default to `strategy: 'workflow_dispatch'`. The `effectiveStrategy` function in `packages/core/release-strategy.ts` currently defaults absent `strategy` to `'branch_merge'`. After migration:

```typescript
// packages/core/release-strategy.ts
export function effectiveStrategy(config: WorkspaceReleaseConfig): ReleaseStrategy {
  return config.strategy ?? 'workflow_dispatch'; // was: 'branch_merge'
}
```

This change must happen **after** all existing workspaces have been explicitly set to `'branch_merge'` or migrated to `'workflow_dispatch'` (§6). Flip the default only once the migration is complete.

#### Field-level changes on `WorkspaceReleaseConfig`

| Field | Change |
|---|---|
| `strategy` | Effectively required for new workspaces. `absent` defaults to `branch_merge` until §6 migration completes, then defaults to `workflow_dispatch`. |
| `workflowFile` | Required for `workflow_dispatch`. The scaffold (§5) ensures it exists. |
| `ref` | Required for `workflow_dispatch`. |
| `deployTarget` | **Deprecated** for `workflow_dispatch` workspaces. Platform creds move to GitHub Actions secrets. Retained for legacy `branch_merge` workspaces during the migration window. |
| `releaseBranch` | `branch_merge` only. Retained as-is. |
| `prodBranch` | `branch_merge` only. Retained as-is. |

No DB migration is required — `releaseConfig` is JSONB; fields are added/removed by updating the workspace via `manage_workspaces update releaseConfig`.

#### `branch_merge` deprecation

`branch_merge` is not removed in this iteration. The `executeRelease` code path is retained for the migration window. Once all workspaces have migrated (§6), a separate task removes the `branch_merge` path and the Vercel polling code.

#### Fix webhook Path B

`webhook/route.ts` `pull_request.closed` handler currently hardcodes `release.yml` and ignores `releaseConfig`. Replace it:

1. Call `resolveReleaseStrategy(workspace.releaseConfig)`.
2. Skip if strategy is not `workflow_dispatch` (no double-fire for `branch_merge` workspaces).
3. Use `resolution.strategy.workflowFile` and `resolution.strategy.ref` from the resolved config.
4. After dispatch, record `runId`/`runUrl` in `tasks.releaseResult` (see §4).

---

### 3. Credential Ownership

**Principle:** Platform credentials (Vercel token, Fly API key, etc.) live in the **target repo's** GitHub Actions secrets. buildd holds none.

#### Current state

| Credential | Location | Problem |
|---|---|---|
| `VERCEL_TOKEN` | buildd's Vercel environment (global) | Shared across all workspaces; can't serve multiple Vercel teams |
| `VERCEL_API_TOKEN` | buildd's Vercel environment (global) | Same issue; different name from `VERCEL_TOKEN` |
| `watchedProjects.vercelTokenSecretId` | Per-row encrypted secret | ✅ Already per-repo; use this pattern everywhere |

#### Target state

- `WorkspaceReleaseConfig.deployTarget` is deprecated for `workflow_dispatch` workspaces. Platform creds are passed as `secrets.DEPLOY_TOKEN` from the calling repo's GitHub Actions secrets.
- `VERCEL_API_TOKEN` (health-watcher prod checks) is separate from release creds. It remains in the health-watcher path, resolved via `watchedProjects.vercelTokenSecretId` first, then falling back to the global env. Each watched project for a different Vercel team must set its own `vercelTokenSecretId`.
- `moa-ops` sets its own Vercel token as a GitHub Actions secret in the `moa-ops` repo and as `vercelTokenSecretId` on its `watchedProject` row. buildd's env never holds a `moa-ops`-scoped token.
- After migration: remove `VERCEL_TOKEN` from buildd's Vercel environment. `VERCEL_API_TOKEN` may remain for the health-watcher global fallback, but new watched projects should always set `vercelTokenSecretId`.

#### Implementation steps (non-breaking)

1. Mark `WorkspaceReleaseConfig.deployTarget` as `@deprecated` in JSDoc. No DB migration.
2. In `release-executor.ts`: add a warning log when a `workflow_dispatch` workspace still has `deployTarget` set.
3. The `executeRelease` Vercel polling block already guards on `strategy === 'branch_merge'` (implicit in the early return for non-`branch_merge` strategies). Make this explicit.
4. Document for workspace operators: set `VERCEL_TOKEN` (or equivalent) as a GitHub Actions secret directly on your repo.

---

### 4. What buildd Reads Back

After dispatching a `workflow_dispatch`, buildd must:
1. Record `runId`, `runUrl`, `runStatus` in `tasks.releaseResult`.
2. Gate missions: defer next-task creation until the release run completes.
3. Fire Pushover alert on failure.
4. Support retrigger when the release fails.

#### Read contract

Two mechanisms, in preference order:

**Primary: `workflow_run` webhook**

Add a `workflow_run` event handler to `apps/web/src/app/api/github/webhook/route.ts`. GitHub sends this event when any workflow (including dispatched ones) completes.

```
event: workflow_run
action: completed
payload.workflow_run.id         → runId
payload.workflow_run.conclusion → 'success' | 'failure' | 'timed_out' | ...
payload.workflow_run.html_url   → runUrl
payload.workflow_run.name       → matches releaseConfig.workflowFile
```

Handler logic:
- Match the run to a `tasks.releaseResult` entry by `runId` (set at dispatch time in §2 Path-B fix).
- On `success`: update `releaseResult.status = 'completed'`, set `runConclusion`.
- On `failure`/`timed_out`: update `releaseResult.status = 'failed'`, fire Pushover alert, set mission alert.

**Secondary: poll via `release_status` / mission heartbeat**

The existing `releasePreflight` function and `release_status` MCP action already fetch run status. The mission heartbeat (already runs hourly) can poll `release_status` for workspaces in `pending_ci` state and finalize them.

#### Updated `ReleaseResult` fields (at dispatch time)

```typescript
// tasks.releaseResult immediately after Path-B dispatch:
{
  status: 'pending_ci',    // already defined in ReleaseResult
  runId: number,           // new — GitHub Actions run ID
  runUrl: string,          // new — link to the workflow run
  runStatus: string,       // new — 'queued' | 'in_progress' | 'completed'
  runConclusion: string | null,  // new — null while running; 'success' | 'failure' etc.
  message: string,
}
```

The `runId`, `runUrl`, `runStatus`, and `runConclusion` fields are new additions to `ReleaseResult`. They are populated by the dispatch path and updated by the `workflow_run` webhook.

---

### 5. Scaffolding

New repos created via buildd should arrive release-ready. Today `manage_workspaces action=init` only prints instructions; `create_repo` creates the repo but drops no files.

#### Scaffold trigger points

| Action | Change |
|---|---|
| `manage_workspaces action=create_repo` | After repo creation, push an initial commit containing `.github/workflows/release.yml` |
| `manage_workspaces action=init` | Add optional `releaseSetup: true` parameter; scaffold `release.yml` if the workspace has a linked repo and the file doesn't already exist |

#### What gets scaffolded

A `.github/workflows/release.yml` with the thin `workflow_call` wrapper pattern from §1. The file is committed directly to the repo via the GitHub API (`PUT /repos/{owner}/{repo}/contents/.github/workflows/release.yml`).

#### Auto-configure `releaseConfig`

When scaffolding, also set the workspace `releaseConfig`:
```json
{
  "enabled": true,
  "strategy": "workflow_dispatch",
  "workflowFile": "release.yml",
  "ref": "dev"
}
```

This makes the workspace release-ready immediately without a separate `manage_workspaces update` call.

**Idempotency:** if `.github/workflows/release.yml` already exists (repo was imported, not created by buildd), skip silently. Use the file-exists check via the GitHub API before pushing.

---

### 6. Migration Plan for Existing Release Workspaces

Migration order: lowest-traffic first, `buildd-ai/buildd` last.

---

#### `buildd-ai/buildd`

Current inferred config (check actual via `manage_workspaces action=list`):
```json
{
  "enabled": true,
  "strategy": "branch_merge",
  "releaseBranch": "dev",
  "prodBranch": "main",
  "deployTarget": { "type": "vercel", "projectId": "...", "teamId": "..." }
}
```

Migration steps:
1. Verify `.github/workflows/release.yml` exists. If not, push the scaffold.
2. Add `VERCEL_TOKEN` (scoped to the `buildd-ai` Vercel team) as a **GitHub Actions secret** on the `buildd-ai/buildd` repo.
3. Update `release.yml` to use the `workflow_call` pattern, passing `secrets.VERCEL_TOKEN` as `DEPLOY_TOKEN`.
4. Update workspace `releaseConfig`:
   ```json
   {
     "enabled": true,
     "strategy": "workflow_dispatch",
     "workflowFile": "release.yml",
     "ref": "dev"
   }
   ```
   (Remove `releaseBranch`, `prodBranch`, `deployTarget`.)
5. Test: `trigger_release repo=buildd-ai/buildd force=false`. Confirm `runId` is returned and stored in `releaseResult`.
6. Monitor: verify Pushover fires on next successful release.

**Rollback:** revert `releaseConfig.strategy` to `'branch_merge'` via `manage_workspaces update`. The `branch_merge` code path is preserved during the migration window.

---

#### `moa-ops`

`moa-ops` is a different GitHub organization and Vercel team — it cannot share buildd's global `VERCEL_TOKEN`.

Migration steps:
1. Audit `moa-ops` workspace: `manage_workspaces action=list`.
2. Audit its watched project: `manage_watched_projects action=list workspaceId=moa-ops`.
3. Obtain the `moa-ops` Vercel API token (scoped to the moa-ops Vercel team).
4. Add it as a GitHub Actions secret on the `moa-ops` repo (`VERCEL_TOKEN`).
5. Create an encrypted secret in buildd via `manage_secrets action=set` for the health-watcher use case, then update the `watchedProject` row: `manage_watched_projects action=update projectId=<id> vercelTokenSecretId=<new-secret-id>`.
6. Update `moa-ops` workspace `releaseConfig` to `strategy: 'workflow_dispatch'`.
7. Test: trigger a release on `moa-ops`, confirm workflow runs under the correct Vercel team.

**Rollback:** revert `releaseConfig.strategy` to `'branch_merge'`.

---

#### Other watched projects

For any other workspace with `releaseConfig.enabled === true`:
1. Inventory via `manage_workspaces action=list` + `manage_watched_projects action=list`.
2. Apply the same 6-step pattern as `buildd-ai/buildd` above.
3. Sequence: migrate lowest-traffic workspaces first.

---

#### Final cleanup (after all workspaces migrate)

1. Flip `effectiveStrategy` default from `'branch_merge'` to `'workflow_dispatch'`.
2. Open a follow-up task to remove the `branch_merge` code path from `executeRelease`.
3. Remove `VERCEL_TOKEN` from buildd's Vercel environment.
4. Remove `deployTarget` from the `WorkspaceReleaseConfig` TypeScript interface.

---

### 7. Out-of-Scope Follow-ups

These are known issues identified during this audit. They are NOT in scope for this spec. Track each as a separate task.

1. **`recordTaskOutcome` SQL bug** — "missing FROM-clause entry for table 'workers'" in `packages/core/routing-analytics.ts`. Fixed in PRs #978/#979; worth a regression check under load.

2. **Routing-analytics noise** — low-signal log spam in `routing-analytics.ts` that doesn't affect functionality.

3. **Webhook Path B hardcodes `release.yml`** — known bug listed here since it's a prerequisite for `workflow_dispatch` multi-repo support. Fix is specified in §2 but listed here as a standalone issue if §2 is delayed.

4. **`VERCEL_TOKEN` vs `VERCEL_API_TOKEN` name collision** — two env vars that often hold the same physical token but serve different code paths. A cleanup PR should unify naming (or at least add a comment). Low urgency once deployment creds move to per-repo secrets.

5. **`pending_ci` release tasks never complete automatically** — `executeRelease` can return `status: 'pending_ci'` (release-PR path), but there is no `check_suite` handler that completes the task when CI on the release PR resolves. The task sits pending until the next mission heartbeat picks it up. Closing this loop requires a targeted `check_suite.completed` handler that matches the release PR number.

6. **`script` strategy is unimplemented** — `ReleaseStrategy` includes `'script'`; `resolveReleaseStrategy` validates it but there is no execution path. Implement or remove.

7. **Vercel polling inside serverless execution** — `pollVercelDeployment` runs for up to 5 minutes inside a Vercel serverless function that has a ~10-second default execution limit (or 5-min max on Pro). This is fragile for slow deploys. Moving to `workflow_dispatch` (§2) eliminates this entirely; listed here as a known risk in the meantime.
