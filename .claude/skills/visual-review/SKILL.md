---
name: visual-review
description: "Take phone- and desktop-width screenshots of buildd's web app and review them before calling UI work done. Use for any change that touches what a page renders. Covers the local recipe (scripts/qa/shoot.sh, needs a DATABASE_URL), the worker recipe (dispatch the Visual QA workflow on your branch and download the qa-screenshots artifact, no DB needed), and the preview recipe for workspaces with Vercel previews (get_page_source, and its two auth-wall failure modes)."
author: buildd
---

# Visual Review

Tests prove the code runs. They say nothing about whether the page reads right at
390px. Look at it.

## When to use

- Any change to a page, component, layout or style under `apps/web/src/app/`.
- **Before calling UI work done.** Attach or describe what you saw. "Tests pass"
  is not a UI verdict.

Pick the recipe by one question: do you have a `DATABASE_URL`?

| You are | Recipe |
|---|---|
| A human, or anyone with a dev DB | Local: `scripts/qa/shoot.sh` |
| A worker agent (no DB, by design) | CI: dispatch `visual-qa.yml` |

## Local recipe

```bash
QA_PORT=3217 QA_VIEWPORT=mobile DEV_USER_EMAIL=you@example.com \
  scripts/qa/shoot.sh /app/missions /app/tasks/<id>
# → /tmp/qa/screenshots/<route-id>.png, /tmp/qa/a11y/<route-id>.json
```

- `shoot.sh` boots `next dev` with `NODE_ENV=development` (dev auth short-circuit),
  `DISABLE_WRITES=true` and your `DEV_USER_EMAIL`, captures, then tears down.
- **It needs a `DATABASE_URL`.** Point it at a dev database or a Neon dev branch,
  never prod. Keep it in your shell or an ignored env file, and never commit env files.
- `QA_VIEWPORT`: `mobile` = 390x844 touch phone at 3x; `WxH` for anything else
  (below 768px wide it also emulates touch); unset = 1280x900 desktop. Shoot both
  when the change is layout-sensitive.
- Shots are full-height and 3x on mobile, so they're large. Downscale before
  reading them on macOS: `sips -Z 1800 /tmp/qa/screenshots/*.png`.

## Local service recipe (local or cloud browser)

A cloud visual-auditor connects to its task's remote browser through runner-provided
loopback endpoints. Run the same capture helper; do not install Chromium or copy a
Cloudflare credential into the container. `BUILDD_BROWSER_PROVIDER` and the connection
endpoints are supplied by the runner only after its browser probe succeeds.

With a synthetic/local `DATABASE_URL` available (see `scripts/demo/`), start
`scripts/qa/serve-local.sh` in the background. It binds the app to `0.0.0.0`, waits
for `/api/version`, and writes `${QA_OUTPUT:-/tmp/qa}/service.json` only when ready.
For a cloud provider it also registers that port with the task's private browser
relay; the returned `browserUrl` remains the loopback origin. Pass that URL as
`QA_BASE_URL` to `scripts/qa/capture.ts`, using `QA_NO_LOGIN=1` with dev auth.
Stop the service process after capturing. No public port is exposed.

Copy `browser` from each entry in `captures.json` into artifact `metadata.qa.browser`.
A `providerError` is a capture failure with no valid screenshot, never a visual
finding or an `ok` verdict. Report the named failure rather than swapping providers.

## Worker recipe (no DB)

`.github/workflows/visual-qa.yml` stands the app up in CI on a copy-on-write Neon
clone, captures, and uploads an artifact. Push your branch first, because the run
checks out `--ref`.

**Which `--ref`, for a mission audit.** Your own branch when you check your own work.
For a mission's visual audit, the ref is `captureRef.ref` from `get_page_source`: the
mission's integration branch on a `mission-branch` mission, trunk otherwise. Builder PRs
on such a mission merge into the integration branch, not trunk, so a trunk shot shows the
page before the fix. Record the branch on each shot as `metadata.qa.ref` and
`captureRef.source` as `qa.refSource`. A shot from another ref never reaches the human
review: it is superseded by a correct-ref shot of the same route and viewport, or listed
as a capture gap. **When your own finding says a shot is invalid because of its ref,
recapture it from `captureRef.ref`. Do not file it as `unsure`.**

