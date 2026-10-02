---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "agent-endpoint-resolver"
    type: "symbol"
    name: "resolveAgentModelRoute"
    path: "packages/core/agent-endpoint.ts"
  - id: "claim-attaches-endpoint"
    type: "symbol_reachable"
    symbol: "attachAgentEndpoints"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
  - id: "runner-applies-endpoint"
    type: "symbol_reachable"
    symbol: "mapAgentModel"
    entry: "apps/runner/src/agent-model-env.ts"
  - id: "cloud-route"
    type: "symbol_reachable"
    symbol: "resolveAgentModelRoute"
    entry: "apps/web/src/app/api/runner/model-endpoint/route.ts"
  - id: "ranking-tests"
    type: "test_file"
    path: "packages/core/__tests__/agent-endpoint-resolve.test.ts"
  - id: "claim-injection-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/agent-endpoint-injection.test.ts"
  - id: "runner-env-invariant-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/agent-model-env.test.ts"
  - id: "cloud-route-tests"
    type: "test_file"
    path: "apps/web/src/app/api/runner/model-endpoint/route.test.ts"
---
# One agent model endpoint for host and cloud runners

**Status:** Implemented (task `6da66631`)
**Related:** `docs/credentials-architecture.md`, `packages/core/litellm-gateway.ts`, `packages/core/secrets/types.ts`, `packages/core/db/schema.ts` (`secrets`), `packages/shared/src/executor.ts` (`CLAIM_CREDENTIAL_FIELDS`), `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/workers/claim/credential-injection.ts`, `apps/web/src/app/api/runner/github-token/route.ts`, `apps/web/src/lib/credential-health.ts`, `apps/web/src/lib/chat/models.ts`, `apps/web/src/lib/chat/openrouter-id.ts`, `packages/ai-kit/src/models/call-config.ts` (`gatewayModel`), `packages/core/model-tier-defaults.ts`, `apps/runner/src/index.ts` (`buildProviderConfig`), `apps/runner/src/workers.ts`, `apps/runner/src/prompt-builder.ts` (`resolveSessionModel`), `apps/cloud-runner/src/outbound.ts` (`resolveModelRoute`), `apps/cloud-runner/src/egress.ts`, `apps/web/src/app/app/(protected)/settings/providers/`, `docs/design/cloudflare-sandbox-runner.md`

---

## Problem

A team that runs its model traffic through one proxy (a LiteLLM gateway, or
OpenRouter) has to configure that proxy three times, in three shapes, and the
runners can't see the one the server already has:

- **Server-side calls** (chat, `inferenceCall`, decision calls) read a team
  gateway from `secrets`: purpose `inference_key`, label `litellm`, JSON
  `{ apiKey, baseUrl }`, resolved by `resolveLiteLLMGateway`. `baseUrl` is the
  OpenAI-compatible root (`https://litellm.example.com/v1`). OpenRouter and
  provider keys are `inference_key` rows too (`apps/web/src/lib/chat/models.ts`).
- **Host runners** ignore all of that. Each machine sets `LLM_PROVIDER` /
  `LLM_BASE_URL` / `LLM_API_KEY` or saves them through the runner UI
  (`POST /api/config/llm-provider`); `buildProviderConfig` turns them into a
  `ProviderConfig`, and `workers.ts` injects `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` (the OpenRouter branch, or any custom `baseUrl`).
  `LLMProvider` is only `'anthropic' | 'openrouter'`. Ten machines means ten
  copies of the key and ten places to rotate it.
- **The cloud runner** reads Worker secrets `MODEL_PROXY_URL` /
  `MODEL_PROXY_KEY` / `MODEL_PROXY_AUTH_HEADER` or the AI Gateway triple, in
  `resolveModelRoute`, and applies them at egress. The container holds only
  `ANTHROPIC_API_KEY_PLACEHOLDER` (`apps/cloud-runner/src/lifecycle.ts`).
  Changing the endpoint means redeploying the Worker.

