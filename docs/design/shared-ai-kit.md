# Shared AI kit: chat, Jev decisions and the model economy for sibling apps

**Status:** Proposed
**Related:** `packages/core/model-tier-registry.ts` (`resolveTierEntry`, `resolveAllTiers`), `packages/core/model-tier-defaults.ts`, `packages/core/tier-pool-source.ts` (`drawChatPoolArm`), `packages/core/decision-client.ts` (`decisionCall`, `gateChoice`), `packages/core/inference-client.ts`, `packages/core/inference-keys.ts`, `packages/shared/src/chat.ts`, `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/models.ts`, `apps/web/src/lib/chat/routing.ts`, `apps/web/src/components/chat/`, `apps/web/src/app/api/model-tiers/route.ts`, `apps/web/src/lib/api-auth.ts`, `docs/SPEC.md` §3a, `docs/design/agent-chat.md`, `docs/design/chat-canvas.md`, `docs/design/decision-calls.md`, `docs/design/inference-calls-primitive.md`, `docs/design/model-tiers.md`, `docs/design/tier-model-pools.md`, `docs/design/tier-weights.md`, `docs/design/model-quality-signals.md`, `docs/design/cross-app-assertion-grant.md`

External consumers (private repos, cited as `repo:path`): `dispatch-family` (Cue), and the two apps in `moa-ops` (`nextjs-app`, the store ops app; `money-app`, personal finance).

---

## Problem

Three sibling apps use models today and each one picks and calls them in its own way. None of them uses the economy buildd already has.

| App | How it picks a model | How it calls Jev | Chat |
|---|---|---|---|
| buildd | Tier registry: workspace row, then team row, then catalog, then `TIER_DEFAULTS`, per surface (`agent` / `chat`). Pools with traffic splits exist in P1 | `decisionCall` through `@typesafe-ai/sdk` 0.6.0 to OpenRouter `/api/v1/systemone`, 5s deadline, never throws | AI SDK v7 UI message stream, in the web function, approval cards, tier switch, budgets |
| Cue | `dispatch-family:src/lib/model-tiers.ts` passes a tier string (`budget`/`standard`/`premium`) to buildd tasks. No model call of its own | `dispatch-family:src/lib/jev.ts`: raw `fetch` to OpenRouter `/api/alpha/decisions`, 8s timeout, 3 attempts | None. `CLAUDE.md` forbids any direct generative call; all AI work is a buildd runner task |
| store (`nextjs-app`) | `nextjs-app/src/lib/ai/config.ts` `getModelForUseCase`: env `AI_MODEL`, then DB `system_settings` `ai_model:<useCase>`, then a hardcoded vendor model id | `@typesafe-ai/sdk` is in `package.json` but unused | `/api/chat` was deleted as unused. Two `/api/agent/*` streaming routes remain |
| money (`money-app`) | Same `lib/ai/config.ts` copy, same DB keys (the two apps share a database today, so one app's setting silently changes the other's) | `money-app/src/lib/services/finance/jev-classifier.ts`: SDK `systemOne`, auto-apply at 0.9, a versioned fingerprint test, an offline eval harness | `/api/agent/personal-chat`: `openai` SDK with a hand-rolled tool loop, wrapped in `createUIMessageStream` from AI SDK v6 |

What this costs us, concretely:

1. **Three Jev clients, two endpoints, three retry policies.** A model bump (`typesafe/jev-1.13` to the next release) is three PRs in three repos, each with its own eval story. Only money has a version fingerprint; only buildd has a hard total deadline.
2. **Model choice is a string in a settings table.** The two moa apps pin a vendor model id by hand. No budget, no tier, no price band, no pool, no outcome signal. When the pinned preview model is withdrawn the calls fail until someone edits the row.
3. **Chat is rebuilt per app.** money's chat carries a comment-level workaround ("AI SDK v6 `streamText()` has bugs with multi-step tool execution via OpenRouter") that buildd solved by moving to v7 with `@openrouter/ai-sdk-provider`. The fix does not travel.
4. **Cue cannot be interactive.** Everything goes through a runner task, so the fastest answer Cue can give is "queued". There is no way to ask it a question and get an answer in the same breath.

## Current state (what exists, honestly)

This section is the recon the proposal leans on. Where the target mockup and buildd's code differ, the code wins and the gap is named.

### buildd v3 chat

