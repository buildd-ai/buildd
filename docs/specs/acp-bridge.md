---
title: ACP Bridge
status: active
owner: max
last_verified: 2026-11-22
summary: The `buildd acp` bridge MUST present this machine's runner workers as ACP threads, route each reply by worker state, file a new thread's task reserved for this runner, and say plainly when it cannot.
domain: runners
surfaces: [apps/runner/src/acp/bridge.ts, apps/runner/src/acp/translate.ts, apps/runner/src/acp/runner-port.ts, apps/runner/src/acp/links.ts]
related: [claim-gate-legibility]
keywords: [T3 Code, ACP, buildd-acp, Local ACP command, session/prompt, user_request, acp-sessions.json]
verified_by: [apps/runner/__tests__/unit/acp-bridge.test.ts, apps/runner/__tests__/unit/acp-e2e.test.ts, apps/runner/__tests__/unit/acp-shim.test.ts, apps/runner/__tests__/unit/acp-transport.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "acp-usertextfrom"
    type: "symbol"
    name: "userTextFrom"
    path: "apps/runner/src/acp/bridge.ts"
  - id: "acp-tasktitlefrom"
    type: "symbol"
    name: "taskTitleFrom"
    path: "apps/runner/src/acp/bridge.ts"
  - id: "acp-replyroute"
    type: "symbol"
    name: "replyRoute"
    path: "apps/runner/src/acp/translate.ts"
  - id: "acp-waitingform"
    type: "symbol"
    name: "waitingForm"
    path: "apps/runner/src/acp/translate.ts"
  - id: "acp-bridge-commands"
    type: "symbol"
    name: "BRIDGE_COMMANDS"
    path: "apps/runner/src/acp/translate.ts"
  - id: "acp-bridge-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/acp-bridge.test.ts"
---

## ACP Bridge

**Capability statement**: `buildd acp` serves this machine's running buildd runner as an Agent Client Protocol agent on stdio (T3 Code: Settings → Providers → Local ACP command), so a client thread follows, answers, steers, pauses and stops buildd workers. The bridge never runs an agent: it reads the runner's worker state and relays actions through the runner's owner-only socket, as `buildd top` does.

Entry points: `apps/runner/src/acp/main.ts` (stdio loop; stdout is the protocol channel, so `console.log/info/debug` are redirected to stderr) and the `buildd-acp` launcher shim (`apps/runner/src/acp/shim.ts`, below).

### Invariants

- The bridge MUST NOT start, run or bill a model session itself. Every action goes through the runner socket.
- `initialize` MUST advertise `loadSession`, `sessionCapabilities.list`, no image/audio/embedded-context prompts and no MCP transports. Form elicitation is used only when the client declares `clientCapabilities.elicitation.form`.
- Every method other than `initialize`, `authenticate`, `session/new`, `session/list`, `session/load`, `session/prompt` and `session/cancel` MUST fail with JSON-RPC `-32601` (see Failure messages).
- A user-visible failure MUST be an `agent_message_chunk` that ends the turn with `end_turn`, never a silent drop.

### Prompt envelope

T3 Code wraps a message in `<user_request>` plus `<t3_code_instructions>`, `<runtime_info>` and `<pull_request_linking>` blocks meant for an agent running inside T3. A buildd worker has none of T3's tools.

- `userTextFrom` MUST keep only the content of `<user_request>…</user_request>`, trimmed, when that wrapper is present.
- Without the wrapper it MUST drop the three envelope blocks and keep the rest, so another client's text passes through unchanged.
- Only `text` blocks of the prompt are read; they are joined with newlines before unwrapping.
- The task title (`taskTitleFrom`) MUST be the first non-empty line of the user text, clipped to 120 characters with a trailing `…`. The full user text is the task description.
- `/watch`, `/pause` and `/stop` are recognised after unwrapping, on the whole trimmed text only.

### Session identity and restart

- A thread opened by importing a worker from `session/list` has **session id = worker id**.
- A thread the client started (`session/new`) gets an id `new-<uuid>`. Its first message creates a task and worker; the bridge then persists the link session id → worker id in `<BUILDD_HOME>/acp-sessions.json` (`apps/runner/src/acp/links.ts`). The file holds ids only, is written as a secret file, and keeps the newest 1,000 links.
- After a restart, a prompt or `session/load` for a linked id MUST resolve to its worker, not create a second task. A `new-…` id with no link is still a new thread.
- `session/list` MUST report a client-started worker under its thread id, not its worker id, so the client does not offer a duplicate. It filters by the client's folder (path, then git worktree root, then folder/`origin` repo names against the worker's workspace name), sorts newest first, and carries `taskId`, status, workspace, worktree and branch in `_meta.buildd`.
- `session/load` replays the worker's timeline (tool calls as completed), advertises `/watch /pause /stop` as available commands, and re-emits the waiting question if the worker is waiting.

