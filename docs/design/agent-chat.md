# Agent chat

**Status:** Proposed
**Related:** `packages/core/inference-client.ts`, `packages/core/inference-policy.ts`, `packages/core/model-tier-registry.ts`, `packages/core/model-tier-defaults.ts`, `packages/core/model-catalog.ts`, `packages/core/mcp-tools.ts`, `packages/core/memory-store.ts`, `packages/core/task-label.ts`, `packages/core/timezone.ts`, `apps/web/src/lib/pusher.ts`, `apps/web/src/app/app/(protected)/tasks/[id]/respond/`, `apps/web/src/app/app/(protected)/home/`, `apps/web/src/app/app/(protected)/missions/[id]/MissionBoard.tsx`, `apps/runner/src/types.ts`, `docs/design/inference-calls-primitive.md`, `docs/design/model-tiers.md`, `docs/design/model-routing-experiment.md`, `docs/design/ask-synchronous-qa.md`, `docs/design/chat-integrations.md`, `docs/design/decision-calls.md` (proposed alongside this doc), `docs/credentials-architecture.md`, `.claude/skills/schema-change/SKILL.md`

---

## Problem

The only way to start work in buildd is to file it: open the mission form, write a
goal, write criteria, pick a workspace, submit. That works when you already know
what you want. It fails at the step before, when you're still asking questions:

- "What would it take to bill customers in their own currency?" has no home. You
  work it out somewhere else, then come back and translate the answer into a
  mission form.
- "What did my agents ship today?" means scanning Home, Missions and Activity and
  assembling the answer yourself.
- A waiting-input question reaches your phone as a link to
  `/tasks/[id]/respond`, a page with no memory of the conversation that led to
  the mission.
- "Run this every day at 9" is a separate schedules form with a cron field. Agents
  that read the clock from the model's training data get "today" wrong, so a
  schedule written by an agent needs the real date and timezone passed in.
- "Don't do X again" has nowhere to go. `memories` is team-wide knowledge with no
  owner and no expiry (`packages/core/db/schema.ts`, `memories`), so a personal
  instruction either pollutes team recall or is lost.

The pieces exist: a buildd tool surface (`packages/core/mcp-tools.ts`), a typed
single-shot model call (`inferenceCall`), a tier registry, team-scoped secrets,
Pusher. What's missing is one conversational surface that joins them, where
talking about work and filing it happen in the same place.

## Current state

- **Model calls from the server.** `inferenceCall` (`packages/core/inference-client.ts`)
  is single-shot: no streaming, no tools, no message history. It resolves a tier
  through `resolveTierEntry` and a key through `resolveInferenceKey`, which reads
  `secrets` rows with purpose `inference_key` (label = provider) or
  `anthropic_api_key`. It supports `anthropic` and `openrouter`. `openai-codex`
  returns `unsupported_provider`. Every call site is gated by an
  `InferenceCapability` in `packages/core/inference-policy.ts`, and every
  capability is off by default.
- **Key scoping.** `resolveInferenceKey` accepts team-wide rows and the matching
  workspace row. It has no user dimension. `secrets.accountId` points at
  `accounts`, which are API-key identities (runners, integrations), not people.
  `inference_key` is in the `secrets.purpose` union in the schema but missing from
  `SecretPurpose` in `packages/core/secrets/types.ts`.
- **Providers in three places.** `TierProvider = 'anthropic' | 'openai-codex' | 'openrouter'`
  (`model-tier-defaults.ts`) routes tiers. The runner's
  `LLMProvider = 'anthropic' | 'openrouter'` (`apps/runner/src/types.ts`) is a
  runner-local switch read from `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL`,
  which points the Agent SDK at a different base URL. They don't share code or
  credentials.
- **Memory.** `memories` rows are team-scoped, typed
  (`discovery | decision | gotcha | pattern | architecture | summary`), and never
  expire. They're ingested into `knowledge_chunks` under `{teamId}:memory`. `recall`
  and `learn` are `handleRecallAction` / `handleLearnAction` in `mcp-tools.ts`.
- **Conversation-shaped data.** No chat tables exist. The closest are
  `mission_notes` (typed question/reply notes) and `workers.instructionHistory`.
- **Realtime.** Pusher channels are `workspace-`, `task-`, `worker-`, `mission-`,
  and they're public-named. There's no per-user channel and no channel auth route.
