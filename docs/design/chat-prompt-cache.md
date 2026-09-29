# Prompt-cache-aware chat routing

**Status:** Proposed
**Related:** `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/routing.ts`,
`apps/web/src/lib/chat/models.ts`, `apps/web/src/lib/chat/context-block.ts`,
`apps/web/src/lib/chat/store.ts`, `packages/core/tier-pool.ts`,
`packages/core/model-tier-registry.ts`, `packages/core/db/schema.ts`
(`conversations`, `conversation_messages`), `docs/design/agent-chat.md`,
`docs/design/decision-calls.md`, `docs/design/model-tiers.md`,
`docs/design/tier-model-pools.md`

## Problem

Every chat turn resends the whole conversation, and none of it is cached. For a
typical chat turn, most of the input is the same system prompt, tool definitions
and history as the turn before. Every model family the chat tiers map to can read
that repeated prefix from a cache for roughly a tenth to a half of the input
price. We pay full price for all of it anyway, for three reasons:

1. **Nothing asks for a cache.** No `cache_control` marker is sent, so Anthropic
   models (explicit opt-in) never cache.
2. **The prefix changes every turn**, so even providers that cache automatically
   miss:
   - the system prompt embeds the current time to the second
     (`zonedIsoWithOffset`, `context-block.ts:37`), and the context block sits in
     the instructions, which come before the history;
   - the tools sent change with each turn's intent and area picks (`activeTools`,
     `turn.ts:438`);
   - past `HISTORY_LIMIT = 40` stored rows (`store.ts:26`), the window slides by
     one row per turn (`rows.slice(-HISTORY_LIMIT)`, `turn.ts:146`), so the first
     message in the history is different every turn.
3. **The model can change mid-conversation.** A cache belongs to one model (and,
   through OpenRouter, one upstream host). In *Auto*, each turn picks its own
   tier (`routeTurn`, `turn.ts:235`). A tier change swaps the model and starts a
   new pool chain.

We also can't measure any of this. `conversation_messages.usage` stores
`inputTokens`, `outputTokens`, `costUsd` and `latencyMs` only
(`schema.ts`, `conversationMessages.usage`). Cache read and write tokens are
thrown away, even though the OpenRouter provider already parses them
(`@openrouter/ai-sdk-provider` 3.1.0 maps `prompt_tokens_details.cached_tokens`
and `.cache_write_tokens` onto the AI SDK's `inputTokens.cacheRead` /
`cacheWrite`).

This doc proposes a concrete Phase 1 that makes caching work and measurable
without a new model call. It also proposes two experimental Jev decisions,
Phases 2 and 3, that start in shadow mode and only apply after an offline eval
passes.

## 1. What OpenRouter supports

**Sources.** OpenRouter's prompt caching guide
(<https://openrouter.ai/docs/features/prompt-caching>, fetched while writing
this doc), Anthropic's prompt caching docs
(<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>), and
the installed provider source
(`apps/web/node_modules/@openrouter/ai-sdk-provider/dist/index.js`, v3.1.0).

| Upstream | How it caches | Min prefix | TTL | Read price | Write price |
|---|---|---|---|---|---|
| Anthropic (Claude) | **Explicit** `cache_control` breakpoints (max 4), or a top-level automatic mode | 1,024–4,096 tokens, depending on model | 5 min default; 1 h opt-in | 0.1× input | 1.25× (5 min) / 2× (1 h) |
| OpenAI | Automatic | 1,024 tokens | model-dependent | 0.25–0.5× | free on older models; 1.25× on the newest, which also allow opt-out |
| Google Gemini (2.5+) | Implicit; also accepts `cache_control` | 1,024–4,096 tokens | ~5 min | 0.25× | input price plus storage |
| DeepSeek | Automatic | not stated | not stated | 0.1× | 1.0× |
| Moonshot (Kimi) | Automatic | not stated | not stated | 0.25× | free |
| Groq-hosted models | Automatic | not stated | not stated | 0.5× | free |
| Z.AI (GLM) | Automatic | not stated | not stated | ~0.2× | free |
| Alibaba (Qwen) | **Explicit** | not stated | 5 min | 0.1× | 1.25× |
| xAI (Grok) | Automatic | not stated | not stated | 0.25× | free |

