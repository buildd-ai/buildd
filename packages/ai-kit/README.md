# @builddai/ai-kit

Shared chat contract, tool permissions, model plans and Jev decisions for apps
that use [buildd](https://buildd.dev)'s model economy.

buildd decides **which model** a call uses and **whether it may spend**. Your
app makes the call with its own provider key and reports a content-free usage
record. buildd never sees prompts, tool results or replies.

```sh
npm i -E @builddai/ai-kit@0.5.0
```

Pin exact versions: a Jev model bump or a contract change is a new kit release,
and you should re-run your evals before taking it.

## Entry points

| Import | What | Status |
|---|---|---|
| `@builddai/ai-kit/chat/contract` | Wire types: parts, object refs, data parts, approval previews, tool-permission rows. No deps, isomorphic | Ready |
| `@builddai/ai-kit/chat/server` | `createChatTurn` (the turn runner), `defineToolGroups` + server-side Allow enforcement, the `ChatStore` persistence adapter. Peer `ai@^7`, loaded lazily on the first turn | Ready |
| `@builddai/ai-kit/chat/react` | Thread, composer, tools / scope / tier pickers, thinking panel, approval / hand-off / setup cards, empty state, `useKitChat`. Peers `react@^19`, `@ai-sdk/react@^4`, `ai@^7` (all required by this entry) | Ready |
| `@builddai/ai-kit/chat/theme.css` | `--kit-*` CSS custom properties. No Tailwind | Ready |
| `@builddai/ai-kit/chat/styles.css` | The components' layout, reading only `--kit-*`. No Tailwind | Ready |
| `@builddai/ai-kit/chat/schema.sql` | Reference Postgres tables for a `ChatStore` (never run by the kit) | Reference |
| `@builddai/ai-kit/models` | Model-plan client + usage sink. No deps; Node, Bun, edge | Ready |
| `@builddai/ai-kit/decide` | Jev decisions: typed questions, gating, versioning, eval. Optional peer `@typesafe-ai/sdk@0.6.0`: install it to call `decide`; without it the module still loads and `decide` returns `sdk_missing` | Ready |
| `@builddai/ai-kit/surfaces` | Jev orders the app's own chips (`defineRankSurface`), with a code fallback and a confidence gate. Multi-slot `defineSurface` is types only | Rank slot ready |

## Model plans

Ask buildd which model to call and whether it may spend; make the call with
your own key; record a content-free receipt.

```ts
import { createModelsClient, toCallConfig, isPlanDeniedError } from '@builddai/ai-kit/models';

const models = createModelsClient({
  apiKey: env.BUILDD_AI_KEY,                // a bld_ key for the app's service account
  providers: ['openrouter'],                // provider keys the app holds
  defaults: {                               // used only when buildd is unreachable; every tier
    'premium-plus': { provider: 'openrouter', model: '<pinned id>' },
    premium:        { provider: 'openrouter', model: '<pinned id>' },
    standard:       { provider: 'openrouter', model: '<pinned id>' },
    budget:         { provider: 'openrouter', model: '<pinned id>' },
  },
  // storage: kvPlanStore,                  // optional: survive cold starts (get/set of JSON)
});

try {
  const plan = await models.plan({ tier: 'standard', kind: 'chat_turn', budget: { maxUsdPerCall: 0.02 } });
  const cfg = toCallConfig(plan, { apiKeys: { openrouter: env.OPENROUTER_API_KEY }, appName: 'cue' });
  // ... call cfg.model at cfg.baseURL ...
  models.recordUsage({ plan, tokens: { input, output }, costUsd, latencyMs, outcome: 'ok' });
} catch (e) {
  if (isPlanDeniedError(e)) { /* show e.reason: daily_cap_reached, per_call_limit, ... */ }
}
await models.flush(); // before a serverless function returns (e.g. in waitUntil / after)
```

- **Caching.** Plans are cached per (tier, surface, workspace, budget) until
  buildd's `expiresAt` (60s). Concurrent callers share one request.
- **Bounded fallback.** buildd slower than 800ms, a 5xx, a network error or an
  unusable answer: the last good plan is served for up to `maxStaleSeconds`
  (24h) past expiry with `planSource: 'cached'`, then your `defaults` with
  `planSource: 'fallback'` and `planId: null`. `plan()` never blocks longer
  than the deadline and throws only `PlanDeniedError`.
- **Budget.** `deny` throws `PlanDeniedError`; `downgrade` returns the cheaper
  model as buildd sent it (`plan.tier` ≠ `plan.requestedTier`).
- **Receipts.** `recordUsage` never throws. It rebuilds each record from the
  server's allowlist (plan id, model, provider, tier, kind, planSource, tokens,
  cost, latency, outcome, feedback), so nothing else you pass can reach buildd, and
  refuses locally what buildd would reject. Batches of ≤100, one retry on a
  network error / timeout / 5xx / 429, then dropped and counted in `stats()`.
  Optional `kind` (`chat` | `inference` | `decision`) lets buildd report spend
  by kind; a `decision` receipt needs no tier.
