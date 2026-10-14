---
title: Runner Model Auth Source
status: active
owner: max
last_verified: 2026-10-14
summary: A runner MUST detect the model login on its own machine, use it with no setup, say which one it uses, and report that label (never the value) to the server.
domain: runners
surfaces: [apps/runner/src/host-seat.ts, apps/runner/src/workers.ts, apps/web/src/app/api/workers/heartbeat/route.ts, apps/cloud-runner/src/owner-seat.ts]
related: [runner-liveness, credential-isolation, real-and-virtual-cost, auth-oauth-boundaries]
keywords: [host seat, claude login, codex login, codex_auth_source, codexAuthSource, setup-token, CLAUDE_CODE_OAUTH_TOKEN, BUILDD_HOST_SEAT, owner seat, keychain, hasClaudeCredentials, model_auth_source, detectModelAuthSource]
verified_by: [apps/runner/__tests__/unit/model-auth-detect.test.ts, apps/web/src/app/api/workers/heartbeat/route.test.ts, apps/web/src/app/app/(protected)/settings/_lib/model-auth-label.test.ts, apps/web/src/app/app/(protected)/settings/RunnerTokensSection.dom.test.tsx, apps/web/src/app/app/(protected)/settings/runners/qa-state.test.ts, apps/web/src/app/api/workers/active/route.test.ts, packages/core/__tests__/mcp-tools-list-runners.test.ts, apps/cloud-runner/src/owner-seat.test.ts]
assertions:
  - id: detector
    type: symbol
    name: detectModelAuthSource
    path: apps/runner/src/host-seat.ts
  - id: detector-tests
    type: test_file
    path: apps/runner/__tests__/unit/model-auth-detect.test.ts
  - id: heartbeat-route
    type: route
    method: POST
    path: /api/workers/heartbeat
    file: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: heartbeat-reads-label
    type: symbol_reachable
    symbol: isRunnerModelAuthSource
    entry: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: stored-column
    type: config_key
    key: model_auth_source
    file: packages/core/db/schema.ts
  - id: settings-label
    type: symbol
    name: modelAuthLabel
    path: apps/web/src/app/app/(protected)/settings/_lib/model-auth-label.ts
  - id: heartbeat-reads-codex-label
    type: symbol_reachable
    symbol: isRunnerCodexAuthSource
    entry: apps/web/src/app/api/workers/heartbeat/route.ts
  - id: stored-codex-column
    type: config_key
    key: codex_auth_source
    file: packages/core/db/schema.ts
  - id: settings-codex-label
    type: symbol
    name: codexAuthLabel
    path: apps/web/src/app/app/(protected)/settings/_lib/model-auth-label.ts
---

# Runner Model Auth Source

**Capability statement**: A runner on someone's machine MUST use that machine's
own Claude login for its agents without extra configuration. It MUST say which
credential it uses, at startup and in the dashboard. The server MUST learn
which *kind* of credential it is, and never the credential itself.

buildd does not provide model access (CLAUDE.md, Auth Model). A subscription
login stays on the machine that owns it. This spec covers how that machine-side
login is found, named and reported. It does not move the login anywhere.

## Sources

A runner reports one of these, in this order of precedence. The reported label
is the one the agent would authenticate with for a claim that delivers no
credential.

| Label | Detected when | Dashboard words |
|---|---|---|
| `machine_token` | `CLAUDE_CODE_OAUTH_TOKEN` set in the runner env (`claude setup-token`) | Uses a Claude token set on this machine |
| `machine_login` | `claude login` as the runner user: `~/.claude/.credentials.json` with a `claudeAiOauth` entry, or the macOS `Claude Code-credentials` keychain item | Uses this machine's Claude login |
| `api_key` | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` reaches the agent | Uses an API key (billed per token) |
| `none` | none of the above | No model login on this machine. Run `claude login` |

`BUILDD_HOST_SEAT=off` withholds only the env token from the agent, so
`machine_token` is never reported under it. A `claude login` still reaches the
agent through its home directory, so it is still reported as `machine_login`.
The mode (`auto` / `prefer` / `off`) is reported next to the label.

## Invariants

- Detection MUST go through one path: `detectModelAuthSource` and the agent
  env decision (`applyHostSeatPolicy`) both build on `detectHostSeat`, so the
  startup message, the heartbeat label and what the agent gets never disagree.
  The legacy hasClaudeCredentials check is gone.
- A stub `oauthAccount` in `~/.claude.json`, or a credentials file holding only
  MCP OAuth entries, MUST NOT count as a login.
- No token, key or keychain secret MUST appear in the heartbeat payload, the
  `worker_heartbeats` row, a log line or the runner's local `/api/config`
  response. Only the label and mode do.
- A heartbeat that omits the field MUST NOT clear the stored label. Old runners
  that never send it show "not reported", not `none`.
- The reported label is informational. It MUST NOT change claim limits or
  `accounts.authType` in this spec.

## Acceptance criteria

- AC-1: GIVEN macOS with the keychain item present and no `.credentials.json`
  WHEN the runner starts THEN it logs `Model auth: this machine's Claude login`
  and the heartbeat carries `modelAuthSource: machine_login`.
- AC-2: GIVEN `CLAUDE_CODE_OAUTH_TOKEN` set and a `claude login` also present
  WHEN detection runs THEN the label is `machine_token`.
- AC-3: GIVEN only `~/.claude.json` with `oauthAccount.accountUuid` and no
  credentials file, keychain item or env var WHEN detection runs THEN the
  label is `none` and startup prints how to fix it (`claude login`,
  `claude setup-token` for headless, or `ANTHROPIC_API_KEY` for metered).
