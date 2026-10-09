---
title: Local Agent Presence
status: active
owner: max
last_verified: 2026-10-09
summary: A local coding session with the buildd plugin MUST show as seat-free presence, bind only to the worker its own verified claim_task minted, and release it exactly once on exit without completing work.
domain: runners
surfaces: [apps/web/src/lib/local-session.ts, apps/web/src/app/api/workers/local-sessions/route.ts, packages/shared/src/local-session.ts, apps/runner/plugin/scripts/buildd-hook.mjs]
related: [runner-liveness, mission-task-lifecycle]
keywords: [receive_messages, turn boundary nudge, local_sessions, presence_tokens, presence token, bldp_, interactive session, presence, buildd plugin, agent plugin, hooks, SessionStart, SessionEnd, claude code, codex, cursor, buildd install, release slot]
verified_by: [packages/core/__tests__/mcp-tools-receive-messages.test.ts, apps/web/src/lib/local-session.test.ts, packages/core/__tests__/model-prices.test.ts, apps/web/src/lib/presence-token.test.ts, apps/web/src/lib/presence-token-routes.test.ts, apps/web/src/lib/local-session-view.test.ts, apps/runner/__tests__/unit/agent-plugin.test.ts, apps/web/src/app/app/(protected)/tasks/InteractiveSessions.test.tsx, apps/web/src/app/api/workers/[id]/instruct/route.test.ts, apps/web/src/app/api/workers/local-sessions/workspaces/route.test.ts]
assertions:
  - id: "presence-token-auth"
    type: "symbol"
    name: "authenticatePresenceToken"
    path: "apps/web/src/lib/presence-token.ts"
  - id: "presence-token-table"
    type: "migration"
    number: "0261"
    contains: "presence_tokens"
  - id: "presence-token-route-guard"
    type: "test_file"
    path: "apps/web/src/lib/presence-token-routes.test.ts"
  - id: "session-event-handler"
    type: "symbol"
    name: "handleLocalSessionEvent"
    path: "apps/web/src/lib/local-session.ts"
  - id: "strict-event-contract"
    type: "symbol"
    name: "parseLocalSessionEvent"
    path: "packages/shared/src/local-session.ts"
  - id: "local-sessions-route"
    type: "route"
    method: "POST"
    path: "/api/workers/local-sessions"
    file: "apps/web/src/app/api/workers/local-sessions/route.ts"
  - id: "route-uses-strict-contract"
    type: "symbol_reachable"
    symbol: "parseLocalSessionEvent"
    entry: "apps/web/src/app/api/workers/local-sessions/route.ts"
  - id: "local-sessions-migration"
    type: "migration"
    number: "0253"
    contains: "local_sessions"
  - id: "presence-tests"
    type: "test_file"
    path: "apps/web/src/lib/local-session.test.ts"
  - id: "plugin-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/agent-plugin.test.ts"
---

# Local Agent Presence

The buildd agent plugin (`apps/runner/plugin/`) makes a person's interactive
coding session (Claude Code first, Codex and Cursor where their hooks allow) a
first-class buildd presence. MCP stays the control plane: claiming, progress,
notes, PRs and completion all go through the buildd MCP tool. The plugin's
lifecycle hooks only report that the session exists.

## Session events

**Capability statement**: A hook MUST be able to report a session's lifecycle
to buildd with four typed events and nothing else, and MUST never break the
agent loop it runs in.