- **Clock.** `users.timezone` and `teams.timezone` exist (`packages/core/timezone.ts`).
  `taskSchedules.timezone` defaults to `UTC`.
- **Labels.** `tasks.label` is filled by `normalizeTaskLabel` or
  `heuristicTaskLabel` and read through `taskDisplayLabel` (`packages/core/task-label.ts`).
- **Slack and Discord.** Both were removed (`docs/design/chat-integrations.md`).
  That note lists what a rebuild must keep: signature checks, platform-to-workspace
  mapping, tenancy checks on callbacks, and credentials in `secrets`.

## Proposal

One feed where you talk to your buildd agent. It answers from live fleet state
and, when you're ready, files the work through the same tools an MCP client
would use: a mission with a goal and criteria, a schedule, an answer to a
waiting question, arming a held mission. Asking and filing are one path. You
explore, then say "make this a mission" or "run it daily", and the thing you
filed shows up in the feed as a live object, not a paragraph about it.

### The crux

**Chat turns run on the server against model APIs, metered by API token. They
never run on a runner and never use a subscription seat.**

Everything else depends on this. It makes chat quick, because a turn is a
streaming HTTP call in a Vercel function and not a claimed task waiting on a
poll interval. It also means chat always needs an API credential. The
subscription (OAuth) seats that most teams run agents on can't be used, for the
same reason given in `docs/design/inference-calls-primitive.md`: subscription
auth is tied to the runner and has no per-request form. If this is wrong,
meaning turns need a repo, a shell or multi-minute work, chat turns into a second
runner dispatch path and the latency goal fails. The line is enforced by what
chat's tools can do (below): chat reads state and files work, and agents on
runners do the work. Questions about repo structure go to `ask`
(`docs/design/ask-synchronous-qa.md`) once it exists, not to the chat model.

### Decision: build chat on the AI SDK

Chat uses the Vercel AI SDK (`ai` v7) with `@ai-sdk/anthropic`, `@ai-sdk/openai`
and `@openrouter/ai-sdk-provider`. It's the only option that covers all three
providers, streaming UI state, and per-tool approval in one library. The Claude
Agent SDK stays what runners use for multi-minute agent work. It's built around
a local agent loop with files and a shell, which is the wrong shape for a
serverless chat turn.

The v7 details this design uses. Check them against ai-sdk.dev when
implementing, because v7 renamed several of them:

- `streamText({ instructions, messages, tools, stopWhen: isStepCount(n), toolApproval })`.
  `system` is a deprecated alias of `instructions`, `needsApproval` on a tool is
  deprecated in favour of `toolApproval`, and `onFinish` is now `onEnd` (it
  reports `usage` summed across steps).
- The route returns `createUIMessageStreamResponse({ stream: toUIMessageStream(...) })`.
  Messages are saved in `onEnd`, and `consumeStream()` keeps a disconnected
  client from losing the turn.
- On the client, `useChat` from `@ai-sdk/react` with `DefaultChatTransport`.
  Messages render from `parts`. A tool part moves through `approval-requested` →
  `approval-responded` → `output-available` or `output-denied`, and the client
  answers with `addToolApprovalResponse`.
- Resumable streams (`resume: true`) need a Redis store. The Redis the app
  already uses covers that.
- `createMCPClient` from `@ai-sdk/mcp` (HTTP transport) is for connecting
  workspace MCP connectors in P2. It doesn't serve the buildd tools (see Tools).
- AI Elements is shadcn-styled. Where it's useful we copy its behaviour (tool
  part state handling, the confirmation flow) and render in our own components.
  `apps/web/src/app/globals.css` wins.

**What happens to `inferenceCall`.** Its public contract stays: a typed result,
the `InferenceError` taxonomy, the capability gate, and key resolution. Its
transport moves onto the same AI SDK provider layer, using
`generateText({ output: Output.object({ schema }) })`, which replaces the
deprecated `generateObject`. That leaves one provider layer instead of two
hand-written `fetch` paths, gives one-shot judgments OpenAI support without extra
work, and puts chat and judgments on one key resolver. The move happens after P1
ships and doesn't block it. Callers see no change.

### Should the Orchestrator be the chat?

**Yes, as one identity with two modes.** You talk to the Organizer. The Organizer
also plans missions. It has one name, one colour, one set of directives, and one
memory of you. Two modes, because the two jobs have opposite output contracts:

| | Chat mode | Planning mode |
|---|---|---|
| Runs on | server, streaming, seconds | runner, plan-first task, minutes |
| Output | prose, tool calls, object refs | a structured `plan` array (see the Organizer content in `apps/web/src/lib/default-roles.ts`) |
| Prompt | new chat instructions + role identity + directives | existing role content, unchanged |
| Writes | through approval cards | through the plan approval that exists today |

When chat files a mission, the mission records the `conversationId` it came from.
Planning-mode updates such as "plan ready: 12 tasks" and "a Builder is asking you
something" post back into that conversation as objects. So the Organizer you
asked is the one that reports back, and the planner prompt can't leak into chat.

What you get: one agent to talk to, so no one has to know which role to ask. The
planner gets the conversation's context for free, because the mission's goal and
criteria were settled in the chat. Memory carries across: a directive you gave
in chat reaches the planner. What it costs: the Organizer's role row has to carry
two prompts, and editing the role in Team settings has to show both. It also
concentrates risk. A bad directive now affects both chat and planning, which is
one reason directives are always visible and always undoable (Memory, below).
The alternative, a separate "assistant" persona that hands off to the Organizer,
gives the user two agents with different memories and no one to blame when they
disagree. That's worse.

### Who sees what first

The home layout depends on who's looking:

- **Members** get the chat first, then *Needs you*, then *Your missions*. The
  fleet is one line ("1 of 8 agents busy · Fleet →").
- **Operators** get the fleet panel first: agent slots, runners, missions in CI.
  You're an operator if you're a team `owner`/`admin` (`team_members.role`), or if
  a `worker_heartbeats` row for one of your accounts has been seen in the last 10
  minutes, meaning your own machines are running tasks. A per-user override is
  stored with the other home preferences.

The chat column is the same in both. Only the context panel changes.

### Objects in the feed

The agent's answers are buildd objects, not descriptions of them. A mission filed
from chat appears as the mission, with its phase bar, tiles that light up as
agents claim tasks, needs-you prompts you can answer where they are, and PR chips
as PRs land. It's the same data and the same components as the mission board.

**The object contract.** Every buildd tool the chat can call returns

```ts
type BuilddObjectKind =
  | 'mission' | 'task' | 'pr' | 'schedule' | 'artifact' | 'question' | 'directive';

interface BuilddObjectRef {
  kind: BuilddObjectKind;
  id: string;
  workspaceId: string;
  /** Plain text for surfaces that can't render the live object (Slack, email, a deleted object). */
  fallbackText: string;
}

interface ChatToolResult<T> {
  data: T;                   // what the model reads
  objects: BuilddObjectRef[]; // what the client renders
}
```

The message part stores the **ref**, never a snapshot. The client keeps one
registry, `objectRenderers[kind]`. Each renderer fetches through the existing
authenticated GET route and subscribes to the existing Pusher channel
(`channels.mission(id)`, `channels.task(id)`). So a tool that returns a mission,
task, PR, schedule or artifact gets a rich, live render with no extra work, and
reopening a conversation a week later shows the current state, not the state at
filing time. Renderers reuse what exists: `MissionBoard`, `MissionLanes` and
`MissionFeed` for the pane, the mission-row and task-tile components for inline
cards, and `QuestionHero` from the respond page for questions.

**Combining.** "Those two tasks keep touching the same file, make them one
mission" is a single approval card showing both task cards merging into a new
mission card. It files through `manage_missions` create followed by `link_task`
for each task, so the tasks keep their history. It's allowed only when both tasks belong to the
caller's workspace and neither has claimed work in flight.

**Desktop: the docked pane.** The object the conversation is about opens beside
the chat, docked. **The object goes left and the chat goes right** (540px), for
three reasons. Board and Lanes are wide and read left to right by phase and time,
so they get the wide side. The composer stays in the same place on screen
whichever object is open. And a fixed-width chat column on the right is where
people already expect an assistant to sit. The split can be swapped (saved per
user) and collapsed: close the pane and the chat goes full width with inline
cards. The pane follows the conversation, opening the most recently referenced
object, unless you've pinned one.

**Phone.** Objects are expandable cards. Tapping one opens the full view as a
sheet (board summary, the question if one is waiting, running tiles, landed PRs),
with the chat still visible above it.