- **Storage.** `PlanStore` is `{ get(key), set(key, value) }`, sync or async.
  A failing store is treated as a miss. Default: in memory.
- `onError` receives every absorbed failure, for logs.

## Chat

A streamed chat turn on AI SDK v7, with the writes it proposes gated on the
server, and the React components that render it. The kit owns the turn and
the permission rules; your app owns the tools, the model key, the storage and
the look.

### Peers

| Entry | Needs |
|---|---|
| `/chat/contract` | nothing |
| `/chat/server` | `ai@^7` to run a turn (imported lazily: the entry loads, and `defineToolGroups` works, without it). Its `.d.ts` references `ai` types |
| `/chat/react` | `react@^19`, `react-dom@^19` (since 0.3.0, for the phone menu sheet's portal), `@ai-sdk/react@^4`, `ai@^7` (imported statically) |

The kit never imports a provider SDK. Build the model yourself, e.g. with
`@openrouter/ai-sdk-provider`.

### Server: one turn

```ts
// app/api/chat/[id]/route.ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createChatTurn, modelFromPlan } from '@builddai/ai-kit/chat/server';
import { groups } from '@/lib/ai/tool-groups';        // defineToolGroups(...)
import { tools } from '@/lib/ai/tools';                // AI SDK tool({ ... }) keyed by name
import { models } from '@/lib/ai/models';              // createModelsClient(...)
import { chatStore, permissionsApi } from '@/lib/ai/store';

const turn = createChatTurn({
  toolGroups: groups,
  tools,                                               // or (ctx) => tools, per turn
  model: modelFromPlan({
    models,
    tier: 'standard',                                  // or (ctx) => tier; default: the continued turn's tier, else standard
    key: async (ctx, plan) => resolveKey(ctx.userId),  // null ⇒ 409 no_key; or { key, meta: { keyScope } }
    create: ({ config }) => createOpenRouter({ apiKey: config.apiKey, headers: config.headers })(config.model),
    appName: 'cue',
  }),
  system: ctx => buildInstructions(ctx),
  store: chatStore,                                    // your ChatStore
  permissions: ctx => permissionsApi.allowed(ctx.userId),
  preview: (tool, input, ctx) => dryRun(tool, input),  // the approval card's before → after
  onUsage: record => ledger.insert(record),            // your own ledger, awaited
});

export const maxDuration = 60;
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUser(req);
  return turn.handle(req, { userId, conversationId: (await params).id });
}
```

`createChatTurn(options)` returns `{ run, handle, steer }`:

- `handle(req, { userId, conversationId, extra?, abortOnDisconnect? })`: parses the JSON body and runs the turn. The request's signal aborts it (Stop / disconnect) unless `abortOnDisconnect: false`.
- `run({ body, userId, conversationId, signal?, extra? })`: the same, from a parsed body.
- `steer({ conversationId, userId, text, id? })`: queue a mid-turn steer (see below). 202 / 400 / 404 when steering is off.

The request body is `ChatTurnRequest`: `{ message, ...appExtras }`. The client sends **only the newest message**: a `user` message, or the latest `assistant` message with approval answers. History always comes from your store. `useKitChat` does this for you.

**Order of a turn.** Refuse before any spend (bad body 400; `admit` 429; `model` returns `no_key` 409 / `budget_exhausted` 429 as `ChatUnavailableBody`) → save the user message, or reconcile the approval answer against the store (a replay, an edit, another user or a lost race ⇒ `409 approval_not_pending`, nothing runs) → stream → on end, save the assistant message and its approval requests, send the receipt, await `onUsage`.

**Options** (`ChatTurnOptions<G, X>`, `X` = your per-request `extra`):

| Option | |
|---|---|
| `toolGroups` | `defineToolGroups(...)`. Every tool must be declared in a group, or the turn throws `ToolGroupsError` (fail closed). A `never` group has no tools, so its tools can't reach the model |
| `tools` | `ToolSet` or `(ctx: TurnToolsContext) => ToolSet`. `ctx.step(label, state?, id?)` adds a thinking row; `ctx.signal` is the turn's abort signal |
| `model` | `(ctx) => TurnModel`. Use `modelFromPlan`; never a hard-coded model |
| `system` | string or `(ctx) => string` |
| `store` | `ChatStore` (below) |
| `permissions?` | the groups this person set to Allow. Default none: every write asks |
| `preview?` | `(tool, input, ctx) => PreviewOutcome`: `{ ok: true, preview: ApprovalPreview, input? }` or `{ ok: false, question }`. Without it every write asks with a raw-input card and Allow never skips |
| `docked?` | an object's data is in the instructions: blocks Allow |
| `activeGroups?` | groups offered to the model this turn (all tools stay defined, so an approved call still runs) |
| `admit?` | your rate limit / per-person cap, before any model call |
| `limits?` | `{ maxSteps: 8, turnMs: 45_000, historyLimit: 40, storedLimit: 500, maxUserText: 8_000, maxOutputTokens: 4_096 }`. `maxOutputTokens` caps every model step: without a cap OpenRouter reserves the model's whole output window against the key and a key with a daily or credit limit refuses every turn. `0` sends no cap |
| `steering?` | `{ queue: SteerQueue, maxPerTurn?: 3 }`. Off when absent |
| `onUsage?` | `TurnUsageRecord`: user, conversation, message, plan, tokens, cost, latency, outcome, `meta` from your key resolver. Carries identity; never sent to buildd |
| `onStep?`, `onError?`, `metadata?`, `headers?`, `generateId?` | hooks |

**Writes are gated on the server.** For each call the kit asks the tool's declared class:

- `read`: runs.
- a write the person set to Allow runs without a card only if `canSkipCard` holds (first skip of the turn, no tool output anywhere in the stored conversation or earlier in this turn, nothing docked, not `startsUnattendedWork`, not `spends`, only `skippableFields`) **and** your `preview` resolves. Its output gets `allowed: true`.
- anything else gets an approval card carrying your preview. **At most one card per turn**: a second write is denied with `ONE_CARD_PER_TURN_REASON` and the model is told to ask after this one.
- a preview that can't resolve the target (`ok: false`) shows no card; the tool answers `Needs clarification: <question>`.
- on approval, the write runs only if this request won the store's compare-and-set, the input hash matches, and the preview rebuilt now has the same target and fingerprint as the approved one ("changed since the card was shown" otherwise). `execute` re-checks all of this, so nothing a tool result says can make a write run.

**Thinking steps.** The runner emits `data-step` parts from the tool lifecycle (active → done, "Check it with you" while a card waits, "Filed as a task" for a hand-off), labelled from the tool declaration's `steps: { active, done, failed? }` or the group label, never the tool name. Plus your own `ctx.step()` rows.

**Hand-off.** Declare the tool `class: 'write', spends: true` (so it always asks) and return `handoffResult({ taskId, url, title })` from its `execute`. The runner streams a `data-handoff` part (`state: 'filed'`), calls `store.linkHandoff`, and the card becomes a live object. When the task reports back (your webhook), append `handoffEventMessage({ id, handoff: { taskId, url, state: 'completed', summary } })` through your store; `latestHandoffs(messages)` folds the states and `<HandoffCard>` shows the newest.

**Provider failures.** A turn that fails after it started streaming writes a typed `data-turn-error` part (`TurnErrorData { code, message, status? }`, saved with the message) and uses the same sentence as the stream's `errorText`. `code` is `insufficient_credit` (out of credit or over the key's limit, e.g. OpenRouter's "requires more credits, or fewer max_tokens"), `rate_limited`, `invalid_key`, or `failed` ("The turn failed."). `classifyTurnError(error)` is exported for your own logs. `<ChatThread>` renders the part in place and `useKitChat().turnError` exposes it.

**Stop.** `useKitChat().stop()` aborts the request; `handle` passes the request's signal, so the model call stops too. The turn deadline (`turnMs`) always applies. Either way the partial answer is saved with `STOPPED_NOTE` and the receipt says `outcome: 'aborted'`.

**Usage.** Each request sends one content-free receipt to the plan's `recordUsage` (`/models`: plan id, model, provider, tier, `kind: 'chat'`, tokens, the provider-reported cost when OpenRouter returns it, latency, outcome) and awaits `onUsage` with the full record (cost estimated from the plan's price when the provider reports none). A continuation after an approval is its own receipt (`continuation: true`); the saved message's `usage` is summed. Call `models.flush()` in `after()` / `waitUntil` on serverless.

