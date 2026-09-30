# Subscriptions and notifications

**Status:** Accepted
**Related:** `apps/web/src/lib/notify.ts`, `apps/web/src/lib/notify-rules.ts`, `apps/web/src/lib/pushover.ts`, `apps/web/src/lib/mission-notifications.ts`, `apps/web/src/lib/task-callback.ts`, `apps/web/src/lib/pr-review-request.ts`, `apps/web/src/lib/pr-review-status.ts`, `apps/web/src/lib/pusher.ts`, `apps/web/src/lib/redis.ts`, `apps/web/src/lib/chat/registry.ts`, `apps/web/src/lib/chat/tools.ts`, `apps/web/src/lib/chat/mission-events.ts`, `apps/web/src/lib/chat/store.ts`, `apps/web/src/app/api/mcp/route.ts`, `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/app/api/github/webhook/route.ts`, `apps/web/src/app/api/webhooks/ingest/route.ts`, `apps/web/src/app/api/teams/[id]/notifications/route.ts`, `apps/web/src/app/app/(protected)/settings/NotificationsSection.tsx`, `packages/core/db/schema.ts` (`secrets`, `notificationPreferences`, `watchedProjects`, `watcherEvents`, `conversations`, `conversationMessages`), `packages/core/decision-client.ts`, `packages/shared/src/chat.ts`, `docs/credentials-architecture.md`, `docs/design/agent-chat.md`, `docs/design/decision-calls.md`, `docs/design/connectors-and-orgs.md`

---

## Problem

Nobody can say "tell me when this happens" to buildd.

- In chat, a person asks "let me know when PR 42 merges". The agent can read the PR now. It cannot watch it. The conversation ends and nothing comes back. The only chat events that post back are planning updates for missions filed from chat (`lib/chat/mission-events.ts`).
- An interactive MCP client (Claude Code, claude.ai) cannot receive a webhook at all. Today it either polls `get_pr_review` with `waitSeconds` (clamped to 45s by `MAX_REVIEW_WAIT_SECONDS`) or forgets.
- A worker that files a subtask and wants to know when it finishes has to poll.
- Team alerts exist but are coarse: `notifyTeam` sends five fixed event types (claimed, completed, failed, credential expired, connector blocked) for every task in the team to one team Pushover key or one webhook URL. There is no "just this PR", no "only for me", no "only if I'm not already looking".
- Two per-object webhooks exist (`create_task` `callbackUrl`, `request_pr_review` `callbackUrl` + `callbackOn`) but each is its own code path with its own delivery rules, and neither can reach a person.

## Current state

What exists and will be built on, not duplicated.