**The respond page folds in.** A waiting-input question is a `question` object.
It renders the same `QuestionHero` component and posts to the same
`/api/workers/[id]/respond` route. Tapping an option is the approval; there's no
second confirm. `/tasks/[id]/respond` stays as the deep link in notifications. If
the task's mission came from a conversation, the link opens that conversation
with the question card in focus. Otherwise it opens the page it opens today.

### Tool calls you can see

Every tool call renders as a compact row: the tool name, its key arguments, a
live state (running, then done or failed), and a one-line result
(`manage_missions list · billing-web → 3 open, none touch currency`). Consecutive calls
group under one header ("3 tool calls · read-only · 0.9s"). Each row expands to
the raw input and output. Calls that need approval render as the approval card
itself, with the tool name in its header (`manage_missions · create`) and
Confirm / Edit / Discard. This is where the product earns trust. You can see what
the agent read before it proposed anything, and nothing it writes is hidden in a
paragraph.

### Tools and permissions

**The buildd tools are wired in-process, not over MCP.** The chat route builds AI
SDK tools from the same definitions and handlers in `packages/core/mcp-tools.ts`
that `/api/mcp` serves. It doesn't call its own MCP endpoint over HTTP, because
that would add a round trip and a second cold start to every step, and need a
token minted for every turn. Sharing definitions keeps parity: a new MCP action
shows up in chat as soon as it's added to the allowlist below. A test compares
the chat allowlist against `mcp-tools.ts` so a renamed action fails CI instead of
dropping out of chat. `createMCPClient` is reserved for third-party MCP
connectors.

**Tools run as the signed-in user,** under the same authorization as the
dashboard route for that action. The approval card is consent on top of
authorization; it never replaces it. An approval is checked on the server when
it arrives: the approval id, the tool input hash, and the approving user must
match what was proposed, so a replayed or edited approval executes nothing.

| Class | Runs | Actions |
|---|---|---|
| Read | Straight away, shown as tool rows | `list_tasks`, `get_task`, `manage_missions` list/get/get_criteria_state, `list_schedules`, `trace_schedule`, `list_artifacts`, `get_artifact`, `get_pr`, `get_pr_review`, `query_events`, `get_budget_forecast`, `explain`, `recall`, `check_path_claim` |
| Write, reversible | Approval card | `create_task`, `manage_missions` create/update/arm/link_task, `create_schedule`, `update_schedule`, `approve_plan`, `learn` (writes to team knowledge) |
| Answer | The tap is the approval | answer a waiting question (the `/respond` route) |
| Personal | Straight away, with Undo | save a directive or a short-term note for yourself |
| Merge | Approval card, only when CI is green and the app-side merge safety check passes | `merge_pr` |
| Never from chat | Not available | `manage_secrets`, `manage_model_tiers`, `manage_workspaces`, `trigger_release`, any delete, `memory_delete`, `send_agent_message` |

The limits on each turn:

- **Steps:** at most 8 model steps (`stopWhen: isStepCount(8)`).
- **Writes:** at most one approval card open per turn. A second write waits for
  the first to be answered.
- **Wall clock:** a 45s budget per turn, inside the route's `maxDuration`. When it
  runs out, the turn ends with what it has and says it stopped.

### Memory in three tiers

Extend `memories`. Don't add a second store.

| Tier | What it's for | Scope | Lifetime | Loaded |
|---|---|---|---|---|
| **Directive** | "Always round per line." "Don't open PRs on Fridays." | the user (`userId`), optionally one workspace | until removed | every turn, every surface, and in planning mode |
| **Short-term** | "Nothing in flight touches currency." Findings from this conversation, so the agent doesn't repeat itself | one conversation | expires after 20 turns or 3 days, whichever comes first | every turn in that conversation |
| **Knowledge** | the existing team memory | team | as today | through `recall`, as today |

Schema: add `tier` (`'knowledge' | 'directive' | 'short_term'`, default
`'knowledge'`), `userId` (nullable), `conversationId` (nullable) and `expiresAt`
(nullable) to `memories`. The default makes every existing row and every existing
`learn` call knowledge, so nothing changes until chat writes a different tier.

**The safety property: personal tiers never enter team recall.** Knowledge
ingestion into `knowledge_chunks` skips rows where `tier != 'knowledge'`, and the
directive loader filters on `userId = <caller>`. Both get tests: one that
recalling as another team member never returns someone else's directive, and
one that ingestion drops non-knowledge rows.