**Steering (flag).** With `steering: { queue }`, `turn.steer(...)` queues text against the conversation; the running turn injects it at the next step boundary (`prepareStep`) and streams a `data-steer` part (`applied`). Up to `maxPerTurn` (3) apply; the rest, and any that arrive after the last step, come back `deferred` and `useKitChat` sends them as the next message. A steer never extends `turnMs`, and only the turn owner's steers apply. `memorySteerQueue()` is single-process; on serverless use a shared queue (KV list, DB table) since the steer request and the turn usually hit different instances.

**Titles (opt-in).** Pass `title` and the runner names the conversation after a new question's turn is saved. Cheapest step first: your `rules` (e.g. the name of the object the chat was opened about), then the built-in rule (a first message of 2–7 words on one line, filler like "can you" dropped, is its own title), then one call on `model`. Leave `model` out for rules only.

```ts
createChatTurn({
  // ...
  title: {
    needed: ({ conversationId }) => db.untitled(conversationId),        // none yet, and the person never named it
    save: ({ conversationId, title }) => db.setAutoTitle(conversationId, title), // must not replace a person's title
    model: modelFromPlan({ models, key, create, tier: 'budget', kind: 'chat_title' }),
    later: fn => after(fn),                                               // Next; default is fire-and-forget
  },
});
```

