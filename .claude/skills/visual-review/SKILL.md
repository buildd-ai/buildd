---
name: visual-review
description: "Take phone- and desktop-width screenshots of buildd's web app and review them before calling UI work done. Use for any change that touches what a page renders. Covers the local recipe (scripts/qa/shoot.sh, needs a DATABASE_URL) and the worker recipe (dispatch the Visual QA workflow on your branch and download the qa-screenshots artifact, no DB needed)."
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

## Worker recipe (no DB)

`.github/workflows/visual-qa.yml` stands the app up in CI on a copy-on-write Neon
clone, captures, and uploads an artifact. Push your branch first, because the run
checks out `--ref`.

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
gh run download "$RUN" -n qa-screenshots -D /tmp/qa-ci
# → /tmp/qa-ci/screenshots/*.png, /tmp/qa-ci/a11y/*.json, /tmp/qa-ci/captures.json
# The repo is public, so any GitHub user can download this artifact. It holds
# placeholders only and expires after 1 day; still, delete it once you have your copy:
gh api "repos/buildd-ai/buildd/actions/runs/$RUN/artifacts" -q '.artifacts[].id' \
  | xargs -I{} gh api -X DELETE "repos/buildd-ai/buildd/actions/artifacts/{}"
```

Never paste screenshot contents into PR bodies, commits or comments, even from a
scrubbed run. Describe what you saw generically. If a CI shot ever shows real
names or titles, the scrub missed a column: delete the artifact and fix
`scrub-pii.sql` (its test lists every text column in the schema).

Then Read the PNGs. **Normally you are the judge.** You know what you changed, so
review the shots yourself against "What to check" below. That costs nothing extra.

`-f judge=true` is for when you want a CI verdict on the PR: claude-code-action
judges each shot on the team's OAuth seat, writes `verdicts.json` + `report.md`
into the artifact, and posts a neutral `Visual QA` check. It spends seat usage, so
don't turn it on by habit. Never call `/api/qa/judge` directly. It bills a server
API key per token, and CI no longer uses it.

| Input | Maps to | Notes |
|---|---|---|
| `routes` | `QA_ROUTES` | Comma-separated paths. Empty = full manifest (`apps/web/src/qa/visual-qa-routes.json`). |
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
- **The task page can fail locally under Turbopack**: an external module doesn't
  resolve under bun's isolated install. It's an environment problem, not your change.
  Use the CI dispatch for `/app/tasks/<id>`.
- **Vercel previews are behind org auth.** Pointing `QA_BASE_URL` at a preview gets
  you the Vercel login page unless you have `VERCEL_AUTOMATION_BYPASS_SECRET` or a
  storage state. Use the dispatch instead.