**The CI clone is scrubbed to placeholders, so CI shots show layout, not real
content.** `scripts/qa/scrub-pii.sql` rewrites every tenant-authored or
identifying text column (`Workspace 3`, `org-2/repo-2`, `Mission 12: lorem ipsum…`,
`buildd/<8hex>-task-<n>`, PR `#<n>`), and `scripts/qa/scrub-guard.sql` fails the run
before anything renders if a non-placeholder value or a known identifier
survives. Ids, statuses, timestamps and counts are kept, so every state still
renders at a realistic length. To review real copy, use the local recipe against
a dev database.

```bash
gh workflow run visual-qa.yml --ref <branch> \
  -f routes=/app/missions,/app/tasks/<id> -f viewport=mobile
# Find your run. Dispatch prints no id; take the newest run on your branch.
RUN=$(gh run list --workflow visual-qa.yml --branch <branch> --event workflow_dispatch \
  --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" --exit-status
# No TTY (most agent shells): gh run watch returns immediately instead of
# blocking. Poll instead, still in the foreground:
#   until gh run view "$RUN" --json status -q .status | grep -q completed; do sleep 15; done
gh run download "$RUN" -n qa-screenshots -D /tmp/qa-ci
# → /tmp/qa-ci/screenshots/*.png, /tmp/qa-ci/a11y/*.json, /tmp/qa-ci/captures.json
# The repo is public, so any GitHub user can download this artifact. It holds
# placeholders only and expires after 1 day; still, delete it once you have your copy:
gh api "repos/buildd-ai/buildd/actions/runs/$RUN/artifacts" -q '.artifacts[].id' \
  | xargs -I{} gh api -X DELETE "repos/buildd-ai/buildd/actions/artifacts/{}"
```

**Wait for the run in the same turn — never end your turn saying you'll wait for a
notification or a background watcher.** A worker agent's session is not resumed by a
background job finishing: a runner-hosted turn that ends is recorded as complete
regardless of what's still running, so the screenshots never get read and completion
fails for missing evidence. Run the watch/poll step in the foreground (not
backgrounded, not fired-and-forgotten) and block on it before moving on.

Never paste screenshot contents into PR bodies, commits or comments, even from a
scrubbed run. Describe what you saw generically. If a CI shot ever shows real
names or titles, the scrub missed a column: delete the artifact and fix
`scrub-pii.sql` (its test lists every text column in the schema).

Then Read the PNGs. **Normally you are the judge.** You know what you changed, so
review the shots yourself against "What to check" below. That costs nothing extra.

`-f judge=true` is for when you want a CI verdict on the PR: claude-code-action
judges each shot on the team's OAuth seat, writes `verdicts.json` + `report.md`
into the artifact, and posts a neutral `Visual QA` check. It spends seat usage, so
don't turn it on by habit.

| Input | Maps to | Notes |
|---|---|---|
| `routes` | `QA_ROUTES` | Comma-separated paths. Empty = full manifest (`apps/web/src/qa/visual-qa-routes.json`). |
| `plan` | `QA_PLAN` | A capture plan instead of `routes`: the JSON itself, or a repo path. See "Capture plans" below. |
| `viewport` | `QA_VIEWPORT` | `mobile` or `WxH`. Empty = desktop. A malformed value fails the capture. |
| `mission_id` / `task_id` | `QA_MISSION_ID` / `QA_TASK_ID` | Fill `:id` routes in manifest mode only. |
| `judge` | (step gate) | Default `false`. `true` = CI verdict on the team OAuth seat (see above). |

- The data is a scrubbed prod clone, so the ids in your routes must exist there.
  Take them from the dashboard, not from seed scripts. The CI user is one workspace
  owner, so pages outside that user's teams redirect or come up empty.
- Each dispatch gets its own Neon branch and concurrency group, so parallel
  dispatches don't collide or cancel each other. Leaked `ci/visual-qa-*` branches
  older than 2h are swept at the start of every run.
