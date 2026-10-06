---
title: Provider-Backed Browser for Visual Review
status: draft
owner: max
last_verified: 2026-10-05
summary: The visual-auditor role MUST be eligible exactly when a selected browser provider (local Chromium or a Cloudflare session) proves it works, and MUST be able to review a Buildd service booted inside its own sandbox.
domain: runners
surfaces: [apps/runner/src/browser-capability.ts, apps/runner/src/role-advertising.ts, apps/cloud-runner/src/egress.ts, scripts/qa/capture.ts]
related: [qa-capture-steps, worker-sandbox-isolation, credential-isolation, cloud-egress-merge-guard, runner-liveness]
keywords: [visual-auditor, browser capability, BrowserProvider, Browser Rendering, Browser Run, CDP, connectOverCDP, browser bridge, buildd-browser.invalid, local service, serve-local, provider_unavailable, session_lost, service_unreachable, CAPABILITY_BROWSER]
supersedes: []
---

# Provider-Backed Browser for Visual Review

This is the contract the implementation task builds against. It is a **draft**: names
that do not exist in code yet are the names the implementation MUST use, and
`specs:lint` reports them as warnings until they land. Promote to `active` (with
`verified_by`) in the PR that ships Phase 3 below.

Background, read first: `knowledge-base: buildd/design/visual-qa-auditor.md` (the
role, the evidence check, the fix/round loop, page source) and
`knowledge-base: buildd/design/cloudflare-sandbox-runner.md` (`WorkerAgent`, egress
interception, the `buildd-snapshots.invalid` pseudo-host pattern). This spec reverses
one non-goal of the auditor design ("hosted browser services") and nothing else.

## 1. Problem and decision in one paragraph

Today "can run a visual audit" means "a Chromium binary on this host launched"
(`detectBrowser` in `apps/runner/src/browser-capability.ts`). A cloud-runner container
(`apps/runner/Dockerfile.once`) has no Chromium, and adding one plus `next dev` plus a
database to a `standard-1` instance (4 GiB) is the expensive option. So
browser capability becomes **provider-backed**: a runner advertises `browser` (and so
the `visual-auditor` slug) when its *selected provider* proves it can drive a browser.
There are two providers. **`local`** is today's path, unchanged. **`cloudflare`** is a
Browser Rendering (Browser Run) session that the task's `WorkerAgent` Durable Object
owns through a Workers *binding*. The container gets only a loopback CDP endpoint.
The remote browser reaches the Buildd service booted inside the container because
the Durable Object, which already sits in the CDP path, fulfils that browser's
requests for the service origin by fetching from the container port. No public
ingress to the sandbox exists, and no Cloudflare credential exists in the container.

## 2. Current state (what is reused unchanged)

- **Truthful local probe.** `detectBrowser` / `detectBrowserAsync` launch-probe a real
  binary, and `applyBrowserCapability` folds the result into `envKeys` as
  `CAPABILITY_BROWSER`. `rescanBrowserCapability` re-runs it every
  `BROWSER_RESCAN_INTERVAL_MS`. `applyAgentPlaywrightEnv` points the agent's Playwright
  at the build that passed.
- **Role advertising.** `advertisedRoleSlugs` returns `[VISUAL_AUDITOR_ROLE_SLUG]` iff
  `envKeys` has `browser`. `EXPLICIT_ROLE_SLUGS` makes the claim role gate
  (`apps/web/src/app/api/workers/claim/role-gate.ts`) require that explicit match.
  The server only ever reads `envKeys.includes(CAPABILITY_BROWSER)`
  (`browserRunnerOnline` in `apps/web/src/lib/visual-audit-runner.ts`, `GET /api/workers/active`).
- **Capture.** `scripts/qa/capture.ts` launches Chromium, logs in with
  `dev-auto-login` or skips login (`QA_NO_LOGIN`), records `pageerror` / console
  errors, aborts writes (`blockedWrites`), and writes `captures.json`.
  `scripts/qa/shoot.sh` boots `next dev` with `NODE_ENV=development`,
  `DISABLE_WRITES=true` and `DEV_USER_EMAIL`, and waits on `/api/version`.
- **Synthetic data.** `scripts/demo/` runs loopback Postgres (pgvector) behind a
  local neon-http proxy (`NEON_LOCAL_FETCH_ENDPOINT`, `packages/core/db/neon-local.ts`,
  which refuses non-loopback hosts), migrates, and seeds a placeholder story
  (`scripts/demo/seed.ts`).
- **Cloud runner.** `WorkerAgent` (`apps/cloud-runner/src/worker-agent.ts`) is named by
  task id, starts the container, and installs per-host egress interception
  (`installEgressHandlers` → `EgressHandler` in `egress.ts`, with `EgressProps.taskId`
  set by the agent, never by the container). `buildContainerEnv` (`lifecycle.ts`)
  gives the container a per-task token and nothing else credential-shaped.
- **Evidence + loop.** Screenshots are `upload_artifact` rows with
  `metadata.qa = { runKey, route, viewport, finding, verdict, source, ref, refSource, state? }`,
  checked by `loadVisualAuditEvidence`. `issue` → `[surface fix]` task, `unsure` →
  question, boot failure → `AskUserQuestion`. All of it is reused as is.

## 3. BrowserProvider contract

Smallest abstraction that keeps the current behaviour: a provider is something the
**runner** can probe and something the **agent** can connect Playwright to. The rest
of `capture.ts` (contexts, viewports, routes, steps, write guard) is provider-agnostic
because both providers end in a Playwright `Browser`.

### 3.1 Runner side (`apps/runner/src/browser-provider.ts`, new)