Directives show in the chat's context panel and on a Settings → You page, each
with Edit and Undo. When a directive agrees with a team decision already in
knowledge, the agent links the two instead of copying one into the other. A
short-term note that keeps coming up across conversations is a candidate to
become knowledge through `learn`, and that goes through an approval card, because
it becomes visible to the whole team.

Which tier a "remember this" belongs in is decided per request by a decision
call (below). When it's unsure, the agent asks with three buttons: *Just me*,
*This chat*, *The team*.

### Context on every turn

Every turn gets a short context block ahead of the history:

- the current date and time as ISO 8601 with weekday, in the user's timezone
  (`users.timezone`, then `teams.timezone`, then UTC), plus the timezone name;
- the stable `conversationId` (so memory and follow-ups hang off it) and the
  default workspace;
- the user's name and role, and whether they're a member or an operator;
- directives, short-term notes, and a one-paragraph fleet summary (agents live,
  needs-you count, active missions).

Schedules created from chat use the user's timezone, not UTC.

### Naming nothing

Conversations are titled automatically after the first exchange, with a budget
tier call under the `chat` capability. You can rename one but never have to.
Missions and tasks filed from chat get labels through the existing path
(`normalizeTaskLabel` / `heuristicTaskLabel`, read through `taskDisplayLabel`).
A mission draft carries a suggested title the user can edit on the approval card.

### Models: tiers, not a model picker

Users never pick a vendor model. Chat asks for a **tier** like every other caller,
and the mapping from tier to model is the team admin's call, made in Settings →
Team → Agent backends through `resolveTierEntry` and `model_tier_registry`
(`docs/design/model-tiers.md`). The chat header shows a read-only chip
("running on standard").

**Choosing a tier per turn** uses a decision call (`docs/design/decision-calls.md`).
It's a fixed-label classification, `simple | standard | complex`, mapped to
`budget | standard | premium`. The same mechanism routes intent
(`answer | needs_tools | file_work`), which decides whether the turn loads the
write tools at all. Both are confidence-gated. When confidence is low, the turn
takes the safe default: `standard` for the tier, and the full read-plus-approval
tool set for intent. If decision calls are unavailable, every turn uses
`standard` with all tools. The router can pick a cheaper tier than `standard` for
a turn. It never changes which model backs a tier.

**buildd can suggest a new mapping, but it can't make one on its own.** A change
to a tier's mapping comes from an experiment (`docs/design/model-routing-experiment.md`,
`manage_experiments`) and shows as a suggestion card with its evidence attached.
An admin applies or dismisses it. If a tier's outcome signals (criteria pass
rate, human override rate) are holding steady, it's marked **pinned**: a
suggestion to move it to a cheaper or newer model has to come with an experiment
result showing it isn't worse. Both applying and dismissing are logged.

**Provider reconciliation.** Add `'openai'` (API key) to `TierProvider`, next to
`'openai-codex'` (Codex subscription, runner only). Chat accepts only
`anthropic | openai | openrouter`. The runner's `LLMProvider` stays a runner-local
setting. Moving runners onto `secrets` is a separate change and out of scope here.

### Credentials

Chat keys are `secrets` rows with purpose `inference_key` and the provider name
in `label` (`anthropic`, `openai`, `openrouter`). That purpose already exists for
API-token model calls, so no new purpose is needed. P1 adds it to `SecretPurpose`
in `secrets/types.ts`, where it's missing.

**Which key a turn uses,** most specific first:

1. **the user's own key:** a new nullable `secrets.userId`. `accountId` can't
   hold this, because it identifies API-key accounts, not people.
2. **the workspace key:** `workspaceId = W`.
3. **the team key:** `userId`, `accountId` and `workspaceId` all NULL, set by a
   team admin.
4. **an environment variable,** only for local dev and self-hosting, and only when
   no row matched.

`resolveInferenceKey` gains the user tier and keeps its existing tie-breakers
(workspace over team, healthy over revoked, newest). A partial unique index on
`(teamId, userId, workspaceId, label) WHERE purpose = 'inference_key'` keeps each
scope to one key.

**Admin screen:** Settings → Team → Agent backends → *Provider keys* shows one
card per provider, with the team key's last four characters, when it was last
checked, how many members use their own key, and *Add team key*. Members get
Settings → You → *Use my own key*. The existing capability toggle (`chat`, new in
`INFERENCE_CAPABILITIES`, `fallback: 'none'`) sits next to it, off by default,
following the policy's rule that pasting a key never starts spending by itself.