- **Where it runs.** In the web function, never on a runner (`docs/design/agent-chat.md`; `docs/SPEC.md` §3a). `apps/web/src/lib/chat/turn.ts` calls `streamText` with `stopWhen: isStepCount(MAX_STEPS)` and a 45s abort, then `toUIMessageStream` and `createUIMessageStreamResponse`. `POST /api/chat/[id]` streams one turn (`maxDuration = 60`).
- **Wire contract.** AI SDK v7 `UIMessage` parts over SSE: `text`, `reasoning`, `step-start`, `tool-<action>` with approval states, and a custom `data-buildd-event` part for mission events. Types live dependency-free in `packages/shared/src/chat.ts`; the feed reads a structural subset in `apps/web/src/components/chat/chat-contract.ts` so it never imports the SDK. Cross-device updates are a Pusher ping plus a refetch; content never rides Pusher. Resumable streams are designed but not built.
- **Tools.** `apps/web/src/lib/chat/tools.ts` wraps the same actions `/api/mcp` serves, dispatched in-process (`in-process-api.ts`) under reach rules. Writes pause as an `ApprovalCard`; the server checks approval id, input hash and approver before running.
- **Models.** `apps/web/src/lib/chat/models.ts` resolves the turn's tier through `resolveTierEntry(tier, teamId, workspaceId, 'chat')`, optionally drawing a pool arm. `apps/web/src/lib/chat/routing.ts` uses a decision call to pick tier and tool groups per turn, gated, defaulting to `standard`. With only an OpenRouter key, an Anthropic or OpenAI tier is served through OpenRouter.
- **UI** (`apps/web/src/components/chat/`). `ChatComposer` (workspace chip, `ToolsMenu`, `TierSwitch`, orange send that becomes Stop), `ChatFeed`, `ToolCallRows`, `ApprovalCard`, `SteerConversation`, `HomeChatCard`, `canvas-empty.ts` suggestions. Tailwind v4, tokens `--canvas-*` / `--convo-*` in `apps/web/src/app/globals.css`, and a square-corners guard (`apps/web/src/app/square-corners.test.ts`) that exempts the soft conversation layer.

**Mockup vs code.**

| Mockup element | In buildd today |
|---|---|
| `@ all ▾` scope picker | Yes, as the workspace chip ("All workspaces", "→ name" when routed) |
| `auto ▾` tier picker | Yes, `TierSwitch` ("Auto", "Auto · Standard", with price) |
| Orange send, Stop while busy | Yes |
| Bottom tabs HOME · CHAT · MISSIONS · ACTIVITY · HEALTH | Yes for operators (`apps/web/src/lib/nav-config.tsx`) |
| Date and mood line, serif headline "All quiet.", italic subline | No. Home says "Good morning, {name}" in sans. No serif font is loaded |
| "PICKED FOR YOU" numbered suggestions | No. Closest: un-numbered chips in `canvas-empty.ts` and Home's needs-you stack |
| "··· 2" counter on the composer | Not found |
| "BUILDD THINKING" live step checklist | No. There is "buildd is reading…", then `ToolCallRows` and a scan bar. `reasoning` parts are stored, not rendered as steps |
| "Steer while I think…" composer during a turn | No. Enter is disabled while a turn streams; only Stop works. "Steer" in code is the separate worker canvas (`POST /api/workers/[id]/instruct`), with no LLM call |
| "Check it with you" as the last step | Partially: the `ApprovalCard` before a mission is filed |

### Jev in buildd

`packages/core/decision-client.ts`: typed `choice` / `score` / `noul` questions, `DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13'`, one overall deadline, at most one retry, never throws, `gateChoice(answer, minConfidence)`. Callers today: per-turn chat routing and the task-category shadow check. Decision models are deliberately outside the tier registry (`docs/design/decision-calls.md`, Point 5). Everything except key resolution is pure and already importable from a plain bun script (the DB import is lazy). There is no HTTP route or MCP action for decisions.

### Model economy

- Tiers: `premium-plus` (opt-in only), `premium`, `standard`, `budget` (`packages/core/model-tier-defaults.ts`), price bands in `packages/core/model-catalog.ts`.
- Registry: `model_tier_registry` with a nullable `surface` (`agent` / `chat`), edited in Settings or via `manage_model_tiers`. 60s cache.
- Pools: P1 shipped (admin API under `/api/model-tiers/pools`, draws in `tier-pool-source.ts`). Weight-based splits, buildd-controlled explore, and external quality priors are Proposed (`docs/design/tier-weights.md`, `docs/design/model-quality-signals.md`, both 2026-09-27).
- Budgets: `get_budget_forecast` (MCP) and the interactive caps in `docs/SPEC.md` §3a.
- **External read path that exists today:** `GET /api/model-tiers` accepts a `bld_` API key and returns the caller team's effective tier map with `bySurface`. It is read-only and does no budget-aware picking.

**The "pick the best model per budget" API.** No spec for a caller-facing API that explores or picks a model by budget, tier or standard was found on `dev`, on any remote branch, or in PRs from 2026-09-26/27. The four docs from those days (`tier-model-pools.md`, `tier-weights.md`, `model-quality-signals.md`, SPEC §3a) are all internal to buildd; `model-quality-signals.md` explicitly forbids re-serving the external quality data. This doc therefore **proposes** that API (`POST /api/ai/plan`, §2 below) rather than citing it. If that spec exists in an unpushed session, it should supersede §2.

