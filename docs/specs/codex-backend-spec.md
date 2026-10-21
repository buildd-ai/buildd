---
title: Codex Backend Behavioral Spec
status: active
owner: max
last_verified: 2026-10-20
summary: The Codex worker backend MUST drive the shared worker loop by mapping Codex thread events into Claude-shaped SDK messages, emitting exactly one complete and one aggregate result per run, and resuming by thread id.
domain: runners
surfaces: [apps/runner/src/backends/codex-backend.ts, apps/runner/src/backends/codex-events.ts, apps/runner/src/workers.ts, apps/runner/src/codex-auth.ts, apps/runner/src/host-seat.ts]
related: [provider-failover, credential-isolation, runner-liveness]
keywords: [mapcodexeventtosdkmessages, agents.md, codex_home, resumethreadid, model_reasoning_effort, sandboxmode, mcp_servers]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "codex-backend"
    type: "symbol"
    name: "CodexBackend"
    path: "apps/runner/src/backends/codex-backend.ts"
  - id: "codex-event-adapter"
    type: "symbol"
    name: "mapCodexEventToSdkMessages"
    path: "apps/runner/src/backends/codex-events.ts"
  - id: "codex-event-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/backends/codex-events.test.ts"
---

# Codex backend — behavioral spec

**Status:** living spec. Describes how the Codex worker backend *behaves* and the invariants that must hold. This is the regression contract: when you change the Codex backend, the statements here must stay true (or this doc changes in the same PR). It is **not** a build plan — the implementation shipped via PRs #869/#870/#871/#873/#874/#875.

**Scope:** the Codex backend at parity with the Claude backend on the buildd worker run loop. Runner code: `apps/runner/src/`. Backend abstraction: `apps/runner/src/backends/`. Orchestration loop: `apps/runner/src/workers.ts`.

> **How to use this for regression safety:** every numbered **R-n** below is an invariant with a code anchor and a guarding test. Before merging a change to the Codex backend, confirm the touched ones still hold and their tests pass. If a change intentionally alters one, update it and its test together.

---

## 1. Architecture: two channels out of `runStreamed`

`CodexBackend.runStreamed` (`apps/runner/src/backends/codex-backend.ts`) drives the worker loop through **two channels**, exactly mirroring the Claude backend:

1. **Yielded `BackendEvent`s** (`progress | turn_complete | complete | error`) → consumed by the main loop in `workers.ts` (review gate, nudges, completion, cost).
2. **`onProgress(sdkMsg)` → `workers.ts:handleMessage`** → drives **all** rich worker-state tracking: `toolCalls`, commit detection, milestones, phase/loop detection, MCP-call + MCP-failure tracking, error traces, the PR/artifact output-requirement gate, and `worker.lastAssistantMessage`.

`handleMessage` is keyed on **Claude SDK message shapes** (`system:init`, `assistant`+`tool_use`, `user`+`tool_result`, `result`). Codex emits `item.completed`/`turn.completed`, which match none of those. The **event adapter** (§2) bridges the gap so `handleMessage` needs zero Codex-awareness.

**R-1.** Channel 2 feeds `handleMessage` Claude-shaped messages only. `handleMessage` contains no Codex-specific branching for tool/commit/milestone tracking. *Anchor:* `codex-backend.ts` loops `mapCodexEventToSdkMessages(event)` into `onProgress`. *Guard:* `codex-events.test.ts`.

---

## 2. Event adapter contract — `mapCodexEventToSdkMessages`

`apps/runner/src/backends/codex-events.ts`. **Pure** function, `(event, ctx) → SDKMessage[]`. Defensive: any unrecognized/partial event yields `[]`. This is the single highest-leverage regression surface — a wrong mapping silently disables a whole tracking subsystem.

