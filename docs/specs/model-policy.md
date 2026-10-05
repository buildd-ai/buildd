---
title: Standalone Model Policy
status: active
owner: max
last_verified: 2026-10-05
summary: A caller MUST get provider, model and effort from surface (chat or coding) plus tier alone, locally or from the policy service, with a fallback answer always and no provider secret ever crossing the boundary.
domain: integrations
surfaces: [packages/ai-kit/src/policy/resolve.ts, packages/ai-kit/src/policy/protocol.ts, packages/ai-kit/src/policy/client.ts, apps/model-policy/src/handler.ts, packages/core/model-policy.ts]
related: [model-routing-and-tiers, usage-and-cost-accounting]
keywords: [model policy, surface, tier, coding, chat, resolve-only, remotePolicy, createPolicyClient, policy token, shadow, split, adaptive, planId, outcomes]
verified_by: [packages/ai-kit/src/policy/resolve.test.ts, packages/ai-kit/src/policy/protocol.test.ts, packages/ai-kit/src/policy/client.test.ts, packages/ai-kit/src/policy/contract.test.ts, apps/model-policy/src/handler.test.ts, apps/model-policy/src/imports.test.ts, packages/core/__tests__/model-policy.test.ts, packages/core/__tests__/model-policy-authority.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "policy-resolver"
    type: "symbol"
    name: "resolveModelPolicy"
    path: "packages/ai-kit/src/policy/resolve.ts"
  - id: "policy-request-parser"
    type: "symbol"
    name: "parsePolicyRequest"
    path: "packages/ai-kit/src/policy/protocol.ts"
  - id: "local-first-client"
    type: "symbol"
    name: "createPolicyClient"
    path: "packages/ai-kit/src/policy/client.ts"
  - id: "optional-remote-policy"
    type: "symbol"
    name: "remotePolicy"
    path: "packages/ai-kit/src/policy/client.ts"
  - id: "policy-service-handler"
    type: "symbol"
    name: "handle"
    path: "apps/model-policy/src/handler.ts"
  - id: "resolver-precedence-tests"
    type: "test_file"
    path: "packages/ai-kit/src/policy/resolve.test.ts"
  - id: "fallback-tests"
    type: "test_file"
    path: "packages/ai-kit/src/policy/client.test.ts"
  - id: "credential-boundary-tests"
    type: "test_file"
    path: "apps/model-policy/src/imports.test.ts"
  - id: "buildd-registry-as-policy"
    type: "symbol"
    name: "registryModelPolicy"
    path: "packages/core/model-policy.ts"
  - id: "buildd-remote-default-layer"
    type: "symbol"
    name: "resolveRemoteTier"
    path: "packages/core/model-policy.ts"
  - id: "buildd-single-authority-guard"
    type: "test_file"
    path: "packages/core/__tests__/model-policy-authority.test.ts"
---

# Standalone Model Policy

Design: artifact "Standalone model policy: surface + tier, inferred intent".
The protocol lives in `@builddai/ai-kit/policy`; `apps/model-policy` is the
small Cloudflare Worker that serves it. Neither imports buildd code, and an app
can use either with no buildd account.

## Resolve

**Capability statement**: Given `{ surface, tier, app?, workspaceId? }`, the
resolver MUST return one `{ provider, model, effort, policyVersion, planId }`
under a fixed precedence, and the caller MUST NOT be able to declare intent.

**Invariants**:
- The request has exactly four fields. Any other (`intent`, `workload`,
  `kind`, `model`, `messages`, `prompt`, a key) is refused, never ignored
  (`parsePolicyRequest`).
- `surface` is `chat | coding`. buildd's `agent` is `coding` at this boundary
  (`toPolicySurface`); a request or document using `agent` is refused with a
  message naming `coding`.
- Tiers are buildd's four (`premium-plus | premium | standard | budget`), for
  both surfaces. There is no separate chat or coding tier vocabulary.
- Precedence, first match wins: override for app/workspace (+ surface) + tier
  (workspace > app, then surface-scoped > both-surface) → `surfaces[surface][tier]`
  → `tiers[tier]` → the bundled fallback (`pickRoute`). This is the order of
  buildd's tier registry (`pickRegistryRow`), with app/workspace overrides in
  place of workspace rows.
- `DEFAULT_MODEL_POLICY` equals buildd's `TIER_DEFAULTS`
  (`policy/contract.test.ts`).

**Acceptance criteria**:
- AC-1: WHEN a policy maps `chat.standard` and `coding.standard` differently THEN
  the same `tier: 'standard'` resolves to each per surface.
- AC-2: WHEN a request carries `intent` THEN it is refused with `unknown field intent`.
- AC-3: WHEN a policy leaves a tier unset THEN the decision comes from the
  fallback with `source: 'bundled'`.

## Fallback

**Capability statement**: `createPolicyClient.resolve` MUST always return a
callable model.

**Invariants**:
- A local `ModelPolicy` needs no service and makes no network call.
- With `remotePolicy`, a timeout (800ms default), non-2xx, network error or
  unusable answer serves the last good decision for the same request for up to
  `maxStaleSeconds` (`source: 'cached'`), then the fallback policy
  (`source: 'fallback'`, `planId: null`).
- The Worker answers 503 with no valid policy, so the client's own fallback
  (which knows the app's providers) applies instead of a guess.

## Credentials

**Capability statement**: A policy token MUST authorise policy calls only, and
no provider secret MUST ever cross the policy boundary.

**Invariants**:
- `remotePolicy` refuses a provider-key-shaped token and a non-https endpoint
  off localhost.
- A remote decision carrying a credential-shaped key or value anywhere is
  refused and the client falls back (`parsePolicyDecision`,
  `findCredentialLike`); accepted decisions are rebuilt from known fields only.
- The Worker's env is `POLICY_TOKENS` and `MODEL_POLICY`, nothing else; a buildd
  key is not a policy token; an empty or malformed token ring answers 503.
- The Worker imports only `@builddai/ai-kit/policy` (`imports.test.ts`).

## Experiments and outcomes

**Capability statement**: Experiments MUST NOT move traffic automatically
without a trustworthy signal, and outcomes MUST stay typed observations.

**Invariants**:
- Modes: `pinned` (one arm), `split` (weighted, sticky per workspace/app),
  `shadow` (applied route unchanged; the challenger is named on the decision),
  `adaptive` (weights moved from a declared signal).
- `adaptive` needs a surface and a signal in `TRUSTWORTHY_SIGNALS[surface]`.
  Coding: tests, goal criteria, review verdict, merge, rework. Chat: none yet,
  so chat experiments are split or shadow only. v1 has no weight mover.
- Outcome reports are `{ planId, surface, observations[] }` with typed
  observations; there is no score field, and coding-only observations are
  refused on chat. The Worker v1 records them as log lines.

**Code surface**: `packages/ai-kit/src/policy/types.ts`, `packages/ai-kit/src/policy/defaults.ts`,
`packages/ai-kit/src/policy/resolve.ts`, `packages/ai-kit/src/policy/protocol.ts`,
`packages/ai-kit/src/policy/client.ts`, `apps/model-policy/src/handler.ts`,
`apps/model-policy/src/auth.ts`, `apps/model-policy/wrangler.jsonc`.

## buildd on the policy

**Capability statement**: buildd's own tier selection, for agent claims and
for chat and inference calls, MUST go through this resolver; there is no
second tier resolver in buildd.

**Invariants**:
- A team's `model_tier_registry` rows are a `ModelPolicy`
  (`registryModelPolicy`, `packages/core/model-policy.ts`): team rows →
  `tiers`, team surface rows → `surfaces` (`agent` → `coding`), workspace rows →
  `overrides`. `resolveTierEntry` resolves it with the kit's `pickRoute`;
  `pickRegistryRow`, which the admin views use, is answered the same way.
  Settings and `manage_model_tiers` keep writing rows; nothing else changes
  for an admin.
- Agent claims ask surface `coding`; chat turns and `inference-client` ask
  `chat`. Every resolved entry carries `policy: { version, planId, source,
  surface, experiment? }`; claims store it as `context.resolvedTier.policy`.
- A tier the registry leaves unset is the service's to answer when
  `BUILDD_MODEL_POLICY_URL` + `BUILDD_MODEL_POLICY_TOKEN` are set
  (`resolveRemoteTier`, `source: 'policy'`). A registry row is never
  overridden by the service. A `bundled`/`fallback` service answer is not
  authoritative: buildd's catalog pick and the bundled policy apply.
- Outage: a failed resolve backs off 30s and serves the last good service
  answer as `cached` with `planId: null` (outcomes from many runs never land on
  one plan), then the catalog, then `DEFAULT_MODEL_POLICY`. The DB being down
  skips the registry, not the policy.
- `TIER_DEFAULTS`, the alias map and every code-level default
  (`bundledTierEntry`) are derived from `DEFAULT_MODEL_POLICY`. No call site
  indexes `TIER_DEFAULTS` or reads registry rows to resolve a tier
  (`model-policy-authority.test.ts`); model-id literals are policed by
  `scripts/lint-model-ids.ts`.
- Exact-id pins (task `model`, role full id) are the documented escape hatch
  and bypass tier resolution. A shorthand pin (`opus`/`sonnet`/`haiku`) is a
  tier request (`shorthandPinTier`) and resolves through the policy. A model
  the runner cannot launch is replaced by the dispatch guard, and the claim
  then stores no policy decision (none ran).
- Coding outcomes go to the service only for a decision it issued (a
  planId): `tests` from CI on the run's PR, `review_verdict` + `rework` from
  the reviewer, `merged` on merge, `duration` + `cost` at the run's end. Chat
  reports nothing: buildd has no chat signal keyed to a decision yet.
  Experiment and pool arms buildd draws itself are not policy decisions and
  report nothing here.

**Acceptance criteria**:
- AC-4: WHEN a team splits `standard` by surface THEN a claim gets the
  `coding` row and a chat call the `chat` row.
- AC-5: WHEN a registry row pins a tier and a service is configured THEN the
  service is not asked for that tier.
- AC-6: WHEN the service fails THEN the claim resolves from the last good
  answer with no planId, or the bundled policy, and the next 30s make no call.

## Verification gaps

- Deploying the Worker needs Cloudflare credentials and its runtime secrets;
  that is the one manual step (`apps/model-policy/README.md`, Deploy). Until
  `BUILDD_MODEL_POLICY_URL`/`_TOKEN` are set, buildd resolves locally (registry
  + bundled policy) and reports no outcomes.
- buildd's own model-routing experiment and tier pools still draw arms on top
  of the policy's decision; they are not yet policy experiments.