Separately, a host runner also receives server-managed Anthropic credentials
at claim (`attachServerManagedSecrets` → `serverApiKey` / `serverOauthToken`;
`attachClaudeCredentials` → `claudeAccessToken`), and the runner applies those
after the per-machine provider block. The two sources are layered, not ranked:
nothing states which one an agent actually authenticates with when both are
present.

## Proposal

One agent model endpoint per team, optionally narrowed to a workspace, stored
once in `secrets` and consumed by both runner kinds: host runners receive it
at claim, the cloud dispatcher fetches it server-side and applies it at egress.

### Crux

**The endpoint is a model credential, ranked against the Anthropic key and the
Claude seat in one precedence, not layered on top of them.** When the endpoint
wins for a task, it is the *only* model credential that task's agent process
sees: the runner does not set `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
or a broker-issued Claude token alongside it, and the claim does not attach
them. If this is wrong in the lenient direction, a seat token or a team
Anthropic key rides along to a third-party host (Claude Code sends whichever
auth env vars are set to whatever `ANTHROPIC_BASE_URL` says). If it is wrong
in the strict direction, a workspace that has its own Anthropic key is
silently moved onto the team proxy. The rule below (most specific scope wins,
tie goes to the endpoint) avoids both, and is the one thing the implementation
must test first.

### 1. Storage: a new purpose, `agent_endpoint`

Reusing the `litellm` row was the first option. It can carry the agent side
for LiteLLM: LiteLLM serves the Anthropic Messages API at `/v1/messages` on the
proxy root and accepts both `x-api-key` and `Authorization: Bearer`; Claude
Code is pointed at it with `ANTHROPIC_BASE_URL=<root>` (no `/v1`) and
`ANTHROPIC_AUTH_TOKEN=<virtual key>` (docs.litellm.ai, "Anthropic unified" and
the Claude Code tutorial). So the agent base is derivable from the stored
OpenAI root by dropping a trailing `/v1`.

It is still the wrong home, for three reasons:

1. **Other kinds don't fit.** OpenRouter and a non-LiteLLM Anthropic-compatible
   proxy can't be written as a `litellm` row without lying to chat, which
   would then send OpenAI-style `provider/model` calls to it.
2. **Opposite semantics.** The gateway is a fallback chat reaches only when a
   tier's provider has no key ("a fallback, never a detour"). The agent
   endpoint is an explicit detour for every agent run. One row serving both
   means deleting the chat fallback also reroutes every runner.
3. **Separate spend.** Agent runs cost far more per task than chat. LiteLLM
   virtual keys carry their own budget and model allow-list, so a separate key
   is the operationally right default.

So: add `agent_endpoint` to `SecretPurpose` and the `secrets.purpose` union
(text column, no enum migration), per the checklist in
`docs/credentials-architecture.md`. Encrypted JSON blob, two shapes:

```jsonc
// Reference: use the team's LiteLLM gateway row (same scope or broader) for agents too.
{ "kind": "gateway" }
// Self-contained.
{ "kind": "openrouter" | "anthropic-compatible",
  "baseUrl": "https://litellm.example.com",   // Anthropic-compatible root; /v1/messages is appended
  "apiKey": "…",
  "authHeader": "authorization" | "x-api-key", // default authorization (Bearer)
  "models": { "claude-sonnet-5": "team-sonnet" } } // optional, see §5
```

`kind: gateway` is the one-click path for a team that already has a gateway:
one key, one rotation, and the agent base derived from the gateway's root
(trailing `/v1` dropped; an optional `agentBaseUrl` override in the reference
blob covers proxies mounted elsewhere, e.g. LiteLLM's `/anthropic` route).
A team that wants a separate agent budget uses `anthropic-compatible` with its
own virtual key. `openrouter` defaults `baseUrl` to
`https://openrouter.ai/api`, matching `buildProviderConfig` today.

**Anthropic direct is not a kind.** It is what happens with no endpoint: the
existing `anthropic_api_key` / `oauth_token` / `claude_credential` rows,
unchanged.