| Codex event / item | → SDKMessage(s) | Why it matters |
|---|---|---|
| `thread.started` (has `thread_id`) | `{ system, subtype:'init', session_id: thread_id }` | seeds session/thread id (§5) |
| `item.completed` `agent_message` | `assistant` text block | sets `lastAssistantMessage` (R-8), worker output |
| `item.completed` `reasoning` | `assistant` text block | surfaced as text, not a tool call |
| `item.completed` `command_execution` | `assistant` `tool_use { name:'Bash', input:{command}, id }` | **commit detection keys off Bash `git commit`** |
| `item.completed` `file_change` (per change) | `tool_use` per change: `add`→`Write`, `update`/unknown→`Edit`, `delete`→`Bash(rm)`; id `${id}:${index}` | milestone/phase labels |
| `item.completed` `mcp_tool_call` | `tool_use { name:'mcp__'+server+'__'+tool, input: arguments, id }` | **PR/artifact gate reads `input.action`** |
| `item.completed` `web_search` | `tool_use { name:'WebSearch', input:{query}, id }` | tool tracking |
| failed `command_execution` (`status:'failed'` or `exit_code≠0`) | the `tool_use` **plus** a `user` `tool_result{is_error:true}` | error-trace capture |
| failed `mcp_tool_call` (`status:'failed'`) | the `tool_use` **plus** a `user` `tool_result{is_error:true}` | MCP-failure tracking |
| `item.completed` `todo_list` | `[]` (dropped) | see R-7 |
| `turn.completed` / `turn.started` / `item.started` / `item.updated` / `error` | `[]` | see R-2, R-3 |

**R-2 (no result here).** The adapter never emits a Claude `result` message. `result` is emitted once by `codex-backend` on final completion (§4 / R-10). *Reason:* double `result` over-counts `worker.resultMeta`.

**R-3 (terminal items only).** Only `item.completed` is mapped; `item.started`/`item.updated` yield `[]`. *Reason:* in-progress items would double-count tool calls and trip loop detection.

**R-4 (stable tool_use ids).** Every synthesized `tool_use` carries a stable `id` derived from the Codex `item.id` (file_change uses `${id}:${index}`). *Reason:* `handleMessage` correlates `tool_result.tool_use_id` against the stored toolCall for error traces; the toolCall push site must persist this id. *Guard:* `codex-events.test.ts`, `get-error-traces` paths.

**R-5 (failures are dual-emitted).** A failed command or MCP call emits **both** the `assistant` `tool_use` and a `user` `tool_result{is_error}`. *Reason:* error-trace + MCP-failure tracking consume the `user`/`tool_result` shape. *Guard:* `codex-events.test.ts`.

**R-6 (mcp arguments carried through).** `mcp_tool_call.arguments` is passed as `tool_use.input` when present. The SDK `.d.ts` omits `arguments`, but the CLI JSONL emits it (verified, §10). *Reason:* the output-requirement gate matches buildd action-tool calls (`isBuilddActionTool`) by `input.action` (e.g. `create_pr`). *Guard:* `codex-events.test.ts` mcp case.

**R-7 (todo_list is not a tool_use).** `todo_list` items map to `[]`. *Reason:* repeated todo updates would trip `detectRepetitiveToolCalls`. The live todo still surfaces via channel-1 progress.

---

## 3. Worker-state invariants driven through the adapter

These are the integration requirements (R1/R2 from the parity work) that make the loop function — not just the mapping shape.

**R-8 (`lastAssistantMessage` is set for Codex).** `handleMessage`'s assistant branch sets `worker.lastAssistantMessage` from `agent_message` text. *Reason:* the fallback completion summary reads it when the session ends without an agent-authored `complete_task`; without it every Codex task exits with an empty summary. *Guard:* `codex-last-assistant-message.test.ts`.

**R-9 (commit→PR linkage).** PR detection fires via the **MCP `create_pr` arm** of the gate (R-6), not via commit detection. Commit detection (Bash `git commit`) populates `commits` but does **not** populate `commits[].prUrl`. Do not claim commit-based PR detection.

---

## 4. Multi-turn loop + completion + abort

`CodexBackend` runs a **turn loop** on a single persistent Codex `Thread` (`thread.runStreamed(prompt)` is callable repeatedly). `CodexBackendConfig.inputStream` (an `AsyncIterable`) carries `workers.ts`'s nudge/steering enqueues into Codex, mirroring the Claude path (where `ClaudeBackend` passes the initial prompt followed by `inputStream` to `query()` as one open stream) (`workers.ts` passes `inputStream` when it starts the backend).

Loop shape: run initial prompt → on `turn.completed`, park on `inputStream.next()` → a message drives another turn on the same thread; stream-end (or no stream) yields `complete` and returns.

**R-10 (single `complete`, single `result`).** `complete` is yielded in exactly one place (after the loop). The synthetic `result` (`resultEvent('success', …)`) is emitted once, with **aggregate** usage/cost accumulated across turns, never per turn. *Reason:* per-turn emission over-counts `worker.resultMeta`. *Anchor:* `codex-backend.ts` final-completion block. *Guard:* `codex-multiturn.test.ts`.

