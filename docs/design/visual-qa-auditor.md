# Visual QA Auditor for Missions

**Status:** Proposed — PR 1 (teeth) in progress
**Related:** `packages/core/surface-audit.ts`, `apps/web/src/lib/mission-surface-audit.ts`,
`apps/web/src/lib/mission-completion.ts`, `apps/web/src/app/api/workers/claim/route.ts`,
`apps/runner/src/env-scan.ts`, `apps/web/src/lib/default-roles.ts`, `apps/web/src/lib/storage-keys.ts`,
`apps/web/src/app/api/artifacts/upload-url/route.ts`, `apps/web/src/lib/mission-delivery.ts`,
`apps/web/src/lib/artifact-prominence.ts`, `scripts/qa/capture.ts`, `scripts/qa/shoot.sh`,
`.claude/skills/visual-review/SKILL.md`, `.github/workflows/visual-qa.yml`,
`docs/SPEC.md` (the removed-concepts entry for `requiredCapabilities`)
**Demo:** [`visual-qa-auditor-demo.html`](visual-qa-auditor-demo.html) — flow diagram and a mock of the
mission-page Visual review step (open locally; placeholder data only)

## Problem

A UI mission can finish without anyone having looked at a page it changed.

Buildd already treats a visual check as part of mission completion.
`ensureMissionSurfaceAudit` appends a `[surface audit]` task to any mission whose builder
work touches a UI path. The audit depends on every builder task, and while it is open
the mission stays at `pending_deliverables`. But the check has no teeth:

- **Nothing requires a browser.** The audit is inserted with `roleSlug: 'builder'`
  (`mission-surface-audit.ts:112`), so any builder runner can claim it, including one
  where Chromium doesn't launch. That runner can then fill in the checklist from the diff.
- **Almost any artifact satisfies it.** `outputRequirement: 'artifact_required'` is
  enforced by `hasDeliverableArtifact` in `workers/[id]/route.ts`. That accepts any
  artifact this worker wrote, or any mission artifact that another worker updated since
  this one started, or a PR. A text summary passes.
- **The author can grade itself.** The auditor runs as the same role as the builder, with
  write access, so "review" and "quietly fix" are the same action.
- **The screenshots, when there are any, are hard to find.** `SCREENSHOT` is classed as a
  byproduct (`artifact-prominence.ts:69`), and `upload-url` never sets `missionId`, so a
  mission page has nowhere to show them.

The CI path does not fill the gap. `visual-qa.yml` runs on labelled release PRs and on
manual `workflow_dispatch`, is report-only by design, and needs buildd's own Neon
clone and scrub, so it can't be reused for other workspaces.

## Current state

The following already works and is reused unchanged.

- **Browser detection:** `env-scan.ts` advertises `browser` only when headless Chromium
  actually launches.
- **Capture:** `scripts/qa/capture.ts` captures with Playwright and un-clips inner scroll
  containers. Viewports come from `scripts/qa/viewport.ts`. `shoot.sh` boots the app in
  dev mode with `DEV_USER_EMAIL` and `DISABLE_WRITES=true`.
- **Storage:** the `upload_artifact` MCP action gets a presigned PUT from
  `api/artifacts/upload-url`, so bytes go straight to the private R2 bucket. Reads go
  through `api/artifacts/[artifactId]/download`, which checks access and redirects to a
  signed GET.
- **Role routing:** a task with a `roleSlug` is claimable only by runners that list
  that slug in `availableSkills` (`claim/route.ts`). A runner that sends *no*
  `availableSkills` can claim anything, for backward compatibility.

## Proposal

Make the existing `[surface audit]` a real visual review, **for buildd first**. There is
no new gate primitive, no new task kind, no new upload route, and no revival of
`requiredCapabilities`.

### The crux

**Where the pages come from.** The auditor must render a logged-in, navigable app with
non-prod data from a headless worker.

Vercel previews are the obvious answer, but they sit behind deployment protection and
then the app's own OAuth. Automating a real OAuth login is fragile: providers block it,
sessions expire, and 2FA gets in the way. So the design **boots the app inside the
worker sandbox** with a dev-only auth bypass, exactly as `shoot.sh` already does. This
approach doesn't depend on the host and needs no deploy.

If it is wrong for a given app, because the app can't boot outside its host or has no
dev-auth path, the auditor can see nothing. That failure has to be loud. See "Boot
failure" below: it must never become a silent pass.

### 1. Routing: a dedicated role, gated on the runner's browser

- **Add a `visual-auditor` default role** in `default-roles.ts`. A `reviewer` role
  already exists for PR review, so this is a separate slug. Its tools are Read, Glob,
  Grep, Bash (to boot and capture) and the buildd MCP. Its prompt: *files tasks, never
  opens PRs*.
