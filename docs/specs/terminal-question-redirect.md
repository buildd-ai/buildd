---
title: Terminal Question Redirect
status: active
owner: max
last_verified: 2026-10-12
summary: A Claude Code session holding a live buildd claim MUST ask its questions through buildd, not the terminal-only prompt, and a reply typed at the terminal MUST withdraw the open buildd question.
domain: runners
surfaces: [apps/runner/plugin/scripts/buildd-hook.mjs, apps/runner/plugin/hooks/hooks.json, apps/web/src/lib/local-session.ts, packages/shared/src/local-session.ts]
related: [local-agent-presence, answered-question-resume, human-in-the-loop-protocol]
keywords: [AskUserQuestion, ask_human, PreToolUse, permissionDecision, deny, UserPromptSubmit, terminal prompt, needs you, away from terminal, withdraw question, agent plugin, hooks]
verified_by: [apps/runner/__tests__/unit/agent-plugin.test.ts, apps/web/src/lib/local-session.test.ts, apps/web/src/lib/terminal-answer.test.ts]
supersedes: []
assertions:
  - id: "withdraw-on-terminal-answer"
    type: "symbol"
    name: "withdrawQuestionAnsweredInTerminal"
    path: "apps/web/src/lib/terminal-answer.ts"
  - id: "terminal-answer-tests"
    type: "test_file"
    path: "apps/web/src/lib/terminal-answer.test.ts"
  - id: "ask-matcher-hook"
    type: "config_key"
    file: "apps/runner/plugin/hooks/hooks.json"
    key: "AskUserQuestion"
---

# Terminal Question Redirect