### Packages and distribution

- `@buildd/core` and `@buildd/shared` are workspace-only: they export raw `.ts` source, have no `publishConfig`, and nothing in this repo publishes to any registry.
- There is precedent for a private package built from a public repo: `@buildd-ai/knowledge-store`, source in the public `buildd-ai/memory` repo, published as a **private** GitHub Package by a tag-triggered workflow (`knowledge-store-v*`, `npm publish` with `GITHUB_TOKEN`, `packages: write`). Cue already installs it: `bunfig.toml` maps the `@buildd-ai` scope to `https://npm.pkg.github.com/` with `$NODE_AUTH_TOKEN`, and its CI passes a `NODE_AUTH_TOKEN` secret.
- GitHub Packages requires the npm scope to equal the owning org, so a package published from `buildd-ai/*` is `@buildd-ai/<name>`, not `@buildd/<name>`.

---

## Proposal

One package, `@buildd-ai/ai-kit`, built from `packages/ai-kit` in this repo, with four entry points. buildd owns **policy** (which model, how much may be spent, which Jev release, what the chat contract is). Each app owns **execution** (its own provider key, its own tools, its own conversations, its own data).

**The crux: the model call runs in the app, not in buildd.** buildd answers "which model and may I spend" and records a content-free receipt afterwards. It never sees prompts, tool results or replies from a sibling app. If this is wrong, the failure is weak budget enforcement: an app that ignores its plan can overspend. §2 bounds that. The alternative (proxy every token through buildd) makes buildd a data processor for personal finance and a single point of failure for three apps, which is worse.

### 1. The package

**One package, subpath exports, optional peers.** Several packages would mean several versions to keep compatible (the chat server depends on the model client, which depends on the shared types), several publish workflows and several pins in each consumer. One package with subpath exports keeps tree-shaking and keeps React out of server bundles. Split later only if a part needs a different release cadence.

```
@buildd-ai/ai-kit
  /models        model-plan client (server only, no peers)
  /decide        Jev decisions: typed questions, gating, versioning, eval hooks (server only; peer @typesafe-ai/sdk)
  /chat/contract wire types: parts, object refs, data parts (no deps, isomorphic)
  /chat/server   turn runner on the AI SDK (peer ai@^7)
  /chat/react    UI components (peers react@^19, @ai-sdk/react@^4)
  /chat/theme.css  CSS custom properties, no Tailwind
  /surfaces      "dynamic UI": Jev picks among app-registered cards (server; uses /decide)
```

#### 1a. `/models`: the model-plan client

```ts
import { createModelClient } from '@buildd-ai/ai-kit/models';

const models = createModelClient({
  baseUrl: process.env.BUILDD_API_URL,   // default https://buildd.dev
  apiKey: process.env.BUILDD_AI_KEY,     // a bld_ key for this app's service account
  app: 'money',                          // attribution label
  providers: ['openrouter'],             // keys this app actually holds
  fallback: { standard: { provider: 'openrouter', model: '<pinned id>' }, /* every tier */ },
});

const plan = await models.plan({ tier: 'standard', surface: 'chat', kind: 'chat_turn' });
// { planId, tier, provider, model, source, price, budget: { action, remainingUsd }, expiresAt }

await models.report(plan, { usage, latencyMs, outcome: 'ok' | 'error' | 'aborted', feedback? });
```

- `tier` is one of buildd's four; `premium-plus` must be asked for explicitly, as in buildd.
- `kind` is a free label (`chat_turn`, `shipment_summary`, `txn_explain`) used for attribution and, later, per-kind pools. It never selects a vendor model on its own.
- `providers` lets buildd return an id the app can actually route. This reuses buildd's existing "Anthropic tier, OpenRouter key" rewrite (`openRouterModelId` in the chat path).
- **Caching.** Plans are cached in memory for their `expiresAt` (default 60s, matching `resolveTierEntry`). On Vercel this is per warm instance, which is fine: it is a latency cache, not a consistency guarantee.
- **Fallback, bounded.** If buildd does not answer within 800ms, or returns 5xx, the client serves the last good plan for that `(tier, surface)` for up to 24h, then the app's `fallback` map. It never throws and never blocks a call. `plan.source` says which (`registry` / `pool` / `catalog` / `default` / `cached` / `fallback`) so a stale answer is visible in logs.
- `report` is fire-and-forget, batched, retried at most once, and dropped after that. A lost receipt undercounts spend. It never fails the caller.

#### 1b. `/decide`: Jev decisions