**R-11 (no `complete` leaks between turns).** Between turns the backend only ever *parks* on `it.next()`; it does not yield `complete`. When `workers.ts` breaks its consuming `for await` (DONE/error/exhausted), the runtime calls this generator's `.return()`, unwinding from the parked `await` without resuming past it. *Reason:* a mid-loop `complete` would make `workers.ts` exit early. *Guard:* `codex-multiturn.test.ts`.

**R-12 (abort reaches Codex).** `RunStreamedOpts.signal` is honored: the backend returns immediately if `signal.aborted` before start, and breaks the `for await` on abort mid-stream, which closes the SDK event generator whose `finally` kills the `codex exec` child. *Reason:* loop-detection, AskUserQuestion abort, user abort, and destroy all call `abortController.abort()`; without this the turn keeps running and cost keeps accruing. *Anchor:* the `signal` checks in `CodexBackend.runStreamed`; `workers.ts` passes the worker's abort signal. *Guard:* `codex-multiturn.test.ts`.

**R-13 (budget enforcement).** For non-OAuth auth, when accumulated `totalCostUsd > maxBudgetUsd` the backend emits a final `result` (`error_max_budget_usd`) then an `error` and returns. OAuth (seat-based) is exempt.

---

## 5. Thread resume + CODEX_HOME persistence