- **Insert the audit with `roleSlug: 'visual-auditor'`** in place of `'builder'`.
- **Runner-side gate:** the runner lists `visual-auditor` in `availableSkills` only when
  env-scan reports `browser`. This is capability routing through the role gate that
  already exists. It does not reverse the removal of `requiredCapabilities` in PR #1864.
- **Hole to close, scoped:** a runner that sends empty `availableSkills` can still claim
  role-routed tasks. Only slugs in a new constant `EXPLICIT_ROLE_SLUGS`
  (`['visual-auditor']`, in `packages/shared`) now need an explicit match; every other
  `roleSlug` keeps today's behaviour, so no existing runner or client changes. The gate
  (`claim/role-gate.ts`) also reads explicit slugs apart from the rest: a browser runner
  advertising only `['visual-auditor']` keeps claiming builder, organizer and other
  role-routed tasks. Folding the slug into the old `IS NULL OR IN (list)` clause would
  have stranded them. This is the load-bearing piece of PR 1.

### 2. The run

1. **Timing.** The claim deps-gate satisfies `dependsOn` only when the builder tasks are
   completed *and merged*. The audit therefore always runs against trunk after the UI
   has landed. It gates **mission completion, not merge**. Pre-merge review is a
   non-goal for v1.
2. **Boot.** The capture recipe is the existing `visual-review` skill. With no
   `DATABASE_URL` (the buildd worker case) the auditor dispatches `visual-qa.yml` on trunk
   and downloads the screenshots. With one, `shoot.sh` starts the app from trunk with
   the dev auth bypass, `DISABLE_WRITES=true`, and a data URL from a non-prod secret. It never reads a
   checked-in or local `.env`, because locally that can be prod. It waits up to 5 minutes
   for readiness.
