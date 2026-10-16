---
title: Runner Heartbeat and Version
status: active
owner: max
last_verified: 2026-10-15
summary: A runner heartbeat MUST report current presence and version information without exposing its local UI token.
domain: runners
surfaces: [apps/web/src/app/api/workers/heartbeat/route.ts, apps/web/src/app/api/version/route.ts]
related: [worker-reclamation, runner-failure-alerts]
verified_by: [apps/web/src/app/api/workers/heartbeat/route.test.ts, apps/web/src/app/api/version/route.test.ts]
assertions:
  - id: extra-guard-1
    type: test_file
    path: apps/web/src/app/api/version/route.test.ts
  - id: heartbeat-route
    type: route
    method: POST
    path: /api/workers/heartbeat
    file: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: version-route
    type: route
    method: GET
    path: /api/version
    file: apps/web/src/app/api/version/route.ts
  - id: active-workers-route
    type: route
    method: GET
    path: /api/workers/active
    file: apps/web/src/app/api/workers/active/route.ts
  - id: guard-1
    type: test_file
    path: apps/web/src/app/api/workers/heartbeat/route.test.ts
supersedes: []
---
# Runner Heartbeat and Version

**Capability statement**: A runner heartbeat MUST report current presence and version information without exposing its local UI token.

## Runner Heartbeat Protocol

**Invariants**:
- Runners MUST call `POST /api/workers/heartbeat` with `localUiUrl` on each
  `BUILDD_RUNNER_POLL_MIN`-minute cycle (default **60 minutes**; configured via
  the same env var on both the runner host and server). The exported constant is
  `RUNNER_HEARTBEAT_INTERVAL_MS` from `packages/shared/src/runner-liveness.ts`.
  To change the interval, update `BUILDD_RUNNER_POLL_MIN` on both runner and
  server so liveness thresholds scale together.
- **Note:** Pusher delivers realtime task notifications to runners. The heartbeat
  interval is NOT a polling frequency for new tasks — Pusher handles task
  delivery. The heartbeat exists solely to register the runner as alive and to
  maintain the liveness window used by stale-detection.
- Each `(accountId, localUiUrl)` pair has at most one `worker_heartbeats` row;
  the upsert on conflict refreshes `lastHeartbeatAt`.