The model step caps output at 512 tokens, not ~30: budget models often reason first, and a small cap is spent on the reasoning, leaving empty text. An empty answer, a refused plan or a failed call goes to `onError(e, 'title')`, and the conversation keeps no title so the next turn tries again. Its receipt is `kind: 'inference'`. `titleConversation(...)` is the same pipeline for apps with their own turn loop; `ruleTitle` and `normalizeTitle` are exported.

### Persistence: `ChatStore`

```ts
interface ChatStore {
  loadMessages(conversationId: string, opts: { limit: number }): Promise<StoredMessage[]>;   // newest `limit`, oldest first
  saveMessage(conversationId: string, message: StoredMessage): Promise<void>;                 // upsert by id
  recordApprovals(args: { conversationId: string; messageId: string; userId: string; rows: ApprovalRequestRow[] }): Promise<void>; // idempotent on approvalId
  decideApproval(args: { conversationId: string; userId: string; approvalId: string; inputHash: string; approved: boolean }): Promise<boolean>; // ONE atomic compare-and-set on status = 'pending'
  storeApprovalResult?(args: { conversationId: string; toolCallId: string; result: unknown }): Promise<void>;
  linkHandoff?(args: { conversationId: string; messageId: string | null; toolCallId: string; taskId: string; url: string }): Promise<void>;
}
// StoredMessage = ChatMessage & { createdAt?, authorUserId?, tier?, model?, usage?: ChatUsage | null }
// ApprovalRequestRow = { approvalId, toolCallId, toolName, inputHash }
```

`schema.sql` is a reference layout (conversations, messages, approvals, hand-offs, the permission preference, an `ai_usage` ledger) with the one `UPDATE … WHERE status = 'pending' RETURNING` that `decideApproval` must be. `memoryChatStore()` is for tests. Returning exactly `limit` rows from `loadMessages` tells the kit older rows exist, and Allow then treats the conversation as tainted.