```ts
export type BrowserProviderName = 'local' | 'cloudflare';

export interface BrowserProbeResult {
  provider: BrowserProviderName;
  ok: boolean;
  /** Stable code when !ok, from the failure table in §9. */
  code?: BrowserFailureCode;
  /** One line, no secrets: path tried, HTTP status, CDP error text. */
  detail?: string;
  checkedAt: string;          // ISO
  latencyMs?: number;
  /** cloudflare only: opaque session handle (never the token). */
  handle?: string;
  browserVersion?: string;
}

export interface BrowserProvider {
  name: BrowserProviderName;
  /** True when this provider is configured on this host at all (cheap, no I/O). */
  configured(env: NodeJS.ProcessEnv): boolean;
  /** Prove a usable session: launch or acquire, and do one real CDP round trip. */
  probe(): Promise<BrowserProbeResult>;
  /** Env the agent subprocess gets so the QA helper can connect (§3.2). */
  agentEnv(result: BrowserProbeResult): Record<string, string>;
}

export function selectBrowserProvider(env: NodeJS.ProcessEnv): BrowserProvider | null;
```

- `localBrowserProvider` wraps today's code with **no behaviour change**:
  `probe()` = `detectBrowserAsync()` (startup keeps the synchronous `detectBrowser`),
  `ok` = `available`, `detail` = `formatBrowserDetection`, and `agentEnv` = what
  `applyAgentPlaywrightEnv` sets today plus `BUILDD_BROWSER_PROVIDER=local`.
- `cloudflareBrowserProvider` is `configured` iff `BUILDD_BROWSER_BRIDGE_URL` is set
  (only `buildContainerEnv` sets it, §5.4). `probe()` calls the bridge
  `POST /v1/session` then `GET /v1/probe` (§5.3).
- **Selection** (`BUILDD_BROWSER_PROVIDER` = `auto` default | `local` | `cloudflare` | `none`):
  explicit value wins; `auto` picks `cloudflare` when configured, else `local`.
  Exactly one provider is selected per runner process. There is no silent fallback
  from a failed `cloudflare` probe to `local` (or back): a failed selected provider
  means "no browser", reported with its code. Rationale: a fallback would make the
  recorded provider a guess, and §8 needs it to be a fact.
- **Capability** = `applyBrowserCapability(env, result.ok)` on the selected
  provider's result. `CAPABILITY_BROWSER` keeps its meaning ("this runner can drive
  a browser now") and its key, so `advertisedRoleSlugs`, the role gate and
  `browserRunnerOnline` do not change.
- **Detail on the heartbeat**: `WorkerEnvironment` gains optional
  `browserProvider?: BrowserProbeResult` (in `packages/shared/src/types.ts`). It is
  display and diagnosis only; nothing gates on it.

### 3.2 Agent side (`scripts/qa/browser-provider.ts`, new)

The one place the skill and `capture.ts` touch a provider:

```ts
export async function connectReviewBrowser(): Promise<{ browser: Browser; provider: BrowserProviderName; handle?: string }>;
export async function exposeService(opts: { port: number; readyPath?: string; timeoutMs?: number }): Promise<ServiceMapping>;

export interface ServiceMapping {
  provider: BrowserProviderName;
  bindUrl: string;      // where the service listens inside the sandbox
  browserUrl: string;   // the URL the review browser must navigate
  readyPath: string;
  readyAfterMs: number;
}
```

- `local`: `chromium.launch({ headless: true, args: [...] })` with today's flags.
  `exposeService` polls `bindUrl + readyPath` and returns `browserUrl === bindUrl`.
- `cloudflare`: `chromium.connectOverCDP(process.env.BUILDD_BROWSER_CDP_URL)`.
  `exposeService` polls locally, then `PUT ${BUILDD_BROWSER_SERVICE_API}/services/<port>`
  so the bridge confirms it can reach the port **from outside the container**. It
  returns `browserUrl === bindUrl` too (§6.2 explains why that holds).
- Both providers return the same `browserUrl`, so `QA_BASE_URL` and every route in
  a capture plan are identical under either provider. `capture.ts` replaces its
  `chromium.launch` block with `connectReviewBrowser()`. Nothing else in it branches
  on provider, except that it records the provider fields (§8).
- With `BUILDD_BROWSER_PROVIDER` unset (a human running `shoot.sh`), the helper
  behaves as `local`. Existing local use keeps working with no env changes.

## 4. Eligibility: how `visual-auditor` derives from provider health

| Runner | Provider selected | When probed | `browser` in `envKeys` iff |
|---|---|---|---|
| Coder / host runner | `local` | startup (sync), then every `BROWSER_RESCAN_INTERVAL_MS` (async) | the launch probe passed, which is today's rule |
| Cloud `--once` container | `cloudflare` | once, before the claim, **only** when the task it was dispatched for has `roleSlug` in `BROWSER_ROLE_SLUGS` (`['visual-auditor']`) | `POST /v1/session` + `GET /v1/probe` both succeeded |
| Cloud `--once`, any other role | `cloudflare` (not probed) | never | never (it does not need the slug) |

- The cloud runner reads its own task (the per-task token already permits a read of
  that task) to learn `roleSlug` before it claims. So a builder task never acquires a
  billed browser session. The webhook payload is not trusted for this.
- **Configuration is never capability.** A container with `BUILDD_BROWSER_BRIDGE_URL`
  set and a failed probe advertises nothing. A host whose Chromium binary exists but
  does not launch advertises nothing, as today.
- **A failed probe on a browser-role task is loud.** The runner still sends the claim
  with its environment (`claimTask` already carries `this.environment`). The role
  gate refuses it. The claim route MUST then record the refusal on the task as
  `context.visualQa.lastBrowserRefusal = { provider, code, detail, at, runnerGroup }`
  (newest wins, at most one write a minute). The mission's Visual review step shows
  it beside the existing "no browser-capable runner online" line. The container
  exits `EXIT_REFUSED` (3) after printing `BUILDD_BROWSER_PROBE=<code>`, and
  `WorkerAgent` puts that line in its run report.
