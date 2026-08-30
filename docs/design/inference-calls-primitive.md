# Inference Calls as a First-Class Primitive

**Status:** Partially implemented — Step 1 (the client) and Step 3 (the judge) are done; see "Implementation status" below.
**Related:** `packages/core/task-classifier.ts:66-128`, `apps/web/src/lib/mission-criteria-eval.ts:42-146`, `apps/web/src/app/api/missions/[id]/evaluate/route.ts:67-174`, `apps/web/src/app/api/qa/judge/route.ts:75-203`, `packages/core/model-tier-registry.ts`, `packages/core/model-tier-defaults.ts`, `docs/design/model-tiers.md`, `docs/credentials-architecture.md`

---

## Problem

Buildd has one execution primitive: an agent run (worktree, OAuth subscription seat, full Claude Code session). Anything requiring a cheap synchronous judgment has no supported path, so it gets smuggled in as a hand-rolled `fetch` to `api.anthropic.com`. There are four such call sites today, each independently invented:

| # | Site | File | Lines | Model resolution |
|---|------|------|-------|-----------------|
| 1 | `classifyTask` | `packages/core/task-classifier.ts` | 66–128 | `await resolveModelName('haiku')` (DB alias cache) |
| 2 | `judgeWithLLM` (auto-eval) | `apps/web/src/lib/mission-criteria-eval.ts` | 42–146 | `resolveTierEntrySync('budget').model` (code defaults only, ignores DB registry) |
| 3 | `judgeWithLLM` (on-demand route) | `apps/web/src/app/api/missions/[id]/evaluate/route.ts` | 67–174 | `const LLM_MODEL = 'claude-haiku-4-5-20251001'` (hardcoded) |
| 4 | `judgeCapture` (QA judge) | `apps/web/src/app/api/qa/judge/route.ts` | 75–203 | `const MODEL = 'claude-haiku-4-5-20251001'` (hardcoded) |

The accumulated damage:

- **Four model-resolution strategies** (`resolveModelName` alias cache, `resolveTierEntrySync` sync-only, two hardcoded constants). Changing the budget model requires four edits in three packages.
- **Three fence-stripping regexes**: site 1 strips `` ```json `` blocks; sites 2–4 use `text.match(/\{[\s\S]*\}/)`. None handle all cases.
- **Four divergent failure modes**: throw before fetch (site 1), return `[]` and log (sites 2–3), return HTTP 503 (site 4). Callers cannot distinguish a missing key from a malformed response from a transient timeout.
- **Hardcoded Anthropic endpoint and `x-api-key` header everywhere.** The model tier registry already stores `provider: 'openrouter'` rows, but no server-side code implements them. Adding a new provider today means touching every call site.
- **No cost visibility.** Inference spend hits a different budget (dollar budget) than agent runs (session window), but nothing attributes or reports it.

Nothing is broken in a user-visible way today. The cost is architectural: the platform cannot change the budget model, add a provider, or observe inference spend without editing four separate files.

---

## Current State Detail

### Site 1 — `classifyTask`

`packages/core/task-classifier.ts:66-128`. Called from the task-create path to assign a `category`. Reads `apiKey` from its input or `process.env.ANTHROPIC_API_KEY`; throws if absent. Uses the async `resolveModelName` alias resolver (5-minute in-memory cache, DB `system_cache` table) — the only call site with proper DB-backed resolution. Strips markdown fences with two regexes. Throws on non-2xx or parse failure.

### Sites 2 and 3 — `judgeWithLLM`

Two nearly-identical copies of the same function, one in `apps/web/src/lib/mission-criteria-eval.ts` (auto-eval path, triggered by cron/mission completion) and one in `apps/web/src/app/api/missions/[id]/evaluate/route.ts` (on-demand HTTP handler, rate-limited to 6 per mission per hour). Both judge mission goal criteria against task summaries + 3 KB artifact snippets. Both read `process.env.ANTHROPIC_API_KEY` and silently degrade — marking all criteria `NOT_EVALUATED` — when the key is absent. Both return `[]` on any API error or parse failure, causing the **entire batch of N criteria to silently degrade** on a single failure. Site 3 is hardcoded to `claude-haiku-4-5-20251001`. Site 2 calls `resolveTierEntrySync('budget').model` which resolves to the same constant from code defaults (not the DB registry).

### Site 4 — `judgeCapture`

`apps/web/src/app/api/qa/judge/route.ts:75-203`. Called by the spec-drift visual QA workflow. Supports multimodal input (base64 PNG screenshots). Returns a structured `overallVerdict` field. The only call site that returns HTTP 503 when the key is absent rather than degrading. Hardcoded to `claude-haiku-4-5-20251001`.

---

## Two-Primitive Model

The platform has two distinct execution shapes. Neither is better; the shape of the work determines the choice.

### Primitive A: Agent Run

Stateful, tool-using, repo-bearing, OAuth-subscription-authed. A full Claude Code session with a worktree, seat, and session window. Takes minutes to hours. The right choice when work requires: reading or writing files, running shell commands, making commits, using MCP tools, or accumulating context across turns.

### Primitive B: Inference Call

Single-shot, synchronous, structured output, metered by API tokens. A single `POST /v1/messages` call with a fixed prompt, expected to return in under 10 seconds. The right choice when work requires: classification, judgment, summarization, or validation of a fixed context that fits in one prompt.

**Decision rule:** If the task can be completed with a single prompt + response, use an inference call. If it needs tool use, iteration, or a repo, use an agent run.

**Auth constraint — no ambiguity allowed:** OAuth subscription auth is runner-anchored by design (see `docs/design/runner-oauth-broker.md`). The OAuth broker provisions session tokens against a subscription seat, not per-request. An inference call structurally cannot reuse subscription auth — it is metered API dollars or nothing. This is not a cost optimization; it is an architectural invariant. Do not revisit this per-call-site.

---

## Proposal

Introduce `packages/core/inference-client.ts`: a single, typed client that every existing call site migrates to.

### The Crux

The one decision this design turns on: **does the client own model resolution, or does the caller?**

If the caller resolves the model (e.g., `resolveTierEntry('budget').model` before calling), then the client is just a typed `fetch` wrapper. That's simpler but it doesn't fix the divergence — callers still carry model-selection logic and the three resolvers stay alive.

If the client owns resolution (caller passes a `tier: 'budget'` and the client resolves it), then convergence is real: one resolver, one place to add OpenRouter, one migration path.

**Decision: the client owns resolution.** Callers pass a tier name. The client calls `resolveTierEntry` (async, DB-backed) and maps the provider field to the correct endpoint and auth header.

### Point 1: Provider Abstraction

One client, two providers at launch: Anthropic and OpenRouter. The model tier registry already stores `provider: 'anthropic' | 'openrouter'` on each tier row. The client reads this field and routes accordingly:

```
provider='anthropic'  → https://api.anthropic.com/v1/messages
                         headers: { x-api-key, anthropic-version }

provider='openrouter' → https://openrouter.ai/api/v1/chat/completions
                         headers: { Authorization: Bearer <key>, HTTP-Referer }
                         body: OpenAI-compatible chat format
