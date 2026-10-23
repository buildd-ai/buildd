---
title: Capability Requests and Grants
status: active
owner: max
last_verified: 2026-10-23
summary: An agent MUST get access it lacked at start only by asking for a provider and an access (read or write), resolved by team policy into a task-scoped, revocable grant checked on every use; writes need a signed-in admin.
domain: auth
surfaces: [apps/web/src/lib/capability-grants.ts, apps/web/src/lib/capability-grants-store.ts, apps/web/src/lib/task-delegation.ts, apps/web/src/lib/capability-grants-needs-you.ts, apps/web/src/lib/connector-gateway.ts]
related: [agent-capabilities, model-inference-agent-capability, mcp-connectors-and-roles, team-permissions]
keywords: [connector gateway, native MCP, tools/list, tools/call, readOnlyHint, toolPolicy, connectorCeiling, request_capability, capability grant, capability policy, auto_grant, ask_human, forbidden, approve, deny, revoke, lease, TTL, provider write guard]
verified_by: [packages/core/__tests__/provider-access-ask.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/TaskAccessSection.test.tsx, apps/web/src/lib/connector-gateway.test.ts, apps/web/src/app/api/mcp/c/[connectorId]/route.test.ts, apps/web/src/lib/connector-gateway-store.test.ts, apps/runner/__tests__/unit/connector-gateway-mount.test.ts, apps/web/src/lib/capability-grants-needs-you.test.ts, apps/web/src/app/app/(protected)/home/DecisionCard.access.dom.test.tsx, apps/web/src/lib/agent-capabilities/access-log.test.ts, apps/web/src/lib/capability-grants-view.test.ts, apps/web/src/app/app/(protected)/settings/connections/connectors/AgentAccessSection.dom.test.tsx, apps/web/src/lib/capability-grants.test.ts, apps/web/src/lib/capability-grants-store.test.ts, apps/web/src/app/api/agent-capabilities/requests/route.test.ts, apps/web/src/app/api/agent-capabilities/requests/[id]/route.test.ts, apps/web/src/app/api/agent-capabilities/policy/route.test.ts]
supersedes: []
assertions:
  - id: request-route
    type: route
    method: POST
    path: /api/agent-capabilities/requests
    file: apps/web/src/app/api/agent-capabilities/requests/route.ts
  - id: decide-route
    type: route
    method: POST
    path: /api/agent-capabilities/requests/[id]
    file: apps/web/src/app/api/agent-capabilities/requests/[id]/route.ts
  - id: policy-route
    type: route
    method: PUT
    path: /api/agent-capabilities/policy
    file: apps/web/src/app/api/agent-capabilities/policy/route.ts
  - id: resolve-request
    type: symbol
    name: resolveCapabilityRequest
    path: apps/web/src/lib/capability-grants.ts
  - id: check-grant-use
    type: symbol
    name: checkGrantUse
    path: apps/web/src/lib/capability-grants.ts
  - id: authorize-use
    type: symbol
    name: authorizeCapabilityUse
    path: apps/web/src/lib/capability-grants-store.ts
  - id: inference-grant-source
    type: symbol
    name: capabilityGrantSource
    path: apps/web/src/lib/capability-grants-store.ts
  - id: inference-route-uses-grants
    type: symbol_reachable
    symbol: capabilityGrantSource
    entry: apps/web/src/lib/capability-model-inference.ts
  - id: gateway-route
    type: route
    method: POST
    path: /api/mcp/c/[connectorId]
    file: apps/web/src/app/api/mcp/c/[connectorId]/route.ts
  - id: gateway-decide
    type: symbol
    name: decideToolCall
    path: apps/web/src/lib/connector-gateway.ts
  - id: gateway-classify
    type: symbol
    name: classifyNativeTool
    path: apps/web/src/lib/connector-gateway.ts
  - id: gateway-grant-check
    type: symbol
    name: authorizeConnectorToolUse
    path: apps/web/src/lib/capability-grants-store.ts
  - id: gateway-route-uses-grants
    type: symbol_reachable
    symbol: authorizeConnectorToolUse
    entry: apps/web/src/app/api/mcp/c/[connectorId]/route.ts
  - id: gateway-tests
    type: test_file
    path: apps/web/src/app/api/mcp/c/[connectorId]/route.test.ts
  - id: rules-tests
    type: test_file
    path: apps/web/src/lib/capability-grants.test.ts
  - id: store-tests
    type: test_file
    path: apps/web/src/lib/capability-grants-store.test.ts
  - id: access-gate-rule
    type: symbol
    name: accessEscalationRule
    path: apps/web/src/lib/capability-grants-needs-you.ts
  - id: access-needs-you-tests
    type: test_file
    path: apps/web/src/lib/capability-grants-needs-you.test.ts