- **Elastic groups in the "online" check.** `browserRunnerOnline` keeps its current
  rule for host runners. A cloud group has no standing heartbeat, so the group
  counts as browser-capable for display when its newest run in the last 24 h reported
  `browserProvider.ok`. It is display only, like the rest of that function.

## 5. Cloudflare architecture

```
 task container (no CF credential)                 WorkerAgent DO (named by taskId)            Cloudflare
 ┌─────────────────────────────────┐   egress      ┌───────────────────────────────────┐       ┌──────────────┐
 │ agent: Playwright.connectOverCDP│──ws://127.0.0.1:<shim>/cdp                        │ env.  │ Browser      │
 │                                 │   ▼           │ BrowserBridge                     │BROWSER│ Rendering    │
 │ runner shim (owns session token)│──https://buildd-browser.invalid/v1/* ─────────────▶│ ─ session (acquire/keep/close)    │──────▶│ session      │
 │                                 │   (intercepted, EgressProps.taskId)                │ ─ CDP relay + Fetch mediation     │◀──────│ (headless    │
 │ bun dev on 0.0.0.0:<port>   ◀───┼───────────────── ctx.container.getTcpPort(port) ───│ ─ service map, allowlist, caps    │       │  Chromium)   │
 │ loopback Postgres + neon proxy  │               │ ─ evidence counters               │       └──────────────┘
 └─────────────────────────────────┘               └───────────────────────────────────┘
```

### 5.1 Who holds what

- **The `WorkerAgent` Durable Object owns the browser.** `wrangler.jsonc` gains a
  `"browser": { "binding": "BROWSER" }` binding. A binding is not an API token: the
  Worker holds no Cloudflare API credential for this feature, and the container
  holds none at all. The REST / WebSocket "Browser Run" endpoints that need an
  account API token are **not used** (§11).
- A new class `BrowserBridge` (in `apps/cloud-runner/src/browser-bridge.ts`) lives in
  the agent, beside the existing `ContainerPort` seam. It reaches the browser through
  a `BrowserPort` seam (acquire, open devtools socket, close), so Bun tests can drive
  it with a fake browser, as `supervisor.test.ts` drives a fake container.
- The relay speaks the binding's devtools transport, including its message chunking
  for large frames, by reusing the transport from `@cloudflare/playwright` /
  `@cloudflare/puppeteer` rather than reimplementing it (spike S1).

### 5.2 The task-facing bridge: transport and auth

- **Pseudo-host.** `buildd-browser.invalid`, intercepted like `buildd-snapshots.invalid`
  (`installEgressHandlers` adds it when `BROWSER_BRIDGE=1` and the binding exists).
  `classifyEgressHost` returns a new kind `'browser'`; `EgressHandler` hands it to the
  agent named by `EgressProps.taskId`. **The task id comes from the interception,
  never from the request.** A container can only ever reach its own agent.
- **Session token.** `buildContainerEnv` adds `BUILDD_BROWSER_SESSION_TOKEN` (32 random
  bytes, base64url, minted per run, stored hashed in the agent). Every bridge request
  carries `Authorization: Bearer <token>`, which is checked in constant time. The
  token is a second factor on top of the interception identity. It is useless
  outside this container, because only this container's egress reaches this agent.
  It dies when the run ends.
- **Runner shim.** The runner (`buildd-once`) holds the token and serves a loopback
  listener on an ephemeral port. It exposes `ws://127.0.0.1:<p>/cdp` and a plain-HTTP
  proxy of the session API at `http://127.0.0.1:<p>/v1/*`, adding the bearer itself.
  The agent gets `BUILDD_BROWSER_CDP_URL` and `BUILDD_BROWSER_SERVICE_API`, never the
  token, and `BUILDD_BROWSER_SESSION_TOKEN` is removed from the agent env by
  `agent-env.ts`. This also makes the agent contract independent of how the shim reaches
  the agent: a WebSocket through outbound interception if spike S2 passes, else the DO
  dials into the shim with `getTcpPort(<p>).fetch(<upgrade>)` after a plain-HTTPS
  `POST /v1/attach` signal. The task never sees which.
- The agent and runner share a uid in the container, so the token is not secret from
  a determined agent. That is accepted: it grants exactly the agent's own session.

### 5.3 Session API (served by `BrowserBridge`, all JSON, all bearer-authenticated)

| Method + path | Does | Errors |
|---|---|---|
| `POST /v1/session` | Acquire the run's browser session, or return the live one. → `{ handle, provider: 'cloudflare', browserVersion, expiresAt }` | `provider_missing` (no binding), `provider_capacity` (acquire refused or rate-limited), `provider_handshake_failed` |
| `GET /v1/probe` | One CDP round trip on the live session: `Browser.getVersion`, then create and close an `about:blank` target. → `BrowserProbeResult` | `session_lost`, `provider_handshake_failed` |
| `GET /v1/cdp` (WebSocket) | The CDP relay (§5.5). Exactly one client at a time. | 409 `cdp_client_busy`; close code 4001 `session_lost` |
| `PUT /v1/services/:port` body `{ readyPath }` | Register a service port. The agent `GET`s `readyPath` through `getTcpPort(port)` and expects an HTTP answer below 500. → `{ bindUrl, browserUrl, reachable: true, status, latencyMs }` | 400 `port_not_allowed`, 409 `service_limit`, 502 `service_unreachable` |
| `DELETE /v1/services/:port` | Unmap the port. | — |
| `GET /v1/evidence` | Counters since the session started: requests served per mapped origin, bytes, blocked destinations `[{ origin, count }]`, relay errors. | — |
| `DELETE /v1/session` | Close the browser and revoke the session. | — |

`handle` is an opaque `brs_<12 base32>` minted by the agent. The Browser Rendering
session id never leaves the agent.

### 5.4 Container env (from `buildContainerEnv`, only when `BROWSER_BRIDGE=1` and the binding exists)

