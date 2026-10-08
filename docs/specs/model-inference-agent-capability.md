---
title: Model Inference Agent Capability
status: active
owner: max
last_verified: 2026-10-08
summary: A running agent MUST get a brokered decision-model answer only under a live task-scoped model.inference grant and a reserved budget, never seeing a key or choosing an endpoint, and failing closed.
domain: auth
surfaces: [apps/web/src/lib/capability-model-inference.ts, apps/web/src/app/api/agent-capabilities/model-inference/route.ts, apps/web/src/lib/agent-capabilities/principal.ts, packages/core/decision-client.ts]
related: [agent-capabilities, credential-isolation, decision-kinds]
keywords: [model.inference, Jev, TypeSafe, OpenRouter, LiteLLM, brokered inference, agent eval, decide, grant, budget ledger]
verified_by: [apps/web/src/lib/capability-model-inference.test.ts, apps/web/src/app/api/agent-capabilities/model-inference/route.test.ts, apps/web/src/lib/task-token-routes.test.ts]
supersedes: []
assertions:
  - id: "model-inference-route"
    type: "route"
    method: "POST"
    path: "/api/agent-capabilities/model-inference"
    file: "apps/web/src/app/api/agent-capabilities/model-inference/route.ts"
  - id: "invoke-model-inference"
    type: "symbol"
    name: "invokeModelInference"
    path: "apps/web/src/lib/capability-model-inference.ts"
  - id: "check-grant"
    type: "symbol"
    name: "checkGrant"
    path: "apps/web/src/lib/capability-model-inference.ts"
  - id: "fail-closed-grant-seam"
    type: "symbol"
    name: "NO_GRANT_SERVICE"
    path: "apps/web/src/lib/capability-model-inference.ts"
  - id: "fail-closed-ledger-seam"
    type: "symbol"
    name: "NO_LEDGER"
    path: "apps/web/src/lib/capability-model-inference.ts"
  - id: "route-uses-adapter"
    type: "symbol_reachable"
    symbol: "invokeModelInference"
    entry: "apps/web/src/app/api/agent-capabilities/model-inference/route.ts"
  - id: "adapter-tests"
    type: "test_file"
    path: "apps/web/src/lib/capability-model-inference.test.ts"
  - id: "route-tests"
    type: "test_file"
    path: "apps/web/src/app/api/agent-capabilities/model-inference/route.test.ts"
---

# Model Inference Agent Capability

## Brokered decision calls for an agent run

**Capability statement**: A live agent run MAY ask buildd to answer a bounded
decision (Jev's `choice` / `score` / `noul` questions over a small state) with
its team's configured decision model, through
`POST /api/agent-capabilities/model-inference`. buildd resolves the team's own
key and the endpoint; the agent receives answers and a receipt. This is not an
evaluation platform: the agent runs its own script and dataset on its own
runner and stores what it learns as task artifacts, exactly as it stores any
other output.

**Status today: fails closed.** The generic grant service (mission task
0bfbe2dc, planned at apps/web/src/lib/capability-grants.ts) and a durable
per-grant budget ledger do not exist yet. The route is wired with
`NO_GRANT_SERVICE` and `NO_LEDGER`, so every well-formed request is refused
with `403 no_grant`, before any key is resolved or any provider is called.
The capability is not live until both seams are implemented and an approved
grant has made a verified call.

**Invariants**:

- Every request re-resolves the principal: a live worker on its task, claimed
  by the calling account, which still holds claim authority on the workspace
  (`resolveWorkerPrincipal`). A per-task token reaches only its own task's
  worker in its own workspace.
- Every request re-reads the grant (`ModelInferenceGrantSource`) and re-checks
  it (`checkGrant`): capability, team, workspace, task and worker all equal the
  principal's; not revoked; `expiresAt` in the future; the operation and the
  exact model id are listed; the budget is inside `MODEL_INFERENCE_LIMITS`.
- The endpoint and key come only from the team's decision route
  (`resolveTeamDecisionRoute` → `resolveDecisionRoute` with
  `allowPlatformKey: false`): OpenRouter's fixed URL, or the team admin's
  LiteLLM gateway behind the public-address fetcher. A body carrying
  `baseURL`, `endpoint`, `apiKey`, `headers` or `provider` is rejected, not
  ignored. buildd's platform decision key is never spent on agent work.
- The model the team's route resolves MUST equal the model requested, and the
  route's provider MUST equal the grant's provider.
- No provider call happens unless the ledger first reserved the call's worst
  case (`maxUsdPerCall` dollars, the estimated tokens, one call, one in-flight
  slot) against the grant's budget. `reserveRefusal` is the rule every ledger
  applies; a durable ledger MUST apply it atomically (one conditional UPDATE …
  RETURNING), never read-then-write.
- Exactly one provider attempt per reservation (`maxAttempts: 1`), with a
  deadline no later than the grant's expiry.
- Settlement debits the provider's reported cost; when the call reached the
  provider but the cost is missing, negative or non-finite, or the call
  failed (error, timeout, rate limit, transport), it debits the whole
  reservation. Only a call that provably never left (zero attempts, or a
  local `invalid_request` / `missing_key` / `sdk_missing`) is released at zero.
  A failed settle leaves the reservation held (over-count, never under-count).
- No response, receipt or audit row carries a key, a base URL, or a provider
  response body.
- Every outcome is recorded in `agent_capability_decisions` with capability
  `model.inference` (`recordCapabilityDecision`); the resource is
  `grant:<id>` once a grant is found, else `task:<id>` or `worker:<id>`.

**Acceptance criteria**:

- AC-1: WHEN a well-formed request arrives and no grant source is wired THEN the route returns 403 with code `no_grant` and no provider call is made.
- AC-2: GIVEN a grant whose workspace, task, worker or team differs from the principal THEN the request is refused with `grant_mismatch` and no key is resolved.
- AC-3: GIVEN a grant that is revoked, or whose `expiresAt` is now or earlier THEN the request is refused with `grant_revoked` / `grant_expired` and no provider call is made.
- AC-4: GIVEN a requested model not listed in the grant, or not the team's configured decision model THEN the request is refused with `model_not_allowed`.
- AC-5: GIVEN no ledger (the default) THEN the request is refused with 503 `ledger_unavailable` and no provider call is made.
- AC-6: GIVEN a ledger with too little dollar, call, token or concurrency headroom THEN the request is refused with 429 and the matching code, and no provider call is made.
- AC-7: GIVEN N concurrent requests against a grant whose dollar budget covers K reservations THEN at most K provider calls are made.
- AC-8: GIVEN an allowed call whose provider reports a cost THEN the receipt carries the answering model version, token counts, `costUsd`, and `debitedUsd` equal to that cost.
- AC-9: GIVEN an allowed call whose provider reports no cost, or which fails after being sent THEN `debitedUsd` equals the grant's `maxUsdPerCall`.
- AC-10: WHEN a body names `baseURL`, `apiKey` or `endpoint` THEN the route returns 400 before resolving any grant.
- AC-11: WHEN a per-task token names a worker on another task THEN the route returns 404.

**Calling it from an agent script**

The agent's normal script (on the runner, in the task's checkout) posts one
request per decision with its task credential, and keeps its own results:

```bash
curl -sS -X POST "$BUILDD_SERVER/api/agent-capabilities/model-inference" \
  -H "Authorization: Bearer $BUILDD_API_KEY" -H 'content-type: application/json' \
  -d '{"workerId":"'"$BUILDD_WORKER_ID"'","model":"typesafe/jev-1.13",
       "state":"<one dataset row>",
       "questions":{"label":{"type":"choice","instructions":"Classify the row.","criteria":{"a":null,"b":null}}}}'
```

A 200 returns `{ answers, receipt }`; the receipt's `debitedUsd` is what the
grant was charged. Refusals return `{ error, code }` (and a `receipt` when the
provider was reached). The script aggregates its own results and saves them
as a task artifact through the usual artifact tools; nothing here stores
datasets or runs evaluations.

**Integration contract for the grant service (task 0bfbe2dc)**

Implement `ModelInferenceGrantSource` and pass it in place of
`NO_GRANT_SERVICE` in `defaultModelInferenceDeps`. For capability
`model.inference`, the stored grant is scoped to team, workspace, task and
worker, names one provider (`openrouter` | `litellm`), exact model ids,
operations (`decide`), `expiresAt`, `revokedAt`, and a
`ModelInferenceBudget`. Return null for anything not live; this module
re-checks every field regardless. A grant on a terminal task MUST read as not
live. The ledger (`ModelInferenceLedger`) needs per-grant running totals;
until a table exists, `NO_LEDGER` keeps refusing.

**Code surface**:

- Route: `apps/web/src/app/api/agent-capabilities/model-inference/route.ts` (`POST`)
- Adapter, seams and rules: `apps/web/src/lib/capability-model-inference.ts` (`invokeModelInference`, `checkGrant`, `reserveRefusal`, `parseModelInferenceRequest`, `resolveTeamDecisionRoute`, `NO_GRANT_SERVICE`, `NO_LEDGER`)
- Principal: `apps/web/src/lib/agent-capabilities/worker-principal.ts`, `apps/web/src/lib/agent-capabilities/principal.ts`
- Audit: `apps/web/src/lib/agent-capabilities/audit.ts`, table `agentCapabilityDecisions` in `packages/core/db/schema.ts`
- Key and route resolution: `packages/core/decision-client.ts` (`resolveDecisionRoute`)
- Transport: `packages/ai-kit/src/decide/index.ts` (`decide`)

**Out of scope**: generic `chat` or completion proxying, agent-supplied
endpoints or keys, running evaluations or storing datasets, the grant
request/approve UI and policy (task 0bfbe2dc), and the ledger table.
