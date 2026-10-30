---
title: Runner Heartbeat and Version
status: active
owner: max
last_verified: 2026-10-30
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
- **Presence is carried by Pusher, content by the heartbeat.** A runner is
  *online now* only when BOTH hold: (a) it is a member of its account's
  presence channel (see "Presence channel" below) and (b) its last content beat
  is non-stale. Runners MUST call `POST /api/workers/heartbeat` with
  `localUiUrl` (1) at startup, (2) whenever beat content changes (slots, busy
  count, version/commit, update state, workers named), and (3) as a slow
  fallback ping every RUNNER_FALLBACK_PING_MS (10-15 minutes, jittered) so a
  Pusher outage degrades to slow liveness rather than none. An idle, unchanged
  runner on a healthy Pusher connection sends nothing between fallback pings.
  This replaces the former "MUST heartbeat each cycle" rule and the fixed
  `LIVENESS_PING_INTERVAL_MS` (60 s) ping; the hourly aligned tick
  (`RUNNER_HEARTBEAT_INTERVAL_MS`, `BUILDD_RUNNER_POLL_MIN`, default 60 min)
  stays for reconcile, claim fallback and idle-job polling.
- **Note:** Pusher delivers realtime task notifications to runners. The
  heartbeat interval is NOT a polling frequency for new tasks.
- Each `(accountId, localUiUrl)` pair has at most one `worker_heartbeats` row;
  the upsert on conflict refreshes `lastHeartbeatAt`.
- Liveness lives in Redis (`apps/web/src/lib/liveness.ts`,
  `apps/web/src/lib/runner-beats.ts`): every beat stamps a Redis key, and the
  row (with the leases of the workers it names) is written only when its
  content changes, when the beat names a worker no write has renewed yet, or
  once per `LIVENESS_DB_WRITE_INTERVAL_MS` (5 minutes). A lease written on
  that cadence runs `WORKER_LEASE_TTL_MS` plus the interval, so it never lapses
  between writes. A stored `lastHeartbeatAt` can therefore be one interval old:
  every reader of the 3-minute "online now" window reads it raised to the Redis
  beat (`withLiveRunnerBeats`), with any SQL cutoff widened by the interval
  first. Without Redis every beat writes, as before (fail open). The lost-claim
  search runs on a writing beat, or at once while a start is pending or a claim
  is in flight.
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
- AC-3: WHEN a valid heartbeat is received THEN the runner's liveness is
  `NOW()`: in Redis on every beat, and in `worker_heartbeats.lastHeartbeatAt`
  on the first beat, on a change, and at least once per
  `LIVENESS_DB_WRITE_INTERVAL_MS` (every beat when Redis is unavailable).
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

---

## Presence channel (revision, pending owner approval)

**Capability statement**: A runner's reachability MUST be asserted by a Pusher
presence connection and recorded server-side only on state change, so an idle
runner costs no periodic traffic and a killed runner goes offline within about
a minute.

**Invariants**:
- **Channel scope: one presence channel per account**,
  `presence-runner-<accountId>` (prefixed by `PUSHER_CHANNEL_PREFIX` like every
  other channel). Account, not team, because the heartbeat row, claim limits
  and the existing `runner-<accountId>` nudge channel are already
  account-scoped, so no new join is needed to authorise it, and members per
  channel stay small. A team channel would put every runner of every account in
  one channel and make each join/leave fan out to all of them. Pusher caps a
  presence channel at 100 members; an account has a handful of runners, and the
  join auth refuses (HTTP 403) beyond a runner cap well under that limit so one
  account can never hit the provider limit.
- **Presence member = runner instance.** `user_id` is `runnerBeatId`'s
  `localUiUrl` half (the same key as the `worker_heartbeats` unique pair); the
  auth response's `user_info` carries nothing else. Two runners of one account
  are two members; one runner's reconnect is the same member.
- **The channel carries no application events.** Nothing is ever triggered on
  it; it exists for membership only. Existing task/worker/nudge channels are
  unchanged. This keeps it out of the message-quota failure mode of #5079
  (unconditional per-PATCH events exhausting the daily quota).
- **Cost budget.** Each runner connect or disconnect produces one
  `member_added`/`member_removed` webhook and, per other subscriber on the
  channel, one fan-out message. Subscribers are the account's runners only (the
  dashboard does not join). Cost is therefore O(connection changes x runners
  per account), independent of time, versus the 60 s ping's O(runners x 1440)
  requests per day. The rollout PR MUST record the before/after message
  accounting in its task, not in the repo.
- **Auth.** The runner subscribes with Pusher's channel authorization pointed
  at a new route, POST /api/pusher/auth (there is no Pusher auth route today;
  every existing channel is public). It authenticates the runner's `bld_`
  key, accepts only `presence-runner-<accountId>` for that key's own account,
  and signs with `pusher.authorizeChannel`, returning the `user_id` above. It
  never signs any other channel.
