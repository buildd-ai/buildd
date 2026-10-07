---
title: Provider-Backed Browser for Visual Review
status: active
owner: max
last_verified: 2026-10-07
summary: The visual-auditor role is eligible only after a selected browser provider proves usable; a cloud browser reaches registered container-local services through a task-scoped CDP relay.
domain: runners
surfaces: [apps/runner/src/browser-provider.ts, apps/cloud-runner/src/browser-bridge.ts, apps/cloud-runner/src/egress.ts, scripts/qa/capture.ts]
verified_by: [scripts/qa/capture-provider.test.ts, apps/runner/__tests__/unit/browser-provider.test.ts, apps/runner/__tests__/unit/qa-browser-provider.test.ts, apps/cloud-runner/src/browser-bridge.test.ts, apps/cloud-runner/src/browser-binding.test.ts, apps/cloud-runner/src/lifecycle.test.ts, apps/cloud-runner/src/deploy-plan.test.ts, apps/cloud-runner/src/run-report.test.ts, apps/web/src/lib/visual-audit-runner.test.ts, apps/web/src/lib/explain.test.ts, apps/web/src/app/api/workers/claim/explicit-task-exclusion.test.ts, apps/web/src/lib/visual-audit-evidence.test.ts]
related: [qa-capture-steps, worker-sandbox-isolation, credential-isolation, cloud-egress-merge-guard, runner-liveness]
keywords: [visual-auditor, BrowserProvider, Browser Rendering, CDP, connectOverCDP, browser bridge, local service, CAPABILITY_BROWSER]
supersedes: []
---

# Provider-Backed Browser for Visual Review

## Contract

The existing `visual-auditor` role uses a selected browser provider. Local Chromium
remains the default on a host. A cloud container connects to Browser Rendering
through its owning WorkerAgent, using the Worker's `BROWSER` binding. The container
never receives an account credential.

The code and deterministic guards below are implemented. Deployed Cloudflare
transport and a cloud-only workspace capture still require live verification;
the unit guards do not substitute for that proof. The bridge remains opt-in with
`BROWSER_BRIDGE=1` until that verification succeeds.

## Provider selection and capability truth

`selectBrowserProvider` accepts `auto`, `local`, `cloudflare`, and `none` through
`BUILDD_BROWSER_PROVIDER`. Unset means `auto`: choose cloudflare in a cloud executor or when a bridge URL
exists, otherwise local. A cloud executor without its binding reports
`provider_missing` rather than falling back to local. An explicit cloudflare selection never falls back to
local. Invalid names fail loudly.

`localBrowserProvider` reuses the existing launch probe and Playwright discovery.
`cloudflareBrowserProvider` acquires a session then requests a real CDP probe:
`Browser.getVersion`, create an about:blank target, and close that target. Neither
a binding nor an environment variable alone grants `CAPABILITY_BROWSER`.

Run-once reads the task role before probing. Builder tasks never acquire a remote
browser. A successful visual-auditor probe starts the loopback shim, sets browser
capability, and permits the existing explicit role advertisement. A failed probe
removes browser capability. Heartbeats carry the latest `browserProvider` result.
Periodic remote rescans preserve that result without starting local Chromium.

The privileged task-token response carries the server-stored `roleSlug`.
WorkerAgent mints a browser capability only for a visual-auditor task, irrespective
of client-supplied role data. It creates a new token for every attempt.

## Worker binding and egress

Wrangler declares `browser: { binding: 'BROWSER' }`; custom deployment rendering
retains that binding. `BROWSER_BRIDGE=1` plus the binding and the role authorize the
bridge. `buildContainerEnv` adds only the pseudo-host URL and ephemeral run token.
There is no Cloudflare API credential in either the container or agent environment.

