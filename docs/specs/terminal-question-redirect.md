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
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "deny-reason"
    type: "symbol"
    name: "askRedirectReason"
    path: "apps/runner/plugin/scripts/buildd-hook.mjs"
  - id: "terminal-withdrawal"
    type: "symbol"
    name: "withdrawQuestionAnsweredInTerminal"
    path: "apps/web/src/lib/terminal-answer.ts"
  - id: "withdrawal-predicate"
    type: "symbol"
    name: "terminalWithdrawWhere"
    path: "apps/web/src/lib/terminal-answer.ts"
  - id: "withdrawal-reachable-from-presence"
    type: "symbol_reachable"
    symbol: "withdrawQuestionAnsweredInTerminal"
    entry: "apps/web/src/lib/local-session.ts"
  - id: "plugin-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/agent-plugin.test.ts"
  - id: "withdrawal-tests"
    type: "test_file"
    path: "apps/web/src/lib/terminal-answer.test.ts"
---

# Terminal Question Redirect

In a claimed Claude Code session, AskUserQuestion shows only in that terminal;
buildd never sees it. `ask_human` puts the question in Needs-you. The plugin
denies AskUserQuestion and points the model at `ask_human`; typing at the
terminal still answers.

## Redirect

**Capability statement**: A Claude Code session holding a live interactive
worker MUST have AskUserQuestion denied with a reason pointing to `ask_human`.
Every other session is unchanged.

**Invariants**:
- `hooks.json` has a synchronous `PreToolUse` entry, matcher `AskUserQuestion`,
  timeout 5 s, running `buildd-hook.mjs claude ask`. The async busy-touch entry
  is unchanged.
- Deny only when all hold: client is Claude Code; local state holds a claim;
  a forced touch returns `askVia: { workerId }`; `BUILDD_ASK_IN_TERMINAL` is
  not `1`.
- The server sets `askVia` only for a held worker with `runner = 'mcp'` and a
  live status, choosing the most recently bound (`boundState`'s rule). Runner
  workers never get it.
- Anything else, including timeout, network error or non-2xx: print nothing,
  exit 0 (fail open).
- The deny reason names the short worker id and says: call `ask_human` with
  that `workerId` and the options; run `waitCommand` in the background; also
  write the question in the reply; treat a typed reply as the answer.
- The hook sends no question, option or prompt text.

**Acceptance criteria**:
- AC-TQR-1: GIVEN a held claim and `askVia` WHEN PreToolUse fires for
  AskUserQuestion THEN the hook denies, naming `ask_human`, `waitCommand` and
  the short id.
- AC-TQR-2: GIVEN no claim in state THEN the hook prints nothing and makes no
  request.
- AC-TQR-3: GIVEN a timeout or 500 THEN the hook prints nothing and exits 0.
- AC-TQR-4: GIVEN the held worker has ended THEN no `askVia`, nothing printed.
- AC-TQR-5: GIVEN `BUILDD_ASK_IN_TERMINAL=1` THEN nothing printed.
- AC-TQR-6: GIVEN only a non-`mcp` worker held THEN no `askVia`.
- AC-TQR-7: GIVEN a Codex or Cursor client THEN no redirect output.

## Answering at the terminal

**Capability statement**: A prompt typed while the interactive worker waits on
an `ask_human` question MUST withdraw that question.

**Invariants**:
- The UserPromptSubmit touch carries `prompted: true` only for a non-empty
  prompt not starting with `<task-notification>`. Claude Code fires
  UserPromptSubmit when a background command finishes, with no field to tell
  it apart; without this check the `waitCommand` would withdraw its own
  question. The prompt text is never sent.
- On `prompted`, each held worker with `runner = 'mcp'`, `status =
  'waiting_input'` and `waitingFor.type = 'question'` is CAS-set to `running`,
  `waitingFor: null`, gated on `waitingFor IS NOT NULL`, the gate `/respond`
  uses. Exactly one of buildd answer and terminal answer wins.
- A withdrawal posts one note ("Answered in the terminal"), emits
  `worker:progress` on the worker and task channels, and queues nothing.
- After a withdrawal the background waiter exits non-zero and `await_answer`
  returns `stillWaiting: false`.

**Acceptance criteria**:
- AC-TQR-8: GIVEN a held worker waiting on a question WHEN a `prompted` touch
  arrives THEN it is `running`, `waitingFor: null`, one note posted, nothing
  queued.
- AC-TQR-9: GIVEN the same worker WHEN a touch without `prompted` arrives THEN
  the question stays open.
- AC-TQR-10: GIVEN `/respond` won first THEN the withdrawal matches no row and
  the queued answer stays.
- AC-TQR-11: GIVEN `waitingFor.type = 'permission'` THEN it is left alone.
- AC-TQR-12: GIVEN a withdrawn question WHEN the waiter polls THEN it exits
  non-zero and `await_answer` returns `stillWaiting: false`.
- AC-TQR-13: GIVEN a prompt starting with `<task-notification>` THEN `prompted`
  is absent.

## Code surface

- `apps/runner/plugin/hooks/hooks.json`: the matcher entry.
- `apps/runner/plugin/scripts/buildd-hook.mjs`: `askRedirectReason`, `hookOutput`, ask mode, `prompted`.
- `apps/runner/src/agent-plugin-install.ts`: `claudeLikeHookEntries` (non-plugin installs, Claude only).
- `packages/shared/src/local-session.ts`: `parseLocalSessionEvent` (`prompted`), `askVia`.
- `apps/web/src/lib/local-session.ts`: `handleLocalSessionEvent`.
- `apps/web/src/lib/terminal-answer.ts`: `withdrawQuestionAnsweredInTerminal`, `terminalWithdrawWhere`.

## Out of scope

- Answering AskUserQuestion from the hook: the prompt would not show while it waits.
- Codex and Cursor: no equivalent hook.
- Telling an unrelated typed prompt from an answer: any typed prompt withdraws.

## Verification gaps

1. AC-TQR-12 (waiter exits after a withdrawal) has no test and no live run yet.
2. A claim the hook never saw bound (missed PostToolUse) is not redirected.
