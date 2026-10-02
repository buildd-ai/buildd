# Model routes: one registry for every place a model call can go

**Status:** Accepted. Phases 1–2 implemented; 3–4 proposed.
**Related:** `packages/ai-kit/src/models/routes.ts`, `packages/core/inference-route.ts`, `packages/core/inference-client.ts`, `apps/web/src/lib/chat/models.ts`, `packages/core/inference-keys.ts`, `packages/core/litellm-gateway.ts`, `packages/core/agent-endpoint.ts`, `apps/runner/src/agent-model-env.ts`, `apps/cloud-runner/src/outbound.ts`, `docs/design/agent-model-endpoint.md`, `docs/credentials-architecture.md`

---

## Problem

"Provider" meant two things. The tier registry's `provider` is the **vendor**:
who makes the model and what it costs. OpenRouter and a LiteLLM gateway are
**routes**: where the bytes go, with which key, in which wire format. Because
the two were never separated, each call site wrote its own fallback chain, and
they disagreed:

- chat: own key → OpenRouter → gateway;
- `inferenceCall`: own key → gateway. No OpenRouter fallback, and an `openai`
  tier could never call OpenAI directly (`unsupported_provider`);
- `/api/ai/plan`: own key → OpenRouter.

So a team whose only key was OpenRouter got chat, and `missing_key` on goal
grading. Base URLs, attribution headers, verify endpoints and model-id
rewriting were each copied in several places, and around eight type unions
named overlapping provider sets.

## Proposal

**Crux:** a route is data, not a branch. `ROUTES` (`@builddai/ai-kit/models`,
pure, shared with outside apps) holds per route: wire format
(`anthropic-messages` | `openai-chat`), API root (or "on the credential", for a
gateway), auth scheme, verify path, vendors served, whether personal keys are
allowed, attribution, and whether it reports cost. `routeOrder(vendor)` is the
one fallback order; `routeModelId` the one id rewrite. If the crux is wrong (a
route needs behaviour a descriptor can't express), the escape hatch is a
per-wire transport, which already exists, not a per-route branch.

Server-side, `resolveInferenceRoute` (`packages/core/inference-route.ts`) walks
`routeOrder` and returns the first route with a credential: keys through
`resolveInferenceCredential` (scope precedence and key policy unchanged), the
gateway through `resolveLiteLLMGateway`. Chat and `inferenceCall` both use it;
`inferenceCall` sends by wire format. Receipts keep the planned vendor and
model, so pricing does not depend on the route.

Anthropic and OpenAI are not special cases: each is a route with a fixed root,
the native id, and only itself as vendor.

**Subscription seats (OAuth)** stay supported but are not routes and the
design is not built around them. They are anchored to a runner seat and never
serve a server-side call (`inference-client.ts`); agent runs keep their
existing precedence (`agent-endpoint.ts`). Expect them to matter less over time.

### Phases

1. **Registry** in ai-kit; `toCallConfig`, `verifyProviderKey` and
   `openRouterModelId` read it. No behaviour change. *(done)*
2. **One resolver** for chat and `inferenceCall`. Behaviour change, deliberately:
   `inferenceCall` gains the OpenRouter fallback and OpenAI direct. *(done)*
3. **Agent runs on the same vocabulary**: `agent_endpoint.kind` and the
   runner's `LLM_PROVIDER` become route ids; `agentBaseURL` replaces the
   OpenRouter agent-root constants; Cloudflare AI Gateway (cloud runner) joins
   `ROUTES`.
4. **Settings → Providers** renders from `ROUTES` instead of per-provider cards.

## Safety

The resolver is bounded by the route list (at most one lookup per route, no
retries of its own); a failing lookup moves to the next route, never throws.
A key still never reaches a provider it was not issued for: the route id *is*
the `inference_key` label, re-checked in `resolveInferenceCredential`. A gateway
stays team-only (`personalKeys: false`) and is still called only on public
addresses without redirects.

## Open questions

- **Per-team route order.** One fixed order today. A team that prefers its
  gateway over a vendor key (to keep spend in one place) can't say so. Lean:
  add an optional ordered list on `teams` when someone asks; the resolver
  already takes the order from one function.
- **`/api/ai/plan`** still applies its own OpenRouter fallback from the app's
  declared providers. Lean: move it onto `routeOrder` in phase 3; it differs
  only in that the app, not buildd, holds the keys.
- **Feature differences** (prompt caching and thinking on the Anthropic wire,
  `response_format` and logprobs on OpenAI-compatible routes) are not on the
  descriptor yet. Add a capability set when the first call site needs to pick a
  route by capability rather than by key.

## Non-goals

- Codex and other agent backends: they drive a CLI, not an endpoint.
- System One / Jev decisions: a capability of the OpenRouter route, kept in
  `decision-client.ts`.
- OpenRouter as a **data source** (catalog, rankings, tier pools).
- Storage: no new table or purpose. `inference_key` labels already are route ids.