`BUILDD_BROWSER_BRIDGE_URL=https://buildd-browser.invalid`,
`BUILDD_BROWSER_SESSION_TOKEN=<per-run>`. Nothing else. The existing
`CONTAINER_CREDENTIAL_HEADERS` / `stripContainerCredentials` discipline applies, and
the bridge never forwards any container header to the browser binding.

### 5.5 CDP relay and request mediation

The relay passes CDP frames between the task's client and the browser unchanged,
**except for the Fetch domain, which it owns**:

1. On every `Target.attachedToTarget` (flattened sessions, as Playwright uses), the
   relay sends its own `Fetch.enable { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }`
   on that session. It holds the client's `Runtime.runIfWaitingForDebugger` for that
   session until the enable is acked, so no request of a new page escapes mediation.
   It does the same for workers and OOPIF targets.
2. The client's own `Fetch.enable` / `Fetch.disable` are **recorded, not forwarded**:
   the relay keeps the client's patterns per session and answers the call itself.
3. On `Fetch.requestPaused`: if the client's recorded patterns match, the relay
   forwards the event to the client and waits for its decision. Playwright's
   `page.route`, and so capture.ts's write guard, keeps working. The client's
   `failRequest` / `fulfillRequest` pass through. A client `continueRequest`, or no
   client pattern match, goes to the relay's **routing decision**:
   - **Mapped origin** (`http://127.0.0.1:<port>` or `http://localhost:<port>` for a
     registered port): fetch it from `getTcpPort(port)` with the method, headers and
     body, and answer `Fetch.fulfillRequest` with the status, headers and body. The
     request leaves Cloudflare's network for no host but the agent's own container.
   - **Allowlisted** (§7): `Fetch.continueRequest`.
   - **Anything else**: `Fetch.failRequest { errorReason: 'BlockedByClient' }`, counted
     in evidence as `blocked`.
4. The relay also sets `Network.setBlockedURLs(['ws://*', 'wss://*'])` per session.
   Fetch does not see WebSocket handshakes, and the only WebSocket the app opens is
   Next's HMR, which the review does not need (spike S3 verifies both).
5. **Denied client methods** (answered with a CDP error, logged): `Target.createBrowserContext`
   with `proxyServer` or `proxyBypassList` (the params are stripped and the call
   proceeds), `Browser.setDownloadBehavior`, `Network.setBlockedURLs` (the relay owns
   it), `Target.exposeDevToolsProtocol`, `Browser.close` (it maps to "end this client
   connection"; the session stays for the next connect).
6. **Fail closed.** If the relay's Fetch session on any target is lost or errors, the
   relay closes the client connection with `session_lost`. It never leaves a page
   running unmediated.

Spike S4 decides whether rule 3's merge is needed at all, or whether Chromium already
stacks a relay-level and a client-level interception correctly. Either way the
observable contract is the same: client routes see requests first, and only the relay
decides network reachability.

## 6. Local service: boot, networking, readiness

The task must boot Buildd **from its own worktree** and review that exact service. A
deployed preview is never required and never substituted (`qa.source` stays `sandbox`).

### 6.1 Boot (`scripts/qa/serve-local.sh`, new; the same script under both providers)

1. **Data:** start loopback Postgres (pgvector) and the neon-http proxy: with Docker
   via `scripts/demo/docker-compose.yml` when `docker` works (Coder, laptops), else as
   plain processes from binaries baked into the image (cloud container: there is no
   Docker in a container). Migrate with `packages/core` `db:migrate`, then seed with
   `scripts/demo/seed.ts` (default story `scripts/demo/stories/placeholder.json`).
   `neon-local.ts` already refuses a non-loopback `DATABASE_URL` or endpoint, so this
   cannot point at a real database.
   - Optional `QA_DATA=secret`: use a role-mapped non-prod URL
     (`VISUAL_QA_DATABASE_URL`, `role_env_secret`) as the auditor design allows. It is
     not the default and the verification task does not rely on it.
2. **App:** pick a free port (bind to 0, read it back, close). Run `next dev` from the
   worktree with `NODE_ENV=development`, `DISABLE_WRITES=true`,
   `DEV_USER_EMAIL=<the story's owner>`, `PORT=<port>`, and host
   `127.0.0.1` (local provider) or `0.0.0.0` (cloudflare provider, so
   `getTcpPort` can reach it; spike S5). It never reads a checked-in or local `.env`.
3. **Readiness:** poll `/api/version` for up to 300 s, failing early if the server
   process exits. Then call `exposeService({ port, readyPath: '/api/version' })`.
4. **Output:** write `/tmp/qa/service.json`
   `{ bindUrl, browserUrl, port, readyPath, readyAfterMs, data: 'synthetic' | 'secret', story, devUser, provider, handle? }`
   and print one line `[serve] ready <browserUrl> (<provider>)`.
5. **Teardown:** a trap kills the app process group and stops the data plane, then
   `DELETE /services/<port>`.

### 6.2 How the browser reaches it

- **Local Chromium.** Service and browser run on the same host, in the same network
  namespace: both are descendants of the agent process, so they share whatever
  namespace bwrap gives it (`worker-sandbox-isolation`). The browser navigates
  `http://127.0.0.1:<port>` directly. Nothing new.
- **Cloudflare.** The remote browser cannot address the container, and it must not
  be able to. It navigates the **same** URL, `http://127.0.0.1:<port>`. That request
  never reaches the network: the relay pauses it (§5.5), sees a registered port, and
  fulfils it from `ctx.container.getTcpPort(port)`. Consequences:
  - The service is reachable **only** from browser sessions whose requests pass
    through this task's relay, which means only this run's session. No hostname, DNS
    record, tunnel or public route exists to guess or leak.
  - The page origin is `http://127.0.0.1:<port>`, a potentially trustworthy origin,
    under both providers. Cookies, NextAuth (no `AUTH_URL` / `X-Forwarded-Host`
    rewriting) and Next 16's dev-origin check (no `allowedDevOrigins`) behave exactly
    as they do locally. That is why the skill needs no provider-specific steps.
  - Costs: request and response bodies cross CDP as base64. A dev-mode page load is a
    few MB of chunks. The per-request cap is 25 MB and the per-session budget 512 MB,
    both exceeded = `service_unreachable` with detail `body_too_large` /
    `budget_exhausted`. Next's HMR WebSocket is blocked (benign, verified by S3, and
    the dev overlay stays hidden as today).