---

# Capability Requests and Grants

Discovery ([resolve_capability](mcp-connectors-and-roles.md)) answers "what
could serve this category here" (a search filter). This spec is the next
step: a running agent asks for a provider at read or write, team policy answers, and what is granted is narrow, temporary
and checked on every use. It reuses connectors, workspace enablement, role
`connectorRefs`, credential health and the catalog policy through discovery,
and records every decision in `agent_capability_decisions`. It adds two
tables, `capability_policies` and `capability_grants`; there is no second
connector store.

## Asking

**Capability statement**: A live agent run MUST be able to ask for access to
a named provider (`provider` + `access`: `read` or `write`; or
`model.inference`) for its own worker, and
MUST get one of a fixed set of outcomes with next steps and alternatives,
without naming a connector id or seeing a credential.

**Invariants**:
- `POST /api/agent-capabilities/requests` (MCP `request_capability`) takes
  `provider` (catalog slug) and `access` (`read | write`), and optionally
  `tool` (exact), `resource`, `environment`, `risk`, `ttlSeconds`, `reason`.
  There is no `domain:verb` to request or be granted: grants and policies are
  per provider and risk, and the gateway decides per tool. A `domain:verb`
  body is refused 400 and points at the search below. A body naming
  `connectorId`, `credentialRef`, `apiKey`, `token`, `baseURL`, `endpoint`,
  `headers` or `url` is refused 400. `*` is never a wildcard.
- The principal is re-resolved per request (`resolveWorkerPrincipal`): a live
  worker on its task, claimed by the calling account. A per-task token
  reaches only its own task's worker; anything else answers 404. A trigger
  token is refused. A request from an ended task is refused 409.
- Risk is the highest of the access, the declared `risk`, and the named tool's
  risk by name (`classifyToolRisk`: read verbs read, destructive or authority
  verbs admin, anything else write). An agent cannot lower it.
- Outcomes: `existing` (the role already mounts the connector for a read, or
  a live grant covers the exact ask), `auto_granted`, `pending_approval`,
  `denied`, `forbidden`, `need_connection`, `need_reauth`, `unhealthy`,
  `unavailable`. Every outcome lists `nextSteps` and up to five
  `alternatives` (other installs of the same provider, with their own outcome).
- The categories (observability, deployment, database, analytics,
  work_tracking, docs, source_control) are only a search filter:
  `GET /api/connectors/capabilities?capability=domain:verb` (MCP
  `resolve_capability`) lists which providers serve one, and `?provider=<slug>
  &access=read|write` shows one provider's state in a workspace. Nothing
  requested, stored, granted or audited carries a category.
- One open row per (worker, target, exact ask): asking again, or two asks
  racing, returns the same row (partial unique index on `dedupe_key` over
  `pending`/`granted`). A denied ask is not re-opened for that worker.
- buildd's own capabilities live under provider `buildd`, served by buildd
  itself, not a connector: `resource` is the target workspace UUID and a
  person always decides. `access: write` is `tasks:create` (file tasks there),
  `access: read` is `analytics:read` (read its analytics: stats, decisions,
  health). The capability names `tasks:create` / `analytics:read` are still
  accepted in place of provider + access. Its own workspace is `existing`; another team's is `forbidden`
  (no row); a target the task's delegation already grants is `existing`. A
  `pending_approval` keeps the run alive: the next steps tell the agent to keep
  working and ask again, never to end the run or ask_human for the same access.
  The approver must reach the target themselves (`approver_lacks_reach`
  otherwise). Approval writes the grant onto the task's own delegation
  (`tasks.delegation`, lib/task-delegation.ts), which the task token re-reads
  on every call; if that write fails the approval is undone. Revoking removes
  it from the delegation. A refused read of another workspace's analytics is
  therefore one real action: the agent asks `buildd` `read` on that workspace,
  a person approves, and the same call is retried.