**Hosts matter for open-weight models.** OpenRouter can serve one open-weight
model from several upstream hosts. Whether the model caches, and at what price,
is a property of the host, not of the model. A cache only helps if the next turn
lands on the same host. OpenRouter documents **provider sticky routing**: when
the host's cache reads are cheaper than its input price, repeat requests go to
the same endpoint until 10 minutes of inactivity. A `session_id` on the request
gives explicit control across a multi-turn session.

**Usage fields.** The OpenRouter response reports
`usage.prompt_tokens_details.cached_tokens` (reads) and
`usage.prompt_tokens_details.cache_write_tokens` (writes, where the host charges
for them). `usage.cost` already includes the discount. We already take the cost
from `usage.cost` in `turnCostUsd` (`models.ts:196`), so recorded cost will
start reflecting cache savings as soon as there are hits. Only the token split
is missing.

**What the installed SDK can mark.** The provider reads
`providerOptions.openrouter.cacheControl` (or `anthropic.cacheControl`) on
messages and content parts (`getCacheControl`, `dist/index.js:3679`), plus a
top-level `cache_control` model setting. Tool definitions have no per-tool
marker. For Anthropic that doesn't matter: the cache prefix order is
tools → system → messages, so a breakpoint on the system message also covers the
tools, *provided the tool list is byte-identical between turns*.

**Could not verify:**

- **No live call.** The sandbox has no OpenRouter key, so none of this was
  checked against a real response. The figures above come from the docs and the
  SDK source.
- **Per-host behaviour** for the open-weight models the chat tiers map to. Which
  hosts cache, and whether sticky routing keeps us on them under our
  provider-order settings, needs a live probe (Phase 1, task P1-6).
- **Exact per-model Anthropic minimums.** OpenRouter gives a range; confirm
  against Anthropic's table for the models in the registry when wiring
  breakpoints.
- **The native routes.** Chat can also call Anthropic and OpenAI directly
  (`languageModelFor`, `models.ts:38`). `@ai-sdk/anthropic` supports
  `providerOptions.anthropic.cacheControl` on messages. Whether the installed
  version reports cache tokens in `usage.inputTokens.cacheRead` the same way was
  not checked.

## 2. Current behaviour audit

**Where the tier is picked.** `handleChatTurn` (`turn.ts`) calls `routeTurn`
(`routing.ts:250`) unless the conversation is pinned. The complexity question
(`simple | standard | complex` → `budget | standard | premium`) is gated at
`TIER_MIN_CONFIDENCE = 0.8`. Below the gate, and on timeout
(`ROUTING_TIMEOUT_MS = 900`), the turn gets `FALLBACK_TIER = 'standard'`.
Acknowledgements skip routing and get `budget` (`routing.ts:271`). A pinned
conversation overrides the tier (`if (conv.tier) route = { ...route, tier: conv.tier }`,
`turn.ts:258`). An approval resume reuses the previous assistant turn's tier
(`turn.ts:269`).

**What can change the model mid-conversation:**

| Cause | Where | Frequency |
|---|---|---|
| Auto picks a different tier | `routeTurn`, every unpinned turn | common. An "ok" after a premium answer drops to `budget`, and the next real question goes back up |
| No key for the routed tier | falls back to `standard`, `turn.ts:298` | rare |
| Pool chain ends | `drawChatPoolArm` (`tier-pool-source.ts:402`). The chain ends on a tier change or after `CHAT_CHAIN_IDLE_MS` = 6 h (`tier-pool.ts:348`) | follows tier changes; the 6 h idle is far past any cache TTL anyway |
| Admin changes the registry | `resolveTierEntry` in-memory cache, `CACHE_TTL_MS = 60s` (`model-tier-registry.ts:43`) | rare; acceptable |
| OpenRouter moves to a different upstream host | outside our code | unknown. Sticky routing should cover it (§1) |

**Prefix instability, in request order:**

1. **Tools.** Every tool stays defined, and `activeTools` narrows what's sent to
   this turn's groups (`turn.ts:438`). A different intent or area pick sends
   a different tool list.
2. **Instructions.** `CHAT_INSTRUCTIONS` is stable. It is followed by
   `renderChatContextBlock`, which holds the second-resolution clock, the tier,
   the budget warning, workspace activity labels (`activityLabel`, relative to
   `now`), the docked object and the standing rules (`turn.ts:418`).