**Invariants**:
- The wire format is `{ event: start|touch|bind|end, client: claude|codex|cursor|other, clientSessionId, clientVersion?, repo?, interactive?, workerId? (bind only), reason?: exit|clear|other (end only), usage? (touch and end only), busy? (touch only), continuesSessionId? (start only) }`. The endpoint refuses any other field, at every level of `usage` too, so no prompt, response, reasoning, transcript or secret can ride along.
- The client session id is stored only as a SHA-256 hash. `repo` is reduced to `owner/name` (credentials and host dropped) on the client and again on the server.
- Auth is the person's presence token (`bldp_`, `~/.buildd/config.json` `presenceToken`, written by `buildd login`; `BUILDD_PRESENCE_TOKEN` overrides), else the account API key. No credential is written into any hook configuration. Trigger-level keys are refused.
- A presence token is minted only by a login (device flow or browser), for the person who signed in, one per machine (a new login on the same machine revokes the previous one). It is HMAC-signed and never stored; its `presence_tokens` row (user, machine label, created, last used, revoked) is what makes it revocable: `buildd logout` revokes it, and the signed-in person can list and revoke theirs (`/api/auth/presence-token`). A token whose person is in no team any more is refused.
- A presence token reaches exactly three things: presence events (`POST /api/workers/local-sessions`), the scope list (`GET /api/workers/local-sessions/workspaces`, `{ id, repo, teamId }` of every workspace with a repo the person reaches across all their teams, nothing else; presence token only, an API key or task token answers 401), and revoking itself. `authenticateApiKey` refuses it before any lookup, so every other route answers 401; `presence-token-routes.test.ts` pins the files that verify one.
- A presence is owned by exactly one of an account (API key) or a person (presence token), enforced by a check constraint.
- Every event is idempotent: a replayed `start`/`touch` refreshes, a replayed `bind` answers `already_bound`, a replayed `end` answers `already_ended`.
- The hook script exits 0 on every path (no key, buildd down, non-2xx, timeout, bad payload, unknown client) within its 3 s request timeout, and prints nothing except an optional one-line nudge.
- Writes are coalesced to one a minute per session: on the client (state file per session; a `Stop` touch is exempt, it is the turn's last chance to learn a message waits) and on the server (`last_seen_at < now - 60s` guard).

**Acceptance criteria**:
- AC-1: WHEN a body carries a field outside the contract (e.g. `prompt`) THEN the endpoint answers 400 and writes nothing.
- AC-2: GIVEN buildd is unreachable WHEN the hook runs THEN it exits 0 with empty stdout.
- AC-3: GIVEN a touch less than a minute after the last write WHEN it arrives THEN nothing is written (`coalesced`).

**Code surface**: `POST /api/workers/local-sessions` (`apps/web/src/app/api/workers/local-sessions/route.ts`), `parseLocalSessionEvent` (`packages/shared/src/local-session.ts`), `handleLocalSessionEvent` (`apps/web/src/lib/local-session.ts`), `apps/runner/plugin/scripts/buildd-hook.mjs`.

## Presence is not a worker

**Capability statement**: A session's presence MUST cost no capacity, and MUST
become tracked work only through that session's own verified `claim_task`.

**Invariants**:
- The hook sends nothing for a session outside the account's workspace repos: only a session in a workspace repo (cached per key, refreshed at most every 10 minutes on an unknown repo, fail closed), in a repo whose `.mcp.json` names buildd, or one that has claimed a task (`bind`) is reported.
- A `start` carries `interactive`: false for a session nobody is attending (Claude Code `claude -p` and SDK runs, read from `CLAUDE_CODE_SESSION_ATTENDED` then `CLAUDE_CODE_ENTRYPOINT`; Cursor background agents). Claude Code's `bind` and `touch` carry the same flag, because a session outside a workspace repo sends no `start` and its presence is first created by the bind (or a touch healing a missed start). Such a presence is neither listed nor counted as an interactive session until it binds a worker for a task.
- `start`/`touch` write only `local_sessions`. They never insert a `workers` row, change `accounts.activeSessions`, or write a task. Presence is never counted as agent capacity; where it is counted it is labelled "Interactive sessions".
- `bind` attaches a presence to an existing worker only when that worker belongs to the calling account (API key), or, for a presence token, was claimed by an account of a team the person is in and, when the claim recorded who made it (`interactiveClaimUserId`, an OAuth session), by that person; it must have `runner = 'mcp'` (written by the claim route only after the HMAC session marker verifies; `mcp-unverified` and runner workers are refused), and is live. Another account's worker and an unknown id get the same 404.
- A presence may hold several workers: Claude Code subagents share the parent's `session_id` and their tool calls fire the parent's hooks, so each subagent's `claim_task` binds to the same presence (`local_session_workers`, one row per worker). One worker is bound to at most one presence, ever (primary key on `local_session_workers.worker_id`). A presence bound before multi-claim keeps its single worker through the legacy `local_sessions.bound_worker_id` column, which is read (never written) and also guards that worker against other sessions.
- The hook keeps, on the person's machine only, which subagent made which claim (`agent_id` from the subagent's PostToolUse payload); it is never sent.
- A hook `touch` refreshes `workers.updated_at` only for the presence's own held workers, each under the same once-a-minute guard as the MCP touch. Another session's hooks never touch them.
- A `touch` may carry `busy`: `true` from `UserPromptSubmit` and `PreToolUse` (a turn or a tool is starting), `false` from `Stop`. The server writes `local_sessions.busy_since` only when the mark changes, never throttled, with `last_seen_at`; a `start` clears it. A long command fires no hook until it returns, so this is what tells the interactive reaper the client is still working (see [runner-liveness](runner-liveness.md)). Client side, a flip is sent at once and an unchanged mark is throttled like any touch; `PreToolUse` is async on Claude Code, reads no tool input and no transcript, and a racing write never drops a recorded claim (claims are merged with the state file at write time).
- The hook binds deterministically: its post-tool hook reads the worker id from buildd's own `claim_task` reply. It reads no other tool output.