**When no key resolves:** chat doesn't start a turn. The composer turns into the
existing mission form with the draft text kept, and a card explains why: admins
see *Add a team key*, members see *Ask an admin to connect a provider, or use your
own key*. Nothing falls back to a subscription seat.

### Cost and rate limits

Chat spend is inference spend. It's metered per turn from `usage` (the
generative call, plus the routing decision call in front of it, stored on the
user message), and summed per team and per person per day in the team's
timezone. It never touches an account's `maxCostPerDay` / `totalCost`, which
meter runner work.

| Team's runner auth | What the user sees | Limits |
|---|---|---|
| `authType: 'api'` | real dollars, next to agent spend in `get_budget_forecast` as its own line | the team daily chat budget, each person's share of it, 30 turns per user per 10 minutes |
| `authType: 'oauth'` | real dollars for chat, labelled "chat, API key". Agent run cost stays virtual, as today, and the two are never summed | the same limits. Hitting one never touches seat budgets |

The limits (`apps/web/src/lib/chat/limits.ts`), checked in this order before any
model call:

1. **Team daily budget.** `teams.chatDailyBudgetUsd`. Unset means the default,
   `DEFAULT_CHAT_DAILY_BUDGET_USD` ($20), never "no cap". `0` pauses chat.
2. **Per-person share.** `teams.chatUserDailyBudgetUsd`. Unset means
   `DEFAULT_CHAT_USER_SHARE` (half) of the team budget. Always clamped to the
   team budget, so a solo team that wants the whole budget sets it equal.
3. **Turn admission.** 30 turns per user per 10-minute sliding window, taken by
   one conditional upsert on `chat_turn_windows`
   (`INSERT … ON CONFLICT DO UPDATE … WHERE <count in window> < 30 RETURNING`).
   The row lock serializes parallel requests, so exactly the remaining slots
   succeed. Approvals and resumes are admitted the same way.

A budget refusal consumes no turn. Routing runs after admission, so a refused
turn spends nothing. Budget is checked against recorded spend, so turns already
in flight can finish slightly past the cap; admission bounds how many.

Owners and admins set both budgets with `PATCH /api/teams/[id]`
(`{ chatDailyBudgetUsd, chatUserDailyBudgetUsd }`, dollars, `null` = default).

At 80% of either budget the agent says so once. At 100%, turns stop until
midnight in the team's timezone, and the mission form stays available. A
refused turn returns 429 with `error`, `scope` (`team` or `user` for a budget),
`retryAfterSeconds`, and a `message` that says which limit was hit, when it
resets and who can raise it.

### Streaming and cross-device updates

- `POST /api/chat/[conversationId]` streams the turn (UI message stream over
  SSE). The conversation id comes from the server when a conversation is created
  and stays the same for its life.
- Resumable streams use Redis, keyed by conversation id, so a phone that drops
  signal mid-turn picks the stream back up.
- **Pusher carries pings, not content.** Channels are public-named today, so
  message text never goes over Pusher. After each message is saved, the server
  sends `conversation:updated { conversationId, messageId }` on a new
  `conversation-{id}` channel. Other devices fetch through the authenticated GET.
  Live objects use their existing channels.

### Data model

```
conversations
  id                uuid pk
  team_id           uuid not null → teams
  workspace_id      uuid null → workspaces        -- default scope for tool calls
  created_by_user_id uuid not null → users
  title             varchar(80) null              -- auto; read through a display helper like taskDisplayLabel
  title_source      text not null default 'auto'  -- 'auto' | 'user'
  agent_role_slug   text not null default 'organizer'
  last_message_at   timestamptz not null
  archived_at       timestamptz null
  created_at        timestamptz not null default now()
  index (created_by_user_id, last_message_at desc)

conversation_messages
  id                uuid pk
  conversation_id   uuid not null → conversations (cascade)
  role              text not null   -- 'user' | 'assistant' | 'event'
  parts             jsonb not null  -- UIMessage parts; tool parts carry state + BuilddObjectRef[]
  author_user_id    uuid null → users
  surface           text not null default 'web'  -- 'web' | 'slack' | 'discord' | ...
  tier              text null
  model             text null
  usage             jsonb null      -- { inputTokens, outputTokens, costUsd }
  created_at        timestamptz not null default now()
  index (conversation_id, created_at)

conversation_approvals
  id                uuid pk          -- the approval id the client echoes back
  message_id        uuid not null → conversation_messages (cascade)
  tool_name         text not null
  input_hash        text not null
  proposed_for_user_id uuid not null → users
  status            text not null default 'pending'  -- 'pending' | 'approved' | 'denied' | 'expired'
  decided_at        timestamptz null
  -- decided with UPDATE ... WHERE status = 'pending' RETURNING (no db.transaction on neon-http)

missions.conversation_id   uuid null → conversations (set null)
memories.tier / user_id / conversation_id / expires_at   (see Memory)
secrets.user_id            uuid null → users (cascade)
teams.chat_daily_budget_usd decimal null
```