- **Ports.** Only ports registered through `PUT /v1/services/:port` are mapped: at
  most 4, each from 1024 to 65535, never the shim's own port. Every other
  `127.0.0.1` / `localhost` / RFC 1918 / link-local destination is blocked like any
  non-allowlisted host.

## 7. Dev auth and allowlists

- **Auth** reuses the visual-review approach unchanged. `NODE_ENV=development`
  short-circuits `getCurrentUser` to `DEV_USER_EMAIL` (`apps/web/src/lib/auth-helpers.ts`),
  so `capture.ts` runs with `QA_NO_LOGIN=1`, exactly as `shoot.sh` does. The seeded
  story's owner is the dev user, so authenticated pages render real-shaped
  (synthetic) data. The `dev-auto-login` credentials POST stays available for apps
  that need a cookie. It is a same-origin request to the mapped origin, so it goes
  through the bridge like any other. `VISUAL_QA_STORAGE_STATE` keeps working, since it
  is a Playwright context option. Landing on a sign-in path after this is
  `app_auth_failed`, never a shot.
- **Destination allowlist (cloudflare).** The default is the mapped service origins,
  plus the `data:`, `blob:` and `about:` schemes. A deployment may add exact hosts
  for `GET`/`HEAD` subresources through the Worker var
  `BROWSER_BRIDGE_EXTRA_HOSTS` (comma-separated, no wildcards, https only; for example
  an avatar CDN). Top-level navigations go to mapped origins only, whatever the extra
  list says.
- **Why this is not a general-purpose browser proxy.**
  1. *Confidentiality is structural.* The only privileged thing the bridge offers is
     a path to the container's service, and that path exists only as a fulfil from
     this run's relay. Bypassing the allowlist (a CDP trick the denylist missed) gets
     the remote browser the public internet, which it, and the container, have
     anyway. It does not get any other container, task or private network.
  2. *The allowlist is a policy boundary* against abuse and cost: the team's
     Browser Rendering usage and Cloudflare-egress reputation are not a free proxy for
     arbitrary browsing. That is why top-level navigation is mapped-origins only, and
     why every blocked attempt is counted in evidence.
  3. *Scope is one run.* A session is reachable only from its own container, by its
     own token, for at most the run's lifetime (§8).
- **Local provider:** there is no network enforcement, which is today's behaviour. It
  is the host's own browser, with the host's own reach and no added privilege.
  `GET /v1/evidence` has no local equivalent; the helper reports `blocked: null`.

## 8. Lifecycle, concurrency, cleanup, observability

**Lifecycle (cloudflare).**
- *Acquire* on the first `POST /v1/session`, which is the probe (§4). Probe and use
  are the same session, so a probe that passed is still true when capture starts.
- *Keep alive:* the agent holds the devtools socket open while the run lives. Client
  connects and disconnects (one `capture.ts` invocation each) reuse the session.
- *Idle:* no client connected and no session API call for 10 min → the agent closes the
  browser. The next `POST /v1/session` re-acquires, **at most 3 times per run**; the 4th
  is `provider_capacity`.
- *Hard cap:* 60 min of session time per run, then `session_lost` with detail `ttl`.
- *End:* when the run ends, whatever the outcome (`finish`, the crash path, orphan
  recovery, `killContainer`), the agent closes the browser, drops the service map, and
  forgets the token hash before it destroys the container. A Durable Object restart
  loses the socket. The session then counts as lost, never resumed, and the next
  client call gets `session_lost`.
- *Revocation:* `DELETE /v1/session`, a run ending, or the dispatcher's existing kill
  route revokes at once. A revoked token gets 401 `session_revoked`.

**Concurrency.** One browser session per run (the agent is per task, and a task has at
most one live run). One CDP client per session. Account-wide concurrency is bounded
by the container cap (`max_instances`) and by Browser Rendering's own per-account
browser limits, which surface as `provider_capacity`, never a hang. Local provider:
unchanged, one Chromium per `capture.ts` process.

**Evidence and artifacts.** The flow is unchanged: `capture.ts` writes PNG + a11y +
`captures.json`, and the auditor uploads with `upload_artifact` and files fixes and
questions as today. Additions:
- Each capture in `captures.json` gains `browser: { provider, handle?, probe: { ok, code?, checkedAt }, service: { bindUrl, browserUrl, readyPath, readyAfterMs }, blocked?: [{ origin, count }] }`,
  plus the `consoleErrors` and `pageErrors` (first 20 each, 2000 chars) that
  `capture.ts` already logs, now stored per route.
- The auditor copies `browser` into `metadata.qa.browser` on every shot.
  `metadata.qa.source` keeps meaning *page source* (`sandbox` | `vercel-preview`);
  `qa.browser.provider` is orthogonal, so a reviewer sees both "which build" and
  "which browser".
- The mission lightbox shows provider and `browserUrl` beside route and viewport.
  Screenshots stay private R2 objects. The share refusal and the 30-day `qa/` expiry
  are unchanged.

**Observability / debug fields** (all non-secret):

| Field | Where |
|---|---|
| selected provider, probe result (`BrowserProbeResult`) | heartbeat `environment.browserProvider`; runner log line `[env-scan] browser(<provider>): yes/no — …` |
| refusal on a browser-role task | `context.visualQa.lastBrowserRefusal`; container line `BUILDD_BROWSER_PROBE=<code>`; cloud run report |
| session handle `brs_…`, acquire latency, reacquire count, session seconds | cloud run report (`run-report.ts` gains a `browser` block); `qa.browser.handle` |
| service mapping `bindUrl → browserUrl`, readiness time | `/tmp/qa/service.json`; `qa.browser.service` |
| requests served, bytes, blocked origins, relay errors | `GET /v1/evidence`; run report; `qa.browser.blocked` |
| capture source | `qa.source` (unchanged), `qa.ref`, `qa.refSource` |