Extract the pure parts of `packages/core/decision-client.ts` (question and answer types, `validateDecisionRequest`, `parseDecisionAnswers`, `gateChoice`, the deadline and single-retry transport over `@typesafe-ai/sdk`) into the kit. buildd's `decisionCall` keeps its policy check and key resolution and delegates the transport to the kit, so buildd behaves the same.

On top of that, generalise what money already does well:

```ts
import { defineDecision } from '@buildd-ai/ai-kit/decide';

export const notableTxn = defineDecision({
  id: 'money.notable_txn',
  promptVersion: '2026-09-27.a',     // bump when definitions or examples change
  questions: { notable: { type: 'noul', question: '…' } },
  mode: 'shadow',                     // 'shadow' | 'gated' | 'live'
  minConfidence: 0.9,                 // required for 'gated' choice questions
});
// notableTxn.version  => `${promptVersion}|${JEV_MODEL}|kit-${KIT_VERSION}`
// notableTxn.fingerprint => hash of questions + definitions, asserted by a test helper
```

- **One Jev model constant** (`JEV_MODEL`) lives in the kit and is pinned, never `~typesafe/jev-latest`. This keeps `docs/design/decision-calls.md` Point 5: decision models stay out of the tier registry, because a decision's version must name its model and a registry remap would silently invalidate every eval. A Jev bump becomes one kit release, and each app re-runs its eval before upgrading the pin.
- **Modes.** `shadow` persists answers through an `onDecision` hook and never acts. `gated` acts only above `minConfidence` (choice/score); `noul` has no confidence field, so a gated noul needs an explicit probability threshold. `live` is for add-only uses like Cue's "hold back from auto-noise".
- **Eval hooks.** `runDecisionEval({ decision, rows, labelOf, split: 'even-odd' })` returns accuracy, coverage and accuracy at each confidence threshold, and cost per 1k. It generalises `money-app:scripts/jev-eval.ts`. The kit ships the harness only; each app keeps its labelled data and its results files.
- **Fingerprint test helper.** `expectDecisionPinned(decision, { fingerprint, version })` fails when definitions change without a `promptVersion` bump. This is money's test, made reusable.
- **Key.** The caller passes its OpenRouter key; the kit never reads env vars on its own (the same rule as buildd's "every SDK setting is passed explicitly").

#### 1c. Chat: contract, server, React

**`/chat/contract`** takes `packages/shared/src/chat.ts` as the starting point and generalises the buildd-specific parts:

- `ObjectRef<K extends string>`: an app declares its own object kinds (`shipment`, `order`, `account`, `item`) and a renderer for each. buildd's `BuilddObjectRef` becomes `ObjectRef<'mission' | 'task' | 'pr' | 'question'>`.
- New data parts, all optional, all ignorable by an older client:
  - `data-step`: `{ id, label, state: 'done' | 'active' | 'pending' }`. Drives the mockup's thinking checklist. The server emits it from tool starts and ends plus explicit `step()` calls; the model does not invent step labels.
  - `data-suggestions`: `{ items: [{ id, label, prompt }] }`. Drives "PICKED FOR YOU".
  - `data-handoff`: `{ taskId, url, state }`. A long job was filed to a runner (see §3).
  - `data-event`: the generalised `data-buildd-event`.

**`/chat/server`**: `createChatTurn()` is `apps/web/src/lib/chat/turn.ts` with its existing injection seams made explicit:

```ts
const turn = createChatTurn({
  models,                               // from /models: resolves the tier to a model per turn
  route: routeTurnWithJev(),            // optional: Jev picks tier + tool groups, gated, default 'standard'
  tools: appTools,                      // AI SDK tools; writes declare needsApproval
  system: buildSystemPrompt,
  store: conversationStore,             // app-provided persistence adapter
  limits: { maxSteps: 8, turnMs: 45_000, perUserDailyUsd: 2 },
});
export const POST = (req) => turn.handle(req, { userId, conversationId });
```

- AI SDK v7 `streamText` with `@openrouter/ai-sdk-provider`, the combination buildd already runs in production. This removes the need for money's hand-rolled `openai` loop.
- Approvals: the same pattern as `apps/web/src/lib/chat/approvals.ts` (id, input hash, approver, atomic claim), behind the `store` adapter.
- Persistence: an interface, plus reference SQL for `conversations`, `conversation_messages`, `conversation_approvals` shipped as `schema.sql` (the knowledge-store precedent). Each app migrates its own DB with its own tool (Drizzle in all three apps).
- **Steer while it thinks.** AI SDK v7 cannot inject a user message into a running `streamText` step. Proposed semantics: a steer message is queued server-side against the running turn and injected at the next step boundary via `prepareStep`, and the UI marks it "applies at the next step". If the turn ends first, the steer becomes the next user message. The bound: at most 3 queued steers per turn, and a steer never extends `turnMs`. This is new; buildd does not do it today.
- Stop stays client-side (`useChat().stop()`), plus the server's abort deadline.

**`/chat/react`**: components that read the contract, not buildd's DB:

`<ChatThread>`, `<ChatComposer>` (with `scope` and `tier` slots), `<ScopePicker>`, `<TierPicker>` (Auto / budget / standard / premium, with price from the plan), `<ThinkingPanel>` (renders `data-step` parts plus tool rows), `<ApprovalCard>`, `<SuggestionsCard>`, `<StopButton>`, `<SteerComposer>`, `<ChatHome>` (headline, subline, suggestions, composer), and `useKitChat()` (a thin wrapper over `useChat` with `DefaultChatTransport`).

**Theming.** Components style themselves only through CSS custom properties in `/chat/theme.css` (`--kit-bg`, `--kit-surface`, `--kit-ink`, `--kit-muted`, `--kit-accent`, `--kit-accent-ink`, `--kit-radius-soft`, `--kit-radius-hard`, `--kit-font-body`, `--kit-font-display`, `--kit-font-mono`) plus `className` and `data-*` hooks. No Tailwind in the kit: buildd is on Tailwind v4 and Cue on v3, and neither should be forced to change. Each app maps its tokens once:

- buildd: `--kit-*` from `--canvas-*` / `--convo-*`; `--kit-radius-hard: 0` keeps the square-corners rule for objects.
- Cue: `--kit-accent: var(--primary)`, light-first, following its design skill.
- moa-ops: its existing theme tokens (it already has token-lint and contrast gates).

The mockup's serif display headline is `--kit-font-display`; an app that loads no serif gets its body font.

#### 1d. `/surfaces`: dynamic UI, bounded

Jev picks **which** app-coded card to show, never **what** to render:

```ts
const home = defineSurface({
  id: 'cue.home',
  slots: {
    mood:   { type: 'choice', labels: ['calm', 'busy', 'behind'], default: 'calm' },
    hero:   { type: 'choice', labels: ['all_quiet', 'needs_you', 'deadline_today'], default: 'all_quiet' },
    picks:  { type: 'rank', candidates: suggestionCatalog, max: 3 },   // `rank` = one score question per candidate
  },
  state: async (ctx) => summariseForJev(ctx),   // app decides what Jev sees
  decision: { mode: 'shadow', minConfidence: 0.85 },
});
```

- **Safety property.** The output space is closed: labels and candidate ids the app registered. Props come from app code. A low-confidence answer, a timeout or shadow mode renders `default`. The model never emits markup, copy, or URLs. Prompt injection from content in `state` can at worst pick a different registered card.
- The mockup's "SUN 27 SEP · CALM", "All quiet." and "Nothing is waiting on you" map to `mood` + `hero` + the app's copy for that hero. The headline copy is authored, not generated.

### 2. Where the model call runs

| | App-side call, buildd plans (recommended) | Proxied through buildd | buildd hosts the whole turn, app exposes tools via MCP |
|---|---|---|---|
| Content seen by buildd | None; receipts are metadata only | Every prompt and tool result | Every prompt, tool result and reply, stored in buildd's conversations |
| Provider key | App's own, in its env | buildd team key | buildd team key |
| Cost attribution | Receipts per app service account; accurate if apps report | Exact | Exact |
| Budget enforcement | Cooperative: plan returns `ok` / `downgrade` / `deny`, kit honours it, plus a per-instance local ceiling when buildd is unreachable | Hard | Hard |
| Latency | One cached plan lookup (usually 0ms) | Extra hop on every token, two 60s function limits stacked | Extra hop on every tool call |
| buildd outage | Apps keep working on cached or fallback plans | All three apps lose chat and Jev | All three apps lose chat |
| Build effort | Two small routes plus the kit | Proxy streaming, per-app auth, rate limits | Connector plumbing exists (`cross-app-assertion-grant.md` is buildd to app), but the UI still has to live in the app |

**Recommendation: app-side.** The deciding factors are data (personal-finance content must not transit or be stored in another service) and blast radius (a buildd deploy should not be able to break the store's shipping chat). The cost is that enforcement is cooperative; that is acceptable because all three apps are ours and use the same kit code path, which honours `deny`.

**New buildd routes** (they do not exist yet):

- `POST /api/ai/plan`. Body: `{ tier, surface: 'chat' | 'inference', kind, providers, budget?: { maxUsdPerCall? } }`. Wraps `resolveTierEntry` (and `drawChatPoolArm` when the team has a pool that admits the surface), the price from `model-prices.ts`, and a spend check. Returns the plan shown in §1a. Auth: `authenticateApiKey`, `trigger` level is enough. The team comes from the key; the app's workspace comes from the key's account, so per-app overrides are ordinary workspace rows in `model_tier_registry`.
- `POST /api/ai/usage`. Body: `{ planId, tokens, costUsd?, latencyMs, outcome, feedback? }`. No content fields: the route rejects unknown keys, so a future caller cannot start sending prompts by accident. It feeds Settings → Budgets (as the app's service account) and, when tier pools add `tier_outcomes`, their reward signal.

**Budget safety property.** A plan with `budget.action = 'deny'` makes the kit refuse the call with a typed error. `downgrade` returns a cheaper tier's model. When buildd is unreachable, the kit enforces `localDailyCapUsd` per warm instance (default equal to the app's configured cap). That bound is per instance, not global, and this doc does not claim otherwise.

**Defaults are no-ops.** `/api/ai/plan` with no workspace rows returns exactly what `GET /api/model-tiers` returns today for the team. No existing buildd path changes behaviour.

### 3. Cue: from runner-only to interactive

What changes:

- **The rule.** Cue's `CLAUDE.md` changes from "never call LLM APIs directly" (with a Jev exception and a retrieval exception) to "generative calls only through `@buildd-ai/ai-kit/chat/server` at one call site (`src/lib/ai/chat.ts`), decisions only through `@buildd-ai/ai-kit/decide` (`src/lib/jev.ts` becomes a thin wrapper), everything long-running is still a buildd runner task." The intent of the old rule (no scattered SDK imports, no model names in Cue) is kept; the mechanism changes from "none" to "one".
- **Tools.** Chat tools wrap the existing handlers behind Cue's `cue_read`, `cue_search`, `cue_mutate` MCP tools, called in-process like buildd's `in-process-api.ts`. Mutations need approval by default.
- **Hand-off to runners.** A `hand_off` tool (approval-gated) calls the existing `src/lib/cue-job-dispatch.ts` path (`POST /api/tasks` on buildd) with `context.conversationId`. The runner's completion arrives at Cue's existing `/api/webhooks/buildd`, which appends a `data-handoff` / `data-event` message to the conversation. In the mockup, "Check it with you" is the `ApprovalCard` for that hand-off; after approval the step list shows "Filed as a task" and the card becomes a live `data-handoff` object.
- **Persistence.** Cue adds the three conversation tables from the kit's reference schema in its own Drizzle migration.
- **Who pays** is the hard part: Cue's per-tenant Claude OAuth tokens cannot be used server-side (`docs/SPEC.md` §3a: subscription auth is runner-anchored). See Open questions.

### 4. moa-ops: store and money chat

Use cases that justify chat (read-mostly, answerable in one turn):

- Store: "what's stuck in shipping", "which orders are waiting on a label", "why is this order on hold". Tools wrap the store MCP's read actions (shipments, unfulfilled aging, label status, fulfillment status). The existing write actions (merge or split a shipment) are approval-gated.
- Money: "why did cash drop this week", "can I afford X this month", "what's unusual in my spending". Tools wrap the finance MCP's read actions (cash flow, balances, transaction search, forecast). money's existing personal chat moves onto the kit rather than being rewritten from scratch.

**Auth boundaries (invariants):**

1. Money chat runs only in the money deployment, with a tool registry built only from money's handlers. The store's tool registry is built only from store handlers and contains no finance action. A unit test in the store asserts no tool name matches the finance MCP's action set; this matters because the store app today contains a forwarding stub to the finance MCP.
2. Each app has its own `bld_` service account and its own provider key. Receipts from money are attributed to money and carry no content.
3. Conversations are stored in each app's own tables. Nothing about a money conversation is written to buildd beyond token counts, cost, latency, model and outcome.
4. **Known gap:** the two moa apps share one database today and a split is in progress. Until the split lands, invariant 1 is enforced in code, not by the data layer. The store chat must not ship before money's conversation tables are in money's own schema, or the store could read them with its own DB handle.

### 5. Distribution

- **Source:** `packages/ai-kit` in this repo, Apache-2.0 like the rest of it. buildd consumes it as a workspace dependency.
- **Registry:** a private GitHub Package, `@buildd-ai/ai-kit`, copying `buildd-ai/memory`'s `publish-knowledge-store.yml`: tag `ai-kit-v*` or `workflow_dispatch`, `packages: write`, `npm publish` with `GITHUB_TOKEN`. The package ships compiled ESM plus `.d.ts` in `dist/` (unlike `@buildd/core`, which exports raw `.ts` and only works inside the workspace).
- **Versioning:** independent semver starting at 0.1.0, not buildd's lockstep `0.236.x`. `scripts/release.sh` must not bump it. A CHANGELOG lives in the package. Breaking changes to `/chat/contract` are major bumps; new optional data parts are minor.
- **Consumers pin exact versions.** All three consumers install with bun:
  - `bunfig.toml`: `[install.scopes] "@buildd-ai" = { url = "https://npm.pkg.github.com/", token = "$NODE_AUTH_TOKEN" }` (Cue already has this line). `.npmrc` with the same scope for tools that read it.
  - Vercel: a `NODE_AUTH_TOKEN` env var on each project (production and preview), a classic PAT with `read:packages` from an account that can read the org's packages. Cue already needs one for `knowledge-store`.
  - GitHub Actions: `secrets.NODE_AUTH_TOKEN` in each consumer repo. `moa-ops` belongs to a personal account, so its built-in `GITHUB_TOKEN` cannot read an org package; it needs the PAT secret.
- **Rejected: git+ssh dependency.** Vercel builds have no SSH key, the package lives in a monorepo subdirectory (awkward for bun and npm git deps), and a git dependency skips the build step, so consumers would compile buildd's TypeScript themselves.
- **Note on "private".** The source is in a public repo, so a private registry gates installs, not knowledge. That is fine as long as the kit contains no secrets or app-specific logic, which the design already requires.

### 6. Migration plan

Each phase is independently shippable and leaves the others working.

**P0: kit skeleton, extract, no behaviour change (buildd)**
- Create `packages/ai-kit` with `/decide` (transport and pure parts from `decision-client.ts`) and `/chat/contract` (from `packages/shared/src/chat.ts`, re-exported by `@buildd/shared` so no import changes).
- Add the publish workflow; publish 0.1.0.
- AC: buildd's existing decision and chat tests pass unchanged. A scratch Next 16 + bun project installs `@buildd-ai/ai-kit@0.1.0` on a Vercel preview with `NODE_AUTH_TOKEN`. Removing the token makes the install fail with a 401, not a silent fallback.

**P1: model plans (buildd routes plus moa)**
- buildd: `POST /api/ai/plan`, `POST /api/ai/usage`, receipts shown in Settings → Budgets under the service account. Kit `/models`.
- store and money: replace `getModelForUseCase` with `models.plan`; map each use case to a tier (`default`/`chat` to `standard`, analysis use cases to `standard` or `premium`, classification to `budget`).
- **Delete:** both copies of `lib/ai/config.ts` and `lib/ai/use-cases.ts` (after mapping), the `ai_model:*` rows in `system_settings`, `/api/settings/ai/models`, money's `ModelSheet`, the `*WithFallback` wrappers (they no longer fall back), and the store's unused `@ai-sdk/google` and `@typesafe-ai/sdk` deps.
- AC: remapping `standard` for the app's workspace in buildd changes the model an app call uses within 60s, with no app deploy. With buildd unreachable (bad URL), app calls still succeed and log `source: 'fallback'`. A `deny` plan produces a typed error the UI shows. A test asserts `/api/ai/usage` rejects a body containing any non-metadata field.

**P2: one Jev client (all three apps)**
- money: `jev-classifier.ts` and `brief/notable.ts` move onto `defineDecision` / `runDecisionEval`. Cue: `src/lib/jev.ts` wraps the kit's transport (and moves off `/api/alpha/decisions` onto the SDK's System One endpoint).
- **Delete:** money's `getJevClient` and its local retry and timeout code; Cue's raw `fetch` client; the per-app copies of the Jev model id.
- AC: money's held-out eval reproduces its current accuracy and coverage at 0.9 within one point. Cue's shadow rows keep writing with the same `EMAIL_JEV_VERSION` semantics. Each app's fingerprint test passes, or it fails and forces a version bump.

**P3: money chat on the kit**
- Replace `/api/agent/personal-chat`'s `openai` tool loop with `createChatTurn` on AI SDK v7, and its `AssistantV2` UI with kit components mapped to money's theme. Upgrade money to `ai@^7` / `@ai-sdk/react@^4`.
- **Delete:** the manual tool loop; the `ai_sdk.md` v6 workaround note for this route.
- AC: a three-tool question ("why did cash drop") completes through OpenRouter in one turn. Stop aborts within 1s. The conversation persists in money's tables. A receipt appears in buildd with no content. The `ThinkingPanel` shows one `data-step` per tool call.

**P4: store chat**
- New store chat route and page on the kit with store-only tools. Blocked on invariant 4 in §4 (money's conversation tables are not readable by the store).
- AC: the finance-exclusion test in §4 passes. Every write tool needs approval. "What's stuck in shipping" answers from live shipment data.

**P5: Cue interactive**
- Rule change in Cue's `CLAUDE.md`; conversation tables; chat page with Cue theme; `hand_off` to runners; the webhook appends results.
- AC: a question Cue can answer from its own data returns in one turn with no runner task created. A request needing a runner shows an approval card; approving creates exactly one buildd task, and its completion appears in the same conversation. With no provider key configured, the chat page says who can fix it (buildd's `ChatSetupCard` behaviour) and `@cue` in QuickAdd still works.

**P6: buildd dogfoods the kit**
- buildd's `ChatComposer`, `ChatFeed`, `ToolCallRows`, `TierSwitch` and `ApprovalCard` become kit components themed by buildd tokens. buildd-specific pieces stay here: tools, reach rules, mission objects, `in-process-api.ts`, Pusher.
- AC: the chat fixture page (`apps/web/src/app/app/dev/chat/`) renders every state it does today. The square-corners guard passes. No visual regression in the canvas screenshots.
- Without this phase the kit forks from buildd's chat within weeks, so it is not optional; it is last only because it has the most surface.

**P7: surfaces (dynamic UI)**
- `defineSurface` in shadow on Cue's home and moa's dashboards, then gated after an eval.
- AC: in shadow the rendered card is always `default`, and the Jev pick is logged. Gating a slot requires an eval of at least ~700 labelled rows, not a round number.

### 7. Risks

- **AI SDK v6 to v7 in moa-ops.** Both moa apps pin `ai@^6`. The kit's chat entry points peer-depend on v7. P3 and P4 carry that upgrade; P1 and P2 do not need it.
- **Cooperative budgets.** A bug in an app, or an app on an old kit version, can overspend. Mitigation: the kit refuses `deny` in one place; buildd alerts when receipts for an account exceed its cap even though it cannot stop the call.
- **Shared moa database** (§4, invariant 4).
- **Plan staleness.** Up to 24h of cached plans during a buildd outage, then pinned fallbacks that age in each app's code. The kit logs a warning on every `fallback` plan, so the drift is visible.
- **Jev model upgrades across apps.** A kit release that bumps `JEV_MODEL` changes three apps' decisions at once if they float the version. Mitigation: exact pins, and the fingerprint includes the model, so tests fail until each app re-evaluates.
- **Public repo.** The kit, its docs and its tests must stay app-agnostic. No app's prompts, labels, finance definitions or data belong in `packages/ai-kit`.
- **Steer mid-turn** is new behaviour with no precedent in buildd. It can confuse users if a steer lands after the step it was meant for. Shipping it behind a flag in P3 limits that.

---

## Open questions

1. **Who pays for Cue's interactive chat?** Per-tenant OAuth tokens cannot serve server-side calls. Options: one Cue OpenRouter key (Max pays, capped per tenant by `perUserDailyUsd`), or each tenant brings an API key. *Lean:* one Cue key with a low per-tenant cap to start; revisit if more tenants join.
2. **Cue: app-side chat, or buildd hosts the turn and calls Cue's MCP?** The second keeps Cue's "no LLM in Cue" rule literally and reuses buildd's chat wholesale, but puts family data in buildd's conversation tables and the UI would still have to live in Cue. *Lean:* app-side, same as moa, for one pattern across all three apps.
3. **Is a private registry worth it?** The source is public Apache-2.0 either way. Public npm would drop the PAT from three Vercel projects and three CI configs. *Lean:* private GitHub Packages now, matching `knowledge-store`; revisit if the tokens become a chore.
4. **Per-app overrides: workspace rows, or a new `surface` value per app?** *Lean:* each app is a buildd workspace (Cue already has one) and overrides are ordinary workspace rows. No schema change.
5. **Is cooperative budget enforcement enough,** or should money's chat be hard-capped by holding its key in buildd? *Lean:* cooperative; holding money's key in buildd defeats the data boundary.
6. **Receipts for money chats:** is model, tokens, cost and latency acceptable metadata to send to buildd? *Lean:* yes; it is less than OpenRouter already sees. Note that the OpenRouter account used by money is not configured for zero retention.
7. **The model-picking spec you remember from 2026-09-26/27.** It was not found in this repo, on any branch, or in PRs. If it exists (an unpushed session, or another repo), should `/api/ai/plan` here yield to it?
8. **Mockup-only elements** (mood line, serif headline, numbered picks, "··· 2" counter): build them into `<ChatHome>`, or leave them to each app's composition? *Lean:* `<ChatHome>` provides the slots; mood and picks come from `/surfaces`; each app supplies copy and fonts. What "··· 2" counts needs your call (queued steers? open threads? active tools?).
9. **Steer semantics:** queue-and-inject at the next step, or stop-and-resend? *Lean:* queue-and-inject, behind a flag.

## Non-goals

- Runner changes. Runner tasks, backends, OAuth seats and claim-time tier resolution stay as they are.
- Hosting sibling apps' conversations, tools or data in buildd.
- Putting Jev into the tier registry or into pools.
- Slack, Discord or other chat channels (`docs/design/chat-integrations.md` is retired).
- iOS clients. The React components target the web apps; native apps can read `/chat/contract`.
- Generated UI. `/surfaces` only chooses among components an app has coded.
- Re-serving external model-quality data. `/api/ai/plan` returns a model choice, never Artificial Analysis or ranking numbers (`docs/design/model-quality-signals.md`).
