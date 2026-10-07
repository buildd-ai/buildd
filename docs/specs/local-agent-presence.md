---
title: Local Agent Presence
status: active
owner: max
last_verified: 2026-10-07
summary: A local coding session with the buildd plugin MUST show as seat-free presence, bind only to the worker its own verified claim_task minted, and release it exactly once on exit without completing work.
domain: runners
surfaces: [apps/web/src/lib/local-session.ts, apps/web/src/app/api/workers/local-sessions/route.ts, packages/shared/src/local-session.ts, apps/runner/plugin/scripts/buildd-hook.mjs]
related: [runner-liveness, mission-task-lifecycle]
keywords: [local_sessions, presence_tokens, presence token, bldp_, interactive session, presence, buildd plugin, agent plugin, hooks, SessionStart, SessionEnd, claude code, codex, cursor, buildd install, release slot]
verified_by: [apps/web/src/lib/local-session.test.ts, apps/web/src/lib/presence-token.test.ts, apps/web/src/lib/presence-token-routes.test.ts, apps/web/src/lib/local-session-view.test.ts, apps/runner/__tests__/unit/agent-plugin.test.ts, apps/web/src/app/app/(protected)/tasks/InteractiveSessions.test.tsx, apps/web/src/app/api/workers/[id]/instruct/route.test.ts]
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
- The wire format is `{ event: start|touch|bind|end, client: claude|codex|cursor|other, clientSessionId, clientVersion?, repo?, interactive?, workerId? (bind only), reason?: exit|clear|other (end only) }`. The endpoint refuses any other field, so no prompt, response, reasoning, transcript or secret can ride along.
- The client session id is stored only as a SHA-256 hash. `repo` is reduced to `owner/name` (credentials and host dropped) on the client and again on the server.
- Auth is the person's presence token (`bldp_`, `~/.buildd/config.json` `presenceToken`, written by `buildd login`; `BUILDD_PRESENCE_TOKEN` overrides), else the account API key. No credential is written into any hook configuration. Trigger-level keys are refused.
- A presence token is minted only by a login (device flow or browser), for the person who signed in, one per machine (a new login on the same machine revokes the previous one). It is HMAC-signed and never stored; its `presence_tokens` row (user, machine label, created, last used, revoked) is what makes it revocable: `buildd logout` revokes it, and the signed-in person can list and revoke theirs (`/api/auth/presence-token`). A token whose person is in no team any more is refused.
- A presence token reaches exactly three things: presence events (`POST /api/workers/local-sessions`), the scope list (`GET /api/workers/local-sessions/workspaces`, repo slugs of every workspace the person reaches across all their teams), and revoking itself. `authenticateApiKey` refuses it before any lookup, so every other route answers 401; `presence-token-routes.test.ts` pins the files that verify one.
- A presence is owned by exactly one of an account (API key) or a person (presence token), enforced by a check constraint.
- Every event is idempotent: a replayed `start`/`touch` refreshes, a replayed `bind` answers `already_bound`, a replayed `end` answers `already_ended`.
- The hook script exits 0 on every path (no key, buildd down, non-2xx, timeout, bad payload, unknown client) within its 3 s request timeout, and prints nothing except an optional one-line nudge.
- Writes are coalesced to one a minute per session: on the client (state file per session) and on the server (`last_seen_at < now - 60s` guard).

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
- A `start` carries `interactive`: false for a session nobody is attending (Claude Code `claude -p` and SDK runs, read from `CLAUDE_CODE_SESSION_ATTENDED` then `CLAUDE_CODE_ENTRYPOINT`; Cursor background agents). Such a presence is neither listed nor counted as an interactive session until it binds a worker for a task.
- `start`/`touch` write only `local_sessions`. They never insert a `workers` row, change `accounts.activeSessions`, or write a task. Presence is never counted as agent capacity; where it is counted it is labelled "Interactive sessions".
- `bind` attaches a presence to an existing worker only when that worker belongs to the calling account (API key), or, for a presence token, was claimed by an account of a team the person is in and, when the claim recorded who made it (`interactiveClaimUserId`, an OAuth session), by that person; it must have `runner = 'mcp'` (written by the claim route only after the HMAC session marker verifies; `mcp-unverified` and runner workers are refused), and is live. Another account's worker and an unknown id get the same 404.
- One worker is bound to at most one presence, ever (`local_sessions_bound_worker_idx` unique). A presence holding a live worker cannot bind another until that one ends.
- A hook `touch` refreshes `workers.updated_at` only for the presence's own bound worker, under the same once-a-minute guard as the MCP touch. Another session's hooks never touch it.
- The hook binds deterministically: its post-tool hook reads the worker id from buildd's own `claim_task` reply. It reads no other tool output.