A person's own Claude Code session that has claimed a buildd task can ask a
question two ways. `ask_human` (`docs/specs/answered-question-resume.md`, "The
interactive path") puts it in Needs-you, answerable from any device. The built-in
AskUserQuestion tool shows it only in that terminal: buildd never sees it, and the
session blocks until someone is at that keyboard. The skills say to use
`ask_human`; nothing enforces it.

The agent plugin already runs hooks in that session (`docs/specs/local-agent-presence.md`).
Claude Code fires PreToolUse for AskUserQuestion, and a PreToolUse hook can deny
a tool with a reason the model reads. This spec uses that to send the question
through buildd, while keeping the terminal a valid place to answer.

## Redirecting the question

**Capability statement**: When a Claude Code session holding a live interactive
buildd worker calls AskUserQuestion, the plugin MUST deny it and tell the model
to ask with `ask_human`. In every other session it MUST NOT change anything.

**Invariants**:
- A new synchronous `PreToolUse` entry in `hooks.json` with matcher
  `AskUserQuestion`, timeout 5 s, runs the same `buildd-hook.mjs`. The existing
  async `PreToolUse` entry (the busy touch) is unchanged.
- Redirect needs ALL of:
  1. the client is Claude Code;
  2. the session's local hook state holds at least one claim;
  3. a forced touch to `POST /api/workers/local-sessions` returns a new field,
     `askVia: { workerId }`, which the server sets only when this presence holds a
     worker with `runner = 'mcp'` and a live status. With several such workers it
     names the most recently bound one, the rule `boundState` already uses;
  4. `BUILDD_ASK_IN_TERMINAL` is not `1`.
- If any condition fails, the hook writes nothing and exits 0, and the
  terminal prompt appears as before. That includes a timeout, a network error or
  a non-2xx response: the hook **fails open**, as the presence hook already does.
- Redirect output is
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`.
  The reason names the worker's short id and tells the model to:
  1. ask the same question through `ask_human` with that `workerId`, one
     question per call, passing the AskUserQuestion options as `options`;
  2. run the returned `waitCommand` in the background;
  3. also write the question in its reply text, so a person at the terminal can
     answer by typing;
  4. treat a typed reply as the answer.
- The hook sends nothing new to buildd. No question text, option or prompt
  leaves the machine through the hook: the model's own `ask_human` call carries
  the question, as it does today. The plugin's "sends no content" contract
  holds.
- A runner-managed worker is never redirected: its runner handles AskUserQuestion
  itself (park and resume), and the server returns no `askVia` for a runner worker.

**Acceptance criteria**:
- AC-TQR-1: GIVEN a Claude session whose state holds a claim, and a server
  touch returning `askVia` WHEN PreToolUse fires for AskUserQuestion THEN the
  hook prints a `deny` whose reason names `ask_human`, `waitCommand` and the
  worker's short id.
- AC-TQR-2: GIVEN a session with no claim in its state WHEN PreToolUse fires for
  AskUserQuestion THEN the hook prints nothing and makes no request.
- AC-TQR-3: GIVEN a held claim and a server that times out or returns 500 WHEN
  PreToolUse fires for AskUserQuestion THEN the hook prints nothing and exits 0.
- AC-TQR-4: GIVEN a held claim whose worker has ended (completed, failed,
  superseded) WHEN the touch is answered THEN the response has no `askVia`
  and the hook prints nothing.
- AC-TQR-5: GIVEN `BUILDD_ASK_IN_TERMINAL=1` WHEN PreToolUse fires for
  AskUserQuestion THEN the hook prints nothing, whatever the session holds.
- AC-TQR-6: GIVEN a presence holding only a worker whose runner is not `mcp`
  WHEN touched THEN the response has no `askVia`.
- AC-TQR-7: GIVEN a Codex or Cursor client WHEN any hook fires THEN no
  redirect output is ever printed.

## Answering at the terminal

**Capability statement**: When the person types into the session while its
interactive worker waits on an `ask_human` question, buildd MUST withdraw that
question. The typed reply is the answer, so the Needs-you card goes away and no
answer from another device is applied afterwards.

**Invariants**:
- The `UserPromptSubmit` touch carries a new boolean, `prompted: true`, only
  for a person's prompt (see "Verified in a live session": not a
  `<task-notification>` wake-up), and no other hook sets it. The strict contract (`parseLocalSessionEvent`) accepts it.
  The prompt text itself is never sent.
- On a `prompted` touch the server withdraws the question of every worker
  this presence holds that is `runner = 'mcp'`, `status = 'waiting_input'`
  and has a `waitingFor` of type `question`. Withdrawing sets `status: 'running'`
  and `waitingFor: null` in one compare-and-swap gated on `waitingFor IS NOT NULL`.
  That is the same gate `/respond` claims an answer with, so exactly one of
  "answered in buildd" and "answered at the terminal" wins.
- A withdrawal posts one feed note ("Answered in the terminal"), emits
  `worker:progress` with `status: 'running'` on the worker and task channels (so
  open Needs-you views drop the card), and writes no `answerDelivery`. No answer
  came through buildd, so none is queued.
- After a withdrawal, the background waiter exits non-zero with "no longer
  waiting", and `await_answer` returns `stillWaiting: false`. The model
  carries on with the typed reply.
- If an answer from another device won the race, the typed reply is just a
  further user message. The model sees both and reconciles them; nothing is lost.

**Acceptance criteria**:
- AC-TQR-8: GIVEN a held interactive worker in `waiting_input` with a question
  WHEN a `prompted` touch arrives THEN the worker is `running` with `waitingFor:
  null`, one note is posted, and no message is queued.
- AC-TQR-9: GIVEN the same worker WHEN a touch WITHOUT `prompted` arrives (Stop,
  PostToolUse, PreToolUse) THEN the question stays open.
- AC-TQR-10: GIVEN `/respond` claimed the answer first WHEN the `prompted`
  touch arrives THEN the withdrawal matches no row and the queued answer is
  untouched.
- AC-TQR-11: GIVEN a held worker that is `waiting_input` on a permission prompt
  (`waitingFor.type = 'permission'`) WHEN a `prompted` touch arrives THEN it is
  left alone.
- AC-TQR-12: GIVEN a withdrawn question WHEN the session's background waiter
  next polls THEN it exits non-zero (never 0, "answered"), and `await_answer`
  returns `stillWaiting: false`.
- AC-TQR-13: GIVEN a UserPromptSubmit payload whose prompt starts with
  `<task-notification>` WHEN the hook builds the touch THEN `prompted` is absent.

## Verified in a live session (Claude Code 2.1.296)

- **A deny on AskUserQuestion reaches the model.** No prompt is shown. The model
  gets the reason as a tool error (`PreToolUse:AskUserQuestion hook error:
  <reason>`) and acts on it.
- **UserPromptSubmit also fires when a background command finishes.** The
  model is woken with a synthetic prompt that starts with `<task-notification>`,
  and no payload field tells it apart from a person's prompt. So the hook
  decides `prompted` locally: true only for a non-empty prompt that does NOT
  start with `<task-notification>`. The prompt text is read on the machine and
  never sent. Without this gate, the background `waitCommand` would withdraw
  the very question it waits on.

## Code surface

- `apps/runner/plugin/hooks/hooks.json`: the matcher entry.
- `apps/runner/plugin/scripts/buildd-hook.mjs`: `normalizeHookEvent` (the
  `prompted` flag, the AskUserQuestion branch), `hookOutput` (the deny), and
  the opt-out; `askRedirectReason` is the deny text. The AskUserQuestion entry
  runs the script as `buildd-hook.mjs claude ask` (ask mode).
- `apps/runner/src/agent-plugin-install.ts`: `claudeLikeHookEntries` writes the
  same entry for a non-plugin install (Claude Code only).
- `packages/shared/src/local-session.ts`: `parseLocalSessionEvent` (accepts
  `prompted`), and the result type (`askVia`).
- `apps/web/src/lib/local-session.ts`: `handleLocalSessionEvent` (computes
  `askVia`, runs the withdrawal on `prompted`).
- `apps/web/src/lib/terminal-answer.ts`: `withdrawQuestionAnsweredInTerminal`
  and its predicate `terminalWithdrawWhere`.
- Tests: `apps/runner/__tests__/unit/agent-plugin.test.ts`,
  `apps/web/src/lib/local-session.test.ts`.
- Docs: `.claude/skills/buildd-workflow/SKILL.md`, `.claude/skills/buildd-mcp-consumer/SKILL.md`,
  `packages/core/onboarding-templates/consumer-skill.md`, and buildd-docs
  `agent-plugin.mdx`. Each gets one line: in a claimed session the terminal
  prompt is redirected, and typing at the terminal answers.

## Out of scope

- Answering AskUserQuestion from the hook (allow plus answers). The hook runs
  before the prompt shows, so the terminal would show nothing while it waited,
  and a hook's run is bounded by its timeout.
- Codex and Cursor. Neither exposes a question tool with a PreToolUse-style hook.
- Sessions without the plugin. The skills' instruction to use `ask_human` is
  the only lever there.
- Claude's Remote Control. A session connected to it is still redirected, so
  every question lands in one place, Needs-you.
- Telling an unrelated typed message ("how's it going?") from an answer. Any
  typed prompt while a question is open withdraws it: the person is at the
  keyboard, and the model has the question in front of them.

## Verification gaps

1. **Presence is inferred from typing.** A person who reads the question in the
   terminal and then walks away without typing leaves it open in buildd, which
   is the intended fallback. A person who types something unrelated withdraws it.
2. **Local claim state can lag.** A claim the hook never saw bound (a missed
   PostToolUse) is not redirected, so the old terminal-only behaviour remains
   for that session.