3. **History.** Past 40 rows the window slides by one row per turn.

**`cache_control` today:** none. Nothing in `apps/web/src` or `packages/` sets
`cacheControl` or `cache_control`, and `languageModelFor` passes only
`usage: { include: true }` to OpenRouter.

**Cost accounting.** A turn's usage comes from `result.usage` (`turn.ts:464`).
Across a multi-step turn that is probably the last step only, not the total.
That's filed separately as task `ae4a1798` and isn't fixed here. It needs to land
before Phase 1's numbers can be trusted, because tool-heavy turns are exactly the
ones where caching pays most.

## Proposal

### The crux

**Keep the prefix byte-identical within a held chain.** Phase 1 stops the tier
changing mid-conversation (the sticky tier) and adds breakpoints (cache
markers). Neither pays unless the tools, the instructions before the breakpoint
and the history's head are identical from one turn to the next. If they aren't,
we pay Anthropic's 1.25× write price on every turn and never read it back. That
is a cost *increase*, not a saving. So Phase 1 isn't done until the cache-hit
metric shows reads, and the breakpoint change ships behind a per-team flag that
defaults to off.

## 3. Phase 1: sticky tier, cache accounting, breakpoints

### 3a. Sticky tier in Auto

The first routed turn of an *Auto* conversation sets the conversation's
**held tier**. Later turns use the held tier and **don't ask the complexity
question** (the same code path as a pinned tier, which already drops the
question). Intent, area and workspace routing still run every turn.

Two kinds of hold, kept apart:

| | `conversations.tier` (exists) | `conversations.heldTier` (new) |
|---|---|---|
| Set by | the user, through the composer switch | the first routed turn in Auto |
| Meaning | pinned: a user choice | auto-held: routing's choice, kept for the cache |
| UI | the chip shows the tier | the chip shows *Auto · standard* |
| Cleared by | the user switching back to Auto | Phase 2's ratchet (upward only), the user pinning a tier, or `heldAt` older than `HELD_TIER_IDLE_MS` |

**Edge cases:**

- **Acknowledgements** ("thanks", "ok") on a held conversation use the held
  tier, not `budget`. Dropping to `budget` for one turn costs a whole prefix
  write on a new model, and that is more than the output saving.
- **An acknowledgement as the first turn** doesn't set a hold, so the first
  substantive turn decides.
- **Fallback when there's no key** keeps working. The turn uses `standard`, the
  hold stays unchanged, and the turn records `tierSource: 'fallback'`.
- **Idle release.** Past `HELD_TIER_IDLE_MS` (proposed: 30 min, well beyond the
  5 min TTL) the cache is gone anyway. The next turn re-routes and sets a new
  hold. This keeps a stale choice from sticking to a conversation reopened days
  later.

**Default is a no-op.** A team setting `chat.stickyAutoTier` defaults to `false`.
With it off, nothing reads or writes `heldTier`.

### 3b. Cache tokens in receipts and conversation cost

- Extend `ChatUsage` and the `conversation_messages.usage` jsonb type with
  optional `cacheReadTokens` and `cacheWriteTokens`, filled from
  `u.inputTokens.cacheRead` / `cacheWrite`. This fits the AI SDK v7 usage
  shape. The provider's `providerMetadata.openrouter.usage.cachedTokens` is
  the fallback.
- Sum them when a continuation merges usage (`turn.ts:479–488`), like the other
  fields.
- Carry `inputTokens` as the **total** prompt tokens. The provider's `noCache`
  split is derivable, and keeping total input stops existing dashboards moving.
- **Priced fallback.** `turnCostUsd`'s estimate path (native routes, which report
  no cost) prices cache reads and writes from the price table.
  `priceForModel` (`packages/core/model-prices.ts:88`) already returns
  `cacheRead` and `cacheWrite`.
- **Receipt.** The per-turn receipt and the conversation cost total on the tier
  chip add "cached: N% of input" and the saving in dollars.
- **Also record the hold.** Each turn records whether it was routed, held,
  pinned or a fallback (`tierSource` on the stored route usage). This also fills
  part of the "routing records almost nothing" gap.

### 3c. Breakpoints on the stable prefix

Reorder the request so the stable part comes first, then mark it:

1. **Tools: stable per held chain.** Order tools deterministically by name. Make
   the active group set **monotonic within a chain**: this turn's groups plus
   every group already sent in this chain, stored as
   `conversations.heldToolGroups`. The set grows at most a handful of times per
   conversation, and each growth costs one cache write. Tool approval and
   write-gating stay per turn: they're enforced in `toolApproval` and the
   deny path, not by which definitions are sent. **Needs verifying:** that
   offering a write tool's definition without an intent pick doesn't make the
   model reach for it more. See open question 2.
2. **Instructions.** Split into `CHAT_INSTRUCTIONS` + standing rules (stable,
   system message, **breakpoint 1**) and a **turn context** message placed after
   the history: the clock, the tier, the budget warning, activity labels and the
   docked object. The clock keeps its second resolution, because it's no longer
   in the prefix.
3. **History. Step windowing instead of a sliding window.** When stored rows
   exceed `HISTORY_LIMIT`, cut back to `HISTORY_LIMIT / 2` and keep that cut
   until the count passes the limit again. That's one prefix break per 20 turns
   instead of one every turn. **Breakpoint 2** goes on the last message of the
   previous turn. That's the longest prefix that will repeat next turn, since
   only the new user message and the turn context follow it.
4. **Top level.** Leave OpenRouter's top-level automatic mode off. Explicit
   breakpoints give predictable writes.

Breakpoints go through `providerOptions.openrouter.cacheControl` on OpenRouter
and `providerOptions.anthropic.cacheControl` on the native Anthropic route. They
are only sent when the resolved model is Anthropic or Qwen (explicit-cache
families). Automatic-cache families need only the stable ordering. Also send a
`session_id` equal to the conversation id on OpenRouter, so sticky routing has
an explicit key.

The 5-minute TTL is the default. The 1-hour TTL (2× write) is open question 3.

### 3d. Data model and migration

| Change | Migration? |
|---|---|
| `conversations.held_tier text null`, `held_tier_at timestamptz null` | yes (one additive migration) |
| `conversations.held_tool_groups text[] null` | same migration |
| `conversation_messages.usage` gains `cacheReadTokens?`, `cacheWriteTokens?`, `tierSource?` | no: jsonb, typed in `schema.ts` only |
| Team setting `chat.stickyAutoTier` (default false), `chat.cacheBreakpoints` (default false) | no, if stored in the existing team settings json. Check where chat settings live now |

The mission branch lags `origin/dev` on migration indices. Take the next index
from `origin/dev` when generating, and follow `.claude/skills/schema-change/`.

### 3e. Test plan

Unit tests, co-located. `turn.test.ts` already has `route`, `resolveModel` and
`streamTextImpl` seams.

- **Sticky tier:**
  - flag off: behaviour is unchanged (route called every turn with the
    complexity question);
  - flag on: turn 1 routes and sets `heldTier`, turn 2 skips the complexity
    question and uses the held tier;
  - an acknowledgement uses the held tier;
  - a first-turn acknowledgement sets no hold;
  - idle past `HELD_TIER_IDLE_MS` re-routes;
  - a pinned tier wins over a hold;
  - a no-key fallback keeps the hold.
- **Accounting:**
  - `cacheRead` / `cacheWrite` from a stubbed usage land in the stored usage;
  - continuations sum them;
  - `turnCostUsd` prices them on the estimate path;
  - an absent field stays absent, not 0.
- **Prefix stability.** This is the test that matters. Build two consecutive
  turns' `streamText` arguments through the seam, then assert:
  - byte-identical tools (order and set) when the intent pick changes within a
    chain;
  - an identical system message when `now` differs;
  - an identical history head across a turn that doesn't cross the step
    boundary.
- **Breakpoints:**
  - present on system and on the last prior message for an Anthropic model;
  - absent for automatic-cache families;
  - absent with the flag off.
- **Live probe (manual, P1-6):** a script that runs a 5-turn conversation per
  chat tier through OpenRouter and prints `cached_tokens` / `cache_write_tokens`
  per turn. Turns 2–5 must show reads. Run it by hand with a real key. It's not
  in CI.

## 4. Phase 2 (experimental): cache-aware upward ratchet