3. **Required routes, set by code.** Map the mission's merged diffs to routes with
   Next's file-system rule: a changed `app/**/page.tsx` or `layout.tsx` gives its route,
   plus any matching entry in `apps/web/src/qa/visual-qa-routes.json`. The mapping is a
   pure function in `packages/core/visual-qa-routes.ts`: it drops `(group)` and `@slot`
   segments, maps `[id]` to `:id`, and ignores `app/api/**`. A layout also requires every
   manifest route under it. In PR 1 the changed files are the builder tasks'
   `pathManifest` entries (via the audit's `dependsOn`), recomputed at completion;
   merged-PR file lists are a later refinement. The auditor may
   **add** routes, for example ones that use a changed shared component. It cannot drop
   a required one.
4. **Capture.** Navigate read-only with GETs and no form submits. Capture every
   required route at mobile (390×844) and desktop (1280×900). **Bound:** at most 40
   shots per run.
5. **Upload.** Each shot is one `upload_artifact` call, `type: 'screenshot'`, with
   `missionId` set (a small change to `upload-url`). Each carries
   `metadata.qa = { runKey, route, viewport, finding, verdict }`, where `verdict` is one
   of `ok | issue | unsure`. There is no batch route. A run is the set of artifacts
   sharing a `runKey`.

### 3. The evidence check

In `workers/[id]/route.ts`, and only for `visual-auditor` tasks, this check **replaces**
`hasDeliverableArtifact`. Completion requires all of these:

- Every required route × viewport has a screenshot artifact from **this** worker.
- Each of those artifacts has its R2 object present (a HEAD request), so a row with no
  upload doesn't count.
- Each has a non-empty `finding`.
- Each `issue` has a linked fix task.

The model decides what it saw. Code decides whether it looked, and at what.

### 4. The gate: advisory verdict, blocking findings

- **`issue`:** the auditor files a `[surface fix] <route>: <finding>` task in the same
  mission. `pending_deliverables` then holds completion open, as it does for any open
  deliverable, so nothing new has to gate.
- **`unsure`:** the auditor raises a mission question with the shot attached, and a human
  says fix or waive.
- **No verdict blocks directly.** That avoids the permanent-`UNVERIFIED` stall the
  criteria reviewer was built to escape.
- **Boot failure:** the auditor does not mark the task `failed`. `failed` is terminal in
  `mission-completion.ts` and would *release* the gate. It asks a question instead
  ("app did not boot: …") with `AskUserQuestion`, which the runner parks as
  `waiting_input`, and the open task holds the mission. Not `post_note`: a note does not
  park, so the session ends and the runner's fallback completion is refused and recorded
  as a failure. The runner's in-session output-requirement nudge skips visual-auditor
  tasks for the same reason. After the 4h mission waiting-input timeout the task is
  failed and cloned; the clone keeps `roleSlug` and `dependsOn`, so it holds the mission
  and re-derives the same required routes. The evidence check
  refuses a completion with no screenshots in any case. (A worker cannot report
  `infra_stalled` itself: only the server sets it, after repeated infra retries, so it
  is not a boot-failure path.)
- **Re-check, defined:** today, `ensureMissionSurfaceAudit` appends each new work task,
  fix tasks included, to the existing audit's `dependsOn`. That is inert once the audit
  is done. Change it so that when an audit is already `completed` and a `[surface fix]`
  task is created, it creates **one** new `[surface audit] round 2` scoped to the
  issue routes. **Bound:** at most 2 rounds. A third set of issues goes to a human
  question instead of looping.

### 5. Where the screenshots show

- **Mission page:** a `visual` step in `DeliveryStepKey` (`mission-delivery.ts`)
  renders, inside `MissionDelivery`, a thumbnail strip with verdict dots and a count line.
  Click opens a lightbox showing the route, viewport, finding, verdict and linked fix
  task. Thumbnails load through the existing `download` route, so no new read route is
  needed.
- **Prominence:** audit screenshots count as review evidence, not byproducts. That is one
  rule in `artifact-prominence.ts`.
- **PR:** gets a link to the dashboard page only. Images are never embedded, and the
  `share` route refuses to make an audit screenshot public, because shots of preview data
  can contain real content.

### 6. Decay

- An **R2 lifecycle rule** expires audit screenshots after 30 days. It is a single bucket
  setting. The key helper in `storage-keys.ts` gives them a `qa/` segment so the rule can
  match by prefix.
- Rows outlive their objects, and the finding text is the durable record. The UI renders
  an "expired" tile when the signed GET returns 404.
- No cron is needed at single-user volume.

## Implementation sketch

1. **PR 1, buildd only: teeth.**
   - Require an explicit role match for `EXPLICIT_ROLE_SLUGS` (`visual-auditor` only).
   - Add the `visual-auditor` role, and have the runner advertise it only when browser
     is present. Default roles are seeded only when a team is created, so existing teams
     don't get the row. Claiming doesn't need it, but prompt and tool injection do:
     register it for the buildd team through the UI or `register_skill`, not a migration
     that lists teams.
   - Keep `roleSlug` on the stale-`waiting_input` retry clone, so a retried audit stays
     routed and gated.
   - Route the audit to it.
   - Required routes from code, and the evidence check.
   - `missionId` on upload.
   - The boot-failure path.
2. **PR 2: visible.** The Delivery-step strip and lightbox, the prominence rule, the
   share refusal, the `qa/` key segment, and the lifecycle rule.
3. **PR 3: loop.** Fix-task filing, the unsure-to-question path, and round 2 with its
   bound.

**Only after PR 1–3 have caught real defects on buildd:** make this work for any
workspace. That means a `workspaces.visualQaConfig` holding `bootCommand`, `port`,
`readyPath`, `authBypassEnv`, `dataSecretLabel`, `uiGlobs` (defaulting to today's
prefixes) and `routesManifest`, plus a `qa_database_url` secret purpose, and it must be
tried on a second, non-Next app before it's called generic.

## Open questions

- **Is an empty `availableSkills` list relied on anywhere?** *Resolved:* yes (today's
  runner never sends one), so the tightening is scoped to `EXPLICIT_ROLE_SLUGS` and every
  other role keeps the empty-list behaviour. Any claimer that sends no skills (MCP,
  external clients) can no longer claim a `visual-auditor` task, which is intended.
- **Critical PRs outside missions?** *Lean:* later, as a label that creates an audit task
  on the PR's branch before merge. That is the only pre-merge path, and it is not in v1.
- **Is "read-only" enforceable?** Bash can write files. *Lean:* yes, enough. The role
  prompt says no PRs, and `DISABLE_WRITES` covers buildd's DB. For other apps, writes to
  a branch DB are the accepted risk of the generic phase.
- **Second theme?** Headless comes up dark. *Lean:* add the light theme only when the
  diff touches colour tokens or `dark:` classes, and not before PR 3.

## Non-goals

- **Pixel-diff baselines.** Stored screenshots compared pixel by pixel measure the
  fixture, not the product. They churn on font loading and first-compile timing, and get
  re-blessed wholesale. Every run is judged fresh, with no baselines.
- **Browsing deployed previews** through deployment protection and app OAuth. A
  preview-only credentials provider plus the bypass header could be a later opt-in for
  issues that only happen in production.
- **Pre-merge review inside missions.** The audit runs after merge, by construction of
  the deps-gate.
- **Hosted browser services, and native or mobile apps.**
- **Replacing `visual-qa.yml`.** Buildd's release-PR workflow stays as it is.