- AC-4: GIVEN `BUILDD_HOST_SEAT=off`, `CLAUDE_CODE_OAUTH_TOKEN` set and a
  `claude login` WHEN detection runs THEN the label is `machine_login`; with the
  token and no login it is not `machine_token`.
- AC-5: GIVEN a heartbeat with `modelAuthSource: api_key` WHEN `POST
  /api/workers/heartbeat` handles it THEN the runner's `worker_heartbeats` row
  stores `api_key`. A later heartbeat without the field leaves it `api_key`.
- AC-6: GIVEN a heartbeat with an unknown label (e.g. a token string) WHEN the
  route handles it THEN nothing is stored for that field and the heartbeat
  still succeeds.
- AC-7: GIVEN a runner row with `machine_login` WHEN the owner opens Settings ›
  Runners THEN the row reads "Uses this machine's Claude login". With `none`
  it reads the fix-it line as a warning.

## Cloud runner (self-hosted on Cloudflare)

This already works the same way and needs no change here. The deployer sets
their own `claude setup-token` value as the Worker secret
`CLAUDE_CODE_OAUTH_TOKEN` (`wrangler secret put`, or the deploy script's
`--owner-seat`). `ownerSeatEnabled` turns it on from the secret alone. It is
off on managed runners (`MANAGED_CLOUD_RUNNER=1`). The egress handler injects
it, so the container never sees it, and each run report carries
`modelAuth: owner_seat`, which is the cloud form of `machine_token`.

- AC-8: GIVEN the Worker secret is set and `MANAGED_CLOUD_RUNNER` is unset WHEN
  a run's model route resolves to the seat THEN its run report carries
  `modelAuth: owner_seat`, and the claim and container env carry no token.

## Codex

The same detection path also names the runner's Codex login. Codex is
optional, so `none` is not a warning anywhere.

- R-10: Detection follows the rules `decideCodexSeat` uses for a Codex task
  with no delivered credential: `machine_login` (a `codex login` with a ChatGPT
  login in `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`), `api_key` (that
  file holds an API key, or `OPENAI_API_KEY` is set), `none`. Under
  `BUILDD_HOST_SEAT=off` the machine's `codex login` counts only through an
  explicitly set `CODEX_HOME`. The file is read for which kind of login it
  holds, never for a value.
- R-11: Startup prints a second line, `Codex auth: <words>`. With `none` it
  says the fix: run `codex login` as the runner user, or set `OPENAI_API_KEY`.
- R-12: The heartbeat carries the label as `codexAuthSource`, under the
  no-secret rule above. The server stores it in
  `worker_heartbeats.codex_auth_source` by the same rules as the Claude label:
  unknown dropped, omitted keeps the stored value, never sent shows nothing.
- R-13: The runner row in Settings shows the Codex label on its own line only
  when it is not `none`: "Codex: uses this machine's Codex login" or "Codex:
  uses an OpenAI API key (billed per token)". `none` and not reported show
  nothing, so a Claude-only runner looks as it does today.

- AC-10: GIVEN `~/.codex/auth.json` with a ChatGPT login and no `CODEX_HOME`
  THEN the Codex label is `machine_login`; under `BUILDD_HOST_SEAT=off` it is
  `none`, and with `CODEX_HOME` set to that directory it is `machine_login`.
- AC-11: GIVEN an auth.json holding only an API key, or no file and
  `OPENAI_API_KEY` set THEN the label is `api_key`, and neither value appears in
  the serialized heartbeat.
- AC-12: GIVEN a heartbeat with Codex `machine_login` and then one without the
  field THEN the stored label is `machine_login`; a token-shaped value stores
  nothing and returns 200.
- AC-13: GIVEN a runner row with Codex `none` THEN no Codex line shows; with
  `machine_login` THEN "Codex: uses this machine's Codex login" shows.
- AC-14: GIVEN the runner's local config endpoint THEN it carries the Claude
  and Codex labels and no `hasClaudeCredentials` field.

## Code surface

- Detection: `apps/runner/src/host-seat.ts` (`detectModelAuthSource`, `describeModelAuthSource`, `detectHostSeat`)
- Startup + agent env: `apps/runner/src/workers.ts` (startup `Model auth:` line, `applyHostSeatPolicy` call site)
- Heartbeat client: `apps/runner/src/buildd.ts` (heartbeat payload)
- Heartbeat route: `apps/web/src/app/api/workers/heartbeat/route.ts`
- Storage: `workerHeartbeats` in `packages/core/db/schema.ts`
- Display: `apps/web/src/app/app/(protected)/settings/RunnerTokensSection.tsx` (`codexAuthLabel` in `_lib/model-auth-label.ts` for the Codex line)
- Readers: `GET /api/workers/active` and `list_runners` (`codexAuth=` only when reported)
- Cloud: `apps/cloud-runner/src/owner-seat.ts` (`ownerSeatEnabled`), `apps/cloud-runner/src/run-report.ts`

## Out of scope

- Deriving claim limits or `authType` from the reported label (follow-up once
  the label is trusted in production).
- Hiding a `claude login` from the agent under `off`.
- Ingesting the cloud run report's `modelAuth` into the runner row.
- Codex on the Cloudflare runner (it runs Claude only).
- Removing server-held subscription seats (`knowledge-base: buildd/plans/seat-custody-removal.md`).
- Checking that a detected login actually works (an expired login still
  reports `machine_login`).