**Acceptance criteria**:
- AC-1: GIVEN Axiom installed and connected but the team has blocked it in the catalog WHEN an agent asks for `axiom` `read` THEN the outcome is `forbidden` (`catalog_blocked`) and no row is written.
- AC-2: GIVEN no role in the workspace mounts Axiom and no rule WHEN an agent asks THEN the outcome is `pending_approval`; a second identical ask returns the same request.
- AC-3: GIVEN another role mounts Axiom and no rule WHEN an agent asks for a read THEN it is `auto_granted` with the requested TTL (narrowed by policy).
- AC-4: GIVEN the role mounts a provider WHEN an agent asks for `write` THEN it is `pending_approval` (`write_needs_human`), whatever the team rule says.
- AC-5: WHEN a body names a connector id THEN the route returns 400.
- AC-5a: GIVEN a running task with no delegation WHEN its agent asks for `buildd` `write` (or `read`) on a same-team workspace THEN the outcome is `pending_approval`; WHEN a person who reaches that workspace approves THEN the task's delegation grants `tasks:create` (`analytics:read` for read) there and a repeat ask is `existing`; WHEN revoked THEN the grant leaves the delegation.

## Team policy

**Capability statement**: A team admin MUST be able to set, per provider and
risk (read/query/write/admin), optionally narrowed by workspace, role,
environment or resource, whether a request is auto-granted, asks a person,
or is forbidden; team members MUST be able to read it and MUST NOT change it.

**Invariants**:
- `GET/PUT/DELETE /api/agent-capabilities/policy`. One rule per scope
  (`scopeKey`); PUT upserts. The most specific matching rule wins; equally
  specific rules resolve to the most restrictive effect.
- With no rule: read/query auto-grant only where some role in the workspace
  already mounts the connector; otherwise, and for every write/admin, ask a
  person. Installing or preinstalling a connector grants an agent nothing.
- `auto_grant` is refused (400) for write and admin, and a stored one is
  clamped to `ask_human`: writes always need a person.
- `maxTtlSeconds` caps every grant the rule covers (hard ceiling 24 h).
- Reading needs team membership; changing needs `manage_connectors` (owners
  and admins by default). Both need a signed-in session: any bearer
  credential, including an admin key, is refused 403 `session_required`.

## Deciding

**Capability statement**: A signed-in person holding `manage_connectors` in
the request's team MUST be able to approve, deny or revoke, idempotently; no
API key, and so no agent, can approve anything.

**Invariants**:
- `POST /api/agent-capabilities/requests/[id]` with `decision`
  `approve | deny | revoke`. Another team's request answers 404.
- Each transition is one conditional UPDATE: `pending → granted | denied`,
  `pending | granted → revoked`. Repeating a decision answers 200 with
  `alreadyDecided: true`; a conflicting one (deny after approve) answers 409
  with the row as it stands. Two concurrent clicks produce one transition.
- Approval may go above the auto-grant line (that is its purpose) but never
  past a forbidding rule, a catalog block or a workspace disable. Approval for
  an ended task or stopped worker, or after the task's role changed, is
  refused and the request is closed (`expired`).
- The approver can only narrow the TTL; policy narrows it further.

## Using a grant

**Capability statement**: A grant MUST authorize a call only while every
fact it was granted under still holds; revoking it MUST stop the next call.

**Invariants**:
- `authorizeCapabilityUse(principal, use)` is the only path from a grant to a
  use. It reads the worker's granted rows and every fact fresh: grant
  team/workspace/task/worker equal the caller's; status `granted`, not
  revoked, unexpired; task open; worker live; task role unchanged; exact
  provider/connector; exact tool if the grant names one, else the tool's risk
  within the grant's; exact resource/environment if named; connector still
  visible, not catalog-blocked, not disabled in the workspace, credential not
  dead; no rule now forbids it; and a policy-made grant still auto-grants
  under current policy. Each use is audited (`capability.use`).
- The `model.inference` route reads its grant through `capabilityGrantSource`
  under the same checks, and spends through the durable per-grant ledger
  ([model-inference-agent-capability](model-inference-agent-capability.md)).