- The server issues a `viewerToken` on the first registration for that
  `(accountId, localUiUrl)` pair; subsequent heartbeats reuse it (token is
  stable for the runner instance's lifetime).
- `workspaceIds` on `worker_heartbeats` is deprecated and always written as `[]`;
  workspace association is resolved on demand by `GET /api/workers/active`.
- Each heartbeat MAY carry `runnerCommit` (the runner codebase's own `git
  rev-parse HEAD`, read fresh from disk each beat) and `runnerVersion`
  (`package.json` version, read once at process start) — the runner's own
  build identity, not a task's commit. Persisted verbatim to
  `worker_heartbeats.runner_commit` / `.runner_version` and surfaced on
  `GET /api/workers/active`. This is how a runner instance still serving
  pre-fix code becomes distinguishable from one running a merged fix, without
  SSH access to the host: before this field existed, a runner's actual
  deployed commit was observable only via its own local, unauthenticated-off-box
  `/api/version` endpoint (`apps/runner/src/index.ts`), which nothing on the
  platform side ever polled. Both fields are `null` for a runner older than
  this change (it simply omits them from the POST body) — treat `null` as
  "unknown", not "on an old commit".
- Each heartbeat MAY also carry an **update-snapshot bundle**: `currentCommit`
  (the commit the running process loaded at boot / last successful
  self-update — not a fresh read), `diskCommit` (a fresh `git rev-parse HEAD`
  taken at snapshot time), `commitDrift` (`diskCommit !== currentCommit`, both
  non-null — an external process rewrote the tree without restarting this
  runner), `updating` and `updateAvailable` (the runner's own auto-update
  state machine), and `trackedBranch` (its `BUILDD_BRANCH`). This is the same
  live state the runner already reports on its own local, unauthenticated
  `/api/version` (`apps/runner/src/index.ts`), sent via
  `apps/runner/src/updater.ts`'s `getRunnerUpdateSnapshot()` (a
  registered-provider singleton — `index.ts` owns the live state,
  `workers.ts` sends the heartbeat, and a direct import between the two would
  be circular). Persisted to `worker_heartbeats.current_commit` /
  `.disk_commit` / `.commit_drift` / `.updating` / `.update_available` /
  `.tracked_branch`, surfaced on `GET /api/workers/active`. Sent as one
  bundle, never partial: an omitted bundle leaves all six columns at their
  last known-good value in the upsert conflict `set` (same convention as
  `runnerCommit`/`runnerVersion` above); a bundle that IS sent writes even a
  `null` `currentCommit`/`diskCommit` verbatim — that null is a real fact (the
  disk read failed just now), not "no data".
- `worker_heartbeats.update_available_since` is server-derived, never sent by
  the runner: the heartbeat route stamps it the instant `updateAvailable`
  first becomes `true` (comparing against the row's own prior value, read in
  the same request), holds it steady across heartbeats while `updateAvailable`
  stays `true`, and clears it back to `null` the moment `updateAvailable`
  stops being `true`. Surfaced on `GET /api/workers/active` and the
  `list_runners` MCP action so "how long has this runner been behind" is a
  measured timestamp instead of inferred from boot age or heartbeat cadence.
  Left untouched (not cleared) on a heartbeat that omits the whole
  update-snapshot bundle, same as the other five columns.
- The full heartbeat snapshot (capacity, environment, runner build, and the
  update-snapshot bundle above) is also reachable from any MCP transport via
  the `list_runners` action (`packages/core/mcp-tools.ts`) — before this it
  was visible only through `GET /api/workers/active`, which needs an API key
  no MCP action ever forwarded, so a task doing update/version recon had no
  way to read it.

**Acceptance criteria**:
- AC-1: WHEN `POST /api/workers/heartbeat` is called without `localUiUrl` THEN
  the server returns HTTP 400.
- AC-2: WHEN a runner sends its first heartbeat THEN the response contains a
  `viewerToken` that remains unchanged on all subsequent heartbeats for the same
  `localUiUrl`.
- AC-3: WHEN a valid heartbeat is received THEN `lastHeartbeatAt` is updated to
  `NOW()` in `worker_heartbeats`.
- AC-17: WHEN a heartbeat carries `runnerCommit`/`runnerVersion` THEN both are
  persisted verbatim to `worker_heartbeats` and returned by
  `GET /api/workers/active`.
- AC-18: WHEN a heartbeat omits `runnerCommit`/`runnerVersion` (legacy runner)
  THEN both are stored as `null`, not overwritten with a stale prior value from
  a different field.
- AC-19: WHEN a heartbeat carries the update-snapshot bundle THEN all six
  fields are persisted verbatim to `worker_heartbeats` and returned by
  `GET /api/workers/active`, including a `null` `currentCommit`/`diskCommit`.
- AC-20: WHEN a heartbeat omits the update-snapshot bundle THEN all six
  columns are left at their previously stored value, not overwritten with
  `null`.
- AC-21: `GET /api/workers/active` computes `upToDateWithDeployed` by
  comparing a heartbeat's `diskCommit` against `/api/deploy-identity`'s `sha`
  — but ONLY for `trackedBranch === 'main'` (the only branch Vercel deploys
  from). A `dev`-tracking runner, or a heartbeat missing either commit,
  reports `upToDateWithDeployed: null`, never a guess.
- AC-22: WHEN a heartbeat's update-snapshot bundle carries `updateAvailable:
  true` AND the stored row's prior `updateAvailable` was not already `true`
  THEN `updateAvailableSince` is stamped to the current time.
- AC-23: WHEN consecutive heartbeats both carry `updateAvailable: true` THEN
  `updateAvailableSince` is left unchanged from its first-stamped value.
- AC-24: WHEN a heartbeat's bundle carries `updateAvailable: false` (or
  `null`) THEN `updateAvailableSince` is cleared to `null`.
- AC-25: The `list_runners` MCP action, reachable from every MCP transport
  (API-key, OAuth, in-process runner/chat) via `handleBuilddAction`, returns
  the same per-runner fields as `GET /api/workers/active` — slots as
  "a busy of b slots", workspaces, runner build, and the full update-snapshot
  bundle including `updateAvailableSince` — scoped to whatever workspaces the
  calling token can already see.
- AC-26: Each runner row carries `browser` (its heartbeat `envKeys` include
  `browser`), printed by `list_runners` as `browser: yes/no`. WHEN
  `workspaceId` is given (`GET /api/workers/active?workspaceId=`, 404 for a
  workspace the caller cannot see) THEN the response adds
  `browserRunnerOnline` by `browserRunnerOnline`'s claim rule (null when the
  lookup failed) and `list_runners` leads with "Browser-capable runner online
  for <ws>: yes/no/unknown", listing only that workspace's runners.

**Code surface**:
- Route: `apps/web/src/app/api/workers/heartbeat/route.ts`
- Schema: `packages/core/db/schema.ts` — `workerHeartbeats` table
- Runner send site: `apps/runner/src/workers.ts` (`sendHeartbeat`),
  `apps/runner/src/buildd.ts` (`BuilddClient.sendHeartbeat`)
- Runner commit/version source: `apps/runner/src/updater.ts` (`getCurrentCommit`,
  `PKG_VERSION`, `getRunnerUpdateSnapshot`)
- Shared type: `packages/shared/src/types.ts` — `RunnerUpdateSnapshot`
- Dashboard surface: `apps/web/src/app/api/workers/active/route.ts`
- MCP surface: `packages/core/mcp-tools.ts` (`list_runners` action, dispatched
  through `handleBuilddAction` — reachable from every transport, not just the
  API-key one; text in `packages/core/mcp-visual-review.ts`)

---


## `/api/version`: deployed vs. latest-available

**Capability statement**: `GET /api/version` MUST answer two different
questions without letting either be mistaken for the other: what THIS server
is actually running (`deployed`), and what the newest commit is on a given
branch in GitHub (`latestAvailable`).

**Invariants**:
- `deployed` is read from the platform's build-time env
  (`apps/web/src/lib/deploy-identity.ts` — `VERCEL_GIT_COMMIT_SHA`,
  `VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`, plus `apps/web/package.json`'s
  `version` via a static import) — never a GitHub lookup, so it is correct
  immediately after a deploy, before GitHub's view of the branch is
  re-fetched. The same helper backs `GET /api/deploy-identity`, so the two
  routes can never disagree about what "deployed" means.
- `latestAvailable` resolves `?branch=` through the same allowlist as the
  heartbeat route (`resolveVersionBranch` in `apps/web/src/lib/version-cache.ts`
  — `main`/`dev`; anything else, including no param, falls back to the
  cache's default). It calls `getLatestVersion(branch, { tolerateStale:
  false })` — the ONE caller that opts out of the cache's normal
  stale-on-failure fallback (the heartbeat route still gets that resilience,
  since a runner is better off with a slightly-stale advertised commit than
  none for one transient GitHub blip). A GitHub failure here degrades
  `latestAvailable` to `{ commit: null, tag: null, checkedAt: null, error:
  <message> }` — the response is still HTTP 200 with the `deployed` block
  intact, never a 502.
- Response carries `Cache-Control: no-store`, so no CDN can serve a previous
  deploy's answer.
- Runners resolve their OWN tracked branch via `?branch=` (see
  `apps/runner/src/index.ts`'s `pollVersion`, serverless-mode polling) and
  read `latestAvailable.commit` — never the old flat `latestCommit` field,
  which this endpoint no longer sends (there is exactly one consumer of the
  public route, updated in the same change that introduced this shape).

**Acceptance criteria**:
- AC-27: WHEN `GET /api/version` is called with no Vercel env vars set (local
  dev) THEN `deployed` reports all fields `null` rather than throwing.
- AC-28: WHEN `?branch=main` is given THEN `latestAvailable.branch` is
  `"main"` and the GitHub lookup is for `main`'s head, independent of
  `deployed`.
- AC-29: WHEN the GitHub lookup fails (network error, non-2xx) THEN the
  response is still HTTP 200, `deployed` is populated, and
  `latestAvailable = { commit: null, tag: null, checkedAt: null, error:
  <message> }`.

**Code surface**:
- Route: `apps/web/src/app/api/version/route.ts`
- Deploy identity: `apps/web/src/lib/deploy-identity.ts` (`getDeployIdentity`,
  `DEPLOYED_VERSION`), also used by `apps/web/src/app/api/deploy-identity/route.ts`
- Version cache: `apps/web/src/lib/version-cache.ts` (`getLatestVersion`,
  `resolveVersionBranch`, `ALLOWED_VERSION_BRANCHES`)
- Runner consumer: `apps/runner/src/index.ts` (`pollVersion`)

---

**Out of scope**: The sibling contracts linked in the frontmatter.