```

Structured-output handling (JSON extraction) lives in the client once:

```typescript
// Preferred: JSON mode via tool use (Anthropic) or response_format (OpenRouter)
// Fallback: extract first {...} block, validate against expected schema
```

The client exposes one function signature regardless of provider:

```typescript
inferenceCall<T>(params: {
  tier: 'budget' | 'standard' | 'premium';
  system: string;
  user: string;
  schema: ZodSchema<T>;      // or JsonSchema
  maxTokens?: number;        // default: 1024
  workspaceId?: string;      // for workspace-scoped tier overrides
}): Promise<InferenceResult<T>>
```

`InferenceResult<T>` is either `{ ok: true; data: T; model: string; usage: TokenUsage }` or `{ ok: false; error: InferenceError }`.

### Point 2: Structured Output — Per-Item or Batched

The two `judgeWithLLM` sites batch N criteria into one response. This is the correct approach and should stay batched. The honest accounting of the limitation:

**Evidence surface** is the real constraint, not call count. The judge sees task summaries and 3 KB artifact snippets with no repo access. A second call would have the same evidence and would not improve accuracy. A per-criterion loop of N calls buys nothing except N× cost and N× latency.

**Parse failure degrades the batch.** Today, a single JSON parse error returns `[]`, silently marking every criterion `NOT_EVALUATED`. The fix is not per-criterion calls; it is a retry contract.

**Retry and partial-result contract for the new client:**

- On transport error or non-2xx: retry once with 1-second backoff, then return `{ ok: false, error: 'transport' }`.
- On parse failure: attempt JSON extraction (`/\{[\s\S]*\}/`), then Zod validation. If validation fails, return `{ ok: false, error: 'parse' }` with the raw text attached for debug logging.
- Callers receive `InferenceError` and decide their fallback. They do NOT silently return `[]`; they mark individual criteria with `'inference-error'` evidence so the state is visible.
- No per-criterion retry from the client. If the caller needs per-criterion retries, they call the client N times themselves.

### Point 3: Failure Taxonomy

Callers today cannot distinguish a missing key from a malformed response from a transient timeout. The new error type distinguishes:

```typescript
type InferenceError =
  | { kind: 'missing_key'; provider: 'anthropic' | 'openrouter' }
  | { kind: 'transport'; status?: number; message: string }
  | { kind: 'parse'; raw: string; validationErrors: string[] }
  | { kind: 'ambiguous'; raw: string }     // model responded but answer not classifiable
  | { kind: 'rate_limited'; retryAfter?: number }
  | { kind: 'provider_error'; status: number; body: string }