**Acceptance criteria**:
- AC-5b: GIVEN a task refused reading another workspace's analytics WHEN it asks `buildd` `read` on that workspace and a person approves THEN its delegation carries `analytics:read` there and the retried read passes.
- AC-5c: GIVEN an agent whose question to a person asks for provider access (e.g. widening the worker key with `analytics:read` for Axiom) WHEN it calls `ask_human` THEN the call is refused with `use_request_capability` and the canonical ask (`provider: axiom, access: read`, plus a named resource such as `buildd-traces`), nothing is parked, and the answer never recommends widening the worker key: `analytics:read` is buildd's own analytics, not a provider's. A runner-managed agent's `AskUserQuestion` is not yet intercepted; its prompt and the `request_capability` description carry the same rule.
- AC-6: GIVEN an approved grant WHEN an admin revokes it THEN the next `authorizeCapabilityUse` is refused.
- AC-7: GIVEN a live grant WHEN the task's role changes, the task ends, the credential needs reconnecting, or the provider is blocked THEN the next use is refused with `role_changed`, `task_terminal`, `credential_dead` or `catalog_blocked`.
- AC-8: GIVEN a `query` grant with no tool named WHEN the agent calls a write-named tool THEN it is refused `tool_risk_exceeds_grant`.
- AC-9: GIVEN a grant for worker A WHEN worker B on the same task asks to use it THEN it is refused.

## Showing and deciding

**Capability statement**: A person who can decide MUST be told once, in one
place, when an agent waits on them, and MUST be able to approve a scoped lease
or deny from there; everyone in the team MUST be able to see what agents asked
for, what they hold and the policy, without being able to change any of it.

**Invariants**:
- An access request is an escalation gate subject (`capability_request:<id>`)
  with one fixed rule and no model call (`accessEscalationRule`): `pending` is
  the person's (rail `access_approval`); an auto-grant and anything decided are
  Buildd's, shown on Settings and never a Needs You card or push.
- Home lists a pending request only for teams where the viewer holds
  `manage_connectors`: one card per request (the store already keeps one open
  row per exact ask). The card names what, who, workspace, why and the lease,
  and approves for the asked lease or denies in place; Settings → Team → Apps
  → Agent access (`/app/settings/apps?request=<id>`) offers a shorter lease.
- A request is open only while it is `pending` AND its run has not ended
  (`isOpenAccessRequest`, built on `runClosure`, the same rule an approval
  and every use check). Only an open request is a Home card, adds to Home's
  count and its tab badge, or offers Approve and Deny. A pending row whose
  task or agent run ended reads as closed even before the row says so (fail
  closed: an unreadable run is ended), and the next team read closes the row
  the way an approval attempt would (`expired`, `decidedBy: system`, reason
  `task_terminal` or `worker_not_live`).
- A closed request leaves Home rather than collapsing there, as a past
  agent question does: Settings and the task's Access section keep its
  history. If it closes while its card is up, a decision answers 409 and the
  card drops every button and says why (the route marks the refusal
  `closed`, `decisionClosesRequest`).
- A new pending request pages the team once; a repeat ask (same row) does not.
- A task's Access section tells a run's own credentials (buildd token, repo
  access, model endpoint: issued on start, renewed while it lives, nobody
  approved) from governed requests. Credentials read "active", renewals sit
  behind a toggle; a request still open links to the same decision as its
  Needs You card (`accessRequestHref`) and never reads as refused. One that
  closed undecided reads "closed" with why, no link, and does not open the
  section.
- Settings → Team → Apps → Team apps shows each app's real state from the
  team's connector on the same host (Connected, Sign-in expired, Not
  connected, Not set up, Not available, Blocked by your team) and offers only
  the step the server can take. A provider that won't let buildd connect reads
  "Not available" with no Connect and no reason. Members see offered entries,
  requests, grants and policy read-only, and can request an app the team has
  not set up (`POST /api/connectors/catalog/request`, which pages the team).
- Agent access is compact: a one-line summary and the requests waiting for a
  decision, never folded; what agents hold, history and policy open below it,
  and open by themselves when `?request=<id>` points there.
- The UI never decides: every control posts to the routes above and shows
  what they answered. A repeat decision reads as already done; one someone
  else made first reads as it stands; a refused approval shows the server's
  reason.