`conversation_bindings` (platform, external thread id → conversation) waits for P3.

**Migration notes.** Every column is additive and nullable, or has a default that
keeps today's behaviour, so the migration runs cleanly against any existing data.
Ship it in three migrations, one per phase, not one large one, and follow
`.claude/skills/schema-change/SKILL.md`. Check dev's journal index right before
every push, because index collisions with concurrent branches are routine. Read
the generated SQL and commit `schema.ts` together with `drizzle/`. Expired
short-term memories are removed by an hourly sweep (`DELETE ... WHERE
expires_at < now()`, at most 1,000 rows per run) registered through the existing
cron manifest with `withCronRun`. No row is ever deleted by a read path.

### One conversation model across app, phone and chat platforms

- **App and phone** are the same conversation, rendered at two widths. The phone
  isn't a separate product.
- **Slack, Discord, Teams (P3)** use the Vercel Chat SDK (npm `chat`): one bot
  codebase with per-platform adapters. It handles webhook signature checks,
  native cards with buttons (`onAction`), and threads that map to conversations.
  Its `chat/ai` subpath (`createChatTools`, `toAiMessages`) connects it to the
  same AI SDK turn. A Slack thread binds to one `conversationId` through
  `conversation_bindings`, so a mission filed in Slack shows up in the app's feed
  and the reverse. Objects render in Slack as native cards made from the object's
  `fallbackText` plus buttons, and a button click resolves the same
  `conversation_approvals` row as a click in the app.
- It keeps what `docs/design/chat-integrations.md` says a rebuild must keep. Each
  inbound callback re-derives the workspace from the platform's team or guild id
  through an indexed binding (no table scan), then checks the target object
  belongs to that workspace. Bot credentials are `secrets` rows with a new
  purpose, `chat_platform_credential` (label = platform). There's a test that an
  unsigned request is rejected.
- **`ask` stays separate.** It's agent-to-platform, stateless, and runs on a
  warm runner with the codebase graph. Chat is human-facing, stateful and
  server-side. They share one boundary, from `ask` §9: neither does engineering
  work in the guise of a question. Chat files work, and when a question needs repo
  structure, it calls `ask` once `ask` exists.

## Implementation sketch

In dependency order, with the load-bearing piece first.

### P1: read-only chat plus mission filing with an approval card

1. The `chat` inference capability (off by default), `inference_key` in
   `SecretPurpose`, `secrets.userId`, and `resolveInferenceKey` with the user tier.
2. `conversations`, `conversation_messages`, `conversation_approvals`, and
   `missions.conversation_id`.
3. `POST /api/chat/[id]` on AI SDK v7: context block, tier and intent routing
   through decision calls with the fixed fallback, the read tool set, and
   `manage_missions` create behind approval.
4. The object contract and renderers for `mission`, `task`, `pr` and `question`.
   The `/respond` question folds into the feed.
5. Desktop split (object left, chat right, swappable, collapsible), phone cards
   and sheets, the member and operator context panels, a Chat item in `NAV_ITEMS`,
   and the no-key fallback.

**Acceptance:**
- With the capability off, or no key resolved, nothing changes for any team:
  there's no Chat entry point and the mission form behaves as today. A test
  asserts both.
- A read-only question ("what's in flight on billing-web?") streams its first
  token in under 2s at the p50 and shows every tool call as a row.
- "Make this a mission" produces exactly one approval card. Confirming files one
  mission with goal and criteria, and the card turns into the live mission,
  updating over Pusher without a reload. Denying files nothing. Replaying the
  approval id files nothing.
- A waiting question answered in the feed resumes the worker through
  `/api/workers/[id]/respond`, and the old `/tasks/[id]/respond` link still works.