## 9. Failure semantics: loud, never a pass

`BrowserFailureCode` is one closed union, shared by the runner, the bridge, the helper
and `captures.json`:

| Code | Raised by | Means | Auditor does |
|---|---|---|---|
| `provider_missing` | runner selection / bridge | no provider configured, or no binding | not eligible (§4); if already running: `AskUserQuestion` |
| `provider_handshake_failed` | probe / `POST /v1/session` / connect | acquire or the CDP round trip failed | same |
| `provider_capacity` | bridge | acquire refused, rate-limited, or the reacquire cap hit | same |
| `service_not_ready` | `serve-local.sh` / `exposeService` | the app did not answer `readyPath` within 300 s, or exited | boot failure: `AskUserQuestion` with the last log lines |
| `service_unreachable` | `exposeService` / relay | ready locally, but the bridge cannot reach the port, or a body or budget cap was hit | same |
| `app_auth_failed` | capture | landed on a sign-in path or `/app/home` check failed | same; no shot uploaded |
| `session_lost` | relay / helper | socket gone, TTL, Durable Object restart, revoked | recapture once after a new `POST /v1/session`; then `AskUserQuestion` |
| `destination_blocked` | relay | a top-level navigation outside the mapped origins | the route is a capture failure (it never shows a blocked page as a shot) |
| `capture_failed` | capture | anything else per route | as today (`error` in `captures.json`) |

Rules:
- `capture.ts` exits non-zero on any provider- or service-level code, and records
  `providerError: <code>` on every route it could not shoot. A route with
  `providerError`, `configError` or `error` has no shot.
- The evidence check (`loadVisualAuditEvidence`) refuses a shot whose
  `qa.browser.probe.ok === false` or that carries `qa.providerError`, and refuses
  `verdict: 'ok'` on any shot without `qa.browser.provider` once Phase 3 ships. So a
  run that never had a working browser cannot complete as a pass, even if the agent
  tries.
- No failure here marks the task `failed`. It parks with `AskUserQuestion`, as the
  auditor design's boot-failure rule already requires. `failed` would release the
  mission gate.

## 10. Threat model and credential boundary

| Asset | Threat | Control |
|---|---|---|
| Team Cloudflare account | container steals a CF API token | None exists: the feature uses a Workers binding; `buildContainerEnv` adds only a bridge URL and a per-run token; a test asserts no `CLOUDFLARE_*` / `CF_*` / `*API_TOKEN*` key in the container env or the agent env |
| Other tasks' browsers / services | container addresses another task's agent or session | Pseudo-host routing uses `EgressProps.taskId` from interception; agent named by task id; token bound to the run; the handle is opaque and not accepted as an address |
| The sandbox service | third party reaches it | No public ingress; reachable only as a relay fulfil for this run's session (§6.2) |
| The container's other ports | bridge used as a port scanner / internal proxy | Only registered ports, ≤ 4, ≥ 1024, not the shim; everything else blocked and counted |
| Team Browser Rendering spend, CF reputation | the session used as a general browsing proxy | Mapped-origin-only navigation, explicit extra hosts for subresources only, 60 min / 512 MB caps, 3 reacquires, browser-role tasks only |
| Mediation itself | client CDP disables interception or adds a proxy | Relay owns Fetch and `setBlockedURLs`; dangerous methods denied or stripped (§5.5); lost mediation closes the session |
| Data in screenshots | real data leaks | Synthetic seed by default; loopback-only DB guard; private R2; share refusal; 30-day expiry (unchanged) |
| Session token | leaked from the container | Worthless outside this container's egress; revoked at run end; never logged (redacted like the task token) |
| The remote browser | hostile page content, since the agent controls the app code | Cloudflare's browser isolation; no credentials in the browser; allowlist limits where a page can send data |

Residual risks, accepted and recorded: an unmediated WebSocket to the remote host's own
loopback if `setBlockedURLs` does not cover it (S3; that is Cloudflare's isolation
boundary, not ours); an agent with the container uid can drive its own session
outside `capture.ts`, which is in scope since that is the agent's own capability.

## 11. Alternatives rejected

- **Chromium inside the cloud container.** Simplest networking, but a `standard-1`
  instance has to hold Claude Code, `next dev`, Postgres and Chromium in 4 GiB. It
  stays possible: `BUILDD_BROWSER_PROVIDER=local` in a bigger image just works, and
  that is the point of the provider seam.
- **Browser Run REST / CDP WebSocket with an account API token.** That puts a broad
  credential on the Worker, or worse in the container. The binding needs none.
- **Public bridge origin** (a Worker route, Cloudflare Tunnel, or the Sandbox SDK's
  `exposePort` preview URLs). Each creates public ingress to the sandbox, guarded by a
  capability in a URL or cookie. Each makes the page origin differ from local, which
  needs Host / `X-Forwarded-Host` rewriting, `AUTH_URL` and `allowedDevOrigins`. Tunnel
  and preview URLs also need DNS or the Sandbox SDK runtime that the cloud-runner
  design rejected. This is the documented fallback only if spikes S1 and S4 both
  fail.
- **A narrow RPC** (`navigate` / `screenshot` / `evaluate`) instead of CDP. It is
  safer by construction, but it forks `capture.ts`, capture plans and steps into a
  second implementation. That is exactly the "second QA subsystem" this mission must
  avoid.
- **A cloud-specific role.** It splits routing, evidence and the human loop. The
  `visual-auditor` slug stays the only one.

## 12. Implementation plan (each step mergeable alone, nothing changes until step 3's flag)