**Permission preference.** `createPermissionsApi(groups, { get(userId), set(userId, groups) })` gives `{ allowed(userId), GET({ userId }), PATCH(req, { userId }) }`, matching buildd's `/api/chat/permissions` contract (`GetToolPermissionsResponse`, `UpdateToolPermissionRequest`).

### React

```tsx
'use client';
import '@builddai/ai-kit/chat/theme.css';
import '@builddai/ai-kit/chat/styles.css';
import { useRef } from 'react';
import {
  useKitChat, ChatThread, ChatComposer, ChatEmpty, ChatSetupCard, ToolsMenu, TierPicker, ScopePicker,
  type ChatComposerHandle,
} from '@builddai/ai-kit/chat/react';

export function Chat({ id, name, chips, rows, onToolChange }) {
  const chat = useKitChat({ api: `/api/chat/${id}`, id, steer: { api: `/api/chat/${id}/steer` } });
  const composer = useRef<ChatComposerHandle>(null);
  return (
    <>
      <ChatThread
        messages={chat.messages}
        status={chat.status}
        onApprovalResponse={chat.respond}
        empty={<ChatEmpty name={name} chips={chips} onChip={c => (c.send ? chat.send(c.text) : composer.current?.prefill(c.text))} />}
      />
      {chat.unavailable && <ChatSetupCard reason={chat.unavailable.error} message={chat.unavailable.message} action={<a href="/settings/ai">Add a key</a>} />}
      <ChatComposer
        ref={composer}
        busy={chat.busy}
        onSend={chat.send}
        onStop={chat.stop}
        onSteer={chat.steer}                       // omit to keep steering off
        scope={<ScopePicker options={spaces} value={scope} onChange={setScope} />}
        tools={<ToolsMenu rows={rows} onChange={onToolChange} />}
        tier={<TierPicker value={tier} last={lastTier} onChange={setTier} />}
        formFallbackHref="/new"
        showFormFallback={chat.messages.length === 0}
      />
    </>
  );
}
```