Phase 1 holds the first turn's tier forever (within the idle window). That's
wrong when a conversation starting with "what's running?" turns into "redesign
the claim route". Phase 2 lets a Jev decision call move the hold **up only**,
weighing the cache it would throw away.

**Question.** A Choice asked on held, unpinned turns, in the same routing request
as intent and area, so it adds no round trip: `stay | step_up | to_premium`.
There is no `step_down`. Downgrades save output price but pay a full prefix
write, and a wrong downgrade costs quality. Descending is left to the idle
release.

**Inputs (the decision's state):**

- The user message and the previous assistant turn's summary line. This is the
  existing routing context.
- The held tier and how many turns it has served.
- **Cache state as context:**
  - cached prefix tokens on the last turn (from Phase 1's `cacheReadTokens` +
    `cacheWriteTokens`);
  - seconds since the last turn against the TTL, i.e. whether the cache is
    probably still warm;
  - the estimated re-write cost at the target tier's price;
  - the estimated per-turn saving from staying.

  These go in as rendered prose ("the conversation holds ~40k cached tokens,
  warm; moving to premium re-sends them at ~$X"). Jev reads context, not
  features.

**Gating** (`docs/design/decision-calls.md` point 2): an upgrade is a quality
fix, so the gate is moderate. Proposed: `step_up` at ≥ 0.8, `to_premium` at
≥ 0.9. Below the gate the answer is `stay`. If decision calls are unavailable,
the answer is `stay`.

**Bound (safety property):** at most two ratchets per conversation, since there
are only three tiers and it's upward only. Each ratchet writes one prefix at the
new model's price. The worst case is 2 extra prefix writes per conversation.

**Shadow mode first.** Ask the question and record the answer, confidence and
cache-state inputs on the turn's stored route (`tierSource: 'held'`,
`ratchet: { label, confidence, applied: false }`). Apply nothing. Recording goes
through the existing decision-call trace, so no new table is needed unless open
question 4 says otherwise.

**Eval before auto-apply.** Over a shadow window, on held conversations:

1. **Agreement with the unheld router.** When the ratchet says `stay`, how often
   would today's per-turn router have picked a higher tier? That's the upper
   bound on the quality we give up.
2. **Regret signals** on turns where the ratchet said `stay` but the per-turn
   router said higher, compared with turns where both agreed:
   - the user switching the tier manually;
   - retry or regenerate;
   - negative turn feedback (`turn-feedback.ts`).
3. **Cost model.** Replay the conversations under "apply ratchet" and compare
   dollars with Phase 1 hold-only and with no hold (the per-turn router), using
   the recorded cache tokens.

**Pass bar (to be set with data; proposed):** regret rate on `stay` no worse
than the per-turn router's baseline, within a 95% interval. Cost per
conversation at or below the per-turn router's. Enough held conversations for
the interval to be meaningful. Only then does auto-apply turn on, behind a team
setting that defaults to off.

## 5. Phase 3 (experimental): context trimming

Long conversations carry context that no longer matters: large tool results
from forty turns ago, resolved approval cards, a docked object the user moved
away from. Trimming it saves input tokens on every later turn. But it breaks the
cache from the trim point on, so a trim is only worth doing if the saving over
the expected remaining turns beats one cache re-write.

**Droppable** (candidates only; Jev chooses among them):

- tool-result bodies older than the last K turns (K = 6 proposed), replaced by a
  one-line stub ("listed 34 tasks");
- resolved approval cards and their previews;
- thinking-step parts;
- assistant turns the user replied to with a topic change (the existing topic
  question in `askTopicQuestion`).

**Never droppable:** system instructions, standing rules and directives, any
pending approval, the last K turns, and any user message.

**Weighing the break.** The cost of a trim at position p is the re-write of
everything after p, at the write price. The saving is
`dropped_tokens × input_price × expected_remaining_turns`, where
`expected_remaining_turns` comes from the conversation's own history (a simple
estimate, not a model). The decision only runs when the saving estimate exceeds
the break cost by a margin (proposed 2×). This deterministic pre-check keeps the
call off most turns.

**Question.** For each candidate block, a Noul: "does the next reply still need
this?". It's asked in one request, with a moderate gate. Low confidence keeps
the block.