0. **Spikes** (a scratch branch under `wrangler dev` plus one real account, results
   appended to this spec as "Spike results"; a failing spike changes the plan in
   *this file* before code):
   - S1: the agent opens the binding's devtools socket and relays one
     `Browser.getVersion` with large-frame chunking.
   - S2: a WebSocket from the container through `interceptOutboundHttps` works, or else
     DO→container `getTcpPort().fetch` upgrade does.
   - S3: `Network.setBlockedURLs(['ws://*','wss://*'])` blocks a WebSocket handshake to
     `127.0.0.1`.
   - S4: a `connectOverCDP` client's `page.route` plus relay Fetch mediation (§5.5
     rule 3) captures `/app/home` from a container `next dev`.
   - S5: `getTcpPort` reaches a server on `0.0.0.0` and does not reach one on `127.0.0.1`.
1. **Runner seam, local only, no behaviour change.** `browser-provider.ts` with
   `localBrowserProvider` and `selectBrowserProvider`. `env-scan` and the rescan go
   through it. Add `BUILDD_BROWSER_PROVIDER=local` to the agent env and
   `browserProvider` to the heartbeat. Tests: selection matrix; a failed local probe ⇒
   no `browser`, no slug; existing `browser-capability.test.ts` and
   `role-advertising` tests unchanged and green.
2. **QA helpers and local proof.** Add `scripts/qa/browser-provider.ts` and
   `scripts/qa/serve-local.sh`. `capture.ts` uses `connectReviewBrowser` and records
   `browser` / `providerError`. Update the `visual-review` skill with one "Local
   service recipe" for both providers. An integration test boots a trivial HTTP
   server and captures it through the local provider. The local e2e (§13 A) passes.
3. **Cloud bridge behind `BROWSER_BRIDGE=1`.** Add the `BROWSER` binding,
   `BrowserBridge` (session, relay, mediation, services, evidence, caps) behind
   `BrowserPort`, the `'browser'` egress kind, the `buildContainerEnv` keys, the
   runner shim, and `cloudflareBrowserProvider`. Run-once reads its role and probes
   only for browser roles. Bun tests with a fake `BrowserPort` cover: mapped-origin
   fulfil; blocked host; client route sees the request first; unregistered port
   blocked; token mismatch 401; second client 409; idle close and reacquire cap; run
   end revokes; lost mediation closes the client. A lifecycle test asserts that no
   CF credential is in the container env. The image gains Postgres, pgvector and the
   neon-http proxy as processes (measure the size delta).
4. **Server.** Store `lastBrowserRefusal` on claim refusal. `browserRunnerOnline`
   learns elastic groups. Evidence-check rules (§9). Lightbox fields. Tests next to
   each route.
5. **Promote.** Set this spec `active` with `verified_by`, and fold the new non-goal
   reversal into `knowledge-base: buildd/design/visual-qa-auditor.md`.

## 13. End-to-end verification (what the verification task runs)

**A. Local provider** (Coder host, mission branch checked out):
```bash
BUILDD_BROWSER_PROVIDER=local scripts/qa/serve-local.sh &           # → [serve] ready http://127.0.0.1:<port> (local)
jq . /tmp/qa/service.json                                            # bindUrl == browserUrl, data=synthetic
QA_BASE_URL=$(jq -r .browserUrl /tmp/qa/service.json) QA_NO_LOGIN=1 \
  QA_PLAN=<plan with one click on /app/missions> QA_VIEWPORT=mobile bun scripts/qa/capture.ts
QA_BASE_URL=… QA_NO_LOGIN=1 QA_ROUTES=/app/missions bun scripts/qa/capture.ts   # desktop
jq '.[] | {id, finalUrl, browser, providerError}' /tmp/qa/captures.json
```
Pass: authenticated page (not sign-in), `browser.provider == "local"`, the state shot
shows the clicked control's result, and the shots are uploaded with `qa.browser`.

**B. Cloudflare provider** (a cloud-runner deployment with `BROWSER_BRIDGE=1`, and a
`visual-auditor` task dispatched to it on the mission branch):
- In the container, the same three commands as A with `BUILDD_BROWSER_PROVIDER` unset.
  `service.json.provider == "cloudflare"`, `handle` matches `brs_…`, and
  `browserUrl == bindUrl == http://127.0.0.1:<port>`.
- **Proves it is the local service and not a deployment:** the served page's
  `/api/version` body carries the worktree's commit, and `GET /v1/evidence` shows the
  requests served for `127.0.0.1:<port>` matching the capture.
- **Credential check:** `env | grep -Ei 'cloudflare|^cf_|api_token'` in the agent shell
  prints nothing, and the test from step 3 passes.

**C. Negative proof** (each MUST end non-zero with the named code and no `ok` verdict):
- A plan navigating `https://example.com` → `destination_blocked`.
- A plan navigating `http://127.0.0.1:<an unregistered port>` → `destination_blocked`.
- `curl -X DELETE $BUILDD_BROWSER_SERVICE_API/session` mid-capture → `session_lost`.
- `serve-local.sh` with the app bound to `127.0.0.1` in the container →
  `service_unreachable` (S5).
- Dispatch a `visual-auditor` task to a deployment without the binding → the claim is
  refused, and `lastBrowserRefusal.code == "provider_missing"` is visible on the task.

## Code surface