- A red `Guard scrubbed clone` step means the scrub missed something. No app, no
  shots, no artifact. The error names `table.column` only; fix the scrub, don't
  work around the guard.
- If capture crashes, a dispatch run fails (on release PRs it's report-only). A
  single route failing does **not** fail the run, so a green run can still hold a
  bad shot. Check `captures.json`, which records `error`, `redirected` and
  `devOverlay` per route.

## Capture plans: dialogs, menus and gated states

A loaded page shows only its resting state. To shoot a modal, menu, confirm or gated
sub-state, pass `QA_PLAN` (or `-f plan=…`) instead of `QA_ROUTES`: a path to a JSON
file, or the JSON itself. Spec: `docs/specs/qa-capture-steps.md`.

```json
[{ "route": "/app/tasks/<pending task id>",
   "states": [{ "key": "force-start-dialog",
                "steps": [{ "action": "click", "selector": "role:button[name=Start Task]", "commit": true },
                          { "action": "waitFor", "selector": "text:Force start" }] }] }]
```

- Each route is shot at its base state, then once per state on a fresh load (a
  viewport shot, id `<route-id>--<key>`, `state` in `captures.json`).
- Actions (closed list): `click`, `hover`, `fill` (`value`), `press` (`key`),
  `select` (`value`), `waitFor` (`state: visible | hidden`), `waitMs` (`ms`, max 5000).
  Selectors: `testid:<id>`, `role:<role>[name=<name>]`, `text:<text>`, `css:<css>`.
- **Steps never commit.** Open, reveal, type; never confirm, submit or save. A step that
  sends a write needs `commit: true`, honoured only with `QA_PAGE_SOURCE=sandbox`; a
  preview rejects the whole plan and names the step. Every other write is aborted in the
  browser and listed as `blockedWrites`. The example is a commit step because opening
  that dialog sends a Start request; CI runs with `DISABLE_WRITES=true`, so nothing starts.
- A step that does not settle leaves `stepFailed: { index, selector, error }` and a shot
  of the page where it stopped; the run still exits 0.
- Upload a state shot with `metadata.qa.state` = its key. Required coverage counts base
  shots only, so a state shot is extra evidence, never a substitute.

## Preview recipe (other workspaces with Vercel previews)

A workspace whose repo deploys a Vercel preview per commit can audit that instead of
booting the app: set `gitConfig.visualQa.pageSource` to `vercel-preview` or `auto`
(`auto` falls back to the sandbox when the commit has no READY preview). Buildd itself
stays on `sandbox`. Design: `docs/design/visual-qa-auditor.md` → "Page source".

1. `buildd action=get_page_source params={ waitSeconds: 45 }` (add `sha` or `prNumber`).
   It reads the commit's GitHub deployment statuses with the workspace's GitHub App, so
   no Vercel token is needed. `pending` means call again; `preview_unavailable` is loud.
   With no `sha` or `prNumber` the commit is the head of `captureRef.ref` (above).
2. Capture from `decision.baseUrl`:
   ```bash
   QA_BASE_URL=<baseUrl> QA_PAGE_SOURCE=vercel-preview QA_ROUTES=/,/settings \
     QA_VIEWPORT=mobile bun scripts/qa/capture.ts
   ```
   Not in buildd's repo? Use a throwaway kit with its **own** browsers path:
   ```bash
   git clone --depth 1 https://github.com/buildd-ai/buildd /tmp/qa-kit/src
   cd /tmp/qa-kit && bun add playwright
   export PLAYWRIGHT_BROWSERS_PATH=/tmp/qa-kit/browsers
   bunx playwright install chromium && bun src/scripts/qa/capture.ts
   ```
   A plan works the same from the kit (`QA_PLAN=/tmp/qa-kit/plan.json`); on a preview
   it must hold no `commit: true` step.
   Without that export, `playwright install` from a different version garbage-collects
   the shared `~/.cache/ms-playwright` builds, including the runner's own browser. A
   browser that will not launch exits 1, never 0.
3. Upload each shot with `metadata.qa.source` copied from `captures.json`, plus
   `qa.ref` and `qa.refSource` from `captureRef`.

**Diagnosing the two failure modes.** capture.ts exits 3 and records `configError` on
the capture instead of taking a shot. Neither is a visual finding:

| `configError` | What you hit | Fix (the owner's) |
|---|---|---|
| `protection_bypass_missing` | Vercel's login / SSO wall | Vercel project → Deployment Protection → Protection Bypass for Automation; store it with `manage_secrets` (`purpose: role_env_secret`) and map it in `gitConfig.envMapping` as `VERCEL_AUTOMATION_BYPASS_SECRET` |
| `app_auth_not_configured` | the app's own sign-in page | Preferred: a preview-only auth bypass env var in the Vercel **Preview** environment that signs in a test user (like buildd's dev auto-login). Else a Playwright storageState JSON as a secret mapped as `VISUAL_QA_STORAGE_STATE` (sessions expire) |

`get_page_source` also reports `auth.*.mapped`, so "not mapped" is visible before you
capture. Set `gitConfig.visualQa.signInPaths` if the app's sign-in page is not at
`/login`, `/signin`, `/sign-in`, `/auth` or `/api/auth/signin`. Never print the bypass
secret or the storage state; capture.ts writes the state to a 0600 temp file and logs
neither.

## What to check

- **First screen at 390px.** Does the thing the page is for show up without
  scrolling? Headers, banners and filters that push it below the fold are a finding.
- **Tap targets.** Roughly 44px or more, not crowded, nothing that only works on hover.
- **Overflow.** No horizontal scroll, no clipped text, no table forced wider than the viewport.
- **Both themes, if the change touches colour.** Capture has no theme switch, so
  check the other theme by hand, or say you didn't.
- **Redirects and error states.** If a shot is the login page or an error boundary,
  you didn't review the page.

## Gotchas

- **The app scrolls inside `<main>`, not the window.** A plain full-page screenshot
  stops at one viewport. `capture.ts` un-clips inner scroll containers first. Keep
  that behaviour if you take screenshots some other way.
- **Fixed and sticky elements land mid-image in full-height shots.** The mobile
  bottom nav is drawn where the first viewport ended, over whatever content is
  there. That's how the shot was taken, not an overlap bug. Judge the first 844
  CSS px (2532 image px at 3x) as the real first screen.
- **The Next dev overlay is hidden by default**, so a build error doesn't cover the
  page. Set `QA_KEEP_DEV_OVERLAY=1` to see it. `captures.json` flags `devOverlay`
  either way.
- **Port 3100 (shoot.sh's default) is often taken** by another session. Always pass
  a free `QA_PORT`. If the port is busy, the readiness probe can hit someone else's server.
- **Headless comes up in the dark theme.** A shot being dark is not a regression.
- **`Failed to load external module <pkg>-<hash>` is a real bug, locally and in CI.**
  Next auto-externalizes some packages (its `server-external-packages.jsonc`), and
  under `bun --bun next dev` Bun cannot resolve Turbopack's hashed alias for them.
  The CI dispatch runs the same `bun dev`, so it fails there too. This blanked
  `/app/tasks/<id>` via `@aws-sdk/client-s3`. The fix is to add the package to
  `transpilePackages` in `apps/web/next.config.mjs`. `src/lib/next-config.test.ts`
  enforces that for direct dependencies.
- **Vercel previews have two auth walls.** See "Preview recipe" below. For buildd
  itself there are no per-PR previews, so use the dispatch.
- **This recipe (local Chromium, `visual-qa.yml`) has no dependency on the
  provider-backed browser work** (`docs/specs/visual-qa-browser-providers.md`,
  a Cloudflare-backed browser provider layered on top of this path). That spec's
  own "current state" section lists this workflow as reused unchanged, and its
  "out of scope" section says so explicitly. A failed task in that work (or its
  mission) is not evidence this recipe is broken — verify it directly with a
  fresh dispatch before treating a mission's visual-audit capability as regressed.