**R-14 (resume by thread id, not sessionId).** A follow-up resumes the prior Codex thread via `RunStreamedOpts.resumeThreadId` → `codex.resumeThread(id)`. The id lives in `worker.codexThreadId` (set in `handleMessage` from the synthetic `system:init.session_id`), **never** in `worker.sessionId` (which is Claude's resume key). `workers.ts` passes `resumeThreadId` only for `taskBackend==='codex'`. *Guard:* `codex-resume.test.ts`, `codex-resume-branch.test.ts`.

**R-15 (stable per-worker CODEX_HOME).** Codex sessions are persisted under `$CODEX_HOME/sessions/`. The worker uses a **stable per-worker** CODEX_HOME (`stableCodexHomePath(workerId)`), not a per-run `mkdtemp`, so rollouts survive a restart. Auth (§12), config and MCP are re-materialized each run **without** touching `sessions/`. Teardown (`teardownStableCodexHome`) happens only when the worker is truly terminal. *Reason:* cross-restart resume (R-14) finds no session otherwise. *Guard:* `codex-stable-home.test.ts`.

---

## 6. Role / skills / context — AGENTS.md

Codex has no Skill tool, no `settingSources`, and **no `instructions` thread option** (`ThreadOptions` is only `{model, sandboxMode, workingDirectory, skipGitRepoCheck}`). Parity is delivered via Codex's native **`AGENTS.md`** (re-read from cwd each turn).

**R-16 (AGENTS.md carries role/skills/CLAUDE.md).** When `taskBackend==='codex'`, the worker writes role persona + **inlined resolved skill content** + (when `useClaudeMd`) CLAUDE.md content into `AGENTS.md` in the repo cwd, and prepends a prompt pointer telling Codex to read it (`buildCodexInstructionDoc`, `writeCodexAgentsMd` in `codex-instructions.ts`). The file is restored or removed in the run's finally block (`restoreCodexAgentsMd`). *Guard:* `codex-instructions.test.ts`.

Retired (was INV-17): previously documented a `<promise>DONE</promise>` sentinel instruction that fed the runner's self-review "ralph loop" exit gate. That loop (and the sentinel constant it depended on) was removed from `codex-instructions.ts`, every task's completion is now driven solely by the agent calling `complete_task`, gated server-side (see `apps/web/src/app/api/workers/[id]/route.ts`).

---

## 7. Sandbox / approval / effort — config.toml

The SDK exposes no approval/effort/sandbox-policy thread options, so these are written to `config.toml` by `writeCodexMcpConfig` (`apps/runner/src/codex-auth.ts`).

**R-18 (MCP auto-approve, was a live prod bug).** `writeCodexMcpConfig` emits `default_tools_approval_mode = "approve"` scoped to `[mcp_servers.buildd]`. *Reason:* headless `codex exec` has approval `never` with no TTY, so without this **every** buildd MCP call (`create_pr`, `update_progress`, `complete_task`, artifacts, memory) is auto-cancelled. Scope is minimal, it does not loosen approvals globally. *Guard:* `codex-mcp-config.test.ts`.

**R-19 (effort mapping).** `configuredEffort` maps to `model_reasoning_effort` in `config.toml` (`codexReasoningEffort` in `codex-auth.ts`); buildd `max` collapses to codex `high`. *Reason:* otherwise `create_task { effort }` is a silent no-op for Codex. *Guard:* `codex-effort-config.test.ts`.

**R-20 (sandbox mapping).** buildd permission policy + `task.kind` → Codex `sandboxMode` (`read-only` | `workspace-write`; default `workspace-write`). Dangerous-bash blocking relies on the **Codex sandbox**, not buildd's PreToolUse hook (which we cannot reach on Codex, see R-22). Both modes need the host's confinement (Seatbelt on macOS, bwrap on Linux, Codex's own unelevated Windows sandbox on Windows). On Windows the runner probes that sandbox (`codex-windows-sandbox.ts`, a real `codex sandbox` run that must write inside its workspace and be refused outside it) and passes `windows.sandbox="unelevated"` on every run, since Codex without it runs `workspace-write` as read-only. That mechanism (`windows_restricted_token`) confines writes but not the network, so it takes `trusted_local` Codex tasks and refuses `protected` ones (a protected task needs `write` and `network` in scope). buildd never uses the `elevated` mode: it sets itself up by creating local accounts and firewall rules. On a host without it, `mapSandboxMode` falls back to `danger-full-access`, with a warning, only for a run the runner decided reduced: a `trusted_local` task on a runner whose operator opted in (Living Spec "Runner isolation" R-5, AC-5). Any other run refuses to start, and the claim route does not hand a `protected` Codex task to that runner. *Guard:* `sandbox-inference.test.ts`, `codex-sandbox-bwrap.test.ts`.

Retired (was INV-21): stdio MCP server injection into `config.toml`, whose only user was the code graph; both were removed.

**R-22 (no reachable hook seam).** buildd's PreToolUse/PostToolUse steering has no Codex equivalent **through the SDK**: `@openai/codex-sdk` surfaces no hook configuration. Standing instructions in `AGENTS.md` are therefore the only steering channel, and anything expressed as a hook on Claude must be re-expressed as instructions for Codex. Note the codex CLI itself *does* ship a hook engine (PreToolUse among others, behind a `[features] hooks` flag plus a trust hash) and it fires under non-interactive `codex exec`; whether it can be driven via the SDK's `--config` passthrough is **unverified**. That is the future path to hook parity, do not claim Codex "has no hooks".

---

## 8. Cost accounting

**R-23 (reasoning tokens billed as output).** `turn.completed.usage.reasoning_output_tokens` is folded into output-token cost (the `turn.completed` handler in `CodexBackend.runStreamed`). *Reason:* reasoning tokens bill as output but arrive in a separate field the estimator previously ignored, under-counting cost. *Guard:* `codex-backend.test.ts`.

Price-per-model is resolved by `priceForModel` with `CODEX_*_USD_PER_M_TOKENS` env overrides.

---

## 9. Structured output

The SDK has **no schema param** (`Input = string`). Structured output is best-effort:

**R-24 (parse + bounded repair).** When `outputSchema` is set, the backend `JSON.parse`s the agent's final text (tolerating code-fence prose via balanced-brace extraction) and checks load-bearing constraints (top-level `type` + `required`). On failure it self-drives up to `MAX_REPAIR_ATTEMPTS` (2) repair turns asking for valid JSON, independent of the external input stream. *Anchor:* `tryParseStructuredOutput`/`buildRepairPrompt`. *Guard:* `codex-structured-repair.test.ts`.

---

## 10. Verified SDK facts (assumption ledger — `@openai/codex-sdk` 0.44.0 / codex-cli 0.140)

A bump that breaks any of these breaks the spec above. Re-verify on SDK upgrade.

- Events: `thread.started{thread_id}`, `turn.started`, `turn.completed{usage}`, `turn.failed{error}`, `item.started|updated|completed{item}`, `error{message}`.
- `ThreadItem` union: `agent_message{id,text}`, `reasoning`, `command_execution{id,command,exit_code,status,aggregated_output}`, `file_change{changes:[{path,kind:'add'|'update'|'delete'}],status}`, `mcp_tool_call{id,server,tool,arguments,result,error,status}`, `web_search{query}`, `todo_list{items}`, `error`. **No `create` file-change kind exists.**
- `mcp_tool_call` **carries `arguments`** at runtime even though the `.d.ts` omits it (R-6).
- `Thread` supports multiple consecutive turns; `thread.runStreamed(input: string)` is repeatable. `Input = string` — **no multimodal**.
- `codex.resumeThread(id, options)` exists; `thread.id` populated after the first turn starts. Sessions persist under `$CODEX_HOME/sessions/`; the SDK spawns `codex exec` with inherited `CODEX_HOME` and never overrides it.
- `ThreadOptions = {model, sandboxMode, workingDirectory, skipGitRepoCheck}` only — no instructions/approvalMode/effort options (hence config.toml, §7).
- `turn.completed.usage` includes `reasoning_output_tokens` (R-23).

---

## 11. Non-goals (documented, intentionally not built)

- **Subagents / agent teams / delegation:** no Codex SDK equivalent. Route delegation-heavy roles to Claude; surface a warning when a Codex task requests delegation.
- **File checkpointing / `rewindFiles`:** Claude-SDK-specific. Rely on git.
- **Images / multimodal:** `Input = string`. `resolvePrompt` throws on non-text prompts (`codex-backend.ts`); route image-attachment tasks to Claude.

---

## 12. Whose Codex login runs the task

The runner's own login comes first; API keys come from buildd (approved spec a8d1eb82, "Model credentials: the runner's own login first, API keys from buildd").

**R-25 (the runner's own login first).** For a Codex task, `decideCodexLogin` (`host-seat.ts`) picks the login. When the claim delivers no Codex credential, the machine's own `codex login` (`localCodexAuthPath`: `$CODEX_HOME`, else `~/.codex`) is used when it exists and the claim allows a runner-local login (`runnerLocalAllowed`). The per-worker CODEX_HOME's `auth.json` is then a link to it (`linkMachineCodexAuth`), so a CLI token refresh lands in the machine's own file, not in a copy. *Guard:* `codex-host-login.test.ts`, `runner-local-allowed.test.ts`.

**R-26 (API keys from buildd).** A delivered Codex API key is written as `{ api_key }` into the per-worker CODEX_HOME (`writeCodexApiKeyToHome`) and `resolveAuth` passes it to the SDK. *Guard:* `codex-auth.test.ts`, `codex-credential-injection.test.ts`.

**R-27 (a machine login stays on the machine).** When the machine's own login ran the session, the runner never sends its tokens to buildd: the post-session write-back in `workers.ts` is skipped for `codexSeatSource === 'machine'`. *Guard:* none yet; this is a gap.

The older path, where buildd stores a ChatGPT (subscription) Codex login, delivers it to the runner (`seedCodexAuthIfMissing`) and takes refreshed tokens back after the session (`writeBackCodexAuth`), still exists in code but is being removed. This spec does not promise it, and new work must not build on it.

---

## 13. Test coverage map

| Area | Tests |
|---|---|
| Event adapter mappings (R-2 to R-7) | `__tests__/unit/backends/codex-events.test.ts` |
| Multi-turn / abort / single-complete (R-10 to R-13) | `__tests__/unit/backends/codex-multiturn.test.ts` |
| `lastAssistantMessage` (R-8) | `__tests__/unit/codex-last-assistant-message.test.ts` |
| Resume (R-14) | `__tests__/unit/backends/codex-resume.test.ts`, `__tests__/unit/codex-resume-branch.test.ts` |
| Stable CODEX_HOME (R-15) | `__tests__/unit/codex-stable-home.test.ts` |
| AGENTS.md role/skills (R-16) | `__tests__/unit/codex-instructions.test.ts` |
| MCP approve / config (R-18) | `__tests__/unit/codex-mcp-config.test.ts` |
| Effort mapping (R-19) | `__tests__/unit/codex-effort-config.test.ts` |
| Sandbox mapping (R-20) | `__tests__/unit/backends/sandbox-inference.test.ts` |
| Cost incl. reasoning tokens (R-23) | `__tests__/unit/backends/codex-backend.test.ts` |
| Structured-output repair (R-24) | `__tests__/unit/backends/codex-structured-repair.test.ts` |
| Backend selection | `__tests__/unit/backends/backend-factory.test.ts` |
| Whose login (R-25 to R-27) | `__tests__/unit/codex-host-login.test.ts`, `__tests__/unit/runner-local-allowed.test.ts`, `__tests__/unit/codex-auth.test.ts`, `__tests__/unit/codex-credential-injection.test.ts` |

## Renumbered

The invariants were `INV-n`, which do not parse as criteria. Old to new:

- was INV-1 to INV-16, now R-1 to R-16 (same number)
- was INV-17, now retired, no id
- was INV-18 to INV-20, now R-18 to R-20 (same number)
- was INV-21 (stdio MCP injection, §7), now retired, no id
- was INV-22 (no reachable hook seam, §7), now R-22
- was INV-21 (reasoning tokens, §8), now R-23
- was INV-22 (structured output, §9), now R-24

New: R-25 to R-27 (§12).