| Piece | Where | What it does now |
|---|---|---|
| Team alerts | `lib/notify.ts` `notifyTeam`, `lib/notify-rules.ts` `resolveNotifyPlan` | Per-team Pushover (team's own app token + user key) and webhook URL, read from team-wide `secrets` rows (purposes `pushover`, `notify_webhook`). Toggled per event in `notification_preferences` (one row per team). Fire-and-forget, swallows errors. |
| Platform alerts | `lib/pushover.ts` `notifyOperator` | Env-keyed Pushover for platform-health alerts only (health-watcher and release-failure alerts are tenant-configured, so they go to the owning team via `notifyTeamOf`); call sites pinned in `lib/notify-routing-invariant.test.ts`. `lib/mission-notifications.ts` `notifyMissionPrReady` sends to the mission's team channel (`notifyTeamOf`, event `needsAttention`), deduped by head SHA via an atomic `UPDATE ... WHERE lastNotifiedSha IS DISTINCT` on `missions`. |
| Settings UI | `settings/notifications/page.tsx`, `settings/NotificationsSection.tsx`, `api/teams/[id]/notifications/route.ts` | Team channel + five toggles. |
| Task callback | `lib/task-callback.ts` `sendTaskCallback`, set from `tasks.context.callback` (`create_task` or `webhooks/ingest` config) | One https POST on task completion or failure, optional bearer token, 5s timeout, no retry. Chat refuses these fields (`CREATE_TASK_REFUSED_FIELDS` in `lib/chat/tools.ts`). |
| PR review callback | `lib/pr-review-request.ts` `deliverPrReviewCallback`, `api/github/pr/review/route.ts` | https only; `on: 'verdict' \| 'merge'`; claimed once so the verdict handler and the close webhook cannot both fire. |
| Long-poll | `lib/pr-review-request.ts` `waitForPrReviewStatus` | Poll-or-wait in one call shape, clamped to 45s, `timedOut: true` means call again. |
| Next-call inbox | `api/mcp/route.ts` (`send_agent_message`), `api/workers/[id]/route.ts` | Worker-to-worker messages queue in `tasks.context.pendingWorkerMessages`, are returned on the recipient's next `update_progress`, and are acked by id. Capped. |
| Watchers | `watchedProjects`, `watcherEvents`, `manage_watched_projects` | Per-repo release/prod-health watcher that files ops tasks. `watcher_events` is an insert-only dedupe ledger: the unique index failing is the read. |
| Chat events | `lib/chat/store.ts` `insertMessage`, `pingConversation` | `role: 'event'` rows with object refs, plus a text-free Pusher ping on `channels.conversation(id)`. |
| Realtime | `lib/pusher.ts` | Public channels per workspace, task, worker, mission, conversation. Pings only, thin payloads. No auth endpoint, so no Pusher presence channels. |
| Chat approvals | `lib/chat/registry.ts` | `read` / `write` / `admin` / `self` / `deferred`; `alwaysAsk` (via `startsWork`) on ops that start recurring or unattended work (`create_schedule`, `update_schedule`, `manage_missions.arm`). `SELF_SCOPED_ALLOWLIST` is empty. |
| Decision calls | `packages/core/decision-client.ts` `decisionCall`, `docs/design/decision-calls.md` | Jev Choice calls, shadow-first; the only shipped site is the `classifyTask` shadow. Nothing acts on a decision yet. |
| Credentials | `secrets`, `docs/credentials-architecture.md` | One table, team/account/workspace scope; `userId` marks a personal row, today `inference_key` only. No per-integration tables. |
| Redis | `lib/redis.ts` | Upstash client, available for short-TTL state. |

Nothing ships email. Slack as an outbound tool is the `connectors-and-orgs.md` design, not a notifier.

## Proposal

Add one primitive: a **subscription** (who wants to hear about what) and one **delivery ledger** (each thing actually sent). Existing emit points call one function, `publishEvent`, which matches subscriptions and writes ledger rows. A router drains each row to the right place: the live conversation, the waiting agent, or the person's chosen channel.

### The crux

**The ledger row is the only thing that sends, and it is unique on `(subscriptionId, dedupeKey)`.**

Every channel (chat event, MCP inbox, Pushover, webhook out) reads from the same row. That gives exactly-once per event per subscription across concurrent emitters (the GitHub webhook and the reconcile cron both see the same merge), makes the MCP inbox free (it is a query over undelivered rows), and gives one place to rate-limit a runaway agent. If this is wrong, and each channel keeps its own dedupe, the failure is the one `pr-review-request.ts` already had to fix: the same verdict delivered twice from two code paths, now multiplied by every channel.

The same pattern is already proven twice in this repo: `watcher_events` (insert fails = already fired) and `missions.lastNotifiedSha` (atomic claim).

### Subscription model

- **Subject.** An object ref, the same shape as `BuilddObjectRef` in `packages/shared/src/chat.ts`: `task`, `mission`, `pr` (workspace + number), `release`, `schedule`, `workspace`, or `webhook_source`. Reach is checked at create time with the existing reach rules and again at delivery; an event on an object the owner can no longer reach is dropped and logged.
- **Event types.** A closed set, each mapped to an existing emit site:

  | Event | Emitted from |
  |---|---|
  | `task.completed`, `task.failed` | `api/workers/[id]/route.ts` (beside `sendTaskCallback` and `notifyTeam`) |
  | `task.needs_input` | same route, where `postQuestionEvent` fires |
  | `pr.merged`, `pr.ci_failed`, `pr.review_verdict` | `api/github/webhook/route.ts` (`pull_request`, `check_suite`, `workflow_run`), review verdict path |
  | `mission.blocked`, `mission.completed` | mission completion decision and stall paths (`MISSION_COMPLETION_DECISION`, `MISSION_LOOP_STALLED`) |
  | `release.live`, `release.failed` | `RELEASE_UPDATED` emit sites, `watcherEvents` (`prod_unhealthy`) |
  | `schedule.fired` | `SCHEDULE_TRIGGERED` emit site |
  | `webhook.received` | new inbound source (P4) |
  | `agent.notify` | a worker or chat agent calling `notify_user` |

- **Filter.** Optional, a small declarative predicate over the event's fields (`{ path, op: 'eq' \| 'in' \| 'contains' \| 'exists', value }`, AND only). No code, no regex. Example: `pr.ci_failed` where `checkName contains "e2e"`.
- **Owner.** Exactly one of: a person (`userId`), or an agent (`taskId` of the waiting worker, or an MCP session's `accountId`). A person owns chat and settings subscriptions. An agent's subscription dies with its task unless it names `fallbackToUserId` (the task's human creator), which it may only set to that person.
- **Lifetime.** `one_shot` (default, deleted after the first delivery) or `standing`. Every subscription has `expiresAt`: one-shot defaults to 7 days, standing to 30 days, hard max 90. A terminal subject (merged PR, completed task) ends a one-shot watch that can no longer fire and tells the owner once.
- **Dedupe.** `dedupeKey` is computed by the emitter from the event itself (`pr:42:merged`, `task:<id>:failed:<attempt>`, `ci:<headSha>:<suite>`). Two emitters for the same fact produce the same key.
- **Coalescing.** A standing subscription carries `coalesceSeconds` (default 300). Rows inside the window for the same subscription are folded into one delivery ("3 CI failures on PR 42") before any external channel is used. The chat and inbox surfaces still show each row.

### Presence

Buildd needs to know whether the person will see a chat message without a push.

- **Signal.** The chat page sends a presence beat (`POST /api/chat/presence`, body: `conversationId`, `visible`) on focus, on `visibilitychange`, and every 30s while visible. The server writes a Redis key `presence:<userId>` with `{ conversationId, at }` and a 75s TTL. The existing `visibilitychange` handlers (`HomeAutoRefresh.tsx`, `MissionAutoRefresh.tsx`) show the pattern.
- **States.** `in_conversation` (a visible beat for the subscription's conversation), `in_app` (a visible beat for any other page), `away` (no live key).
- **"Not in front"** means `away`, or `in_app` for longer than the grace window without opening the event. A hidden tab counts as away.
- **Agents.** A worker is "present" while its task has a live lease or heartbeat. An MCP session is present if it called any buildd tool in the last 10 minutes.
- **Failure mode.** No Redis, or a missing key, reads as `away`. That fails toward delivering, so the cost of a presence bug is a duplicate ping, never a missed one.

### Delivery routing

For each ledger row the router picks the first route that applies:

1. **Agent owner, present.** Queue on the next-call inbox (below). Done.
2. **Agent owner, gone.** If `fallbackToUserId` is set, re-route as a person delivery. Otherwise mark `dropped: owner_gone`.
3. **Person, always.** Write a `role: 'event'` message into the subscription's conversation (if it has one) and ping it. This is the record, whatever else happens.
4. **Person, `in_conversation`.** Stop. They see it live.
5. **Person, `in_app`.** Ping a new `user-<id>` channel (ping only, same rule as the conversation channel) so the app shows a toast. Wait the grace window (120s normal, 0 urgent). If the row is still unread, continue.
6. **Person, `away`.** Check quiet hours and urgency. Send to the person's channels in their order. On failure, try the next. If none succeed, the row stays in the in-app inbox as `undelivered` and shows on next visit.

Webhook-out subscriptions skip presence: they are machine targets.

### Notification connectors

One interface, several senders:

```ts
interface NotificationConnector {
  kind: 'pushover' | 'webhook' | 'email' | 'slack_dm' | 'web_push';
  send(target: ResolvedTarget, n: RenderedNotification): Promise<'sent' | 'failed' | 'rejected'>;
}
```

- **Pushover and webhook** are extracted from `sendPushover` / `sendWebhook` in `lib/notify.ts`, so `notifyTeam` and the new router share them. `notifyTeam` behaviour does not change.
- **Credentials live in `secrets`.** No new credential table. Team channels keep today's team-wide rows. A **personal** channel is a `secrets` row with `userId` set, reusing the personal-row rule the inference keys already use (served only to its owner, excluded from team lists). Each personal channel gets its own purpose rather than reusing the team's: `pushover_personal` (shipped in P1), and later `notify_webhook_personal`. A separate purpose keeps every team read of `pushover` unambiguous and means a personal alert cannot resolve to the team row by construction. See decision 1.
- **Email** needs a platform sender (none exists). It carries no per-team secret; the address is the account email. P4.
- **Slack DM** rides the personal Slack identity from `connectors-and-orgs.md` when that ships. It is a use of a connector, not a new credential.
- **Web push** stores the browser subscription as a personal `secrets` row (`purpose: 'web_push'`), one per device.
- **Webhook out** is https only with a private-address (SSRF) guard, which today's callbacks lack since they check only the scheme, and signs the body with HMAC using a `webhook_token` secret so the receiver can verify it. This is what `callbackUrl` should have been; the two existing callbacks keep working unchanged.
- **Per-person preference.** Extend `notification_preferences` with a nullable `userId` (team row stays `userId IS NULL`; unique on `(teamId, userId)`), plus `channelOrder text[]`, `quietHours jsonb` (`{ start: '22:00', end: '07:00' }`, evaluated in `users.timezone`, then `teams.timezone`, then UTC), and `urgentBypassesQuiet boolean default false`. No row means today's behaviour.
- **Team vs personal.** A person subscription only ever uses that person's channels. It never falls back to the team Pushover, because a team key usually reaches a group and "tell me" must not page everyone.

### Where Jev decides

Jev answers one Choice question per row that would leave buildd (step 6 only, never chat or inbox): `drop | inbox_only | push | push_urgent`, given the event, the subscription's stated intent, and recent deliveries to this person.

- **Where it applies.** Standing subscriptions with broad subjects (a workspace, a mission) and `agent.notify` calls. A one-shot watch the person explicitly asked for is never gated: they asked, they get it.
- **Bound.** Jev can lower urgency or hold to inbox. It can never raise urgency above the subscription's `maxUrgency`, never drop a `task.needs_input` on the person's own task, and never pick a channel.
- **Shadow first**, exactly as `decision-calls.md` requires. A `notify_relevance_shadow` capability in `packages/core/inference-policy.ts`, off by default. The rule path decides; Jev runs after the send with `after()`, and `[decision-shadow]` logs record both answers plus whether the person opened the notification. The gated apply is a separate capability and PR, only after an offline benchmark on labelled rows ("did they open it, did they mute it"). Below the confidence threshold, or on timeout, the rule answer stands.
- **Cost.** One call is a few hundred input tokens; capped per team per day. Over the cap, the rule path runs alone.

### Chat tool surface

Three chat-native tools, registered in `CHAT_NATIVE_TOOL_SPECS` with a new `notifications` group:

| Tool | Class | Card |
|---|---|---|
| `list_watches` | read | none |
| `watch` (one-shot, owner is the caller, delivers to this conversation and the caller's channels) | write | the normal card, which the person's "Allow" may skip |
| `watch` with `lifetime: 'standing'`, or any `webhook_out` target | write, `alwaysAsk` | always, like `create_schedule` |
| `unwatch` (caller's own subscription) | self | first entry in `SELF_SCOPED_ALLOWLIST` |

- The card states what, until when, and where it will go ("PR 42 merged, until Oct 4, here and your Pushover").
- A standing watch is unattended work in the same sense as a schedule: it keeps acting after the person leaves. So it takes the `alwaysAsk` path through `startsWork`, and `startsUnattendedWork` in `lib/chat/tools.ts` learns the `lifetime` input.
- Chat can never set a subscription owned by someone else, and never a webhook target without a card.
- `notify_user` is not a chat tool. The chat agent answers in the conversation; it does not page.

MCP gets the same three as `buildd` actions (`watch`, `unwatch`, `list_watches`), plus:

- `notify_user` (worker level): send one `agent.notify` to the task's human creator. Capped (below).
- `inbox` (worker level): read and ack pending rows for the caller.

### MCP sessions

A Claude Code or claude.ai session cannot receive a webhook, and the MCP route is stateless HTTP on serverless, so server-initiated MCP notifications are not an option. Three layers, cheapest first:

1. **Next-call inbox.** Every `buildd` tool response for an owner with pending rows gets a short `notifications` block appended (at most 3, newest first, with a count of the rest). Delivered rows are marked on the same call. This is the `pendingWorkerMessages` pattern, but reading the ledger instead of `tasks.context`, so it is not capped by a JSON blob.
2. **Explicit poll.** `inbox` with `waitSeconds` long-polls exactly like `waitForPrReviewStatus`: clamped to 45s, `timedOut: true` means call again.
3. **Fallback to the person.** If the session goes quiet for 10 minutes, rows it owns with `fallbackToUserId` route to the person's channels. A session that asked "tell me when CI is green" and was then closed still reaches its human.

Workers use layer 1 on `update_progress`, which already returns `pendingMessages[]`.

### Limits

Every automatic path states its bound.

- **Per person, external channels:** 12 per rolling hour, 3 of them at high priority (an urgent row past the third goes out at normal priority). Over the cap, rows stay `pending` (the inbox shows them) and are retried every 20 minutes, so they go out once the hour has room; one summary push per clock hour says "N more held". The count is read from the ledger (distinct `delivered_at` among `route = 'pushover'` rows), so it needs no Redis; the held notice does, and is skipped without it.
- **Per subscription:** after 20 deliveries in an hour a standing subscription auto-pauses and tells its owner once. Coalescing runs first, so only distinct events count.
- **Per agent:** `notify_user` is 3 per task, urgency `normal` only unless the task's role sets a new `canNotifyUrgent` flag. Beyond that the call returns an error the agent can see, not a silent drop.
- **Creation:** 25 active subscriptions per person, 5 per task, 100 per team standing. Filters are capped at 8 clauses.
- **Webhook out:** 5s timeout, 3 retries with backoff, then `failed`. Consecutive failures past 20 disable that target and notify the owner.
- **Cost:** Jev calls capped per team per day; the rule path needs no model.
- **Abuse:** a person can mute any subscription or a whole sender (a task, a role) from the notification itself; the mute link is signed and needs no login.

## Implementation sketch

Load-bearing piece first: the ledger and `publishEvent`.

### Data model (sketch, no migration written)

```text
subscriptions
  id               uuid pk
  team_id          uuid not null -> teams
  workspace_id     uuid null -> workspaces
  owner_user_id    uuid null -> users
  owner_task_id    uuid null -> tasks        -- agent owner (worker)
  owner_account_id uuid null -> accounts     -- agent owner (MCP session)
  fallback_user_id uuid null -> users        -- only the task/session's human
  conversation_id  uuid null -> conversations
  subject_kind     text not null
  subject_ref      jsonb not null            -- object ref
  event_types      text[] not null
  filter           jsonb null
  lifetime         text not null default 'one_shot'   -- 'one_shot' | 'standing'
  max_urgency      text not null default 'normal'     -- 'low' | 'normal' | 'urgent'
  coalesce_seconds integer not null default 300
  targets          jsonb not null default '[]'        -- extra targets, e.g. webhook_out secret id
  created_via      text not null                      -- 'chat' | 'mcp' | 'worker' | 'settings'
  paused_at, expires_at not null, created_at, updated_at
  check: exactly one owner column set
  index (subject_kind, (subject_ref->>'id')) where paused_at is null

notification_deliveries          -- the ledger, also the inbox
  id               uuid pk
  subscription_id  uuid not null -> subscriptions on delete cascade
  dedupe_key       text not null
  event_type       text not null
  payload          jsonb not null            -- refs and short text only
  urgency          text not null
  route            text null                 -- 'conversation' | 'inbox' | 'pushover' | ...
  status           text not null default 'pending'
                   -- 'pending' | 'delivered' | 'read' | 'coalesced' | 'held' | 'dropped' | 'failed'
  decision         jsonb null                -- rule answer, Jev shadow answer, reason
  attempts         integer not null default 0
  created_at, delivered_at, read_at
  unique (subscription_id, dedupe_key)
  index (owner lookups via subscription) where status = 'pending'
```

Reused, extended:

- `notification_preferences`: nullable `user_id`, unique on `(team_id, user_id)`, `channel_order`, `quiet_hours`, `urgent_bypasses_quiet`.
- `secrets`: new personal purposes `pushover_personal` (P1) and `notify_webhook_personal`, plus `web_push`, all in `PERSONAL_SECRET_PURPOSES`. The team `pushover` and `notify_webhook` purposes stay team-only. No new table.
- `workspace_skills`: `can_notify_urgent boolean default false` (role flag).
- Presence lives in Redis, not Postgres.

Defaults are no-ops: no subscription rows means `publishEvent` matches nothing and every current path behaves as today.

### Phased plan

**P1: watch a task or PR from chat.**
- `subscriptions` + `notification_deliveries`, `publishEvent` wired at the task-completion/failure/needs-input and PR merged/CI-failed emit sites.
- Chat `watch` (one-shot only), `unwatch`, `list_watches`; delivery always as a conversation event.
- Presence beat plus personal Pushover (a `pushover_personal` secret, one field in Settings → Notifications) when away. No Jev, no standing watches, no quiet hours.

**P2: agents and MCP.** `watch` / `inbox` / `notify_user` MCP actions, next-call inbox, 45s long-poll, owner-gone fallback, per-agent caps.

**P3: standing watches and preferences.** `lifetime: 'standing'` behind `alwaysAsk`, coalescing, quiet hours, channel order, the `user-<id>` toast channel, auto-pause, signed mute links. Jev shadow (`notify_relevance_shadow`) starts here, logging only.

**P4: more connectors and sources.** Webhook out (signed), web push, email (platform sender), Slack DM once personal Slack identity ships, inbound `webhook_source` with filters. Jev gated apply only after the benchmark, as its own PR. Then decide whether `sendTaskCallback` and `deliverPrReviewCallback` become thin wrappers over webhook-out subscriptions.

## Non-goals

- Replacing `notifyTeam` or its five team toggles. They stay the team broadcast; they share senders, not semantics.
- Changing the existing `callbackUrl` contracts on `create_task` and `request_pr_review`.
- Platform/ops alerts through `lib/pushover.ts` `notifyOperator`.
- A general event bus or event store. `publishEvent` is a synchronous match at existing emit sites, not a queue product.
- Slack or Discord as a chat front end (`chat-integrations.md`, `agent-chat.md` P3).
- Letting an agent watch on a person's behalf without that person's card.

## Decisions

Status: accepted. These were the six open questions; the owner accepted each recommendation as written in review of this PR.

1. **Personal channel secrets.** `secrets.userId` extends beyond `inference_key` to new personal purposes: `pushover_personal` now, `notify_webhook_personal` when that channel ships. (Amended during P1: the review accepted `userId` on the existing `pushover` purpose, but a separate purpose is safer. Team reads of `pushover` cannot pick up a person's row, and the away path's key query names only the personal purpose.) A person's own key is where their away-alerts go. A person subscription never falls back to the team key, because a team key usually pages a group. Over the per-person cap, rows are held in the inbox and retried, with one "N more held" push per hour (see Limits).
2. **Presence store.** Redis with a short TTL (75s, refreshed every 30s by a visible tab). A missing key, or no Redis, reads as away. Postgres would pay a Neon wake for a 75s fact (`docs/design/cron-wake-windows.md`).
3. **Approval for watches.** A one-shot watch skips the card when the person's "Allow" covers it: it notifies only the caller and ends by itself. Standing watches and any webhook target always ask (`alwaysAsk`).
4. **Workers reaching a person.** A worker may notify only its task's own human, at normal urgency, at most 3 times per task. Urgent needs the role flag `canNotifyUrgent`.
5. **Jev's scope.** Jev gates only standing watches and agent pings (`agent.notify`), never one-shot watches. Shadow first; the gated apply is a separate PR after the offline benchmark.
6. **Email sender.** A platform-owned sender in P4, digest-style, with no per-team secret.

## Open questions

None open. All six were decided above.