- An OAuth-only team with no inference key sees the setup card and the mission
  form, and no turn is attempted.
- The context block has the user's local date and timezone. A test with a fixed
  clock and a non-UTC user checks the rendered block.

### P2: memory tiers, schedules and the rest of the write set

1. The `memories` columns, the rule that personal tiers skip ingestion, the
   directive loader, the short-term expiry sweep, and tier classification through
   a decision call with a three-button fallback.
2. Approval-gated `create_schedule` / `update_schedule` (in the user's
   timezone), arming held missions, `create_task`, combine, `learn`, and `merge_pr`
   (green CI and merge safety only).
3. Renderers for `schedule`, `artifact` and `directive`. Settings → You →
   Directives. The admin tier screen with provider key cards and experiment-backed
   suggestion cards.
4. Resumable streams, and the `conversation:updated` ping for other devices.
5. `inferenceCall` transport moved onto AI SDK providers, contract unchanged.

**Acceptance:**
- "Remember: always round per line" saves a directive that's loaded on the next
  turn in a different conversation and in planning mode. Another member's
  `recall` never returns it. Undo removes it.
- A short-term note is gone after its turn or day limit, and the sweep deletes at
  most 1,000 rows per run.
- "Run this every day at 9" makes a schedule with the user's timezone and the next
  run shown in local time.
- A pinned tier can't be remapped by a suggestion that has no experiment attached.
- A message sent from the phone shows up on an open desktop session within 2s,
  with no message text sent over Pusher.

### P3: Slack, Discord and Teams on one conversation model

1. The Chat SDK bot, `conversation_bindings`, and `chat_platform_credential`
   secrets.
2. Object refs rendered as native cards, with approvals going to the same
   `conversation_approvals` rows.

**Acceptance:**
- A mission filed in a Slack thread shows up in the app's conversation list, and
  the thread gets its live updates as edits.
- An unsigned or replayed webhook is rejected (test). A callback for an object in
  another workspace does nothing (test).
- Approving in Slack and in the app at the same moment executes the tool once.

## Open questions

1. **Multi-tenant Chat SDK credentials.** The adapters read platform credentials
   from environment variables. Buildd needs per-team credentials from `secrets`
   for each request. I haven't verified whether the adapters accept credentials
   passed in per request. If they don't, P3 is one buildd-owned app per platform,
   installed into each team's workspace. That's what I'd go with anyway, but it
   needs checking before P3 is scheduled.
2. **A platform key for teams with none.** Should buildd offer a metered shared
   key so OAuth-only teams can chat without bringing one? I lean no for P1 and P2:
   it's a pricing decision, and the fallback (the mission form plus a setup card)
   works without it.
3. **Running a turn on a runner when no key exists.** It would work, slowly, on the
   subscription seat. I lean no, because it breaks the crux and brings back the
   poll-bound latency that chat is meant to remove.
4. **Should members be able to combine and merge?** The table gates these on
   dashboard authorization. Some teams may want them for admins only in chat,
   even where the dashboard allows members. I lean toward a per-team setting,
   defaulting to the dashboard's rules.
5. **The operator heartbeat window.** 10 minutes is a guess. It should come from
   how often runners actually heartbeat, which I haven't measured.

## Non-goals

- Engineering work in chat. There's no repo, shell, worktree or PR authoring in a
  chat turn. That's what runners are for.
- A general "call a model" endpoint for agents. `docs/design/inference-calls-primitive.md`
  already rules it out, and chat doesn't bring it back.
- A model picker for users, or per-conversation model overrides.
- Moving runner credentials (`LLM_PROVIDER` and friends) into `secrets`.
- Voice input, attachments beyond text and images, and push notifications. The
  existing notification paths keep deep-linking into the conversation.
- Rebuilding the Slack and Discord slash commands as they were. P3 is a
  conversational bot, not the removed commands.

## Prototype

A clickable HTML prototype, kept outside the repo, covers the desktop member home
mid-conversation with a proposed-mission approval card, the same card after
confirming as a live mission, the operator context panel, the docked-pane split
with a mission filed from chat, combining two tasks into a mission, a phone
question answered by tapping, a phone "what shipped today" answer with PR chips
and a saved directive, the phone card-to-sheet expansion, and the admin tier and
provider-key screen. All data is the fictional demo story in
`scripts/demo/stories/multi-currency.json`.