The pseudo-host is `buildd-browser.invalid`. Its HTTPS requests go through
EgressHandler to the agent identified by interception's `taskId`, `agentName`, and
runner size. A lease agent also verifies that its current task matches this
identity. The egress handler overwrites the internal task header; the task cannot
choose another agent by URL, session handle, or request body. Fetch forwarding
preserves the CDP WebSocket upgrade.

BrowserBridge checks that run's bearer token before any session operation. Wrong
tokens and ended runs are refused. Browser session IDs stay in the Worker; the
client sees only an opaque `brs_` handle. The loopback shim injects the token, and
the agent receives only `BUILDD_BROWSER_CDP_URL`, `BUILDD_BROWSER_SERVICE_API`,
provider name and probe metadata. The token is excluded from the agent allowlist.

## Bridge interface

All operations require the current run token through egress:

| Operation | Contract |
| --- | --- |
| `POST /v1/session` | Acquire once; return opaque handle, provider and expiry. Concurrent acquisition is coalesced. |
| `GET /v1/probe` | Perform a real browser/target CDP round trip; return probe success and version. |
| `GET /v1/cdp` | WebSocket upgrade for one client. Another client receives 409. |
| `PUT /v1/services/:port` | Check readiness through container TCP fetch and register a private origin. |
| `DELETE /v1/services/:port` | Remove mapping. |
| `GET /v1/evidence` | Session milliseconds, request/byte totals, served origins, blocked origins and relay errors. |
| `DELETE /v1/session` | Close and revoke this run's capability. |

Sessions close after ten minutes without activity, after a sixty-minute absolute
lifetime, on mediation failure, or when the run ends. One reacquisition is allowed
after idle expiry; it requires registering services again. Every run outcome,
including parking and keeping a warm lease, revokes browser access. A new task in
a reused container gets a new bridge and token. Browser close is idempotent.

The run report includes `browser` with provider, session milliseconds/seconds,
session count, requests, response bytes and relay errors. No token or upstream
session ID enters the report.

## Local-service reachability decision

Use CDP Fetch fulfilment, the draft's private relay alternative, rather than a
public port-preview URL. The container's app binds `0.0.0.0`. The Worker checks it
with `ctx.container.getTcpPort(port).fetch`. The browser still navigates
`http://127.0.0.1:<port>`; the relay fetches the response from the task's container
and fulfils that paused request. No public listener, DNS mapping or tunnel exists.
Host and cookie origins remain local.

Cloudflare's native outbound-worker routing is not used: its documented Fetcher
lifetime is one invocation, while these sessions span requests. Native binding
session guardrails deny all network destinations as a backstop. Registered app
responses arrive through CDP fulfilment, without browser network egress. Live
verification must establish that this interception works before guardrail denial.

Only registered HTTP loopback origins are served. Ports must be 1024–65535, with
at most four mappings; the runner control port is always denied. Readiness paths
cannot redirect the registration request to another host. Each response is capped
at 25 MiB while reading, and session response bytes at 512 MiB. Unregistered ports
and public destinations fail rather than becoming browser-visible error shots.

The relay owns Fetch interception and WebSocket blocking. It initializes mediation
before releasing a newly attached target's debugger. Playwright client routes see
allowed requests first; continuing them fulfils the container response. Client
Fetch enable/disable changes client matching, never disables relay matching.
Nested CDP, proxy changes and interception-disabling commands are denied. A lost
mediation channel closes the browser. The client cannot use a wildcard route to
fulfil a blocked destination.

This initial cloud provider serves container-local HTTP pages. External previews
remain supported by the existing local provider. Additional remote subresource
hosts and HTTPS preview mappings require an explicit subsequent policy extension.

## Capture and artifacts

`scripts/qa/browser-provider.ts` exposes `connectReviewBrowser` and `exposeService`.
Local capture still launches Chromium; cloud capture calls `connectOverCDP` on the
loopback shim. Existing route plans, interaction steps, console/page errors, write
blocking, screenshots and `captures.json` remain the capture contract.

