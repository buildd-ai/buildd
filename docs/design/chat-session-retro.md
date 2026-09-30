# Chat session retros and a daily improvement pass

**Status:** Accepted
**Related:** `apps/web/src/lib/chat-retro/` (the build), `apps/web/src/lib/chat/routing.ts` (per-turn `RoutingRecord`, PR #3121),
`apps/web/src/lib/chat/turn-deadline.ts` (turn budget and stopped note, PR #3154),
`apps/web/src/lib/chat/turn-feedback.ts` (thumbs with reason labels),
`apps/web/src/lib/chat/directives.ts`, `packages/core/chat-directives.ts`,
`packages/core/memory-lifecycle.ts`, `apps/web/src/lib/memory-decisions.ts`
(`insertDecisionReceipts`), `packages/core/decision-client.ts`,
`packages/core/inference-policy.ts`, `packages/core/failure-friction-signature.ts`,
`packages/core/gate-events.ts`, `apps/web/src/lib/cron-run.ts` (`withCronRun`),
`apps/web/src/lib/auto-merge.ts` (`evaluateAutoMergeSafety`), `cron-manifest.json`,
`apps/web/scripts/chat-eval/`, [decision-calls.md](decision-calls.md),
[chat-prompt-cache.md](chat-prompt-cache.md) (PR #3145),
[memory-done-right.md](memory-done-right.md), [friction-dedup-serialization.md](friction-dedup-serialization.md),
[cron-wake-windows.md](cron-wake-windows.md), [agent-chat.md](agent-chat.md)

---

## Problem

Nothing learns from finished chat conversations. Each turn now leaves good
traces:

- the routing record on the user message's `usage.routing` (outcome, latency,
  per-question label, confidence and whether it applied);
- tokens, cost, tier and model on every message;
- the tool parts in `conversation_messages.parts` (tool name, input, result);
- `TURN_STOPPED_NOTE` on a turn that hit its time limit;
- a thumbs-down with a reason label (`wrong_answer`, `wrong_action`, `made_up`,
  `ignored_me`, `too_slow`) in `user_feedback`;
- denied approvals in `conversation_approvals`.

None of it is read after the turn. Today the only readers are live: the tier
pool reads thumbs for per-arm stats, and a directive card fires when a message
states a rule. So the same waste repeats with no record of it. Some examples of
the shape:

- a person asks "what's stuck?", the model lists every task in every workspace,
  and then asks again with a narrower filter;
- a reasoning-tier turn runs into the wrap-up deadline and ends with "Stopped:
  time limit";
- someone asks the same question twice because the first answer came from the
  wrong tool.

No one sees the pattern unless they read transcripts by hand. `feedback-digest`
turns thumbs-downs on notes and artifacts into memories, but its entity types
leave out `conversation_message`, and a memory is not the right fix for "this
tool description sends the model the wrong way".

Chat traffic is low. That shapes the whole design: the loop has to be cheap
enough to leave running while traffic grows, and honest that for a while its
output is qualitative.

## Decisions

Phases 1 and 2 are built as a removable experiment
(`apps/web/src/lib/chat-retro/`, removal steps in its `REMOVAL.md`). Phase 3
(tool-description draft PRs) and cross-team aggregation are not built.
These were settled before the build and override anything below that reads
otherwise:

1. **Own table.** Lessons live in `chat_retros`, not in a column on
   `conversations`, so the experiment drops cleanly.
2. **Per-team opt-in, off by default for every team.** Two team settings in
   `teams.chat_retro` (next to the team's other settings columns):
   `lessons` (record lessons, shadow) and `proposals` (the daily pass may file
   proposal tasks). Proposals require lessons. Turning lessons off turns
   proposals off and deletes the team's existing lessons.
3. **No cross-team or platform aggregation** in this experiment. It is a
   possible future opt-in, not a default.
4. **A closed proposal stays muted until its evidence doubles**, not for a
   fixed number of days.
5. **Removable.** One module directory, one cron route, one settings API
   route, one migration, and a short list of touch points, all listed in
   `apps/web/src/lib/chat-retro/REMOVAL.md`. `CHAT_RETRO_ENABLED=0` is a global
   kill switch; unset means opted-in teams run.
6. **Tool-description draft PRs are out of scope** for this build (the next
   phase, section 3).

## Proposal

There are two stages, both in one cron route that rides an existing wake window:

1. **Retro (per session, batched).** For each conversation window that has gone
   idle since the last pass, run a deterministic pre-filter. If the window
   passes it, make one Jev decision call. Write a content-free *lesson* row:
   labels, numbers and refs, never text.
2. **Daily proposal pass.** Cluster the lessons by signature, rank them by
   waste times frequency, and propose at most a few changes per day, deduped by
   signature the way friction is. Most proposals are guidance. Only
   tool-description text may later be drafted as a PR, and nothing is ever
   merged automatically. (This build files guidance tasks only.)

### The crux

**Jev labels, code counts, and nothing in the loop writes prose.**

Jev answers typed questions and never writes prose (decision-calls.md,
Point 7). It is also weak at counting and arithmetic. So the retro splits along
that line:

- **Code** (deterministic) computes every number and flags *candidate* waste:
  a stopped turn, a repeated tool call, an oversized tool result, a routing
  error, a denied approval, a thumbs-down.
- **Jev** answers Choice questions about those candidates: was the person
  satisfied, what were they after, was this flagged turn needed or wasted and
  why, and what class of fix would have helped.
- **Code** turns the confident answers back into wasted turns and tokens, and
  into a signature.

The daily pass is pure SQL plus the existing task-filing path. No model call
runs in it. Any prose, such as a proposed tool description or a
before-and-after write-up, is written later by an agent working the filed task,
in the team's own workspace, with the team's own access.

If this is wrong, and we let a model write free-text lessons:

- the lessons become a second copy of tenant transcripts, which the privacy
  rules below forbid aggregating;
- there is no fixed label set to cluster on, so the dedupe signature becomes a
  fuzzy text match, and the proposals repeat;
- every retro costs a generative call instead of a decision call, one or two
  orders of magnitude more;
- there is no confidence to gate on, so a wrong lesson looks the same as a
  right one.

The cost of the crux: a lesson says *where* waste happened and *which kind*,
not *what the fix is*. That is deliberate. The fix is the filed task's job.

## 1. Per-session retro

### Trigger: batched in the daily pass, not on idle

"Idle for N minutes" is the absence of an event. Nothing fires when a
conversation goes quiet, so an idle trigger needs a clock. A dedicated clock
means a new wake window, which Neon sleep-first forbids
([cron-wake-windows.md](cron-wake-windows.md)). The daily route already has a
clock, so the retro runs there:

- **Teams.** Only teams with `teams.chat_retro.lessons = true`. Nothing is
  read, and nothing is written, for any other team.
- **Window.** For each conversation, the messages after its retro watermark
  (the last message the previous retro covered) whose `lastMessageAt` is at
  least `RETRO_IDLE_MIN` old at pass time. Proposed value: 30. A conversation
  that resumes later gets a second window. Retros never re-read covered
  messages.
- **Latency cost.** A lesson lands up to a day after the conversation. That is
  fine for a loop whose output is a daily proposal.

A per-turn `after()` hook was considered and rejected. It runs on the chat
route's own budget, it cannot know the conversation is over, and it would
retro half-finished sessions.

### Eligibility: a deterministic pre-filter, then a cost bound

A window is **skipped** (a row with `status = 'skipped'` and a reason, no Jev
call) when all of these hold:

- fewer than 2 user turns;
- no stopped turn, no routing `error:*` outcome, no thumbs-down, no denied
  approval;
- total input tokens under `RETRO_MIN_TOKENS` (proposed 20K, a guess; the
  shadow phase measures what "trivial" looks like).

A single-turn greeting or a quick lookup that went fine costs a few row reads
and nothing else. Jev is not used for eligibility. A decision call to decide
whether to make a decision call spends the money it is meant to save, and the
signals that make a session interesting are all already structured.

A conversation in a workspace whose data class is `sensitive` is skipped
(`reason = 'sensitive'`) and never sent to the decision model.

**Cost bound.** Each team gets at most `RETRO_MAX_PER_TEAM_DAY` judged
retros per day (proposed 20). The rest are skipped with
`reason = 'team_cap'`, newest first, so the backlog never grows. Each pass
stops at `RETRO_MAX_PER_RUN` (proposed 100) and at the route's deadline, and a
window it didn't reach is picked up the next day. Every Jev call writes an
`ai_usage` receipt (surface `decision`, kind `chat_retro`) through the existing
`insertDecisionReceipts`, so retro spend shows up wherever decision spend is
already reported. The call spends under the `chat` capability, the same
policy chat routing uses; whether it runs at all is the team's opt-in.

**Estimate.** One decision call per judged window, with a state capped at
about 4K tokens (below). That is roughly four times a routing call's input and
the same order as the heartbeat-triage check (`inference-policy.ts` gives that
one a cost hint of about $0.0001). Illustrative ceiling: a few hundredths of a
cent per retro, so at the cap a team spends on the order of $0.01 a day. At
today's traffic, most days are far below the cap. The real cost of the loop is
not Jev. It is the agent time spent on the tasks the daily pass files, and
that is bounded separately (section 3).

### Inputs: a bounded skeleton, not the transcript

Jev's accuracy falls as irrelevant state grows. The #3145 context-trim design
bounds its state the same way for the same reason. The retro state is built in
code to about 4K tokens:

- **One line per turn.** Role, tier, input and output tokens, routing outcome,
  stopped flag, thumbs reason. For a user turn: the message text, cut to 300
  characters. For an assistant turn: its tool calls, each shown as tool name,
  argument *keys* (not values), result size in tokens, and an error flag.
- **Flagged candidates.** Code-detected waste candidates, at most 8, chosen by
  token size: `stopped`, `repeat_call` (same tool with the same argument hash
  twice), `large_result` (result over `RETRO_LARGE_RESULT_TOKENS`, proposed
  4K), `routing_error`, `denied_approval`, `thumbs_down`. Each has an index the
  questions refer to.
- **Over budget.** If the rendered state is still over budget, the oldest
  unflagged turns collapse to a count ("…12 turns, 38K tokens…"). If it still
  doesn't fit, the window is skipped with `reason = 'state_budget'`. The
  rendered size is stored on the row, so a budget breach shows up in the data.

User text goes to Jev. That is no new exposure: routing already sends every
user message to the same provider under the same team key. Assistant prose and
tool result bodies are never sent.

### Questions (all Choice; no Noul, since a Noul carries no confidence)

The labels are contrastive and have no catch-all, per decision-calls.md
Point 7. Thresholds start as proposals and are set from the shadow data.

| Question | Labels | Gate (proposed) |
|---|---|---|
| `satisfied` | `yes` · `partly` · `no` | 0.8 |
| `intent` | `status_check` · `find_object` · `explain` · `act` · `plan` · `configure` | 0.7 |
| `turn_<i>`, one per flagged candidate | `needed` · `wrong_tool` · `missing_capability` · `misleading_description` · `over_fetch` · `reasoning_timeout` · `re_asked` · `wrong_tier` | 0.8 |
| `fix_class`, asked only if some candidate may be waste | `tool_description` · `tool_or_param` · `system_prompt` · `routing_tier` · `directive_or_memory` · `ui` | 0.7 |

The cause taxonomy, and how each cause is detected:

- **wrong_tool.** A tool that exists was chosen over the right one. Needs Jev.
- **missing_capability.** No tool or parameter could answer narrowly, so the
  model fetched broadly or gave up. Needs Jev. Its fix class is `tool_or_param`.
- **misleading_description.** The model called the tool the description
  pointed it to, and that was wrong. Jev is least reliable here. Shadow data
  decides whether this label stays or merges into `wrong_tool`.
- **over_fetch.** The result was much larger than the answer used. Code flags
  it with `large_result`, and Jev confirms that it wasn't needed.
- **reasoning_timeout.** The turn stopped at the deadline. Code knows this for
  certain from the stopped note, so a flagged `stopped` candidate is labelled
  by code and Jev is not asked about it.
- **re_asked.** The next user turn restates the previous one. Needs Jev: this
  is what the one-line user text is for.
- **wrong_tier.** The routed tier was too weak (a retry at a higher tier, or a
  `too_slow` or `wrong_answer` thumb on a budget turn) or too strong. Code
  supplies the tier and routing record; Jev confirms.

`intent` reuses the shape of routing's `intent` and `area` questions but is
asked about the whole window, after the fact. It is not a routing gold label.
Grading routing against it is a separate question (Open question 5).

### The lesson row

Content-free by construction, like `memory_decisions` and `ai_usage`: no
column can hold message, tool or model text.

```
chat_retros
  id, team_id (FK cascade), conversation_id (FK cascade), workspace_id (nullable)
  from_message_id, to_message_id        -- the window; to_message_id is the watermark
  status        'skipped' | 'judged' | 'failed'
  skip_reason   'trivial' | 'team_cap' | 'state_budget' | 'sensitive' | null
  user_turns, turns, input_tokens, output_tokens, cost_usd
  intent, intent_conf, satisfied, satisfied_conf
  wasted_turns, wasted_tokens           -- code: sum over candidates Jev labelled waste above the gate
  primary_cause, fix_class, fix_class_conf
  tool_name                             -- the implicated tool, from code (tool parts), or null
  signature                             -- chat-retro:<cause>-<fix_class>-<tool|none>-<hash6>
  evidence jsonb  [{ turn, messageId, kind, tokens, label, conf }]
  state_tokens, version, latency_ms, jev_cost_usd, error
  created_at
```

The window's watermark is `to_message_at`. There is no `opted_out` row: a
team that has not opted in leaves no trace at all. Every text column has a
fixed vocabulary or pattern (`vocab.ts` `LESSON_TEXT_COLUMNS`), a test pins
that list against the table, and every row is checked against it before it
is written.

- **Primary cause.** The cause with the most wasted tokens. A tie goes to the
  cause code detected.
- **Signature.** Built in the same stem-plus-hash form as
  `packages/core/failure-friction-signature.ts`, so it is a valid
  `namespace:slug` for the friction dedupe in `POST /api/tasks`.
- **Tool name.** Always the name of a buildd tool, never a user value.
- **Failure.** A failed Jev call writes `status = 'failed'` with the error
  kind, and the watermark still advances. A retro is never retried: a lost
  lesson costs less than a pass that re-bills the same window every day.

## 2. Where lessons live

Four existing homes were considered. Decided: a new narrow table.

| Option | Why not |
|---|---|
| `memories` / knowledge store | A lesson is telemetry about a session, not knowledge for an agent. Memories are indexed for similarity retrieval across the team, so a lesson row would surface in `recall`. That is noise, and a privacy step down, since conversations are owned per person. |
| `memory_decisions` | One row per question, not per session. No jsonb for evidence, no watermark. Its readout script (`memory-decision-readout.ts`) and the relevance/promotion benchmarks read it by `decision` label, and a session aggregate doesn't fit them. |
| `conversations` jsonb column | Needs no new table, and cascades for free. But one conversation can have several windows, so it would need an array plus a watermark. Clustering across a team means unnesting jsonb, and retention would follow the conversation (forever) instead of 90 days. Still a real alternative (Open question 2). |
| `gate_events` | It records server refusals. Not the right shape or meaning. |

`chat_retros` reuses everything around it:

- the `memory_decisions` conventions: team FK cascade, content-free, labels
  and confidences, `version`;
- `ai_usage` for spend;
- the friction dedupe for filings;
- `withCronRun` for run health.

**Scope.** Rows are team-scoped, and only the team's owners and admins can
read them (`GET /api/teams/[id]/chat-retro`, or an admin-level API key of the
team). `conversation_id` cascades, so deleting a conversation deletes its
lessons, and turning the team's lessons off deletes all of them.

**Retention.** 90 days, pruned by the chat-retro cron itself at the start of
each pass, so removing the experiment removes its retention too.

## 3. Daily proposal pass

The pass runs after the retros, in the same run. It is SQL only, with no model
call.

1. **Cluster.** Per team, group the last 14 days of `judged` lessons by
   `signature`. Only lessons whose cause and fix class cleared their gates
   count.
2. **Rank.** The score is total `wasted_tokens` across the cluster, which is
   mean waste times frequency, weighted by `(1 + share of unsatisfied
   sessions)`. A cluster is eligible only with at least 3 sessions on at least
   2 distinct days. One bad afternoon is not a pattern.
3. **Propose.** At most `RETRO_MAX_PROPOSALS_PER_TEAM_DAY` (proposed 2), top
   score first. Each proposal goes through the existing task-filing path with
   `context.frictionSignature = <signature>`. If an open task already carries
   that signature, the new evidence (counts, window refs) is **appended** to it
   and no task is created. That is exactly friction's dedupe. A signature whose
   task was closed stays muted until the cluster's session count reaches
   twice what the closed task carried (Open question 4, decided).
4. **Record.** Filings, appends and mutes are counted in the run's `withCronRun`
   report. A signature that is eligible but capped is recorded as `deferred`,
   so the backlog is visible without being filed.

**What a proposal is.** A task titled `[chat-retro] <cause> via <tool>: <fix
class>` whose description the pass assembles from a template. It carries only
labels, counts and evidence refs, with no transcript text:

- sessions affected;
- tokens wasted;
- the satisfied/partly/no split;
- the refs to the lesson rows and to the conversation windows.

The worker that picks it up reads the referenced windows through the team's
own access, then writes the actual proposal. Most classes end there:

| Fix class | Proposal | Implementation allowed |
|---|---|---|
| `tool_description` | proposed new description text + a chat-eval question that reproduces it | Phase 3: a **draft PR** editing only description strings |
| `tool_or_param` | a sketch of the missing tool or parameter | no. Guidance only; a person files the build task |
| `system_prompt` | the instruction change and the sessions it would have changed | no |
| `routing_tier` | which routing question or threshold misfired, with the routing records | no. Thresholds are code changes reviewed like any other ([decision-calls.md](decision-calls.md) Point 2) |
| `directive_or_memory` | a suggested standing rule for that person | never auto-written. Surfaces as the existing directive confirm card (`CHAT_DIRECTIVE_PART_TYPE`) the next time they chat; they tap or ignore it |
| `ui` | the friction and the screen | no |

**The narrow safe class: tool-description text (Phase 3 only, not built).** A
tool-description proposal may carry a flag telling its worker to open a PR
limited to description strings in the chat tool registry
(`apps/web/src/lib/chat/registry.ts`) and the MCP tool definitions
(`packages/core/mcp-tools.ts`). The flag was to be set only for platform-level
proposals filed into the operator's workspace; with no platform rollup in
this experiment (section 4), that needs its own decision first. Its bounds:

- **Scope.** The filed task's `pathManifest` names only those files.
- **Draft, never auto-merged.** The PR is opened as a draft, and
  `evaluateAutoMergeSafety` gets one new deny rule: a PR whose task context
  carries `origin: 'chat-retro'` never auto-merges, whatever the workspace
  tier. A person merges it or closes it.
- **Throttle.** At most 1 drafted PR per day, and none while 3 retro PRs are
  already open.
- **Evidence.** The PR body carries the chat-eval before-and-after run (tokens
  and judge score on the reproducing question), so the reviewer sees a
  measured change, not an opinion.

**Relationship to existing loops (reuse, don't duplicate):**

- **Chat directives.** The retro never writes a directive. It only feeds the
  existing card, which the person confirms. `judgeChatDirective` stays the
  in-turn path.
- **Memory lifecycle.** Lessons are not memory candidates. If a filed
  proposal's worker concludes something durable, it calls `learn` like any
  task. Candidate writes, promotion and expiry stay in
  `packages/core/memory-lifecycle.ts`.
- **#3145 context trimming.** The retro doesn't trim anything at runtime.
  `over_fetch` clusters are evidence for #3145's droppable-block list and its K,
  and the retro skeleton reuses #3145's state-bounding rules instead of
  inventing new ones.
- **#3154 turn deadline.** `reasoning_timeout` is read from the stopped note
  that PR writes, and a cluster of them by tier is the evidence for tuning
  `TURN_WRAP_UP_MS` or the budget-tier pool.
- **feedback-digest.** Thumbs on chat turns are an *input* here.
  feedback-digest keeps its entity types, so the two don't both act on the same
  vote.

## 4. Privacy

Transcripts are tenant data. The rules below are enforced by the schema and the
pass, not by convention:

1. **No text leaves the conversation.** Lesson rows, proposals and PR bodies
   carry labels, counts, buildd tool names and refs. User text reaches Jev
   only, the same provider path routing already uses, and is never stored by
   the retro.
2. **Team-scoped.** Clustering and proposals run per team. A team's
   proposals file only into that team's own workspaces, and only when that
   team turned `proposals` on. The default filing target is the conversation's
   workspace. If the conversation has none (team-wide), the proposal isn't
   filed; it only shows in the retro readout.
3. **No cross-tenant aggregation.** Not built in this experiment. A label-only
   platform rollup across teams remains a possible future opt-in; it would
   need its own consent, separate from the settings below.
4. **Opt-in per team, default off.** `teams.chat_retro = { lessons, proposals }`,
   NULL for every team until an admin turns it on (Settings, AI features, or
   `PATCH /api/teams/[id]/chat-retro` with a session or an admin-level API key
   of the team). The settings copy says what is analysed, what is stored, who
   sees it, what it produces and how to turn it off. Turning lessons off
   deletes the team's lessons.
5. **Per-person conversations.** A lesson's evidence refs point at a
   conversation owned by one person. A proposal worker in that team reads the
   window only if the team's existing conversation access allows it. The retro
   doesn't widen who can read a chat.

## 5. Measurement

Three primary metrics, all computed from lesson rows and message usage with
no new instrumentation:

- **Tokens per satisfied session.** Total input and output tokens over judged
  windows with `satisfied = yes`, divided by their count. A thumbs-down on any
  turn in the window overrides Jev's `yes`.
- **Re-ask rate.** The share of judged windows with at least one `re_asked`
  candidate.
- **Timeout rate.** The share of assistant turns carrying the stopped note, per
  tier. Pure code, no Jev.

Plus the routing error and fallback rates already in `usage.routing`.

**Attributing a change.** Every shipped fix links back to its signature
through the filed task. The claim "the loop helped" is made per signature, not
globally: the signature's sessions per week, and wasted tokens per affected
session, over the equal-length windows before and after the fix's merge. A
fix is credited only if its signature falls while chat volume didn't.

**Low traffic.** Chat traffic is currently too low for any of these rates to
separate from noise, and they will stay that way for a while. So:

- **Phase 1 is qualitative.** Success means a person reads a sample of retros
  (the first 30 judged, then 10 a week) against the transcripts and agrees
  with the labels. Per-label precision from that hand grading sets the gates.
  A label below about 0.8 precision at its gate gets reworded or merged, or it
  is cut.
- **The controlled measurement is offline.** Each proposal's reproducing
  question goes into chat-eval (from the operator's own conversations only),
  where the before-and-after is measured on fixed questions without waiting
  for traffic. chat-eval is the evidence for a fix. Production rates are the
  lagging confirmation once volume allows it.
- **No rate is reported as an improvement** until the signature has at least
  about 20 sessions on each side of the fix. Below that, the readout shows the
  counts, not a percentage.

## 6. Rollout

Controlled per team by the two settings (`lessons` = shadow, `proposals` =
propose), with `CHAT_RETRO_ENABLED=0` as a deployment-wide kill switch. Every
team starts off, so merging changes nothing until an admin opts a team in.

1. **Shadow.** Retro rows are written and no tasks are filed. The admin
   lesson list (Settings, AI features) is the readout for now; a readout
   script next to `memory-decision-readout.ts` for clusters, label
   distributions and the hand-grading sample is not built yet. At first it runs only for the operator's team.
   Exit when hand-graded precision clears the gates for the labels kept, and at
   least a few clusters exist that a person agrees are worth acting on.
2. **Propose.** Filing turns on: at most 2 per team per day, deduped by
   signature, guidance only. (No platform rollup filings.) Exit when filed proposals are accepted more
   often than closed as won't-fix over a few weeks.
3. **Draft (next phase, not built).** The tool-description PR path turns on, with the auto-merge deny
   rule in place first. At most 1 per day.

**Implementation sketch (load-bearing first):**

1. The skeleton builder and candidate detector. Pure functions over messages,
   tested on fixtures with no DB: one test per candidate kind, plus the state
   budget and collapse behaviour.
2. `chat_retros` table, `teams.chat_retro`, one migration. Retention runs in
   the chat-retro cron.
3. The retro decision questions, the gates and the code that maps answers back
   to wasted turns and tokens. The `ai_usage` receipts go through
   `insertDecisionReceipts`.
4. The cron route `/api/cron/chat-retro`, wrapped in `withCronRun`. Its
   manifest entry is daily at the top of an hour (`0 10 * * *`), inside the
   window the hourly schedules tick already opens, like `experiment-health`.
   `scripts/cron-coverage.test.ts` will require the entry.
5. The team settings (API route and Settings section). No new inference
   capability: the call spends under `chat`.
6. The proposal pass and the template (Phase 2), then the auto-merge deny rule
   and the draft path (Phase 3).

## Open questions

1. **Idle threshold and window size.** Is 30 minutes idle right, and should a
   very long conversation be split into several windows at a fixed turn count?
   I lean toward 30 minutes and a split every 20 user turns. The state budget
   collapses long windows anyway, and a split keeps each lesson about one
   stretch of work.
2. **Decided: new table.** I leaned toward the table:
   multiple windows per conversation, 90-day retention independent of the
   conversation, and a plain `GROUP BY signature` for clustering. A column
   avoids a migration and cascades for free. At today's volume either works.
   The table is the one that still works once volume grows.
3. **Decided: opt-in, not opt-out.** A jsonb team column
   `teams.chat_retro = { lessons, proposals }`, default NULL (off). No change
   to `FeatureMode`.
4. **Decided: muted until evidence doubles.** The question was: is 30 days right, or should a closed
   proposal mute its signature until its evidence doubles? I lean toward "until
   evidence doubles": a time mute re-files the same rejected idea on a
   schedule.
5. **Use `intent` as routing gold?** The retro's after-the-fact `intent` could
   grade routing's live `intent` answer, for example "writes were withheld and
   the person then asked to act". I lean yes, but only after Phase 1 measures
   the retro label's own precision. Grading one model's label against another
   ungraded one proves nothing.
6. **Decided: no platform participation in this experiment,** and team
   proposals are opt-in. The original question follows: the ask was opt-out. I
   lean toward opt-out for the label-only platform rollup, since it carries no
   text and no refs, but the team-level `propose` mode (tasks filed into a
   customer's workspace) should be opt-in. Filing work into someone's queue
   unasked is a different thing from counting labels. This is a product and
   policy call.
7. **Should `misleading_description` survive?** It is the label Jev is least
   likely to get right from a skeleton. I lean toward keeping it through
   shadow only if hand-grading can tell it apart from `wrong_tool`, and merging
   the two otherwise.

## Non-goals

- **Real-time intervention.** The retro never changes a running turn.
  In-turn behaviour stays with routing, directives and the #3145 phases.
- **Writing directives, memories, prompts or thresholds automatically.** Every
  change is proposed and confirmed by a person, and only the
  tool-description draft PR produces a diff.
- **Model-written lessons or summaries.** See the crux.
- **Grading answer quality in general.** `satisfied` is a waste signal, not an
  eval. chat-eval's `judge` stays the quality measurement.
- **A new wake window or keep-alive.** The route rides the existing hourly
  window and does nothing when it is off.
- **MCP sessions from external agents.** This covers dashboard chat
  conversations only. Agent MCP sessions have their own telemetry
  (`get_usage_stats`, the gate ledger, friction).
