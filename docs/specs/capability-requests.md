---
title: Capability Requests and Grants
status: active
owner: max
last_verified: 2026-10-09
summary: An agent MUST get access it lacked at start only by asking for a semantic need, resolved by team policy into a task-scoped, revocable grant checked on every use; writes need a signed-in admin.
domain: auth
surfaces: [apps/web/src/lib/capability-grants.ts, apps/web/src/lib/capability-grants-store.ts, apps/web/src/lib/capability-grants-auth.ts, apps/web/src/app/api/agent-capabilities/requests/route.ts]
related: [agent-capabilities, model-inference-agent-capability, mcp-connectors-and-roles, team-permissions]
keywords: [request_capability, capability grant, capability policy, auto_grant, ask_human, forbidden, approve, deny, revoke, lease, TTL, provider write guard]
verified_by: [apps/web/src/lib/capability-grants.test.ts, apps/web/src/lib/capability-grants-store.test.ts, apps/web/src/app/api/agent-capabilities/requests/route.test.ts, apps/web/src/app/api/agent-capabilities/requests/[id]/route.test.ts, apps/web/src/app/api/agent-capabilities/policy/route.test.ts]
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
    entry: apps/web/src/app/api/agent-capabilities/model-inference/route.ts
  - id: rules-tests
    type: test_file
    path: apps/web/src/lib/capability-grants.test.ts
  - id: store-tests
    type: test_file
    path: apps/web/src/lib/capability-grants-store.test.ts
---

# Capability Requests and Grants

Discovery ([resolve_capability](mcp-connectors-and-roles.md)) answers "what
could serve this need here". This spec is the next step: a running agent
asks for it, team policy answers, and what is granted is narrow, temporary
and checked on every use. It reuses connectors, workspace enablement, role
`connectorRefs`, credential health and the catalog policy through discovery,
and records every decision in `agent_capability_decisions`. It adds two
tables, `capability_policies` and `capability_grants`; there is no second
connector store.

## Asking

**Capability statement**: A live agent run MUST be able to ask for a
semantic need (`domain:verb`, or `model.inference`) for its own worker, and
MUST get one of a fixed set of outcomes with next steps and alternatives,
without naming a connector id or seeing a credential.

**Invariants**:
- `POST /api/agent-capabilities/requests` (MCP `request_capability`) takes
  `capability`, and optionally `provider` (catalog slug), `tool` (exact),
  `resource`, `environment`, `risk`, `ttlSeconds`, `reason`. A body naming
  `connectorId`, `credentialRef`, `apiKey`, `token`, `baseURL`, `endpoint`,
  `headers` or `url` is refused 400. `*` is never a wildcard.
- The principal is re-resolved per request (`resolveWorkerPrincipal`): a live
  worker on its task, claimed by the calling account. A per-task token
  reaches only its own task's worker; anything else answers 404. A trigger
  token is refused. A request from an ended task is refused 409.
- Risk is the highest of the verb, the declared `risk`, and the named tool's
  risk by name (`classifyToolRisk`: read verbs read, destructive or authority
  verbs admin, anything else write). An agent cannot lower it.
- Outcomes: `existing` (the role already mounts the connector for a read, or
  a live grant covers the exact ask), `auto_granted`, `pending_approval`,
  `denied`, `forbidden`, `need_connection`, `need_reauth`, `unhealthy`,
  `unavailable`. Every outcome lists `nextSteps` and up to five
  `alternatives` (other providers, with their own outcome).
- One open row per (worker, target, exact ask): asking again, or two asks
  racing, returns the same row (partial unique index on `dedupe_key` over
  `pending`/`granted`). A denied ask is not re-opened for that worker.

**Acceptance criteria**:
- AC-1: GIVEN Axiom installed and connected but the team has blocked it in the catalog WHEN an agent asks for `observability:query` THEN the outcome is `forbidden` (`catalog_blocked`) and no row is written.
- AC-2: GIVEN no role in the workspace mounts Axiom and no rule WHEN an agent asks THEN the outcome is `pending_approval`; a second identical ask returns the same request.
- AC-3: GIVEN another role mounts Axiom and no rule WHEN an agent asks for a read THEN it is `auto_granted` with the requested TTL (narrowed by policy).
- AC-4: GIVEN the role mounts a provider WHEN an agent asks for `write` THEN it is `pending_approval` (`write_needs_human`), whatever the team rule says.
- AC-5: WHEN a body names a connector id THEN the route returns 400.

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
  under the same checks. Its budget ledger is still `NO_LEDGER`, so a granted
  inference call is refused 503 `ledger_unavailable` until a ledger ships.

**Acceptance criteria**:
- AC-6: GIVEN an approved grant WHEN an admin revokes it THEN the next `authorizeCapabilityUse` is refused.
- AC-7: GIVEN a live grant WHEN the task's role changes, the task ends, the credential needs reconnecting, or the provider is blocked THEN the next use is refused with `role_changed`, `task_terminal`, `credential_dead` or `catalog_blocked`.
- AC-8: GIVEN a `query` grant with no tool named WHEN the agent calls a write-named tool THEN it is refused `tool_risk_exceeds_grant`.
- AC-9: GIVEN a grant for worker A WHEN worker B on the same task asks to use it THEN it is refused.

**Out of scope**: mounting a granted connector into a running session, or a
gateway that proxies provider calls (the runtime follow-up calls
`authorizeCapabilityUse`); the settings UI for policy and requests; the
model-inference budget ledger. A connector a role already mounts at claim is
governed by role `connectorRefs` and catalog policy, not by grants.

**Code surface**:
- Rules (pure): `apps/web/src/lib/capability-grants.ts` (`parseCapabilityRequest`, `classifyToolRisk`, `parsePolicyRule`, `effectivePolicy`, `resolveCapabilityRequest`, `checkGrantUse`, `approvalRefusal`, `toModelInferenceGrant`)
- Store: `apps/web/src/lib/capability-grants-store.ts` (`requestCapability`, `decideCapabilityRequest`, `authorizeCapabilityUse`, `capabilityGrantSource`, `listTeamRequests`, `loadPolicyRules`)
- Authority: `apps/web/src/lib/capability-grants-auth.ts`
- Tables: `capabilityPolicies`, `capabilityGrants` in `packages/core/db/schema.ts`
- MCP: `request_capability` in `packages/core/mcp-tools.ts`