**Acceptance criteria**:
- AC-4: WHEN `start` is posted THEN one presence row exists and no worker or seat was created.
- AC-5: GIVEN a verified interactive claim WHEN its session posts `bind` THEN that presence references exactly that worker; a second session's `bind` of the same worker answers 409 `bound_elsewhere`.
- AC-6: WHEN `bind` names a runner worker or an `mcp-unverified` one THEN 409 `not_interactive`.

**Code surface**: `local_sessions` table (`packages/core/db/schema.ts`), `bindWhere`, `boundWorkerTouchWhere`, `presenceTouchWhere` (`apps/web/src/lib/local-session.ts`).

## Session end

**Capability statement**: Ending a session MUST release its tracked work safely
and exactly once, and MUST never complete unfinished work or rewrite a finished task.

**Invariants**:
- `end` is a compare-and-swap on `ended_at IS NULL`; only the first end acts.
- With a bound live worker and reason `exit` or `other`, the worker is detached through `detachInteractiveWorker` (the "Release slot" primitive): a terminal task keeps its status and PR and its worker is recorded completed; an open task goes back to `pending` and its worker is recorded failed with the released-slot error. The seat, path claims and capacity wake are released once.
- Reason `clear` ends the presence but keeps the claim: the conversation's process and the MCP connection that made the claim keep running.
- A `start` for an ended session (resume) re-opens it.
- Without any end event (crash), the bound worker falls to the existing 2 h interactive idle reaper and presence reads offline after 10 minutes.

**Acceptance criteria**:
- AC-7: GIVEN a bound worker on an `in_progress` task WHEN `end` (exit) arrives THEN the task is `pending`, not `completed`.
- AC-8: GIVEN a bound worker whose task is `completed` WHEN `end` arrives three times THEN the task stays `completed` and the seat is released once.

**Code surface**: `handleLocalSessionEvent` `end` branch, `detachInteractiveWorker` (`apps/web/src/lib/interactive-detach.ts`).

## Reporting and steering

**Invariants**:
- Session → buildd uses existing primitives only: `update_progress`, `post_note`, `create_pr`, `complete_task` over MCP. Hooks never post task progress, notes or summaries, and a presence-only session never produces task progress.
- Buildd → session reuses the instruction queue. `send_agent_message`/instruct queues into `workers.pending_instructions` for an interactive worker even for `priority: urgent` (no runner listens on Pusher for it). `update_progress` returns and acknowledges the text. The hook's `touch` answer carries only a `pendingInstructions` flag; on Claude Code's and Codex's `UserPromptSubmit` the hook adds one line telling the agent to call `update_progress`. The message text never travels through a hook.

## Surfaces

- Activity shows an "Interactive sessions" section: client as a muted badge, state word (Working / Online / Offline / Ended), repo, the bound task, and for live work the line "Runs on your machine. Buildd can release its slot, not close it." A task worked from a local session names its client (e.g. "Claude Code · local") where a runner name would appear.
- Release from the dashboard stays the task page's "Release slot" (owner/admin).

## Install

`buildd install --global` registers the MCP server for Claude Code per folder, only for folders Claude Code has opened whose repo is one of the account's workspaces (a repo whose own `.mcp.json` names buildd is left alone; `--here` adds the current folder, `--everywhere` restores the user-wide entry; `--oauth`, opt-in, writes each folder's entry as the key-free per-workspace OAuth endpoint `/api/mcp-oauth/<workspaceId>` instead, and `--status --global` reports each entry as key or OAuth without the network),
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
| Lifecycle hooks | SessionStart, UserPromptSubmit, Stop, PostToolUse, SessionEnd | same names; each hook must be trusted in `/hooks` first | sessionStart, afterAgentResponse, stop, afterMCPExecution, sessionEnd |
| Stable session id | `session_id` | `session_id` | `conversation_id` |
| Session end | reliable on exit; `clear` keeps the claim | `SessionEnd` reason is always `other` (treated as exit) | only `window_close` / `user_close` end; `completed`/`aborted`/`error` are touches |
| Subagent identity | subagents share the parent `session_id`; they are the same presence | same | same conversation |
| Inbound steering | queued + `UserPromptSubmit` nudge | queued + `UserPromptSubmit` nudge | queued only (read on next `update_progress`) |
| Without hooks | MCP-only: works as before; buildd sees the session once it claims, and MCP calls keep the claim alive | same | same |

`BUILDD_HOOKS_DISABLED=1` forces MCP-only mode on any client.