### Follow-ups: how a reply is routed

`replyRoute` decides from the worker's state when the user sends text to an existing thread:

| Worker status | Route | Runner socket action |
|---|---|---|
| `waiting` | `answer` | answers the open question or permission request |
| `working` | `message` | steers the running worker |
| anything else (done, error, stale, paused) | `followup` | local send that resumes the worker's session |

- A turn lasts while the worker is `working`. It ends (`end_turn`) the first time the worker is not `working` after it has moved (was working, or produced new messages), with a closing line from `settledText`: question/permission text, `Finished.` (plus the PR URL), `Stopped with an error: …`, or `This run went stale. Reply to continue it.`, each followed by spend when known and described as list price for plan usage, never as a bill.
- **Settle grace**: if the runner shows no movement within `settleGraceMs` (default 30 s) of a reply, the turn ends with "The runner hasn't picked up your reply yet. It will still be delivered; use /watch to follow the run."
- A question or permission request that arises during a turn is asked as a form (one `answer` field, a choice when the runner offers options) when the client supports it, and the run is followed on after the answer. A declined or unsupported form ends the turn on the question; the next typed reply answers it. An answer is relayed only while that same wait is still open.
- A prompt on a thread that has not loaded is adopted, and only messages newer than that point are shown.

### /stop, /pause, /watch, session/cancel

- `/pause` and `/stop` relay the `pause` or `stop` action and end the turn with "Pausing at the next safe point." or "Stopping the run." A refused action reports the refusal.
- `/watch` follows the run without sending anything.
- `session/cancel` on an open turn MUST send `pause` (not stop) and end the turn as `cancelled` with "Pausing the run. Reply to resume it." The next reply on a paused worker resumes it.
- On a thread with no task yet, a command or empty text shows the new-thread text instead (below).

### Reservation: a new thread's task

The first message of a client-started thread files a buildd task in the matching workspace and claims it onto this runner.

- Workspace choice: the project folder's names (folder, `origin` repo, owner/repo) are matched against the workspaces the runner's key reaches. One match is used. Several matches are put to the client as a form when it can show one; otherwise, or when none is chosen, the thread says so.
- The task is filed **reserved for the filing runner's account for 20 minutes**, then claimed by id with `/api/claim`, so no other runner takes it between the two calls. The reservation is a lease and its semantics belong to **CG-7** in `docs/specs/claim-gate-legibility.md`; this spec does not restate them.
- If the claim is refused, the thread MUST say the task is queued and why, and the task stays held for this runner until the lease lapses, then is free for any runner.
- **Pending #6136**: the code on dev today files the task unreserved (title and description only) and claims it afterwards, so another runner can win the gap. #6136 adds `reserve: true` to the `/api/tasks` create and updates the refused-claim message to name the 20-minute hold. Until it merges, treat the reservation requirement and the refused-claim wording below as not yet in force.
- On a successful claim the bridge stores the link, says "Started a buildd task in <workspace>: “<title>”.", and follows the run.

### Failure messages