- **Webhook.** New route POST /api/webhooks/pusher verifies
  `X-Pusher-Key` and the HMAC-SHA256 `X-Pusher-Signature` over the raw body
  with the Pusher secret, rejects a bad signature with 401 before parsing, and
  handles `member_added` / `member_removed` events (Pusher batches events in one
  POST). It maps `user_id` to the `(accountId, localUiUrl)` row and records
  `connected` plus presenceChangedAt (a small column set on
  `worker_heartbeats`, no new table).
- **Only a state change writes.** The write is a conditional
  `UPDATE ... WHERE connected IS DISTINCT FROM <new>` (atomic, no
  transaction), so a duplicate delivery writes nothing. Pusher does not
  guarantee ordering, and a reconnect can deliver `member_removed` after the
  new `member_added`; each event carries `time_ms`, and the update applies only
  when `time_ms` is newer than presenceChangedAt. A removal is additionally
  confirmed against Pusher's channel-users API before it marks the runner
  offline when it arrives within a few seconds of an add for the same member
  (reconnect flap).
- **Online now = connected AND non-stale beat.** One shared helper (beside
  `withLiveRunnerBeats` in `apps/web/src/lib/runner-beats.ts`) folds the two
  signals; dispatch wake routing, `POST /api/workers/claim`, `GET
  /api/workers/active`, `list_runners` and the Health tab MUST read it and MUST
  NOT hand-roll either half. "Non-stale beat" is a window of the fallback ping
  plus slack, so a connected runner whose content has not changed for a long
  time still counts.
- **Old runners (rollout).** A runner build that never joins presence and
  still pings every 60 s keeps working: the server keeps accepting the beat,
  and the fold falls back to beat-only (`RUNNER_LIVE_WINDOW_MS`) for any runner
  with no presence record. A runner is "presence-aware" once it has ever
  connected; from then on a missing connection means offline.
- **Wedged but connected.** Presence says the process holds a socket, not that
  it is working. A runner that is connected but whose workers stop PATCHing
  still goes stale through the existing worker-PATCH stale detection
  (`WORKER_STALE_REAP_MS`, leases, `stale-workers.ts`). Those thresholds are
  NOT loosened by this revision and presence never keeps a worker alive.
- **Runner-side health.** The DEGRADED detector (`heartbeatState` in
  `apps/runner/src/claim-budget-signals.ts`, `SERVER_CONTACT_STALE_MS` 5 min)
  treats "Pusher connected and nothing to report" as healthy: with the 60 s
  ping gone, server contact legitimately goes quiet, so staleness is judged
  from the latest of last HTTP response and last Pusher connection-state
  confirmation, not from HTTP traffic alone. A claim-5xx streak still
  degrades. This composes with the two-tier stale detection (task `0ccffc53`):
  tier one is the connection, tier two is worker progress.
- **Kill-process offline.** Pusher removes a member when its socket drops or
  its ~30 s activity timeout lapses, so a killed process is offline within
  about a minute without any beat being missed.
- **Removal order.** The fixed 60 s ping is removed only after the auth route,
  the webhook and the online-now fold are live and the fold's old-runner path
  is verified; the hourly aligned tick is kept.

**Acceptance criteria**:
- AC-30: WHEN POST /api/webhooks/pusher receives a body whose signature does
  not verify THEN it returns 401 and writes nothing.
- AC-31: WHEN a signed `member_added` arrives for a runner THEN its row is
  marked connected with presenceChangedAt; WHEN the same event is delivered
  again, or an older `member_removed` arrives after it, THEN no write occurs.
- AC-32: WHEN an account has two runners and one disconnects THEN only that
  runner (by `user_id`) is marked disconnected.
- AC-33: WHEN a runner is connected and its last beat is within the fallback
  window THEN it is online now; WHEN either half fails THEN it is not.
- AC-34: WHEN a runner has no presence record and beats every 60 s (old build)
  THEN it is online now by the beat-only rule and its beats are still accepted.
- AC-35: WHEN a presence-connected runner has nothing to report THEN it sends
  no heartbeat until the fallback ping, and the runner's DEGRADED detector does
  not fire.
- AC-36: WHEN Pusher is unreachable THEN the runner's fallback ping keeps the
  beat non-stale and the server marks it online by the beat-only rule after
  the presence signal is judged unavailable.
- AC-37: WHEN a runner process is killed THEN it reads offline within about one
  minute.
- AC-38: WHEN a task is created for an online presence-connected runner THEN
  the dispatch wake reaches it with no added latency versus today (the wake
  does not wait for a beat).
- AC-39: WHEN POST /api/pusher/auth is asked for any channel other than the
  caller's own account's presence channel THEN it refuses with 403.
- AC-40: WHEN a connected runner's workers stop PATCHing THEN stale detection
  reaps them on the unchanged thresholds.

**Code surface** (to be built after approval):
- apps/web/src/app/api/pusher/auth/route.ts,
  apps/web/src/app/api/webhooks/pusher/route.ts
- `apps/web/src/lib/runner-beats.ts` (online fold),
  `packages/shared/src/runner-liveness.ts` (windows, fallback ping)
- `apps/runner/src/workers.ts`, `apps/runner/src/index.ts`,
  `apps/runner/src/claim-budget-signals.ts`

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
