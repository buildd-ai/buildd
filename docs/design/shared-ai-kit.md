# Shared AI kit: chat, Jev decisions and the model economy for sibling apps

**Status:** Accepted. P0 (#2968), the P1 client (#2974) and P2 (#2977) have shipped; the package publishes as `@builddai/ai-kit` (#2991). The kit half of P3 (`/chat/server` `createChatTurn` and the `/chat/react` components) ships in 0.2.0; app adoption (money P3, store P4, Cue P5, buildd P6) is per app. 0.5.0 lifts the generic half of buildd's chat into the kit (P6 slice 1, listed under P6).
**Related:** `packages/core/model-tier-registry.ts` (`resolveTierEntry`, `resolveAllTiers`), `packages/core/model-tier-defaults.ts`, `packages/core/tier-pool-source.ts` (`drawChatPoolArm`), `packages/core/decision-client.ts` (`decisionCall`, `gateChoice`), `packages/core/inference-client.ts`, `packages/core/inference-keys.ts`, `packages/shared/src/chat.ts`, `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/models.ts`, `apps/web/src/lib/chat/routing.ts`, `apps/web/src/lib/chat/permissions.ts`, `apps/web/src/components/chat/`, `apps/web/src/app/api/model-tiers/route.ts`, `apps/web/src/lib/api-auth.ts`, `docs/SPEC.md` §3a, `docs/design/agent-chat.md`, `docs/design/chat-canvas.md`, `docs/design/decision-calls.md`, `docs/design/inference-calls-primitive.md`, `docs/design/model-tiers.md`, `docs/design/tier-model-pools.md`, `docs/design/tier-weights.md`, `docs/design/model-quality-signals.md`, `docs/design/cross-app-assertion-grant.md`

External consumers (private repos, cited as `app:path`): Cue (`cue:`), and the two moa apps (`nextjs-app`, the store ops app; `money-app`, personal finance).

**Revision 2 (after review on #2948):**
- Cue's chat runs in Cue, and the "no LLM in Cue" rule is retired.
- Cue chat is paid for by each user's own OpenRouter key or a household key, with a per-user cost ledger kept in Cue.
- The kit is published to public npm.
- Cooperative budget enforcement is the chosen model, with hard caps held by each app's provider-key limits.
- Tool permissions are a first-class primitive.
- The mood line and headline are dropped.

---

## Problem

Three sibling apps use models today and each one picks and calls them in its own way. None of them uses the economy buildd already has.

| App | How it picks a model | How it calls Jev | Chat |
|---|---|---|---|
| buildd | Tier registry: workspace row, then team row, then catalog, then `TIER_DEFAULTS`, per surface (`agent` / `chat`). Pools with traffic splits exist in P1 | `decisionCall` through `@typesafe-ai/sdk` 0.6.0 to OpenRouter `/api/v1/systemone`, 5s deadline, never throws | AI SDK v7 UI message stream, in the web function, approval cards, per-person tool permissions, tier switch, budgets |
| Cue | `cue:src/lib/model-tiers.ts` passes a tier string (`budget`/`standard`/`premium`) to buildd tasks. No model call of its own | `cue:src/lib/jev.ts`: raw `fetch` to OpenRouter `/api/alpha/decisions`, 8s timeout, 3 attempts | None. Its `CLAUDE.md` forbids any direct generative call, so all AI work is a buildd runner task |
| store (`nextjs-app`) | `nextjs-app/src/lib/ai/config.ts` `getModelForUseCase`: env `AI_MODEL`, then DB `system_settings` `ai_model:<useCase>`, then a hardcoded vendor model id | `@typesafe-ai/sdk` is in `package.json` but unused | `/api/chat` was deleted as unused. Two `/api/agent/*` streaming routes remain |
| money (`money-app`) | Same `lib/ai/config.ts` copy and the same DB keys. The two apps share a database today, so one app's setting silently changes the other's | `money-app/src/lib/services/finance/jev-classifier.ts`: SDK `systemOne`, auto-apply at 0.9, a versioned fingerprint test, an offline eval harness | `/api/agent/personal-chat`: `openai` SDK with a hand-rolled tool loop, wrapped in `createUIMessageStream` from AI SDK v6 |

What this costs us, concretely:

1. **Three Jev clients, two endpoints, three retry policies.** A model bump (`typesafe/jev-1.13` to the next release) is three PRs in three repos, each with its own eval story. Only money has a version fingerprint; only buildd has a hard total deadline.
2. **Model choice is a string in a settings table.** The two moa apps pin a vendor model id by hand. There is no budget, tier, price band, pool or outcome signal. When the pinned preview model is withdrawn, calls fail until someone edits the row.
3. **Chat is rebuilt per app.** money's chat carries a documented workaround ("AI SDK v6 `streamText()` has bugs with multi-step tool execution via OpenRouter") that buildd solved by moving to v7 with `@openrouter/ai-sdk-provider`. The fix does not travel. Neither does buildd's per-person tool permissions model.
4. **Cue cannot be interactive.** Everything goes through a runner task, so the fastest answer Cue can give is "queued". There is no way to ask it a question and get an answer straight away.

## Current state (what exists, honestly)

This section is the recon the proposal leans on. Where the target mockup and buildd's code differ, the code wins and the gap is named.

### buildd v3 chat

- **Where it runs.** In the web function, never on a runner (`docs/design/agent-chat.md`; `docs/SPEC.md` §3a). `apps/web/src/lib/chat/turn.ts` calls `streamText` with `stopWhen: isStepCount(MAX_STEPS)` and a 45s abort, then `toUIMessageStream` and `createUIMessageStreamResponse`. `POST /api/chat/[id]` streams one turn (`maxDuration = 60`).
- **Wire contract.** AI SDK v7 `UIMessage` parts over SSE: `text`, `reasoning`, `step-start`, `tool-<action>` with approval states, and a custom `data-buildd-event` part for mission events. The types live dependency-free in `packages/shared/src/chat.ts`. The feed reads a structural subset in `apps/web/src/components/chat/chat-contract.ts`, so it never imports the SDK. Cross-device updates are a Pusher ping plus a refetch; content never rides Pusher. Resumable streams are designed but not built.
- **Tools.** `apps/web/src/lib/chat/tools.ts` wraps the same actions `/api/mcp` serves, dispatched in-process (`in-process-api.ts`) under reach rules. Writes pause as an `ApprovalCard`; before running, the server checks the approval id, the input hash and the approver.
- **Tool permissions.** `apps/web/src/components/chat/ToolsMenu.tsx` is the composer's `⋯` control. It lists each tool group with an "Ask first" / "Allow" toggle and locks some groups to a fixed mode. The groups (`TOOL_GROUP_LABELS` in `apps/web/src/lib/chat/permissions.ts`) are:

  | Groups | Mode |
  |---|---|
  | Missions, Tasks, Agents, Knowledge, Schedules, Artifacts | Ask first / Allow, where the group has a card-gated write |
  | PRs | Read only |
  | Admin | Ask first, locked |
  | Secrets | Never |

  The trigger carries no count (buildd dropped its Allow badge in #3054; the panel shows each group's mode). The preference is per person per team (`team_members.chat_allowed_tool_groups`, `permissions-store.ts`).

  Enforcement is server-side, in the turn's tool-approval hook in `turn.ts`, through `canSkipCard`. An Allowed write skips its card only when:
  - its effective class is `write`, not admin;
  - it starts no recurring or unattended work;
  - no tool output is anywhere in the model's context (the anti-injection taint rule);
  - it is the first skipped write of the turn;
  - the same preview a card would build resolves.

  There is also at most one approval card per turn.
- **Composer extras.** "Fill in a form instead" (`formFallbackHref` in `ChatWorkspace.tsx`) shows until the first message and links to the classic form. The empty state (`canvas-empty.ts`) reads "Hi {name}, what are we working on?" with chips: What needs me? / What's running right now? / What shipped this week? / Start something new. "Start something new" prefills the composer instead of sending.
- **Models.** `apps/web/src/lib/chat/models.ts` resolves the turn's tier through `resolveTierEntry(tier, teamId, workspaceId, 'chat')`, optionally drawing a pool arm. `apps/web/src/lib/chat/routing.ts` uses a decision call to pick the tier and tool groups per turn, confidence-gated and defaulting to `standard`. With only an OpenRouter key, an Anthropic or OpenAI tier is served through OpenRouter.
- **UI.** `ChatComposer` (workspace chip, `ToolsMenu`, `TierSwitch`, orange send that becomes Stop), `ChatFeed`, `ToolCallRows`, `ApprovalCard`, `SteerConversation`, `HomeChatCard`. Styling is Tailwind v4 with the `--canvas-*` / `--convo-*` tokens in `apps/web/src/app/globals.css`. A square-corners guard (`apps/web/src/app/square-corners.test.ts`) exempts the soft conversation layer.

**Mockup vs code.**

| Mockup element | In buildd today | In this design |
|---|---|---|
| `@ all ▾` scope picker | Yes, as the workspace chip ("All workspaces", "→ name" when routed) | `<ScopePicker>` |
| `···` control | Yes: the tools permission popover (no count on the trigger) | `<ToolsMenu>`, first class (§1c) |
| `auto ▾` tier picker | Yes, `TierSwitch` ("Auto", "Auto · Standard", with price) | `<TierPicker>` |
| Orange send, Stop while busy | Yes | Yes |
| Bottom tabs HOME · CHAT · MISSIONS · ACTIVITY · HEALTH | Yes for operators (`apps/web/src/lib/nav-config.tsx`) | App navigation, not the kit |
| Date and mood line, serif headline "All quiet.", italic subline | No | **Dropped.** Not shown continuously; not in the kit |
| "PICKED FOR YOU" numbered suggestions | No. The closest are the empty-state chips | Empty-state chips, optionally chosen by Jev (§1d) |
| "BUILDD THINKING" live step checklist | No. There is "buildd is reading…", then `ToolCallRows` and a scan bar | `<ThinkingPanel>` over `data-step` parts, new |
| "Steer while I think…" composer during a turn | No. Enter is disabled while a turn streams; only Stop works. "Steer" in code is the separate worker canvas (`POST /api/workers/[id]/instruct`), with no LLM call | `<SteerComposer>`, new, behind a flag |
| "Check it with you" as the last step | Partially: the `ApprovalCard` shown before a mission is filed | `ApprovalCard` on a `hand_off` tool (§3) |

### Jev in buildd

`packages/core/decision-client.ts`:
- typed `choice` / `score` / `noul` questions;
- `DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13'`;
- one overall deadline, at most one retry, never throws;
- `gateChoice(answer, minConfidence)`.

Callers today are per-turn chat routing and the task-category shadow check. Decision models are deliberately kept outside the tier registry (`docs/design/decision-calls.md`, Point 5). Everything except key resolution is pure and already importable from a plain bun script, because the DB import is lazy. There is no HTTP route or MCP action for decisions.

### Model economy

- **Tiers:** `premium-plus` (opt-in only), `premium`, `standard`, `budget` (`packages/core/model-tier-defaults.ts`). Price bands are in `packages/core/model-catalog.ts`.
- **Registry:** `model_tier_registry` with a nullable `surface` (`agent` / `chat`), edited in Settings or via `manage_model_tiers`. 60s cache.
- **Pools:** P1 shipped (admin API under `/api/model-tiers/pools`, draws in `tier-pool-source.ts`). Weight-based splits, buildd-controlled explore and external quality priors are Proposed (`docs/design/tier-weights.md`, `docs/design/model-quality-signals.md`, both 2026-09-27).
- **Budgets:** `get_budget_forecast` (MCP) and the interactive caps in `docs/SPEC.md` §3a.
- **External read path that exists today:** `GET /api/model-tiers` accepts a `bld_` API key and returns the caller team's effective tier map with `bySurface`. It is read-only and does no budget-aware picking.

**The "pick the best model per budget" API.** No spec for a caller-facing API that explores or picks a model by budget, tier or standard exists on `dev`, on any remote branch, or in PRs from 2026-09-26/27. The four docs from those days (`tier-model-pools.md`, `tier-weights.md`, `model-quality-signals.md`, SPEC §3a) are all internal to buildd, and `model-quality-signals.md` explicitly forbids re-serving the external quality data. This doc therefore **proposes** that API (`POST /api/ai/plan`, §2) rather than citing it. If that spec exists in an unpushed session, it should supersede §2.

### Packages and distribution

- `@buildd/core` and `@buildd/shared` are workspace-only. They export raw `.ts` source, have no `publishConfig`, and nothing in this repo publishes to any registry.
- `@buildd-ai/knowledge-store` is a private GitHub Package, built from the public `buildd-ai/memory` repo. Cue installs it through `bunfig.toml`, which maps the whole `@buildd-ai` scope to `https://npm.pkg.github.com/` with `$NODE_AUTH_TOKEN`. Cue's `.npmrc` also maps `@buildd` to GitHub Packages, though Cue installs nothing under `@buildd`.
- Neither `buildd` nor `buildd-ai` is currently a public npm org.

### Cue's credential model

- Each person is a `tenant`. The household owner is the `allowed_users` row with `role = 'owner'`.
- Runner work is paid by each tenant's own Claude token (`claude_tokens`). A tenant with `tenants.useSharedTokens = 1` falls back to the owner's token (`getOwnerClaudeToken` in `cue:src/lib/tenant-job-dispatch.ts`).
- Secrets are stored AES-256-GCM encrypted with a key derived per tenant through HKDF (`encrypt(plaintext, tenantId)` in `cue:src/lib/crypto.ts`), as in `moa_credentials`. Changes are recorded in `audit_logs`.

---

## Proposal

One package, `@builddai/ai-kit`, built from `packages/ai-kit` in this repo and published to public npm, with the entry points listed in §1. buildd owns **policy**: which model, how much may be spent, which Jev release, and what the chat contract and permission model are. Each app owns **execution**: its own provider keys, its own tools, its own conversations and its own data.

**The crux: the model call runs in the app, not in buildd.** buildd answers "which model, and may I spend", and receives a content-free receipt afterwards. It never sees prompts, tool results or replies from a sibling app.

The failure mode if this is wrong is weak central enforcement: an app that ignores its plan can overspend. That is accepted as the chosen budget model (§2). The hard ceiling is each app's own provider-key limit, not buildd.

The alternative, proxying every token through buildd, would make buildd a data processor for personal finance and household data, and a single point of failure for three apps.

### 1. The package

**One package, subpath exports, optional peers.** Several packages would mean several versions to keep compatible (the chat server depends on the model client, which depends on the shared types), several publish workflows, and several pins in each consumer. One package with subpath exports keeps tree-shaking and keeps React out of server bundles. Split later only if a part needs its own release cadence.

```
@builddai/ai-kit
  /models          model-plan client + usage sink (server only, no peers)
  /decide          Jev decisions: typed questions, gating, versioning, eval hooks (server; peer @typesafe-ai/sdk)
  /chat/contract   wire types: parts, object refs, data parts, tool-permission rows (no deps, isomorphic)
  /chat/server     turn runner + tool-permission enforcement (peer ai@^7)
  /chat/react      UI components (peers react@^19, @ai-sdk/react@^4)
  /chat/theme.css  CSS custom properties, no Tailwind
  /surfaces        Jev picks among the app's own suggestion chips and cards (server; uses /decide)
```

#### 1a. `/models`: the model-plan client

```ts
import { createModelClient } from '@builddai/ai-kit/models';

const models = createModelClient({
  baseUrl: process.env.BUILDD_API_URL,   // default https://buildd.dev
  apiKey: process.env.BUILDD_AI_KEY,     // a bld_ key for this app's service account
  app: 'cue',                            // attribution label
  providers: ['openrouter'],             // provider keys this app can route
  fallback: { standard: { provider: 'openrouter', model: '<pinned id>' }, /* every tier */ },
  ledger: localUsageLedger,              // optional: the app's own per-user ledger (§3)
});

const plan = await models.plan({ tier: 'standard', surface: 'chat', kind: 'chat_turn' });
// { planId, tier, provider, model, source, price, budget: { action, remainingUsd }, expiresAt }

await models.report(plan, { usage, latencyMs, outcome: 'ok' | 'error' | 'aborted', feedback?, subject? });
```

- `tier` is one of buildd's four. `premium-plus` must be asked for explicitly, as in buildd.
- `kind` is a free label (`chat_turn`, `shipment_summary`, `txn_explain`) used for attribution and, later, per-kind pools. It never selects a vendor model on its own.
- `providers` lets buildd return an id the app can actually route. This reuses buildd's existing "Anthropic tier, OpenRouter key" rewrite (`openRouterModelId` in `models.ts`).
- **Caching.** Plans are cached in memory until `expiresAt` (default 60s, matching `resolveTierEntry`). On Vercel this is per warm instance: a latency cache, not a consistency guarantee.
- **Bounded fallback.** If buildd doesn't answer within 800ms, or returns a 5xx, the client serves the last good plan for that `(tier, surface)` for up to 24h, then the app's `fallback` map. It never throws and never blocks a call. `plan.source` (`registry` / `pool` / `catalog` / `default` / `cached` / `fallback`) makes a stale answer visible in logs.
- **`report` goes to two sinks:**
  - **The app's own `ledger`**, when one is configured. This write is awaited, is the app's source of truth for cost, and carries `subject` (the app's user id).
  - **buildd's `/api/ai/usage`.** This one is fire-and-forget, batched, retried at most once, then dropped. It is content-free and identity-free: `subject` is never sent to buildd.

  A lost buildd receipt undercounts the economy's view of spend. It never fails the caller and never affects the app's own ledger.

#### 1b. `/decide`: Jev decisions

Extract the pure parts of `packages/core/decision-client.ts` into the kit: the question and answer types, `validateDecisionRequest`, `parseDecisionAnswers`, `gateChoice`, and the deadline-plus-single-retry transport over `@typesafe-ai/sdk`. buildd's `decisionCall` keeps its policy check and key resolution and delegates the transport to the kit, so buildd's behaviour does not change.

On top of that, generalise what money already does well:

```ts
import { defineDecision } from '@builddai/ai-kit/decide';

export const notableTxn = defineDecision({
  id: 'money.notable_txn',
  promptVersion: '2026-09-27.a',     // bump when definitions or examples change
  questions: { notable: { type: 'noul', question: '…' } },
  mode: 'shadow',                     // 'shadow' | 'gated' | 'live'
  minConfidence: 0.9,                 // required for 'gated' choice questions
});
// notableTxn.version     => `${promptVersion}|${JEV_MODEL}|kit-${KIT_VERSION}`
// notableTxn.fingerprint => hash of questions + definitions, asserted by a test helper
```

- **One Jev model constant.** `JEV_MODEL` lives in the kit and is pinned, never `~typesafe/jev-latest`. This keeps `docs/design/decision-calls.md` Point 5: decision models stay out of the tier registry, because a decision's version must name its model, and a registry remap would silently invalidate every eval. A Jev bump becomes one kit release, and each app re-runs its eval before upgrading its pin.
- **Modes.**
  - `shadow` persists answers through an `onDecision` hook and never acts.
  - `gated` acts only above `minConfidence` (choice and score). `noul` has no confidence field, so a gated noul needs an explicit probability threshold.
  - `live` is for add-only uses like Cue's "hold back from auto-noise".
- **Eval hooks.** `runDecisionEval({ decision, rows, labelOf, split: 'even-odd' })` returns accuracy, coverage, accuracy at each confidence threshold, and cost per 1k. It generalises `money-app:scripts/jev-eval.ts`. The kit ships the harness; each app keeps its own labelled data and results.
- **Fingerprint test helper.** `expectDecisionPinned(decision, { fingerprint, version })` fails when the definitions change without a `promptVersion` bump.
- **Key.** The caller passes its OpenRouter key. The kit never reads environment variables on its own.

#### 1c. Chat: contract, server, React

**`/chat/contract`** starts from `packages/shared/src/chat.ts` and generalises the buildd-specific parts:

- `ObjectRef<K extends string>`: an app declares its own object kinds (`shipment`, `order`, `account`, `item`) and a renderer for each. buildd's `BuilddObjectRef` becomes `ObjectRef<'mission' | 'task' | 'pr' | 'question'>`.
- `ToolPermissionRow`: buildd's `ChatToolPermissionRow` (`key`, `label`, `mode: 'ask' | 'allow' | 'read' | 'never'`, `locked`).
- New data parts. All are optional, and an older client can ignore them:
  - `data-step`: `{ id, label, state: 'done' | 'active' | 'pending' }`. It drives the thinking checklist. The server emits it from tool starts and ends plus explicit `step()` calls; the model does not invent step labels.
  - `data-handoff`: `{ taskId, url, state }`. A long job was filed to a runner (§3).
  - `data-event`: the generalised `data-buildd-event`.

**Tool permissions: a first-class primitive.** Each app declares its tool groups once. The same declaration drives the menu rows, the per-person preference, and server-side enforcement.

```ts
import { defineToolGroups } from '@builddai/ai-kit/chat/server';

export const groups = defineToolGroups({
  planner:  { label: 'Planner',  tools: [createItem, completeItem, reschedule], modes: ['ask', 'allow'] },
  email:    { label: 'Email',    tools: [muteSender, autoNoise],                modes: ['ask', 'allow'] },
  calendar: { label: 'Calendar', tools: [addEvent],                             modes: ['ask', 'allow'] },
  handoff:  { label: 'Hand-off', tools: [handOff],                              fixed: 'ask' },
  search:   { label: 'Search',   tools: [cueRead, cueSearch],                   fixed: 'read' },
  keys:     { label: 'Keys',                                                    fixed: 'never' },
});
```

- **Modes.**
  - `ask`: every write gets an approval card.
  - `allow`: a write may skip its card, under the rules below.
  - `read`: the group has no write tool.
  - `never`: the group is not a tool at all. It appears as a locked row so the person can see it is excluded.

  A group declares either `modes` (toggleable) or `fixed` (locked). The default for every toggleable group is `ask`, so shipping a group alters nothing until a person opts in.
- **Server enforcement, not UI.** `createChatTurn` ports buildd's `canSkipCard` rules. An Allowed write skips its card only if all of these hold:
  - it is the first skipped write in the turn;
  - nothing a tool returned is in the model's context (the anti-injection taint rule, `contentInContext` / `toolOutputInHistory`);
  - no docked object's data is in the instructions;
  - the tool is not marked `startsUnattendedWork` or `spends`;
  - the app's `preview(tool, input)` resolves.

  At most one approval card is shown per turn. A `never` group's tools are never registered with the model. A `read` group's tools must declare `class: 'read'`, and the kit throws at startup if a `read` group contains a write.
- **Storage.** The per-person preference goes through the `store` adapter (reference SQL column: the allowed group keys per person). The kit ships `GET` and `PATCH` handlers matching buildd's `/api/chat/permissions` contract.
- **UI.** `<ToolsMenu groups>` renders the `⋯` trigger, named plainly "Tools" with no Allow count (removed in kit 0.5.0, matching buildd), and a popover (a bottom sheet on phones) with one row per group: an Ask first / Allow toggle, or a locked label (READ ONLY / ASK FIRST / NEVER).

Per-app groups. The store, money and Cue sets are starting proposals, to be confirmed when each app's phase lands:

| App | Ask first / Allow | Fixed |
|---|---|---|
| buildd (today) | Missions, Tasks, Agents, Knowledge, Schedules, Artifacts | PRs: read only · Admin: ask first · Secrets: never |
| store | Shipments (merge, split, consolidate), Products (classify, flag slow), Classifications (confirm, reject), Comebacks (rename) | Reports and sales: read only · Notifications: ask first · Finance: **absent**, not even a locked row |
| money | Transactions (reclassify), Decisions and insights (log, react), Reminders | Balances and forecasts: read only · Accounts and cards (statements, cycles, APRs), Plans (cash floor, loan assumptions): ask first · Notifications: ask first · Credentials: never |
| Cue | Planner (create, complete, reschedule), Email (mute, auto-noise), Calendar (add event) | Search and knowledge: read only · Hand-off to a runner: ask first (it spends) · Notifications: ask first · Keys: never |

**`/chat/server`**: `createChatTurn()` is `apps/web/src/lib/chat/turn.ts` with its existing injection seams made explicit:

```ts
const turn = createChatTurn({
  models,                               // /models: tier -> model per turn, plus usage reporting
  key: resolveProviderKey,              // app-provided: (userId) => key | null (Cue: §3)
  route: routeTurnWithJev(),            // optional: Jev picks tier + tool groups, gated, default 'standard'
  groups,                               // defineToolGroups(...)
  preview,                              // app-provided dry run used by approvals and Allow
  system: buildSystemPrompt,
  store: conversationStore,             // app-provided persistence adapter
  limits: { maxSteps: 8, turnMs: 45_000 },
});
export const POST = (req) => turn.handle(req, { userId, conversationId });
```

- It uses AI SDK v7 `streamText` with `@openrouter/ai-sdk-provider`, the combination buildd already runs in production. That removes the need for money's hand-rolled `openai` loop.
- Approvals follow the same pattern as `apps/web/src/lib/chat/approvals.ts`: approval id, input hash, approver, atomic claim, all behind the `store` adapter.
- **No key means no turn.** If `key(userId)` returns null, the turn returns `409 no_key`, and the UI shows a setup card saying who can fix it (buildd's `ChatSetupCard` behaviour).
- **Persistence.** The kit defines a persistence interface and ships reference SQL as `schema.sql` for `conversations`, `conversation_messages`, `conversation_approvals`, the tool-permission preference, and an optional `ai_usage` ledger (§3). Each app migrates its own DB with its own tool (Drizzle in all three).
- **Steer while it thinks.** AI SDK v7 cannot inject a user message into a running `streamText` step. Proposed semantics:
  - A steer is queued server-side against the running turn and injected at the next step boundary via `prepareStep`. The UI marks it "applies at the next step".
  - If the turn ends first, the steer becomes the next user message.
  - Bound: at most 3 queued steers per turn, and a steer never extends `turnMs`.

  This is new behaviour, off by default behind a flag.
- Stop stays client-side (`useChat().stop()`), plus the server's abort deadline.

**`/chat/react`**: components that read the contract, not buildd's DB:

- `<ChatThread>`
- `<ChatComposer>`, with slots for `scope`, `tools`, `tier`, and a `formFallbackHref` that shows "Fill in a form instead" until the first message
- `<ScopePicker>`
- `<ToolsMenu>`
- `<TierPicker>` (Auto / budget / standard / premium, with price from the plan)
- `<ThinkingPanel>` (renders `data-step` parts plus tool rows)
- `<ApprovalCard>`
- `<StopButton>`
- `<SteerComposer>`
- `<ChatEmpty>`: the greeting ("Hi {name}, what are we working on?") and one-tap chips. Each chip is `{ label, text, send }`: `send: false` prefills the composer (buildd's "Start something new") rather than sending.
- `<ChatSetupCard>`
- `useKitChat()`, a thin wrapper over `useChat` with `DefaultChatTransport`

There is no persistent headline, date line or mood line. `<ChatEmpty>` shows only while a conversation is empty.

**Theming.** Components style themselves only through CSS custom properties in `/chat/theme.css`, plus `className` and `data-*` hooks:

`--kit-bg`, `--kit-surface`, `--kit-ink`, `--kit-muted`, `--kit-accent`, `--kit-accent-ink`, `--kit-radius-soft`, `--kit-radius-hard`, `--kit-font-body`, `--kit-font-mono`

The kit uses no Tailwind: buildd is on Tailwind v4 and Cue on v3, and neither should be forced to change. Each app maps its tokens once:

- **buildd:** map `--kit-*` from `--canvas-*` / `--convo-*`. `--kit-radius-hard: 0` keeps the square-corners rule for objects.
- **Cue:** `--kit-accent: var(--primary)`, light-first, per its design skill.
- **moa:** its existing theme tokens (it already has token-lint and contrast gates).

#### 1d. `/surfaces`: Jev picks the app's own chips and cards

Dynamic UI is limited to Jev choosing **which** of the app's own suggestion chips or cards to show, and in what order. It never decides **what** they say.

```ts
const emptyChips = defineSurface({
  id: 'cue.chat_empty',
  slots: {
    chips: { type: 'rank', candidates: cueChipCatalog, max: 4, default: ['what_needs_me', 'plan_today', 'recap_week', 'start_new'] },
    card:  { type: 'choice', labels: ['none', 'overdue_items', 'unread_bills'], default: 'none' },
  },
  state: async (ctx) => summariseForJev(ctx),   // the app decides what Jev sees
  decision: { mode: 'shadow', minConfidence: 0.85 },
});
```

- `rank` is one `score` question per candidate. The top `max` candidates above the threshold are shown in score order, and the rest of the slot is filled from `default`.
- **Safety property.** The output space is closed: labels and candidate ids the app registered. Chip text and card props come from app code. A low-confidence answer, a timeout, or shadow mode renders `default`. The model never produces markup, copy or URLs. Prompt injection from content in `state` can at worst reorder registered chips or pick a different registered card.

### 2. Where the model call runs, and how budgets are enforced

| | App-side call, buildd plans (**chosen**) | Proxied through buildd | buildd hosts the whole turn, app exposes tools via MCP |
|---|---|---|---|
| Content seen by buildd | None; receipts are metadata only | Every prompt and tool result | Every prompt, tool result and reply, stored in buildd's conversations |
| Provider key | The app's own (Cue: the user's or the household's) | buildd team key | buildd team key |
| Cost attribution | App ledger (authoritative) plus buildd receipts per app | Exact | Exact |
| Budget enforcement | Cooperative: the plan returns `ok` / `downgrade` / `deny` and the kit honours it. Hard cap = the provider key's own limit | Hard, in buildd | Hard, in buildd |
| Latency | One cached plan lookup (usually 0ms) | An extra hop on every token; two 60s function limits stacked | An extra hop on every tool call |
| buildd outage | Apps keep working on cached or fallback plans | All three apps lose chat and Jev | All three apps lose chat |

**Chosen budget model: cooperative, with hard caps in each app's own key limits.** buildd's plan is advisory and the kit honours it:

- `deny` refuses the call with a typed error;
- `downgrade` returns a cheaper tier's model.

The hard ceiling is always the provider key: an OpenRouter key's credit limit, set by whoever owns the key (the app operator, a Cue user, or a Cue household owner). If buildd is unreachable, the kit also enforces `localDailyCapUsd` per warm instance. That is a per-instance bound, not a global one, and this doc does not claim otherwise. buildd alerts when an app account's receipts exceed its configured cap, even though it cannot stop the call.

**New buildd routes** (neither exists yet):

- **`POST /api/ai/plan`**
  - Body: `{ tier, surface: 'chat' | 'inference', kind, providers, budget?: { maxUsdPerCall? } }`.
  - It wraps `resolveTierEntry` (and `drawChatPoolArm` when the team has a pool that admits the surface), the price from `model-prices.ts`, and a spend check against the app account's cap. It returns the plan shown in §1a.
  - Auth: `authenticateApiKey`; `trigger` level is enough. The team comes from the key, and the app's workspace comes from the key's account. Per-app overrides are therefore ordinary workspace rows in `model_tier_registry`, with no schema change.
- **`POST /api/ai/usage`**
  - Body: `{ planId, tokens, costUsd?, latencyMs, outcome, feedback? }`.
  - No content or identity fields: the route rejects unknown keys, so a future caller cannot start sending prompts or user ids by accident.
  - It feeds Settings → Budgets (shown as the app's service account) and, once tier pools add `tier_outcomes`, their reward signal.

**Defaults are no-ops.** `/api/ai/plan` for a workspace with no rows returns exactly what `GET /api/model-tiers` returns today for the team. No existing buildd path changes behaviour.

### 3. Cue: from runner-only to interactive

**The rule is retired, not relaxed.** Cue's `CLAUDE.md` "Dispatch must never call LLM APIs directly" paragraph, and its "Exception: Jev decisions" paragraph, are deleted and replaced by:

> **LLM calls only through `@builddai/ai-kit`.** Generative chat goes through `/chat/server` at one call site (`src/lib/ai/chat.ts`); fixed-label decisions go through `/decide` (`src/lib/jev.ts` becomes a thin wrapper). Never import a provider SDK or name a vendor model directly; ask for a tier. Long-running or repo-touching work is still a buildd runner task.

The separate retrieval rule (Voyage embeddings and reranking at two call sites) is not a generative call and stays as it is.

**Chat runs in Cue.** It uses Cue's own tool registry, Cue's own conversation tables and Cue's theme.

**Tools.** Chat tools wrap the existing handlers behind Cue's `cue_read`, `cue_search` and `cue_mutate` MCP tools, called in-process like buildd's `in-process-api.ts`. They are declared in the tool groups in §1c. Mutations default to Ask first.

**Hand-off to runners (kept).**
1. A `hand_off` tool, fixed at Ask first because it spends, calls the existing `cue:src/lib/cue-job-dispatch.ts` path (`POST /api/tasks` on buildd) with `context.conversationId`.
2. The runner's completion arrives at Cue's existing `/api/webhooks/buildd`, which appends a `data-handoff` / `data-event` message to the conversation.
3. In the mockup, "Check it with you" is the `ApprovalCard` for that hand-off. After approval, the step list shows "Filed as a task" and the card becomes a live `data-handoff` object.

Runner work keeps its existing billing (the tenant's Claude token, or the owner's with `useSharedTokens`).

**Who pays for chat: bring your own key, or a household key.**

Chat is metered by API token. Claude subscription tokens cannot serve server-side calls (`docs/SPEC.md` §3a), so chat has its own keys.

- **Storage.** A new `ai_provider_keys` table:
  - Columns: `id`, `tenantId`, `provider` (`openrouter` only at first), `scope` (`user` | `household`), `apiKey` (AES-256-GCM via `encrypt(key, tenantId)`, exactly like `moa_credentials.apiKey`), `last4`, `lastTestedAt`, `lastError`, `createdAt`, `updatedAt`.
  - At most one row per `(tenantId, provider, scope)`. A `household` row may exist only on the owner's tenant.
  - The plaintext never leaves the server, and only `last4` is shown.
  - Every create, replace and delete writes an `audit_logs` row (`ai_key_set` / `ai_key_removed`), with no secret in `detail`.
- **Resolution order**, per turn, for the person sending it:
  1. The person's own `user` key.
  2. The household owner's `household` key, if the owner has set one and has not excluded this person. The exclusion is a new `tenants.excludeFromHouseholdAiKey` flag, default 0, toggled on the admin page next to `useSharedTokens`. The two flags are separate because runner tokens and API keys are different money.
  3. None: chat is disabled for that person. The chat page shows the setup card ("add your OpenRouter key, or ask {owner} to set a household key"), and `@cue` in QuickAdd and all runner paths keep working.

  A key that fails with 401/403 is marked `lastError` and skipped for that turn. Resolution then falls to the next step, with a visible notice. This is bounded to one fallback per turn.
- **Background decisions** with no person attached (email triage at scan time) keep using Cue's operator key (`OPENROUTER_API_KEY`). They never spend a user's or the household's key.
- **Per-user cost ledger: mirrored locally in Cue.** Cue keeps an `ai_usage` table (the kit's reference schema): `tenantId` (who sent the turn), `keyScope` (`user` | `household`), `keyOwnerTenantId`, `conversationId`, `planId`, `model`, `tier`, `inputTokens`, `outputTokens`, `costUsd`, `latencyMs`, `outcome`, `createdAt`.
  - It is written by the kit's `ledger` sink, awaited, in the turn's `onEnd`.
  - It is authoritative for Cue: it drives the per-user cost view and the per-user daily caps even when buildd is down.
  - The buildd receipt (`/api/ai/usage`) is sent as well, for the model economy only, and carries no tenant id.
  - This mirrors buildd's own split: Settings → Budgets shows each person's spend, while the key itself enforces the hard limit.
- **Caps.**
  - The owner can set a per-member daily cap on household-key spend, enforced from the ledger before the turn starts.
  - A person using their own key may set their own cap, or none.
  - The hard cap is the OpenRouter key's own credit limit. The settings page recommends setting one when a household key is added.
- **Cost view.** Settings → AI shows the person's own spend (today, 7 days, 30 days), split by `keyScope`. The owner additionally sees each member's household-key spend.

### 4. moa: store and money chat

Use cases that justify chat (read-mostly, answerable in one turn):

- **Store:** "what's stuck in shipping", "which orders are waiting on a label", "why is this order on hold". The tools wrap the store MCP's read actions (shipments, unfulfilled aging, label status, fulfillment status). The existing write actions sit in toggleable groups (§1c table).
- **Money:** "why did cash drop this week", "can I afford X this month", "what's unusual in my spending". The tools wrap the finance MCP's read actions (cash flow, balances, transaction search, forecast). money's existing personal chat moves onto the kit rather than being rewritten from scratch.

Both apps use a single operator OpenRouter key per app, with its own credit limit. That is the hard cap under the chosen budget model.

**Auth boundaries (invariants):**

1. Money chat runs only in the money deployment, with a tool registry built only from money's handlers. The store's groups contain no finance action and no finance row. A unit test in the store asserts that no registered tool name matches the finance MCP's action set. This matters because the store app today contains a forwarding stub to the finance MCP.
2. Each app has its own `bld_` service account and its own provider key. Receipts from money are attributed to money and carry no content.
3. Conversations are stored in each app's own tables. Nothing about a money conversation is written to buildd beyond token counts, cost, latency, model and outcome.
4. **Known gap:** the two moa apps share one database today, and a split is in progress. Until the split lands, invariant 1 is enforced in code, not by the data layer. The store chat must not ship before money's conversation tables are unreachable from the store's DB handle.

### 5. Distribution: public npm

- **Source:** `packages/ai-kit` in this repo, Apache-2.0 like the rest of it. buildd consumes it as a workspace dependency (`workspace:*`).
- **Registry:** public npm as `@builddai/ai-kit` (#2991). The first choice was `@buildd/ai-kit`, matching the workspace names (`@buildd/core`, `@buildd/shared`), but the `buildd` npm scope belongs to an account we cannot access yet; `builddai` is a user scope and needs no org.
- **Build:** the package ships compiled ESM plus `.d.ts` in `dist/`, unlike `@buildd/core`, which exports raw `.ts` and only works inside the workspace. `files` is limited to `dist`, `schema.sql`, `theme.css` and `README.md`, so nothing else in the repo is published.
- **Publish:** a `publish-ai-kit.yml` workflow runs on tag `ai-kit-v*` or `workflow_dispatch`. It uses npm trusted publishing (GitHub OIDC, `id-token: write`) with `--provenance`, so no long-lived npm token is stored anywhere.
- **Versioning:** independent semver starting at 0.1.0, not buildd's lockstep `0.236.x`. `scripts/release.sh` must not bump it. The CHANGELOG lives in the package. Breaking changes to `/chat/contract` or to the tool-group declaration are major bumps; new optional data parts are minor.
- **Consumers:** all three install with bun, need no auth, and pin exact versions. There are no `NODE_AUTH_TOKEN` changes on Vercel or in CI for this package.
- **One Cue config fix:** Cue's `.npmrc` maps the `@buildd` scope to GitHub Packages, which would send `@builddai/ai-kit` to the wrong registry and fail. Cue installs nothing under `@buildd`, so the line is stale and P0 deletes it. The `@buildd-ai` mapping in `bunfig.toml` stays for `knowledge-store`.

**Alternatives considered.**

- *Private GitHub Package (`@buildd-ai/ai-kit`).* This would copy `buildd-ai/memory`'s `publish-knowledge-store.yml` (tag-triggered `npm publish` with `GITHUB_TOKEN`). Rejected:
  - Consumers need a classic PAT with `read:packages` as `NODE_AUTH_TOKEN` on every Vercel project and in every CI.
  - moa belongs to a personal account, so its built-in `GITHUB_TOKEN` cannot read an org package.
  - The source is public anyway, so a private registry gates installs, not knowledge.
- *git+ssh dependency.* Rejected:
  - Vercel builds have no SSH key.
  - The package lives in a monorepo subdirectory, which is awkward for bun and npm git dependencies.
  - A git dependency skips the build step, so consumers would compile buildd's TypeScript themselves.

Because the package is public, the kit, its docs and its tests must stay app-agnostic. No app's prompts, labels, tool groups, finance definitions or data belong in `packages/ai-kit`; they live in each app.

### 6. Migration plan

Each phase ships on its own and leaves the others working.

**P0: kit skeleton, extract, publish (buildd). No behaviour change.**
- Claim an npm scope (resolved as the `builddai` user scope, #2991) and configure trusted publishing for this repo.
- Create `packages/ai-kit` with `/decide` (the transport and pure parts from `decision-client.ts`) and `/chat/contract` (from `packages/shared/src/chat.ts`, re-exported by `@buildd/shared` so no import changes). Add `publish-ai-kit.yml` and publish 0.1.0 with provenance.
- Cue: delete the stale `@buildd:registry` line from `.npmrc`.
- AC:
  - buildd's existing decision and chat tests pass unchanged.
  - A scratch Next 16 + bun project on a Vercel preview, with no registry token, installs `@builddai/ai-kit@0.1.0`.
  - `bun install` in Cue still resolves `@buildd-ai/knowledge-store` from GitHub Packages.
  - `npm view @builddai/ai-kit` shows a provenance attestation.

**P1: model plans (buildd routes plus moa).**
- buildd: add `POST /api/ai/plan` and `POST /api/ai/usage`, and show receipts in Settings → Budgets under the service account. Add kit `/models`.
- store and money: replace `getModelForUseCase` with `models.plan`, mapping each use case to a tier:
  - `default` and `chat` → `standard`;
  - the analysis use cases → `standard` or `premium`;
  - classification → `budget`.
- Set a credit limit on each app's OpenRouter key.
- **Delete:**
  - both copies of `lib/ai/config.ts` and `lib/ai/use-cases.ts` (after mapping);
  - the `ai_model:*` rows in `system_settings`;
  - `/api/settings/ai/models`;
  - money's `ModelSheet`;
  - the `*WithFallback` wrappers (they no longer fall back);
  - the store's unused `@ai-sdk/google` and `@typesafe-ai/sdk` deps.
- AC:
  - Remapping `standard` for the app's workspace in buildd changes the model an app call uses within 60s, with no app deploy.
  - With buildd unreachable (bad URL), app calls still succeed and log `source: 'fallback'`.
  - A `deny` plan produces a typed error that the UI shows.
  - A test asserts that `/api/ai/usage` rejects a body containing any field outside the metadata schema.

**P2: one Jev client (all three apps).**
- money: `jev-classifier.ts` and `brief/notable.ts` move onto `defineDecision` / `runDecisionEval`.
- Cue: `src/lib/jev.ts` wraps the kit's transport, moving off `/api/alpha/decisions` onto the SDK's System One endpoint.
- **Delete:** money's `getJevClient` and its local retry and timeout code; Cue's raw `fetch` client; the per-app copies of the Jev model id.
- AC:
  - money's held-out eval reproduces its current accuracy, and its coverage at 0.9, within one point.
  - Cue's shadow rows keep writing with the same `EMAIL_JEV_VERSION` semantics.
  - Each app's fingerprint test passes, or fails and forces a version bump.

**P3: money chat on the kit.**
- Replace `/api/agent/personal-chat`'s `openai` tool loop with `createChatTurn` on AI SDK v7, with money's tool groups. Replace its `AssistantV2` UI with kit components mapped to money's theme. Upgrade money to `ai@^7` / `@ai-sdk/react@^4`.
- **Delete:** the manual tool loop, and the v6 workaround note in `ai_sdk.md` for this route.
- AC:
  - A three-tool question ("why did cash drop") completes through OpenRouter in one turn.
  - Stop aborts within 1s.
  - The conversation persists in money's tables.
  - A receipt appears in buildd with no content.
  - The `ThinkingPanel` shows one `data-step` per tool call.
  - With the Transactions group on Allow, a reclassify proposed before any tool ran skips its card. The same reclassify proposed after a read tool ran in the same turn still shows a card (a server-side test, not a UI test).
  - A "never" group's tools are absent from the model's tool list.

**P4: store chat.**
- A new store chat route and page on the kit, with store-only tool groups. It is blocked on invariant 4 in §4.
- AC:
  - The finance-exclusion test in §4 passes.
  - Every write tool defaults to Ask first.
  - The `⋯` panel shows each group's current mode (the trigger carries no count).
  - "What's stuck in shipping" answers from live shipment data.

**P5: Cue interactive.**
- Retire the rule: replace Cue's `CLAUDE.md` rule and its Jev exception with the "LLM calls only through `@builddai/ai-kit`" rule (§3).
- **Keys:** the `ai_provider_keys` table, the `tenants.excludeFromHouseholdAiKey` flag, the Settings → AI page (add, test and remove your own key; the owner adds the household key and per-member caps and exclusions), and `audit_logs` actions.
- **Ledger:** the `ai_usage` table, the kit `ledger` sink, per-user daily caps, and the cost view (self and, for the owner, members).
- **Chat:** the conversation and permission tables from the kit's reference schema; the chat page themed for Cue; `<ChatEmpty>` with Cue chips; Cue tool groups; `hand_off` to runners; the webhook appending runner results.
- AC:
  - A person with their own key chats on it, and their `ai_usage` rows say `keyScope: 'user'`.
  - A member with no key, when the owner has set a household key, chats on it (`keyScope: 'household'`, `keyOwnerTenantId` = the owner). An excluded member sees the setup card instead.
  - With no key anywhere, the chat page shows the setup card, and `@cue` in QuickAdd still creates a runner job.
  - A stored key is unreadable without `TENANT_MASTER_KEY`, and changing it writes one `audit_logs` row.
  - A member over their household-key daily cap is refused before any model call.
  - A question Cue can answer from its own data returns in one turn with no runner task created.
  - A request that needs a runner shows an approval card; approving it creates exactly one buildd task, and its completion appears in the same conversation.
  - No tenant id appears in any `/api/ai/usage` body (a test on the kit's sink).

**P6: buildd dogfoods the kit.**
- buildd's `ChatComposer`, `ChatFeed`, `ToolCallRows`, `ToolsMenu`, `TierSwitch`, `ApprovalCard` and empty state become kit components themed by buildd tokens. `permissions.ts` becomes a `defineToolGroups` declaration plus buildd-specific `startsUnattendedWork` / `SKIPPABLE_FIELDS` hooks.
- buildd-specific pieces stay here: the tools themselves, reach rules, mission objects, `in-process-api.ts`, Pusher.
- **Slice 1 (kit 0.5.0): the generic half of buildd's chat now lives in the kit**, so the adoption slices swap buildd's copies for these:
  - `ToolsMenu` without the Allow count, as buildd's own (#3054).
  - `ChatComposer` extension slots buildd's composer needs: `leading` (an object chip or a locked scope), `actions`, `edge` (the streaming sweep), `footer` (key hints), `mood`, `compact`.
  - `TurnFeedbackProvider` / `TurnFeedback` (from `TurnFeedback.tsx`): the thumbs and one optional reason, behind `onFeedback` and `loadVotes`; buildd keeps `/api/feedback` and its reason list in `@buildd/core/tier-pool`.
  - `SteerComposer` (from `SteerConversation.tsx`): the steer box, message list with sent / delivered, header and presence strip. buildd keeps the instruct route, the polling, `steerPresence` (runner display and heartbeat age) and `SteerButton` (a button bound to buildd's canvas context).
  - Object dock primitives over `ObjectRef<K>`: `createObjectStore` (from `object-store.ts`, with buildd's mission-event policy becoming an app `classify` plus a `sidecar` for the live progress overlay), `ObjectStoreProvider` / `useObjectEntry`, `ObjectCard` / `ObjectPane` over app renderers, `PinnedObject` (the pin mechanism of `PinnedObject.tsx`), `paneReducer` / `parsePaneSide` (from `pane-state.ts`) and `dockChoice` (from `dock-model.ts`). The mission / task / PR / question renderers, `popOutHref`, `taskDockModel`, `atWorkRows`, `needsDockRef`, the mini board and the visual-review chip stay in buildd.
  - Helpers: `createPendingMessages` (`pending-message.ts`), `parseChatUnavailable` / `chatErrorLine` (`chat-errors.ts`, wording overridable), `approvalDraft` / `approvalLabel` / `firstParagraph` (the preview and generic halves of `approval-draft.ts`; the mission draft becomes buildd's `custom`), `formatCost` / `formatPer1k` (`composer-format.ts`; its tier labels already exist as `tierLabel`), `refKey`, `applyTurnVote`.
- AC:
  - The chat fixture page (`apps/web/src/app/app/dev/chat/`) renders every state it does today.
  - The square-corners guard passes.
  - `apps/web/src/lib/chat/permissions.test.ts` passes unchanged against the kit-backed implementation.
  - No visual regression in the canvas screenshots.

  Without this phase the kit forks from buildd's chat within weeks, so it is not optional. It comes last only because it touches the most code.

**P7: surfaces.**
- `defineSurface` for empty-state chips and one optional card, first in shadow on Cue and the moa dashboards, then gated after an eval.
- AC:
  - In shadow, the rendered chips are always `default` and the Jev pick is logged.
  - Gating a slot requires an eval of at least ~700 labelled rows, not a round number.

### 7. Risks

- **AI SDK v6 to v7 in moa.** Both moa apps pin `ai@^6`, and the kit's chat entry points peer-depend on v7. P3 and P4 carry that upgrade; P1 and P2 do not need it.
- **Cooperative budgets.** A bug in an app, or an app on an old kit version, can overspend up to its provider key's limit. That is the accepted bound, so every production key must have a limit set. P1 and P5 require it.
- **Household key abuse or surprise bills.** The owner's key pays for every non-excluded member. This is mitigated by the per-member daily cap (enforced from the ledger before the call), the cost view, and the key's own credit limit.
- **Shared moa database** (§4, invariant 4).
- **Plan staleness.** During a buildd outage, plans can be up to 24h old, and after that the pinned fallbacks in each app's code age further. The kit logs a warning on every `fallback` plan, so the drift is visible.
- **Jev model upgrades across apps.** Exact pins, plus a fingerprint that includes the model, mean an app's tests fail until it re-evaluates.
- **Public package surface.** A public npm package is installable by anyone. The kit must contain no defaults pointing at a private host other than the `https://buildd.dev` base URL, and no app-specific logic.
- **Steer mid-turn** has no precedent in buildd. A steer can land after the step it was meant for. It ships behind a flag.
- **Allow semantics must not drift.** The taint rule is the main defence against a prompt-injected write. The kit's port has to be tested against buildd's `permissions.test.ts` cases in P0/P3, not re-derived.

---

## Open questions

Resolved in review on #2948:
- Who pays for Cue chat: a user's own key, or the household key.
- Where Cue chat runs: in Cue, with the rule retired.
- Public npm.
- Cooperative budgets with key-limit hard caps.
- The `⋯` control is tool permissions.
- The mood line and headline are dropped.

Resolved as a consequence:
- **Per-app model overrides:** workspace rows, no schema change.
- **Money receipts:** metadata only, no identity, no content.
- **Steer semantics:** queue-and-inject behind a flag.
- **Mockup extras:** handled by the tools primitive and chips.

Still open:

1. **The model-picking spec you remember from 2026-09-26/27.** It was not found in this repo, on any branch, or in PRs. If it exists (an unpushed session, or another repo), `/api/ai/plan` here should yield to it.
2. ~~**npm org name.**~~ Resolved in #2991: the `buildd` scope was not available, so the kit publishes as `@builddai/ai-kit`. `@buildd-ai/*` stayed off the table because it collides with Cue's GitHub Packages scope mapping.
3. **Household key default.** When an owner sets a household key, does every member use it automatically (exclusion opt-out, as written), or only members the owner opts in? *Lean:* opt-out. Setting the key is already the owner's opt-in, and the per-member cap limits the downside.
4. **Should household-key usage count against the runner-token sharing flag?** *Lean:* no, keep `useSharedTokens` and the AI-key exclusion separate, as written.
5. **Tool groups per app.** The store, money and Cue tables in §1c are proposals. In particular: should money's Accounts and cards group be toggleable, or stay fixed at Ask first? *Lean:* fixed. Those writes change forecasts that other features read.
6. **Should the kit expose provider choice beyond OpenRouter** (a user bringing an Anthropic key directly)? *Lean:* OpenRouter only for v1. Each extra provider multiplies key validation, pricing and the fallback matrix.

## Non-goals

- Runner changes. Runner tasks, backends, OAuth seats and claim-time tier resolution stay as they are.
- Hosting sibling apps' conversations, tools, keys or data in buildd.
- Putting Jev into the tier registry or into pools.
- A persistent headline, date or mood line in any app's chat home.
- Generated UI. `/surfaces` only chooses and orders chips and cards the app already has.
- Slack, Discord or other chat channels (`docs/design/chat-integrations.md` is retired).
- iOS clients. The React components target the web apps; native apps can read `/chat/contract`.
- Re-serving external model-quality data. `/api/ai/plan` returns a model choice, never Artificial Analysis or ranking numbers (`docs/design/model-quality-signals.md`).