| Situation | Text | What the user does |
|---|---|---|
| Runner not running / socket refused | `/api/workers` or `/api/workspaces` fail: "runner refused /api/workers (<status>): <reason>", "Could not read your buildd workspaces: <reason>"; the connection error itself surfaces from the socket client | Start the runner on this machine (the bridge only talks to it), then retry |
| New thread, no folder | "This thread has no project folder, so buildd cannot tell which workspace the task is for." | Open the thread inside a project folder |
| No matching workspace | "No buildd workspace matches this project (<names>). Connect the repo in buildd first." | Connect the repo as a buildd workspace |
| Several workspaces match | "This folder matches more than one buildd workspace (<list>). No workspace was chosen; send the message again to choose one." (or "Start this task from buildd for now." when the client has no forms) | Resend and pick one, or start the task from buildd |
| Task not created | "buildd did not create the task. The runner refused that (<status>): <reason>." | Fix the cause named, resend |
| Claim refused (current) | "Created the buildd task “<title>” in <workspace>. It is queued: this runner could not take it now. The runner refused that (<status>): <reason>." | Free a slot or fix the limit named; the task stays queued. Pending #6136: it names the 20-minute hold for this runner |
| Action refused | "The runner refused that (<status>)[: <reason>]." | Read the reason; the worker may have moved on |
| Worker not on this runner | "This worker is no longer on this runner." (prompt) or JSON-RPC `-32602` "worker <id> is not on this runner" (`session/load`) | Reopen the thread from `session/list` on the runner that owns the worker |
| Empty or command text on a new thread | the new-thread text: "This thread has no buildd task yet. Describe the work and send it…" | Describe the work and send it |
| Unsupported method | `-32601` "buildd acp does not support <method>" | None; the client should not call it |
| Missing `sessionId` | `-32602` "sessionId required" | Client bug |
| Reply not picked up | settle-grace line above | `/watch` |

### Launcher shim

The runner writes `~/.local/bin/buildd-acp` (marker line `# buildd-acp: written by the buildd runner`) at startup so a client's Local ACP command is just `buildd-acp`. It rewrites only a file carrying its marker, never a foreign one; writes nothing on Windows; and writes only from the installed runner, whose code is inside `BUILDD_HOME`, so a CI or dev checkout never repoints it.

### Mission, role, priority and kind: `_meta.buildd`

A client may open a thread with `_meta.buildd` = `{ missionId?, roleSlug?, priority?, kind? }` on `session/new` or on the first `session/prompt` of that session. The bridge keeps it on the session and passes the fields to the task it files, so the task joins that mission and carries that role, priority and kind.

- Without `_meta.buildd` nothing changes.
- A mission the server refuses (outside the runner's team, or missing) files **no task**: the thread gets one agent message naming the server's error and the turn ends with `end_turn`.
- Which mission a T3 project maps to, and persisting that mapping beside `acp-sessions.json`, remain unspecified; the client supplies `missionId` per thread.

### Acceptance criteria

- AC-1: [GIVEN a prompt wrapped in `<user_request>` and the three T3 blocks] WHEN it is sent THEN only the user request reaches the task, and the title is its first line.
- AC-2: [GIVEN a prompt without the wrapper] WHEN it carries envelope blocks THEN they are dropped and the rest is kept.
- AC-3: [GIVEN a worker `waiting`, `working`, or `done`] WHEN the user replies THEN the route is answer, message, follow-up respectively.
- AC-4: [GIVEN a reply the runner never acts on] WHEN the settle grace passes THEN the turn ends with the "hasn't picked up" line.
- AC-5: [GIVEN an open turn] WHEN `session/cancel` arrives THEN a pause is sent and the turn ends `cancelled`.
- AC-6: [GIVEN a linked client thread and a restarted bridge] WHEN a message arrives THEN it goes to the linked worker and no second task is created.
- AC-7: [GIVEN no workspace matches the folder] WHEN a new thread sends text THEN no task is created and the no-match message is emitted.
- AC-8: [GIVEN an unsupported method] WHEN called THEN the bridge answers `-32601`.
- AC-9: [pending #6136] [GIVEN a new thread's first message] WHEN the task is filed THEN it is reserved for the filing account (CG-7) before the claim by id.
- AC-10: [GIVEN `_meta.buildd` on a new thread] WHEN the first message is sent THEN the task is filed with those fields; WHEN the server refuses the mission THEN no task is filed and the thread says why, ending `end_turn`.

### Code surface

`apps/runner/src/acp/bridge.ts` (methods, `userTextFrom`, `taskTitleFrom`, `NEW_THREAD_TEXT`, `chooseWorkspace`), `translate.ts` (`replyRoute`, `BRIDGE_COMMANDS`, `waitingForm`, `settledText`), `runner-port.ts` (socket actions answer/message/pause/stop/followup, `createTask`, `claim`), `links.ts`, `shim.ts`, `main.ts`.

### Out of scope

Running agents, model billing, claim-gate semantics (CG-7), the runner socket's own auth, and thread to mission mapping (planned only).