**Acceptance criteria**:
- AC-10: GIVEN a pending request WHEN an admin opens Home THEN one access card shows the ask and lease; WHEN a member opens Home THEN none.
- AC-11: GIVEN an approved request WHEN the admin approves again THEN the page says it is already approved, not an error.
- AC-12: GIVEN a policy auto-grant THEN no card and no push; it is listed under Allowed now.
- AC-19: GIVEN a pending request whose task has ended (row still `pending`) WHEN an admin opens Home THEN no card, no count, no Approve or Deny; the task's Access section reads it as closed.
- AC-20: GIVEN an access card on Home WHEN its task ends and the admin taps Approve THEN the card shows why it closed and no buttons.

**Out of scope**: the model-inference budget ledger (its own spec). Provider
tool calls go through the connector gateway below.

## Connector gateway

**Capability statement**: A provider's native MCP tools (Axiom, Vercel) MUST
reach an agent with their own names, descriptions and schemas, through a
buildd pass-through that holds the provider credential server-side and
decides every call against live state; the credential MUST never reach the
agent's prompt, argv, env, logs, artifacts or disk.

**Invariants**:
- Claim injection returns a gateway connector as `{ gateway: true,
  gatewayPath: '/api/mcp/c/<id>' }` with no url and no credential. The runner
  mounts `<its own buildd origin><path>?worker=<id>` with the agent's own
  buildd token (Claude: `mcpServers` http entry; Codex: `config.toml` bearer
  env var). Gateway providers: Axiom and Vercel oauth/header connectors;
  `BUILDD_CONNECTOR_GATEWAY=all` brokers every oauth/header connector, `off`
  restores the direct mount. stdio, `none` and assertion connectors stay direct.
- Mounted set = role `connectorRefs` as before, plus every owned,
  workspace-enabled, unblocked, connected gateway connector. Mounting confers
  nothing: a connector the role does not list needs a live grant for every
  call. The session's MCP topology is therefore fixed, and a grant approved,
  revoked or expired mid-task takes effect on the next call on both runtimes.
- Every request re-resolves the principal (live worker on its own task,
  claimed by the caller; a task token reaches only its own worker, else 404)
  and re-reads task, worker, role, connector visibility, workspace enablement,
  catalog block, credential health and team policy. A trigger token is refused.
- `tools/list` is forwarded and subset-filtered, never rewritten: a tool
  is dropped when its class is above the run's ceiling, turned off by an
  admin, or forbidden by a team rule. Ceiling = role `metadata.connectorCeiling`
  (`read | query | write | admin`; absent = `write`), capped at `query` for an
  unattended run (the task or its mission came from a schedule, as sentinels do).
- A tool's class comes from the provider's own annotations: `destructiveHint`
  is admin, `readOnlyHint` is read (unless the name is an admin verb), and
  anything else, unannotated included, is write. An admin's
  `discoveredMetadata.toolPolicy` (`readOnlyTools`, `denyTools`; exact names)
  corrects it; only a signed-in person may change it (any bearer gets 403
  `session_required`). Only the provider's annotations are cached (per
  instance, 10 minutes); the class, overrides included, is recomputed on every
  call, so a new deny or a removed read-only mark applies to the next call. An
  uncached tool's annotations come from a fresh provider `tools/list`; if that
  fails it is a write (fail closed).
- `tools/call`: a read or query on a role-mounted connector is allowed; any
  write or admin call, and any call on a connector the role does not list,
  needs a live grant covering the exact tool, the annotation risk (never
  lowered by the name), and the resource and environment a grant names (read
  from well-known argument keys). Nothing lifts the ceiling, a grant included.
- A denial is a JSON-RPC result with `isError: true` and
  `structuredContent: { code, nextSteps }` (`capability_not_granted`,
  `role_ceiling`, `unattended_ceiling`, `catalog_blocked`, …), never an HTTP
  auth challenge; `WWW-Authenticate` and `Set-Cookie` from the provider are
  never passed back.
- Writes: the attempt row is stored before the request is sent, and an
  identical write (worker, MCP session, JSON-RPC id, tool, argument hash) is
  refused as `replayed_call`. If the attempt cannot be stored, the call is
  refused.
- Audit (`agent_capability_decisions`): `connector.tool_call` (allowed or
  refused, with reason, risk, basis, grant id, argument hash) and
  `connector.tool_result` (status, HTTP status, duration). Never arguments,
  results or credentials.
- Limits: 60 calls per worker per connector per minute (20 unattended), 256 KB
  request, 8 MB response, 90 s upstream timeout; batches and unlisted
  methods are refused.