- Existing, reused: `apps/runner/src/browser-capability.ts` (`detectBrowser`,
  `applyBrowserCapability`, `applyAgentPlaywrightEnv`), `apps/runner/src/role-advertising.ts`
  (`advertisedRoleSlugs`), `apps/runner/src/run-once.ts`, `apps/runner/src/agent-env.ts`,
  `packages/shared/src/types.ts` (`CAPABILITY_BROWSER`, `VISUAL_AUDITOR_ROLE_SLUG`,
  `EXPLICIT_ROLE_SLUGS`), `apps/web/src/app/api/workers/claim/role-gate.ts`,
  `apps/web/src/lib/visual-audit-runner.ts` (`browserRunnerOnline`),
  `apps/web/src/lib/visual-audit-evidence.ts` (`loadVisualAuditEvidence`),
  `apps/cloud-runner/src/worker-agent.ts`, `apps/cloud-runner/src/egress.ts`,
  `apps/cloud-runner/src/outbound.ts` (`classifyEgressHost`, `SNAPSHOT_HOST_NAME`),
  `apps/cloud-runner/src/lifecycle.ts` (`buildContainerEnv`), `apps/cloud-runner/wrangler.jsonc`,
  `scripts/qa/capture.ts`, `scripts/qa/shoot.sh`, `scripts/demo/docker-compose.yml`,
  `scripts/demo/seed.ts`, `packages/core/db/neon-local.ts`, `.claude/skills/visual-review/SKILL.md`.

## New files (planned; move into Code surface as they land)

- This spec's names: `apps/runner/src/browser-provider.ts` (`BrowserProvider`,
  `selectBrowserProvider`, `localBrowserProvider`, `cloudflareBrowserProvider`),
  `apps/cloud-runner/src/browser-bridge.ts` (`BrowserBridge`, `BrowserPort`),
  `scripts/qa/browser-provider.ts` (`connectReviewBrowser`, `exposeService`),
  `scripts/qa/serve-local.sh`; types `BrowserProbeResult`, `BrowserFailureCode`,
  `ServiceMapping`; constants `BROWSER_ROLE_SLUGS`, `BROWSER_BRIDGE_HOST` (`buildd-browser.invalid`).

## Invariants

- `browser` is in a runner's `envKeys` only if the selected provider's most recent
  probe did a real CDP round trip (cloudflare) or headless launch (local) and succeeded.
- A cloud task container's env and its agent's env never contain a Cloudflare API
  credential, and the agent env never contains `BUILDD_BROWSER_SESSION_TOKEN`.
- A bridge request is served only for the agent named by its interception's
  `EgressProps.taskId`, and only with that run's live session token.
- The sandbox service is reachable by the remote browser only through the relay's
  fulfil of a registered port; there is no listener, route or hostname for it outside
  the container.
- A top-level navigation by a cloudflare session to anything but a mapped origin is
  failed.
- No visual-audit shot with a provider or service failure, or without a recorded
  provider once Phase 3 ships, satisfies the evidence check.
- Every session is closed and its token revoked when its run ends, whatever the outcome.

## Acceptance criteria

- AC-1: GIVEN a host whose Chromium passes the launch probe and `BUILDD_BROWSER_PROVIDER` unset WHEN the runner scans THEN `envKeys` contains `browser`, `browserProvider.provider` is `local`, and `advertisedRoleSlugs` returns `['visual-auditor']` (unchanged from today).
- AC-2: GIVEN a cloud container with `BUILDD_BROWSER_BRIDGE_URL` set whose `POST /v1/session` fails WHEN run-once prepares to claim a `visual-auditor` task THEN `envKeys` lacks `browser`, the claim is refused, and the task's `context.visualQa.lastBrowserRefusal.code` is the failure code.
- AC-3: GIVEN a cloud container dispatched for a `builder` task WHEN run-once starts THEN no `POST /v1/session` is made.
- AC-4: GIVEN `buildContainerEnv` with `BROWSER_BRIDGE=1` WHEN it builds the env THEN it contains `BUILDD_BROWSER_BRIDGE_URL` and `BUILDD_BROWSER_SESSION_TOKEN` and no key matching `/cloudflare|^CF_|API_TOKEN/i`.
- AC-5: GIVEN a registered port 4123 WHEN the remote browser requests `http://127.0.0.1:4123/x` THEN the relay fulfils it with the container's response, and `GET /v1/evidence` counts it.
- AC-6: GIVEN no port 4124 registered WHEN the remote browser requests `http://127.0.0.1:4124/` THEN the request fails `BlockedByClient` and evidence lists `127.0.0.1:4124` as blocked.
- AC-7: GIVEN a session WHEN a client navigates top-level to `https://example.com` THEN the navigation fails and capture records `providerError: destination_blocked` with no shot.
- AC-8: GIVEN a bridge request with the wrong bearer token THEN it is rejected with HTTP 401 and no browser call is made.
- AC-9: GIVEN a CDP client connected WHEN a second client connects to `/v1/cdp` THEN it is rejected with HTTP 409 `cdp_client_busy`.
- AC-10: GIVEN a client that registered a `page.route` for `**/*` WHEN a page requests the mapped origin THEN the client's handler sees the request before the relay fulfils it.
- AC-11: GIVEN a live session WHEN the run ends THEN the browser is closed and a later request with the old token gets HTTP 401 `session_revoked`.
- AC-12: GIVEN `serve-local.sh` whose app never answers `/api/version` WHEN 300 s pass THEN it exits non-zero with `service_not_ready` and no `service.json` is written.
- AC-13: GIVEN a shot whose `metadata.qa.browser.probe.ok` is false WHEN the auditor completes THEN the evidence check refuses completion.
- AC-14: GIVEN `BUILDD_BROWSER_PROVIDER` unset on a laptop WHEN `scripts/qa/shoot.sh` runs THEN it captures exactly as today (local provider, no bridge calls).

## Out of scope

- Pre-merge review, pixel baselines, mobile-native apps (unchanged non-goals).
- Making the cloud provider available to non-`visual-auditor` roles (a later widening
  of `BROWSER_ROLE_SLUGS`).
- A generic, non-Buildd `serve-local` for other workspaces' apps (the auditor design's
  generic phase).
- Changing `visual-qa.yml` or the Vercel-preview page source; both keep working, and
  `vercel-preview` captures may use either provider unchanged.
- Changes to the infrastructure repo. If a spike shows one is unavoidable, it is filed
  as its own task in this mission, not folded into the implementation PR.