**Relationship to Phase 2.** A ratchet already breaks the whole cache: the new
model has no cache at all. So a trim that coincides with a ratchet costs no
extra break. Rule: **when the ratchet fires, run the trim decision on the same
turn, with the break cost set to zero.** Otherwise trims happen at the history
step boundary from 3c, which is also already a break. So Phase 3 only trims at
moments when the cache is already broken. That is the simplest correct
coupling, and it removes the break-cost term from all but the pre-check.

**Shadow mode.** Record the candidates, the answers and the counterfactual token
saving on the turn. Send the untrimmed context.

**Offline eval.** From the shadow records, sample conversations and replay the
next turn twice: once with full context, once trimmed per the decision. Then:

- A grader call judges answer equivalence (same facts, same actions proposed).
- Any tool call that differs counts as a failure.
- The pass bar is set against a same-model full-vs-full replay, which gives the
  noise floor from nondeterminism.
- Report the dollars saved at the observed equivalence rate.

Auto-apply comes only after the trimmed rate is within the noise floor.

## Open questions

1. **Should acknowledgements break the hold to `budget`?** I lean no (3a): one
   budget turn costs a full prefix write on a new model, so it's almost never
   cheaper. The one exception would be a cold cache (past the TTL), where the
   hold gives nothing for that turn.
2. **Monotonic tool set vs. intent gating.** Sending write-tool definitions on a
   turn whose intent was `answer` may nudge the model toward writes. Approval
   still gates them, but a spurious card is friction. I lean toward the
   monotonic set with approval as the guard. The alternative is to always send
   the full set when the flag is on, which is simpler and has one fixed prefix,
   but costs more tokens on short conversations. A/B within P1 if it matters.
3. **1-hour TTL.** It fits chat's pace better than 5 min, since people read a
   reply before answering, but it doubles the write price. Decide from Phase 1's
   data: the share of turns arriving 5–60 min after the previous one.
4. **Where ratchet and trim shadow records live.** The decision-call trace, or
   fields on `conversation_messages.usage`? I lean toward usage jsonb for the
   per-turn fields, because it keeps the cost math in one row.
5. **Pools and holds.** Should a pool chain also stop ending on a tier change
   once a hold exists? With a hold, the tier doesn't change except by ratchet,
   so today's chain rule is already right. Flagging it in case pools add
   per-turn draws later.
6. **Native routes.** Do we add breakpoints to the direct Anthropic route in P1,
   or OpenRouter only? I lean toward both, since the marker is one
   `providerOptions` key and the native route is the one with the largest
   prefixes.

## Proposed task breakdown (Phase 1 only)

Ordered. The load-bearing piece is first, because without a stable prefix the
rest measures nothing.

- **P1-0 (prerequisite, separate):** task `ae4a1798`, multi-step turn cost from
  total usage rather than the last step.
- **P1-1: cache tokens in usage.** `ChatUsage` + usage jsonb type,
  continuation merge, `turnCostUsd` estimate path, and `tierSource` on turns.
  No flag needed, since it's recording only. Tests per 3e.
- **P1-2: stable prefix.** Move the turn context after the history, step
  windowing, deterministic tool order. Behind `chat.cacheBreakpoints`, default
  off. Includes the prefix-stability tests. This is the load-bearing task.
- **P1-3: sticky tier.** The `held_tier` / `held_tier_at` /
  `held_tool_groups` migration, the hold logic in `handleChatTurn`,
  `chat.stickyAutoTier` (default off), and the monotonic tool set. Tests per 3e.
- **P1-4: breakpoints + `session_id`.** Markers for explicit-cache families on
  both routes.
- **P1-5: receipt and chip.** Cached share and dollars saved per turn and per
  conversation. UI change, so it needs a visual review.
- **P1-6: live probe script and run.** A manual script plus a short report of
  per-tier cache hits through OpenRouter. This closes the "could not verify"
  items in §1.

## Non-goals

- A gateway, proxy or LiteLLM-side cache. The team LiteLLM gateway path
  (`gatewayLanguageModel`) is out of scope, and breakpoints are not sent on it
  in Phase 1.
- Changing which model backs a tier, or the pool experiment design.
- Downward ratchets, or re-routing held conversations for cost.
- Summarising history. Phase 3 drops and stubs, it doesn't rewrite.
- Caching for agent runs (runner) or for inference and decision calls outside
  chat.