```

`missing_key` is checked eagerly (before the fetch). `ambiguous` is for callers like `judgeCapture` that need to distinguish "model answered but I can't categorize it" from "model said nothing."

### Point 4: Key Management and Scope

**Reuse `manage_secrets`.** The `secrets` table already handles team-scoped and workspace-scoped encrypted credentials. Inference API keys are stored there with:

- `purpose: 'inference_key'`
- `label`: the provider name (`'anthropic'` or `'openrouter'`)
- Scoping: team-wide (`accountId` set, `workspaceId` NULL) is the normal case; workspace-scoped override is supported but optional.

Resolution order: workspace row → team row → `process.env.ANTHROPIC_API_KEY` (for backward compatibility during migration only).

**BYO-key:** Teams that bring their own Anthropic key store it via `manage_secrets action=set label=anthropic purpose=inference_key`. The platform does not currently provide a shared key for inference calls — that is a product decision deferred (see Open Questions).

**When no key is found:** The client returns `{ ok: false, error: { kind: 'missing_key', provider: 'anthropic' } }`. The caller decides the user-facing behavior. The correct per-caller responses are:

| Caller | Missing-key behavior |
|--------|---------------------|
| `classifyTask` | Skip classification; task created uncategorized |
| `judgeWithLLM` (auto-eval) | Mark criteria `NOT_EVALUATED` with `evidence: 'inference key not configured'` |
| `judgeWithLLM` (on-demand) | Return HTTP 422 `{ error: 'inference_key_missing', provider: 'anthropic' }` |
| `judgeCapture` | Return HTTP 503 `{ error: 'Server not configured for AI judgment' }` (existing behavior preserved) |

**Hard 503 vs graceful degrade:** The QA judge's 503 is correct — the caller is a human-triggered workflow and should know why it failed. The auto-eval paths' silent degrade is also acceptable — automated tasks should not block on inference availability. The client does not decide this; it hands back a typed error and the caller acts appropriately.

### Point 5: Model Selection

The tier registry (`manage_model_tiers`) is the only model-resolution surface. The three competing resolvers are retired:

| Resolver | Status | Replacement |
|----------|--------|-------------|
| `resolveModelName('haiku')` (alias cache) | **Retired** — `classifyTask` migrates to `tier: 'budget'` |
| `resolveTierEntrySync('budget').model` | **Retired** — sync resolver ignores DB; call site migrates to async client |
| `const LLM_MODEL = '...'` | **Deleted** |
| `const MODEL = '...'` | **Deleted** |

The client always calls `resolveTierEntry(tier, workspaceId?)` (async, DB-backed, 60-second cache). The `resolveModelName` alias cache (`model-aliases.ts`) becomes runner-only — it resolves names for agent dispatch, not for inference calls.

**Per-conversation model override:** Not in scope for this doc. Chat use cases (below) may want this eventually; the tier registry's `manage_model_tiers` already supports workspace overrides and is sufficient for current needs. A per-request override parameter can be added to `inferenceCall` later without breaking the API.

### Point 6: Cost Accounting

Inference calls consume dollar budget; agent runs consume session window. These are different scarce resources with different reset periods.

The client returns `usage: { inputTokens, outputTokens }` in every successful response. Callers are responsible for recording this if attribution matters. The client does not write to the DB.

**Attribution decision:** For now, record inference token usage at the **team level only** — aggregated, not per-mission or per-task. Reasons:

- Per-mission attribution requires a `missionId` parameter on every call, which half the current callers don't have.
- Dollar budget is already tracked as team spend via `get_budget_forecast`. Inference calls are a small fraction of that for now.
- Adding per-mission attribution later is additive (new optional parameter); removing it is destructive. Start with the simpler model.

**What `get_budget_forecast` should show:** A breakdown line for inference spend (separate from agent-session spend), summed by provider. This is a dashboard change deferred until inference spend is measurable enough to be worth showing.

### Point 7: Chat Use Cases

Enumerated, with honest verdicts on buildability vs. speculative value:

| Use case | Verdict | Notes |
|----------|---------|-------|
| **In-app task classification** (already exists) | **Build** — migrate to shared client | Sites 1–3; core today |
| **Spec-drift visual QA** (already exists) | **Build** — migrate to shared client | Site 4; core today |
| **Ask-about-a-mission** (user sends a question, gets a summary) | **Worth building** | Bounded scope: one prompt, no tool use, mission context fits in one call. First new inference use case after migration. |
| **Summarize-this-thread** (compress a long task note thread) | **Worth building** | Same shape as ask-about-a-mission. Low effort add-on. |
| **In-app chat (multi-turn)** | **Defer** | Multi-turn requires session/history management. Not an inference call — it becomes an agent run or a stateful chat primitive that doesn't exist yet. Not worth building without a concrete user request. |
| **Proactive insights** (automatic mission summaries on completion) | **Defer** | Inference spend without explicit user request. Wait for attribution and cost data first. |
| **Classification of PR diffs** | **Defer** | No concrete caller today. Add when a caller exists. |

**What is NOT worth building:** A general-purpose "call Claude" endpoint for agents. Agents already have the full Claude Code session. An inference endpoint for agents would add a second model-call path per task and make cost attribution impossible. Reject if proposed.

---

## Migration Path

Four steps in dependency order. Each step is independently shippable.

### Step 1: `packages/core/inference-client.ts` — 1 day

Implement the client. Exports: `inferenceCall`, `InferenceResult`, `InferenceError`. Tests: unit tests with mocked fetch for each error kind. No callers yet.

Key implementation note: the `missing_key` check reads from `manage_secrets` (REST) or from `process.env` fallback. This is an async operation; the function is always async. No sync variant.

### Step 2: Migrate `classifyTask` — half day

Replace the inline `fetch` block with `inferenceCall({ tier: 'budget', ... })`. Remove `resolveModelName` import. Update error handling: on `InferenceResult.ok === false`, log and return `{ category: null, model: null }` (task created uncategorized). Retire `model-aliases.ts` usage from this call site.

Tests: existing `task-classifier.test.ts` needs mocks updated to stub `inferenceCall` instead of `fetch`.

### Step 3: Merge `judgeWithLLM` duplication — 1 day

Extract the shared judge logic from sites 2 and 3 into `apps/web/src/lib/llm-judge.ts` (or a similar shared location). Both route handler and auto-eval lib import from there. Migrate to `inferenceCall`. Remove `LLM_MODEL` constant from `evaluate/route.ts`. Update both callers to handle `InferenceError` explicitly (per the table in Point 4).

Tests: both call sites have existing test coverage — update mocks.

### Step 4: Migrate `judgeCapture` — half day

Replace inline `fetch` in `apps/web/src/app/api/qa/judge/route.ts`. The 503 behavior on missing key is preserved — the caller inspects the returned `InferenceError.kind === 'missing_key'` and returns 503. Multimodal support (base64 PNG) is passed through as an `imageB64` optional parameter on `inferenceCall`.

Tests: existing `qa/judge` tests need fetch mock updated.

### Step 5: Delete dead resolvers — quarter day

After all four sites are migrated: delete `resolveModelName` from `packages/core/model-aliases.ts` (or mark it internal/runner-only). Delete `resolveTierEntrySync` from public exports (keep if still needed by runner path, otherwise delete). CI should catch any remaining callers.

**Total estimate:** 3–4 days of implementation. No schema changes. No Vercel environment changes beyond adding `ANTHROPIC_API_KEY` to the secrets table lookup path (env fallback remains for backward compatibility).

---

## Non-Goals

- **Agent run changes.** This doc does not touch how agent workers are dispatched, how OAuth credentials are resolved for runners, or how session windows are managed. Those are out of scope.
- **A platform-provided shared inference key.** Whether buildd offers inference as a metered platform service (where teams don't bring their own key) is a product and pricing decision. This doc defines the technical mechanism; the product decision is separate.
- **Per-mission or per-task cost attribution in the first pass.** Team-level aggregation is sufficient to start. Per-entity attribution is additive later.
- **Multi-turn chat.** Out of scope. A stateful chat primitive is a different shape from an inference call and requires separate design.
- **Streaming responses.** None of the four existing call sites stream. Add streaming to `inferenceCall` only when a concrete caller needs it.
- **Rate-limit management.** The client retries once on transport errors. It does not implement token-bucket rate limiting, adaptive backoff, or provider failover. See `docs/specs/provider-failover.md` for the broader failover spec.
- **OpenRouter implementation in step 1.** The client interface supports OpenRouter by accepting the provider field from the tier registry. The actual OpenRouter HTTP path can be implemented as a stub that returns `{ ok: false, error: { kind: 'missing_key', provider: 'openrouter' } }` until a team configures an OpenRouter key. No caller currently has an OpenRouter tier row.

---

## Open Questions

**Q1: Should the client be in `packages/core` or `apps/web/src/lib`?**

Lean toward `packages/core`. `classifyTask` is already in core, and shared lib code (criteria eval) imports from core. Putting the client in `apps/web` would require moving `classifyTask` or creating a cross-package import that doesn't exist today.

**Q2: Should `manage_secrets` be the key store, or should the platform provide a team-wide key?**

Lean toward `manage_secrets` for now, with `ANTHROPIC_API_KEY` env fallback. The platform key question is a product decision. If buildd starts providing a shared key, the client's key-resolution chain gets a new fallback at the bottom, and no caller changes.

**Q3: Is `model-aliases.ts` used anywhere in runner paths that would break if we stop exporting `resolveModelName` from it?**

Unknown — needs audit in Step 5. Likely yes (runners call `supportedModels()` and `updateModelAliases()`). The plan is to keep the file but remove the `resolveModelName` export from the inference-client path, not delete the file.

**Q4: Should the on-demand evaluate route (`/api/missions/[id]/evaluate`) return 422 or 503 on missing key?**

Lean 422 — it is a user-initiated action and the error is "this feature requires configuration," not "the server is down." 503 implies the server cannot serve any requests right now. 422 + `{ error: 'inference_key_missing' }` is more actionable for a UI to display "Configure your Anthropic key in settings."

---

## Implementation status (2026-08-30)

Landed:

- **Step 1 — `packages/core/inference-client.ts`.** `inferenceCall` owns tier
  resolution, provider routing, key resolution, JSON extraction, the retry
  contract, and the typed error taxonomy. Both providers are real: **OpenRouter is
  implemented, not stubbed** as this doc originally proposed, because routing
  buildd's own LLM calls through OpenRouter was the motivating requirement.
  Multimodal is supported on both (Anthropic base64 block, OpenRouter data-URI
  `image_url`), so Step 4 has nothing left to build in the client.
- **Step 3 — the judge.** `judgeWithLLM` in `mission-criteria-eval.ts` is
  migrated. The duplicate copy in `evaluate/route.ts` this doc listed as Site 3 no
  longer exists — it was removed when `recalculateOverall` was deduplicated, so
  there was one judge to migrate, not two.
- Key storage: `purpose: 'inference_key'`, `label` = provider name, resolved
  workspace → team → env, with an existing `anthropic_api_key` row accepted for
  Anthropic so nobody pastes the same key twice. No schema migration — `purpose`
  is a `text` column and only its TypeScript union changed.

Corrections to this doc's assumptions:

- **Site 1 (`classifyTask`) is dead code.** It has no production callers; the only
  import is its own test. The `classifyTask` wired into `POST /api/tasks` is a
  different, keyword-based function in `apps/web/src/lib/task-category.ts`. Step 2
  should be a deletion decision, not a migration.
- **The missing-key path is not only a degradation.** For prose goal criteria,
  `missing_key` now routes to a dispatched agent run
  (`mission-criteria-prose.ts`), which can use the OAuth subscription an inference
  call structurally cannot. Non-credential errors (transport, 5xx, rate limit,
  parse) do NOT dispatch — they report and let the next evaluation round retry, so
  a provider blip never costs an agent run.

Also landed, beyond this doc's original scope:

- **Per-capability spend policy** (`packages/core/inference-policy.ts`,
  `teams.enabledInferenceCapabilities`). This doc treated "has a key" as the only
  gate; that conflates two decisions. An inference call is seconds and metered
  cents, an agent run is slower and spends a subscription seat already paid for,
  and which trade is right differs per action and per team — an enterprise may want
  every judgment inline, a solo operator on a subscription may want only the
  actions that have no agent path. So capabilities are named
  (`criteria_grading`, `visual_qa`, `task_classification`, `mission_summary`) and
  opted in individually. Default is empty: storing a key changes no behaviour and
  no team's costs move when this ships.
- The check lives inside `inferenceCall`, ahead of tier resolution, so a new call
  site cannot forget it and a disabled capability costs one query rather than a
  round trip. `capability_disabled` joins `missing_key` and
  `unsupported_provider` as errors meaning "no inference path" — for
  `criteria_grading` all three route to the dispatched agent run.
- Each capability declares `fallback: 'agent' | 'none'`. This is the distinction
  the settings UI must not flatten: switching off `criteria_grading` makes it
  slower, while switching off `visual_qa` turns the feature off, because an agent
  run cannot see a screenshot. Answers Open Question Q2's "product decision"
  half — the mechanism is per-capability opt-in; pricing stays separate.

Remaining:

- **Step 4 — `judgeCapture`** (`/api/qa/judge`) still holds its own `fetch` and
  its hardcoded model. Migrating it is now mechanical.
- **Step 5 — retire the dead resolvers.** `resolveTierEntrySync` still has
  non-inference callers; audit before removing.
- Cost accounting (Point 6): `inferenceCall` returns `usage` on every success, but
  no caller records it yet.