- Credential: decrypted per request under the connector's owner team, sent
  only to the connector's own https URL (no redirects). A provider 401 refreshes
  the OAuth token and retries once. A refresh that comes back `locked` (another
  request refreshed within the lock window, or is refreshing now) is not a
  failure: if the stored token is no longer the one the provider rejected, the
  call is retried with it. Only when no newer token exists is the credential
  marked (`gateway_401`) and the call answered `reconnect_required` as a tool
  result. The session is never aborted for it. Every provider 401 is logged
  (`[connector-gateway] provider 401`) and stamped on the request's span
  (`buildd.connector.refresh_outcome`, `buildd.connector.upstream_result`),
  ids and outcome codes only.
- Outage: if buildd cannot read run state or grants, the call is refused
  (`gateway_unavailable`) and nothing is sent. If the provider is unreachable
  or times out, the answer says a write may or may not have happened.
- Restart and resume: the runner persists only gateway entries (rebuilt field
  by field; a direct mount's headers or a stdio env never reach disk) and
  re-mounts them with a freshly minted token. No grant can go stale across a
  resume, because none is cached on the runner.

**Runtime facts** (installed SDKs): Claude Agent SDK 0.3.290 exposes
methods to replace, toggle and reconnect MCP servers in streaming
mode, but `options.mcpServers` is read once at spawn. Codex SDK 0.162.0 reads
MCP only from `CODEX_HOME/config.toml` at session start and has no per-call
hook. Neither is needed: per-call enforcement in the gateway works the same on
both, and visibility never depends on `tools/list_changed`.

**Acceptance criteria**:
- AC-13: GIVEN a role with `connectorCeiling: query` WHEN it lists Axiom's tools THEN monitor, dashboard and notifier mutations are absent, and calling one answers `role_ceiling` even with a grant.
- AC-14: GIVEN Axiom mounted and then blocked in the catalog WHEN the agent calls a tool THEN `catalog_blocked`, and nothing reaches the provider.
- AC-15: GIVEN a granted write WHEN the grant is revoked THEN the next call answers `capability_not_granted` (`grant_not_live`).
- AC-16: GIVEN a provider 401 mid-call WHEN refresh fails THEN the tool result is `reconnect_required` and the session continues.
- AC-18: GIVEN a provider 401 inside the refresh lock window WHEN a peer request has already stored a new token THEN the call is retried with that token and the credential is not marked (`apps/web/src/lib/connector-gateway-store.test.ts`).
- AC-17: GIVEN any gateway answer, header or audit row THEN it does not contain the provider credential.

**Code surface**:
- Gateway rules (pure): `apps/web/src/lib/connector-gateway.ts`; db half: `apps/web/src/lib/connector-gateway-store.ts`; route: `apps/web/src/app/api/mcp/c/[connectorId]/route.ts`; grant check: `authorizeConnectorToolUse`
- Runner: `buildMcpServerEntries` (`apps/runner/src/workers.ts`), `buildCodexMcpServers` / `gatewayConnectorsOnly` (`apps/runner/src/mcp-json.ts`), persistence in `apps/runner/src/worker-store.ts`
- Rules (pure): `apps/web/src/lib/capability-grants.ts` (`parseCapabilityRequest`, `classifyToolRisk`, `parsePolicyRule`, `effectivePolicy`, `resolveCapabilityRequest`, `checkGrantUse`, `approvalRefusal`, `toModelInferenceGrant`)
- Store: `apps/web/src/lib/capability-grants-store.ts` (`requestCapability`, `decideCapabilityRequest`, `authorizeCapabilityUse`, `capabilityGrantSource`, `listTeamRequests`, `loadPolicyRules`)
- Authority: `apps/web/src/lib/capability-grants-auth.ts`
- Tables: `capabilityPolicies`, `capabilityGrants` in `packages/core/db/schema.ts`
- MCP: `request_capability` in `packages/core/mcp-tools.ts`
- Gate and Home: `apps/web/src/lib/capability-grants-needs-you.ts` (`accessEscalationRule`, `accessNeedsYouRead`, `notifyAccessRequest`), wired through `apps/web/src/modules.ts`
- UI: `apps/web/src/lib/capability-grants-view.ts`, `apps/web/src/app/app/(protected)/settings/connections/connectors/AgentAccessSection.tsx`, `TeamAppsSection.tsx`