**Acceptance criteria**:
- AC-4: WHEN `start` is posted THEN one presence row exists and no worker or seat was created.
- AC-5: GIVEN a verified interactive claim WHEN its session posts `bind` THEN that presence holds that worker; a second session's `bind` of the same worker answers 409 `bound_elsewhere`.
- AC-5b: GIVEN two verified claims from one session (e.g. two subagents) WHEN both bind THEN the presence holds both.
- AC-6: WHEN `bind` names a runner worker or an `mcp-unverified` one THEN 409 `not_interactive`.

**Code surface**: `local_sessions` and `local_session_workers` tables (`packages/core/db/schema.ts`), `bindInsertSql`, `boundWorkerTouchWhere`, `presenceTouchWhere` (`apps/web/src/lib/local-session.ts`).

## Session end

**Capability statement**: Ending a session MUST release its tracked work safely
and exactly once, and MUST never complete unfinished work or rewrite a finished task.

**Invariants**:
- `end` is a compare-and-swap on `ended_at IS NULL`; only the first end acts.
- With reason `exit` or `other`, each held live worker is detached through `detachInteractiveWorker` (the "Release slot" primitive): a terminal task keeps its status and PR and its worker is recorded completed; an open task goes back to `pending` and its worker is recorded failed with the released-slot error. The seat, path claims and capacity wake are released once.
- Reason `clear` ends the presence but keeps every claim: the conversation's process and the MCP connection that made the claims keep running. The hook leaves a note (old session id only, per folder and client, on the machine) and the `start` of the session that continues (`SessionStart` with `source: clear`, within a minute) carries `continuesSessionId`. The server moves every worker the named presence holds to the new one, only for a presence of the same owner and client that is open or ended by `clear`, and the hook moves its local claims and usage totals with them, so the cleared conversation's touches keep its claims alive.
- A `start` for an ended session (resume) re-opens it. A `touch` re-opens it only when it lands more than a minute after the end (a resume whose start was missed); one sooner is a hook that was in flight when the session closed, and changes nothing.
- Without any end event (crash), the bound worker falls to the interactive reaper (2 h, or up to the 8 h backstop when the presence was mid-turn) and presence reads offline after 10 minutes. A reaped claim's open task goes back to `pending` at once, so the same client can claim it again.

**Acceptance criteria**:
- AC-7: GIVEN a bound worker on an `in_progress` task WHEN `end` (exit) arrives THEN the task is `pending`, not `completed`.
- AC-8: GIVEN a bound worker whose task is `completed` WHEN `end` arrives three times THEN the task stays `completed` and the seat is released once.
- AC-8b: GIVEN a presence holding two live workers WHEN `end` (exit) arrives THEN both tasks go back to `pending` and each seat is released exactly once; a replayed `end` changes nothing.
- AC-8c: GIVEN a presence holding a live worker WHEN it ends with `clear` and the continuing session's `start` names it THEN the new presence holds the worker, nothing is released, and the new session's touches keep it alive; a `start` naming a session that exited, or another account's, moves nothing.

**Code surface**: `handleLocalSessionEvent` `end` branch, `detachInteractiveWorker` (`apps/web/src/lib/interactive-detach.ts`).

## Session usage

**Capability statement**: Work done from a person's own session (and its
subagents) MUST be counted in the task's usage and cost the same way runner work
is, from numbers the client already wrote locally, and MUST never move content.