`scripts/qa/serve-local.sh` starts the checked-out dev server on `0.0.0.0`, waits
for readiness, and writes `service.json` containing local/browser URLs and provider.
It requires a caller-provided synthetic database; it does not provision Postgres
or imply the cloud image contains one. Seed/auth setup follows the visual-review
skill and existing demo stack. No production database is used.

Capture records `browser` metadata on results. Provider failures write a failed
manifest and exit nonzero. Blocked navigation and lost sessions carry
`providerError` and no screenshot. Artifact uploads preserve this metadata as
`metadata.qa.browser` / `metadata.qa.providerError`. The evidence check rejects
failed provider metadata even if another screenshot covers the same route;
legacy local shots without provider metadata retain their existing behavior.

## Claim and explain

Browser-role tasks retain the existing explicit slug gate. A refused claim names
missing browser capability. A failed provider probe is stored in
`context.visualQa.lastBrowserRefusal`, preserving existing task context. The stamp
is task/workspace/role scoped and throttled.

Explain names missing browser capability when a queued visual-audit task has no
eligible browser runner. Heartbeat eligibility uses the same executor constraint
as claim: a host browser does not satisfy a cloud-only workspace. An unprobed
elastic group is not evidence of a usable browser.

## Verification

The `verified_by` files test provider selection/no fallback, actual probe RPCs,
agent credential exclusion, immediate-client shim buffering, service readiness,
task/session isolation, private-origin fulfilment, blocked destinations, debugger
mediation ordering, expiry/revocation, deployment rendering, usage counting,
executor-aware browser eligibility, refusal diagnostics and failed evidence.

Live proof must run on a test Worker deployed from the branch with
`BROWSER_BRIDGE=1`, and a test workspace whose executor is cloud:

1. Dispatch a visual-auditor task; confirm its provider probe passes and it claims.
2. Boot a dev service in that container, register its port, and capture desktop
   and phone widths through the ordinary capture helper. Use synthetic data.
3. Confirm the local app's version/ref matches the branch and evidence's served
   origins match the capture. Inspect the screenshots.
4. Attempt an unregistered port and a public destination; both must fail loudly
   with no successful visual verdict.
5. End the session/run and verify the prior token is unusable. Confirm session
   seconds appear in the run report and no account credential reached the agent.

Unit tests and type/build checks alone do not establish this deployed proof.

## Code surface

- `apps/runner/src/browser-provider.ts`: `BrowserProvider`, `BrowserProbeResult`, `BrowserFailureCode`, `localBrowserProvider`, `cloudflareBrowserProvider`, `selectBrowserProvider`, `startBrowserShim`.
- `apps/runner/src/browser-capability.ts`, `apps/runner/src/env-scan.ts`, `apps/runner/src/agent-env.ts`, `apps/runner/src/run-once.ts`, `apps/runner/src/role-advertising.ts`.
- `apps/cloud-runner/src/browser-bridge.ts`: `BrowserBridge`, `BrowserPort`, `handleScopedBrowserRequest`, `BROWSER_BRIDGE_HOST`.
- `apps/cloud-runner/src/browser-binding.ts`, `apps/cloud-runner/src/worker-agent.ts`, `apps/cloud-runner/src/egress.ts`, `apps/cloud-runner/src/lifecycle.ts`, `apps/cloud-runner/src/supervisor.ts`, `apps/cloud-runner/src/run-report.ts`, `apps/cloud-runner/wrangler.jsonc`.
- `scripts/qa/browser-provider.ts`: `connectReviewBrowser`, `exposeService`, `ServiceMapping`; `scripts/qa/serve-local.sh`, `scripts/qa/capture.ts`.
- `apps/web/src/lib/visual-audit-runner.ts`, `apps/web/src/lib/visual-audit-evidence.ts`, `apps/web/src/lib/explain.ts`, `apps/web/src/app/api/workers/claim/explicit-task-exclusion.ts`.