**Scope.** Team-wide or workspace. No account rows and no personal rows (as
with the gateway: a proxy is an organisation's shared configuration). One row
per scope (`replaceScoped`). Resolution mirrors `resolveLiteLLMGateway`:
workspace row, then team row, skipping `revoked`, newest first. A new
`resolveAgentEndpoint({ teamId, workspaceId })` in `packages/core/`, returning
`{ kind, baseUrl, apiKey, authHeader, models, secretId, scope }` or null, never
throwing.

**Key policy.** `loadInferenceKeyPolicy` does not bind it: that policy governs
server-side inference spend, and the claim's `anthropic_api_key` delivery
isn't bound by it either. (Open question 3.)

### 2. Precedence (host runner)

Resolved per task, highest first:

1. **Per-machine override.** `LLM_PROVIDER` set to anything but `anthropic`
   (env or saved config), i.e. `buildProviderConfig` returns a config. The
   machine keeps doing exactly what it does today, so no existing setup
   changes. The runner logs once per task that the team endpoint was ignored,
   and reports `llmProviderOverride: true` (a boolean, never the values) on
   its claim so the dashboard can show which runners bypass the team setting.
2. **Server-side, at claim, one ranking across purposes.** Candidates:
   `agent_endpoint`, `anthropic_api_key`, `oauth_token`, `claude_credential`,
   each already resolved to its most specific row. The most specific **scope**
   wins (workspace > team); on a tie the `agent_endpoint` wins, because
   setting it is an explicit opt-in to route agents. Only the winner is
   attached. So a team endpoint plus a workspace Anthropic key: that workspace
   stays on Anthropic. A team seat plus a team endpoint: agents use the
   endpoint, and the seat is not delivered.
3. **Local credentials** on the machine, as today, when the claim attached
   nothing.

When the endpoint wins, the claim attaches
`modelEndpoint: { kind, baseUrl, authToken, authHeader, models }` and nothing
from `serverApiKey` / `serverOauthToken` / `claudeAccessToken` /
`pendingCredentialRefreshes` for that worker. `modelEndpoint` is added to
`CLAIM_CREDENTIAL_FIELDS`, so a cloud claim strips it by construction.

Only a runner that declares `runnerFeatures: ['agent_endpoint']`
(`AGENT_ENDPOINT_RUNNER_FEATURE`) on its claim is given the endpoint. For any
other runner the claim behaves as if no endpoint existed: nothing is resolved,
nothing is withheld, and it gets today's credentials.

The runner applies it in the same block as the per-machine provider:
`ANTHROPIC_BASE_URL = baseUrl`, then `ANTHROPIC_AUTH_TOKEN = key` for
`authorization` or `ANTHROPIC_API_KEY = key` for `x-api-key`, and deletes the
other auth vars and `CLAUDE_CODE_OAUTH_TOKEN`. The invariant, asserted in a
unit test over the built env: **with a base URL set, exactly one model auth
variable is non-empty.** The same invariant applies to the per-machine branch.

Billing and caps follow the credential: an endpoint run is metered, so
`sdkMaxBudgetUsd` applies the dollar cap (it is skipped only for OAuth), and
the OAuth pacing/budget signals don't count it against a seat.

**Codex / OpenAI backends: out.** `task.backend === 'codex'` already skips
Anthropic injection, and the endpoint follows the same skip. Codex speaks the
OpenAI Responses API with a seat or `auth.json`; routing it through a proxy is
a different credential shape. (Open question 4.)

### 3. Cloud runner delivery

The endpoint never appears in an `executor: 'cloud'` claim (stripped as above,
and not even resolved) and never in container env. The container keeps its
placeholder key; the dispatcher substitutes at egress, as today.

- **New route** `POST /api/runner/model-endpoint`, modelled on
  `/api/runner/github-token`: `Authorization: Bearer <runner API key>` plus
  `X-Buildd-Dispatch-Token` (which the container never holds), body
  `{ taskId, workerId? }`, refused unless the task has a live worker owned by
  the calling account in a workspace it may claim from. Returns
  `{ baseUrl, key, authHeader }`, `Cache-Control: no-store`, or 404 when the
  task resolves no endpoint. It applies the same ranking as §2 but only ever
  returns an endpoint: a cloud task whose winner is an Anthropic key or a seat
  gets 404 and falls through to the Worker's own route. There is no per-task
  token on `dev` today; if one lands, this route accepts it in place of the
  API-key-plus-dispatch-token pair.
- **Cache** per task in the `WorkerAgent`, like the GitHub grant (fetched on
  first model request, held in memory for the run, refetched after a 401 from
  the endpoint with a short backoff).
- **Egress.** `resolveModelRoute` gains a server-provided input. Precedence:
  `direct` (local dev, unchanged) > Worker `MODEL_PROXY_URL` (operator
  override) > **server endpoint** > AI Gateway > `unconfigured` (refuse). The
  server endpoint produces the existing `proxy` route shape, so
  `rewriteOutbound` does not change: strip container credentials, set the one
  header, forward to `baseUrl + path`. On every model route only the model API
  paths are forwarded (`MODEL_API_ROUTES`: `POST /v1/messages`,
  `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /v1/models/<id>`,
  in canonical form); anything else is refused with 403 before a credential
  is added.

Worker secrets stay the operator override so a self-hoster's current
deployment keeps working and so an operator can pin a Worker to one proxy
regardless of which team claims through it.

### 4. Verify and health

`POST /api/secrets/[id]/verify` for an `agent_endpoint` row makes **one**
Messages call through the endpoint: `POST {baseUrl}/v1/messages`, the budget
tier model after mapping (§5), `max_tokens: 1`, with the configured header.
This proves the key, the Anthropic route, and that the alias resolves, which
LiteLLM's free `GET /models` (what `verifyGateway` uses) does not. Results map
like `verifyGateway`: 2xx `healthy`, 401 `revoked`, anything else `unknown`
(an outage never marks it dead). A 403 is `unknown`, not `revoked`: a LiteLLM
key restricted to some models answers 403 for the rest, so it means "this key
may not use this model". A save with a 403 is refused with a message naming the
model and pointing at the alias table. With an alias table the probe is a model
the endpoint will actually be asked for: the budget model's alias target if it
has one, else the first alias target (`agentEndpointProbeModel`).

Both verifications go through `verifyByFetch` (`packages/core/net/public-address.ts`):
the host must resolve only to public addresses, redirects are never followed
(a 3xx fails the check), and the recorded error is a fixed message plus at
most a status code, never reply text. A URL with userinfo, a query or a
fragment is refused at validation; plain http and the loopback hosts only
outside production. A save refuses a URL whose check was blocked (non-public
host or redirect).

Recorded on the existing columns: `healthStatus`, `lastVerifiedAt`,
`lastVerificationError`, `lastSuccessAt`. Runtime auth failures (a host
runner's spawn-time 401, a dispatcher egress 401) feed `consecutiveAuthFailures`
/ `lastFailureAt` / `lastFailureMessage` through `credential-health.ts`, so a
dead endpoint shows on the health page like a dead seat.

### 5. Model naming

Tiers keep naming models by their native id (`TIER_DEFAULTS`,
`model_tier_registry`); the claim keeps writing that id into
`task.context.model`, and `task_outcomes` keeps pricing by it. The endpoint
translates only on the wire:

- `openrouter`: `openRouterModelId('anthropic', id)` (dotted, undated), the
  rule chat already uses.
- `gateway` / `anthropic-compatible`: `models[id]` if mapped, else the id
  unchanged. LiteLLM's own Claude Code guide registers native ids as aliases,
  so the common case needs no map. Unlike `gatewayModel`, no `provider/`
  prefix: Claude Code sends the model string verbatim and the alias is what
  the proxy config names.

The map travels in `modelEndpoint.models`; the runner applies it to
`sessionModel`, `fallbackModel`, and sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to
the mapped budget model so Claude Code's background calls hit an alias that
exists. The runner's `MODEL` stays the default for non-claim paths only,
exactly as `resolveSessionModel` does now. A per-machine override (§2.1) gets
no map: that machine owns its naming.

Tier rows whose provider isn't `anthropic` are unaffected, except that a
`gateway` or `openrouter` endpoint may also serve `openrouter`-provider tier
rows (their ids are already OpenRouter slugs). `openai-codex` rows never go
through it.

### 6. UI

Settings → Model providers (`/app/settings/providers`), a new "Agent runs"
card next to `GatewayAndDecisionModel`: **Anthropic (default)** / **Use the
team gateway** (enabled only when a gateway exists) / **OpenRouter** /
**Anthropic-compatible URL**. Scope selector (all workspaces, or one), header
choice for the custom URL, optional alias map, Verify button, health line. It
also lists runners reporting `llmProviderOverride`. Owners/admins only, masked
like the gateway (last four characters).

### 7. Defaults are no-ops

No `agent_endpoint` row exists until someone creates one. With none, the claim
ranking reduces to today's attach logic, the cloud route returns 404 so egress
falls through to the Worker secrets, and the runner's env build is unchanged.
Per-machine `LLM_*` keeps winning when set.

### 8. Migrating per-machine config

Nothing moves automatically: a machine's key may not be the team's. The path
is: set the team endpoint, Verify, then remove `LLM_*` from each machine (or
pick "Anthropic" in the runner UI). The override list in the card shows which
machines are left. `LLMProvider` stays `'anthropic' | 'openrouter'`; the
runner learns no new local kinds, because the custom-URL case already works
through `LLM_BASE_URL`.

## Implementation sketch

1. **Env invariant first**: extract the runner's model-auth env block into a
   pure function; test "base URL set ⇒ exactly one auth var" for the
   per-machine branch as it exists today.
2. `agent_endpoint` purpose, blob parse/serialize/validate (reusing
   `gatewayUrlProblem`), `resolveAgentEndpoint`.
3. Claim ranking across purposes + `modelEndpoint` attach + add it to
   `CLAIM_CREDENTIAL_FIELDS`; route tests for each tie case in §2.
4. Runner: apply `modelEndpoint`, model mapping, `llmProviderOverride` report.
5. `/api/runner/model-endpoint` + `WorkerAgent` cache + `resolveModelRoute`
   precedence.
6. Verify handler, health wiring, settings card.

## Open questions

1. **Does a tie really go to the endpoint over a team seat?** Lean yes: the
   endpoint only exists because someone chose to route agents. The cost is a
   team that set it for a trial and forgot, now metered instead of on a seat;
   the settings card should say "agent runs are metered through X" plainly.
2. **Cloud naming under the Worker override.** When `MODEL_PROXY_URL` wins at
   egress, the container's model ids come from the claim, not from the
   operator's proxy. Lean: document that the Worker override owns naming, and
   deliver the non-secret alias map on cloud claims only when no Worker
   override is configured (the dispatcher can tell the claim which it has).
3. **Should key policy `own` suppress the endpoint?** Lean no, for parity with
   `anthropic_api_key` at claim; revisit if key policy grows an agent-side
   meaning.
4. **Codex through the endpoint.** LiteLLM can front the Responses API, but a
   Codex run authenticates as a seat. Lean out until a team asks; it would be
   a separate `kind` with its own env mapping, not a change to this one.
5. **Account-scoped endpoints.** Lean no (none for the gateway either). An
   account is an API-key identity, and per-runner routing is what the
   per-machine override is for.

## Non-goals

- Changing how chat, `inferenceCall`, or decision calls pick keys; the gateway
  row and its fallback order stay as they are.
- Load balancing or failover across several endpoints
  (`docs/design/backend-failover-policy.md`).
- Moving or deleting existing per-machine config or Worker secrets.
- Proxying GitHub or MCP traffic; this is model traffic only.
- A new credential table.