**Invariants**:
- Claude Code only, once the session holds a claim. On `Stop` and `SessionEnd` the hook reads the lines appended since its last report (byte offsets in the per-session hook state, at most 8 MB per file per run) of the session's transcript and of each `<session>/subagents/agent-<id>.jsonl`. From each API response record it keeps only the message id, model id, the four token counts (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` with its 5m/1h split), the timestamp and each `tool_use` block's id and tool name (`Bash`, `mcp__buildd__buildd`; a name outside `[A-Za-z0-9_.:-]{1,128}` counts as `other`). Message text, tool inputs and outputs are never kept or sent. `BUILDD_HOOK_USAGE=0` turns it off.
- A message written once per content block is counted once (deduped by message id); a tool call is counted once by its `tool_use` id, however many records repeat it.
- Attribution: a subagent that claimed a task is that task's for its whole run (the hook knows which subagent claimed what from its PostToolUse `agent_id`). Everything else, the session's own calls and subagents that claimed nothing, goes to the session's newest own claim, else its first claim, and only from the session's first claim on.
- `usage` carries cumulative totals per worker (per model: the four buckets and a request count; plus tool calls, per-tool counts `toolCounts`, subagents, first/last timestamp). `toolCounts` is written as the worker's `resultMeta.toolCounts`, the same tool histogram a runner worker fills and usage stats read, so a session's tool calls count there; an older hook that sends none writes none on the session's own `touch`/`end`, so `end` lands its last report before the release, in one request.
- `usage.costBasis` (`real`, `virtual` or `unknown`) says how the session's usage was charged, classified by the hook from its own environment and client config (`costBasisFor`); absent from an older hook, which the server records as `unknown`. See `real-and-virtual-cost.md`.
- The server writes only to a worker this presence holds, that is interactive and live or ended within 10 minutes (the report after `complete_task`). It raises, never lowers: `inputTokens` (all-in), `outputTokens`, `turns` (requests), `costUsd`, and `resultMeta.modelUsage`/`totalUsage`/`localSessionUsage`, so replays and reordering are harmless.
- Pricing is server-side and strict (`priceSessionUsage`): the live catalog, else the static table for a recognisably Anthropic model id; a 5-minute cache write at the table's write rate, a 1-hour write at 2x input. A model with no known price makes the cost unknown: no cost and no `modelUsage` are written, `localSessionUsage.costUnknown` is true and the model is listed in `unpricedModels`. It is never priced as some other model.

**Acceptance criteria**:
- AC-9: GIVEN a held worker WHEN a `touch` carries its usage THEN its tokens, turns and cost are raised to those totals, and an older, smaller report changes nothing.
- AC-10: WHEN `usage` names a worker this presence does not hold THEN nothing is written.
- AC-11: GIVEN a model with no known price WHEN usage is recorded THEN no cost is written and it is flagged unknown.

**Code surface**: `usageRecord`, `collectUsage`, `costBasisFor` (`apps/runner/plugin/scripts/buildd-hook.mjs`), `usageWrite`, `usageWriteWhere` (`apps/web/src/lib/local-session.ts`), `priceSessionUsage` (`packages/core/model-prices.ts`).

## Reporting and steering

**Invariants**:
- Session → buildd uses existing primitives only: `update_progress`, `post_note`, `create_pr`, `complete_task` over MCP. Hooks never post task progress, notes or summaries, and a presence-only session never produces task progress.
- Buildd → session reuses the instruction queue. `send_agent_message`/instruct queues into `workers.pending_instructions` for an interactive worker even for `priority: urgent` (no runner listens on Pusher for it). On an interactive worker the agent is the queue's only consumer: the dedicated `receive_messages` action returns the text once and acknowledges it delivered and read by id in one PATCH; `update_progress` still does the same for older prompts, but nothing depends on it. The hook's `touch` answer carries only a `pendingInstructions` flag. On Claude Code and Codex the hook turns that flag into a nudge naming `receive_messages` at every turn boundary the client exposes: `UserPromptSubmit` and `PostToolUse` add one line of context, and `Stop` blocks once (`decision: 'block'`, never while `stop_hook_active`, so it cannot loop). `Stop` touches are never throttled; `PostToolUse` touches are (one a minute). The message text never travels through a hook.