| Export | |
|---|---|
| `useKitChat({ api, id?, initialMessages?, body?, headers?, credentials?, steer?, onUnavailable?, fetch? })` | → `{ messages, status, busy, error, unavailable, turnError, send, stop, respond, steer, setMessages, clearError }`. Sends only the newest message plus `body`; approval answers go back automatically; a refusal lands in `unavailable`; a mid-stream provider failure in `turnError` |
| `<ChatThread messages status? onApprovalResponse? onEditApproval? renderText? renderObject? renderTool? renderEvent? renderHandoff? viewerName? empty? error? label?>` | `role="log"`. Text (plain by default: pass a markdown renderer), tool rows by step label + summary, approval cards, hand-off cards at their newest state, steers, events, and the thinking panel (open while streaming, folded after) |
| `<ChatComposer onSend onStop? busy? disabled? value? onChange? placeholder? onSteer? busyPlaceholder? scope? tools? tier? formFallbackHref? formFallback? showFormFallback? label? leading? actions? edge? footer? mood? compact?>` | Enter sends, Shift+Enter new line, IME-safe. Send becomes Stop while busy. `leading`: a row in the box above the message (an object chip, a locked scope); `actions`: toolbar controls after `tier`; `edge`: decoration over the top edge; `footer`: under the box; `mood` / `compact` land as `data-mood` / `data-compact`. Ref: `{ focus(), prefill(text) }` |
| `<ToolsMenu rows onChange busyKey? error?>` | The `···` control, named "Tools", with no count on the trigger (since 0.5.0). Ask first / Allow toggles; locked rows read READ ONLY / ASK FIRST / NEVER. `<ToolRows>` for a settings page |
| `<ScopePicker options value onChange routed? allLabel?>` | `@ all`, `→ routed`, `@ pinned` |
| `<TierPicker value onChange last? options?>` | `Auto`, `Auto · Standard`, or a pinned tier; `options[].price` shows as meta |
| `<ThinkingPanel steps streaming>` | the `data-step` checklist (`thinkingSteps(parts, streaming)`) |
| `<ApprovalCard part onRespond onEdit? approverName?>` | before → after from the server preview; typed confirm for `confirmText` |
| `<HandoffCard data renderLink?>` | a filed task as a live object |
| `<ChatEmpty name chips onChip greeting?>` | "Hi {name}, what are we working on?" + your chips `{ id?, label, text, send }`; `send: false` prefills. Order them yourself or with `/surfaces` `defineRankSurface` |
| `<ChatSetupCard reason message? action?>` | for `unavailable` |
| `createComposerStore` / `useComposerState` | the shared new-chat draft, remembered scope and tier (below) |
| `<TurnFeedbackProvider onFeedback initial? loadVotes? messageIds? pendingId? reasons? title?>` + `<TurnFeedback messageId>` | Thumbs under a turn. Down opens one optional reason (popover; a sheet on phones). `onFeedback({ messageId, signal, reason, previous, cleared })`: resolve `false` or throw to roll back. No fetch in the kit |
| `<SteerComposer onSend messages blockedReason? title? presence? onClose?>` | Tell a running agent something (no model turn): your `onSend` queues it, `messages[].status` is `sent` / `delivered`. `steerTitle(role, runner, label)`, `canSteer(...)` |
| `createObjectStore(source, { sidecar?, classify?, clock?, windowMs? })` | One live copy per `ObjectRef`: load on first reader, trailing refetch on the source's events, unwatch with the last reader |
| `<ObjectStoreProvider store\|source>`, `useObjectEntry(ref)`, `<ObjectCard objRef renderers>`, `<ObjectPane objRef renderers variant?>` | Your renderers per kind (`{ card, pane?, matches? }`); an unknown kind or a failed load shows `fallbackText` |
| `<PinnedObject objRef onOpen titleOf? state? meta? extra? detail? openLabel? hideOnDesktop?>` | The object the chat is about, pinned on top: one button on phones, "Open beside" and Show / Hide on wide screens |
| `paneReducer`, `parsePaneSide`, `dockChoice` | The docked pane's side / pin state, and which one thing a side panel shows |
| `createPendingMessages({ prefix?, storage? })` | Park a new chat's first message across the navigation; `take` reads and clears |
| `approvalDraft(part, { custom? })`, `approvalLabel(part, labels)` | An approval card as data (preview, else fields); "New order" from a `tool` / `tool:action` map |
| `formatCost`, `formatPer1k` | `$0.42`, `<$0.01`, `$0.003` |

`/chat/contract` also gains `refKey(ref)`, `parseChatUnavailable(err)`, `chatErrorLine(err, lines?)` and `applyTurnVote(votes, id, signal, reason?)` (0.5.0).

**Shared new-chat composer (remembered scope and tier, one draft).** Where an app starts chats from several places (a home card, the chat page, a canvas), keep one module-level store so the draft, scope and tier follow the person between them, and seed it from their last choices:

```ts
// lib/chat/composer.ts
import { createComposerStore } from '@builddai/ai-kit/chat/react';
export const composer = createComposerStore({
  prefs: {                                   // your storage; apply any tier cap on the server before returning
    load: key => fetch(`/api/chat/composer?key=${key}`).then(r => (r.ok ? r.json() : null)),   // { scope?, tier? }
    save: (key, patch) => fetch('/api/chat/composer', { method: 'PATCH', body: JSON.stringify({ key, ...patch }) }).then(() => {}),
  },
});

// in any composer for a NEW chat
const c = useComposerState(composer, teamId, { scopes: spaces, pageScope: searchParams.get('ws') });
<ChatComposer value={c.draft} onChange={c.setDraft} ...
  scope={<ScopePicker options={spaces} value={c.scope} onChange={c.setScope} />}
  tier={<TierPicker value={c.tier} onChange={c.setTier} />} />
```

- `createComposerStore({ prefs?, onError? })` → `{ get, subscribe, seed(key), setDraft(key, d), setScope(key, s), setTier(key, t), reset }`. Keyed (team, household): nothing crosses keys. `ComposerPrefsAdapter = { load(key) → { scope?, tier? } | null, save(key, patch) }`; absent = never chosen, `null` = all / Auto.
- The seed loads once per key and never overwrites a field the person already changed (`applyComposerSeed`). `setScope` / `setTier` remember the choice through `save`; the draft stays in memory.
- `useComposerState(store, key, { scopes?, pageScope? })` → `{ draft, scope, tier, seeded, setDraft, setScope, setTier }`. `pageScope` (an object's workspace, a query param) wins until the person picks another; a remembered scope not in `scopes` reads as all.
- An existing conversation keeps its own pin: hold its state yourself, and also call `composer.setScope` / `setTier` from its pickers if that choice should be the next new chat's default.

**Theming.** Components read only `--kit-*` (`--kit-bg`, `--kit-surface`, `--kit-ink`, `--kit-muted`, `--kit-rule`, `--kit-accent`, `--kit-accent-ink`, `--kit-radius-soft`, `--kit-radius-hard`, `--kit-font-body`, `--kit-font-mono`, `--kit-sheet-bottom-offset`). Map them once from your tokens (`:root { --kit-accent: var(--primary); }` or on a wrapper); the kit's defaults are on `:where(:root)`, so any mapping of yours wins regardless of stylesheet order. Classes are `kit-*` and state is on `data-*`, for overrides. Mobile-first: 44px tap targets; `prefers-reduced-motion` is honoured.

**Menus.** On wide screens the tools / scope / tier panels open above the composer (which doesn't clip them) and scroll past `min(70vh, 520px)`. Below 640px they are bottom sheets portaled to `<body>`, so a transformed, clipped or stacked ancestor can't capture them; the sheet carries the `--kit-*` values from where it was opened. If your app has a fixed bottom tab bar, set `--kit-sheet-bottom-offset` to its height (including the safe-area padding it already has) and the sheet sits on top of it; the safe-area inset is padded only for what the offset doesn't cover.

## Tool permissions

Declare your tool groups once. The same declaration drives the tools menu,
the per-person preference and server-side enforcement.

```ts
import { defineToolGroups } from '@builddai/ai-kit/chat/server';

export const groups = defineToolGroups({
  notes:  { label: 'Notes',  tools: [{ name: 'create_note', class: 'write' }], modes: ['ask', 'allow'] },
  search: { label: 'Search', tools: [{ name: 'search', class: 'read' }],       fixed: 'read' },
  keys:   { label: 'Keys',                                                     fixed: 'never' },
});

groups.rows(groups.parseAllowed(storedPreference)); // the tools menu rows

// In your tool-approval hook:
if (groups.canSkipCard({ tool, input, allowedGroups, tainted, docked, skippedThisTurn })) {
  // still build the same preview a card would, and skip only if it resolves
}
```

- `ask`: every write gets an approval card (the default for every toggleable group).
- `allow`: a write may skip its card, only if it is the first skip of the turn,
  no tool output is in the model's context, nothing is docked, it starts no
  unattended work and doesn't spend, and its input carries only skippable fields.
- `read`: no write tools (declaring one throws at startup).
- `never`: not a tool at all; shown as a locked row.

## Jev decisions

Jev (TypeSafe's System One model, via OpenRouter) picks one of your labels,
scores an ordered rubric or answers yes/no, with calibrated probabilities. It
never writes text. Use it as an accelerator in front of logic you already
have, never as the only source of an answer.

```ts
import { choice, noul, defineDecision, expectDecisionPinned } from '@builddai/ai-kit/decide';

export const emailTriage = defineDecision({
  id: 'cue.email_triage',
  promptVersion: '2026-09-27.a',          // bump when anything below changes
  questions: {
    bucket: choice('Which bucket?', { actionable: '…', informative: '…', noise: '…' }),
    concerning: noul('Does it report a failed payment or account problem?'),
  },
  mode: 'shadow',                          // default for every question
  modes: { concerning: 'live' },           // an add-only hold can act now
  minConfidence: { concerning: 0.6 },      // required for every 'gated' question
});

const run = await emailTriage.run({ apiKey: openRouterKey, state: { from, subject, body } });
if (run.outcomes.concerning.status === 'applied' && run.outcomes.concerning.value) holdForTriage();
// run.version is `promptVersion|model|kit-<version>`: stamp it on every row you persist.

// Many states (one per request) with ~8 workers and one run budget:
const { items, stats } = await emailTriage.runEach(emails, { apiKey, stateOf: toState, budgetMs: 10_000 });
```

- **Outcomes** per question: `applied` (act on `value`), `suggested` (shadow,
  or below the threshold) or `skipped` (the call failed; fall back).
- **Modes**: `shadow` never applies; `gated` applies at or above the
  question's threshold; `live` applies at or above the threshold if one is set.
  A noul's confidence is `max(p, 1 - p)` and its value `p >= 0.5`.
- **Transport** (`decide`): never throws; one deadline (default 5s) over every
  attempt; retries 408, 429 and 5xx once by default. The SDK's own retry is off
  and every SDK option is explicit, so no `TYPESAFE_*` env var can redirect the
  key. The kit never reads env vars: pass your OpenRouter key.
- **Model**: `JEV_MODEL` is pinned (not `~typesafe/jev-latest`) and is not a
  tier. A Jev bump is a kit release; re-run your eval before taking it.
- **Versioning**: pin the fingerprint in a test. It covers the questions,
  modes, thresholds and model, so a changed definition fails until you bump
  `promptVersion` and re-pin:

  ```ts
  it('is pinned', () => expectDecisionPinned(emailTriage, { fingerprint: '3f1c…' }));
  ```
- **Eval**: `runDecisionEval({ decision, rows, stateOf, labelOf, idOf, split: 'even-odd', run: { apiKey } })`
  reports accuracy, coverage and accuracy at each threshold, per-label
  precision/recall, confusions, cost per 1k and latency. Tune on one half,
  judge on the other, and read thresholds off the held-out table. Keep your
  labelled rows out of git.
- **Receipts**: `onUsage` gets a metadata-only `DecisionReceipt` per call
  (model, tokens, cost, latency, outcome). Send it on with
  `onUsage: r => models.recordUsage(toModelsUsage(r))`. It is sent as
  `kind: 'decision'` with no tier, so buildd reports decision spend on its
  own instead of as budget-tier chat.

Writing labels: define each one contrastively, avoid a catch-all label
("other"), keep state small, and leave arithmetic and dates to code.

## Surfaces: Jev orders your chips

`defineRankSurface` orders the app's own candidates (empty-state chips) with
one Jev `score` question per candidate, in one call. The output space is
closed: only ids you registered, and your code supplies every label and text.

```ts
import { defineRankSurface } from '@builddai/ai-kit/surfaces';

export const CHIPS = defineRankSurface({
  id: 'money.chat_chips',
  promptVersion: '2026-09-28.a',
  candidates: CHIP_CATALOGUE,                       // [{ id, ...your fields }]
  question: c => `Offer the one-tap question "${c.label}" (${c.purpose}) right now? Judge by the counts.`,
  levels: LEVELS,                                   // optional; lowest first
  fallback: state => codeOrder(state),              // always computed: the order when Jev is off or unsure, and the tie-break
  max: 4,
  mode: 'gated', minConfidence: 0.6,                // or 'shadow' to log only
});

const pick = await CHIPS.pick(counts, { apiKey, onUsage, onDecision });   // never throws
// pick = { ids, order, source: 'jev' | 'fallback', reason?, version, scores }
const chips = CHIPS.resolve(pick.ids);
```

- Scores count only when applied (at or above `minConfidence` in `gated`). If
  fewer than `minAppliedShare` (default half) of the candidates are applied,
  or the call fails or times out (default 3s), or there is no key, or the
  mode is `shadow`, the fallback order stands, and `reason` says why.
- Applied candidates sort by score; ties and unapplied candidates follow the
  fallback order. `rank(state, run)` is the same combination, pure, for tests
  and for replaying logged runs.
- `CHIPS.decision` is the `/decide` definition: pin it with
  `expectDecisionPinned` and eval it with `runDecisionEval` before gating.

## Theming

Import `@builddai/ai-kit/chat/theme.css` and `@builddai/ai-kit/chat/styles.css`,
and override the `--kit-*` variables with your own tokens.

## License

Apache-2.0