**Acceptance criteria**:
- AC-9: GIVEN `pendingInstructions: true` WHEN a Claude Code or Codex `PostToolUse` hook runs THEN stdout is `additionalContext` naming `receive_messages`; WHEN `Stop` runs THEN `decision: 'block'` once, and nothing while `stop_hook_active`; GIVEN `false` THEN stdout is empty on every event; the message text appears in no hook output.
- AC-10: WHEN `receive_messages` is called with a message queued THEN it returns the text once and acknowledges it by id; a second call returns nothing.

## Surfaces

- A session's state is decided by its own client's events alone (`local_sessions.last_seen_at`: start, touch, bind, end). It is Working only when that client was heard from in the last 10 minutes and it holds a live worker; Online when heard from and holding none; Offline when not heard from; Ended once the client said so. A write to a held worker (`workers.updated_at`: reaper, webhooks, usage, another session's MCP calls) never makes a session online, never lists an old one again and never moves its clock. A quiet session that still holds live workers reads Offline with those seats shown as held, releasable from the task page.
- Home's runner board shows live session claims as their own lane, "Your sessions", after the runners: one row per live claim (task, elapsed, progress, steer), captioned "N working · M online". The lane exists only while a claim is live; it is never one of the runners, never counted in the runner count, "Agents live n/N" or capacity, and never reads offline or idle. A claim whose start was never stamped starts at its last activity.
- Activity shows an "Interactive sessions" section, collapsed so it never buries the task list: sessions working on a task are shown; online sessions with no task are rows when there are at most two, else one "N online with no task" disclosure; offline and ended sessions fold under "N earlier sessions"; a session lists at most three tasks (live first, newest first) then "+N more". Each row: client as a muted badge, state word (Working / Online / Offline / Ended), repo, time, and for live work the line "Runs on your machine. Buildd can release its slot, not close it." The section count is sessions online now. A task worked from a local session names its client (e.g. "Claude Code · local") where a runner name would appear.
- Release from the dashboard stays the task page's "Release slot" (owner/admin).

## Install

`buildd install --global` registers the MCP server for Claude Code per folder, only for folders Claude Code has opened whose repo is a workspace the person reaches in any of their teams (the presence token's scope list; the login key's list alone without one). A folder whose workspace the login key's team cannot reach always gets the OAuth entry, never the key, and re-running switches an existing such key entry to OAuth, including one shadowing the folder's own `.mcp.json` (a repo whose own `.mcp.json` names buildd is left alone; `--here` adds the current folder, `--everywhere` restores the user-wide entry; `--oauth`, opt-in, writes each folder's entry as the key-free per-workspace OAuth endpoint `/api/mcp-oauth/<workspaceId>` instead, and `--status --global` reports each entry as key or OAuth without the network),
and installs the hooks and the `buildd-session` skill for every detected client;
`buildd install` does the same for one repo; `--status` and `--uninstall` inspect
or remove them. A handler is buildd's if and only if its command names
`buildd-hook.mjs`; install and uninstall touch nothing else and are idempotent.
A file that does not parse is left untouched. The Claude Code plugin is also
installable from the repo's marketplace (`.claude-plugin/marketplace.json`).

## Compatibility and degradation

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Plugin install | marketplace plugin, or `buildd install` | hooks file via `buildd install`; Codex plugin bundling | hooks file via `buildd install` |
| MCP | plugin `mcpServers` or `~/.claude.json` | `codex mcp add` (printed by the installer) | Settings > MCP (printed by the installer) |
| Lifecycle hooks | SessionStart, UserPromptSubmit, Stop, PreToolUse, PostToolUse, SessionEnd | same names; each hook must be trusted in `/hooks` first | sessionStart, afterAgentResponse, stop, afterMCPExecution, sessionEnd |
| Stable session id | `session_id` | `session_id` | `conversation_id` |
| Session end | reliable on exit; `clear` keeps the claim | `SessionEnd` reason is always `other` (treated as exit) | only `window_close` / `user_close` end; `completed`/`aborted`/`error` are touches |
| Subagent identity | subagents share the parent `session_id`; they are the same presence | same | same conversation |
| Inbound steering | queued + nudge on `UserPromptSubmit`, `PostToolUse`, `Stop` | queued + nudge on `UserPromptSubmit`, `PostToolUse`, `Stop` | queued only (read on the next `receive_messages` / `update_progress`) |
| Without hooks | MCP-only: works as before; buildd sees the session once it claims, and MCP calls keep the claim alive | same | same |

`BUILDD_HOOKS_DISABLED=1` forces MCP-only mode on any client.
