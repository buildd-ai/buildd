# Codex backend — behavioral spec

**Status:** living spec. Describes how the Codex worker backend *behaves* and the invariants that must hold. This is the regression contract: when you change the Codex backend, the statements here must stay true (or this doc changes in the same PR). It is **not** a build plan — the implementation shipped via PRs #869/#870/#871/#873/#874/#875.

**Scope:** the Codex backend at parity with the Claude backend on the buildd worker run loop. Runner code: `apps/runner/src/`. Backend abstraction: `apps/runner/src/backends/`. Orchestration loop: `apps/runner/src/workers.ts`.

> **How to use this for regression safety:** every numbered **INV** below is an invariant with a code anchor and a guarding test. Before merging a change to the Codex backend, confirm the touched INVs still hold and their tests pass. If a change intentionally alters one, update the INV and its test together.

---

## 1. Architecture: two channels out of `runStreamed`

`CodexBackend.runStreamed` (`apps/runner/src/backends/codex-backend.ts`) drives the worker loop through **two channels**, exactly mirroring the Claude backend:

1. **Yielded `BackendEvent`s** (`progress | turn_complete | complete | error`) → consumed by the main loop in `workers.ts` (review gate, nudges, completion, cost).
2. **`onProgress(sdkMsg)` → `workers.ts:handleMessage`** → drives **all** rich worker-state tracking: `toolCalls`, commit detection, milestones, phase/loop detection, MCP-call + MCP-failure tracking, error traces, the PR/artifact output-requirement gate, and `worker.lastAssistantMessage`.

`handleMessage` is keyed on **Claude SDK message shapes** (`system:init`, `assistant`+`tool_use`, `user`+`tool_result`, `result`). Codex emits `item.completed`/`turn.completed`, which match none of those. The **event adapter** (§2) bridges the gap so `handleMessage` needs zero Codex-awareness.

> **INV-1.** Channel 2 feeds `handleMessage` Claude-shaped messages only. `handleMessage` contains no Codex-specific branching for tool/commit/milestone tracking. *Anchor:* `codex-backend.ts` loops `mapCodexEventToSdkMessages(event)` into `onProgress` (~L132). *Guard:* `codex-events.test.ts`.

---

## 2. Event adapter contract — `mapCodexEventToSdkMessages`

`apps/runner/src/backends/codex-events.ts`. **Pure** function, `(event, ctx) → SDKMessage[]`. Defensive: any unrecognized/partial event yields `[]`. This is the single highest-leverage regression surface — a wrong mapping silently disables a whole tracking subsystem.

| Codex event / item | → SDKMessage(s) | Why it matters |
|---|---|---|
| `thread.started` (has `thread_id`) | `{ system, subtype:'init', session_id: thread_id }` | seeds session/thread id (§5) |
| `item.completed` `agent_message` | `assistant` text block | sets `lastAssistantMessage` (INV-4), worker output |
| `item.completed` `reasoning` | `assistant` text block | surfaced as text, not a tool call |
| `item.completed` `command_execution` | `assistant` `tool_use { name:'Bash', input:{command}, id }` | **commit detection keys off Bash `git commit`** |
| `item.completed` `file_change` (per change) | `tool_use` per change: `add`→`Write`, `update`/unknown→`Edit`, `delete`→`Bash(rm)`; id `${id}:${index}` | milestone/phase labels |
| `item.completed` `mcp_tool_call` | `tool_use { name:'mcp__'+server+'__'+tool, input: arguments, id }` | **PR/artifact gate reads `input.action`** |
| `item.completed` `web_search` | `tool_use { name:'WebSearch', input:{query}, id }` | tool tracking |
| failed `command_execution` (`status:'failed'` or `exit_code≠0`) | the `tool_use` **plus** a `user` `tool_result{is_error:true}` | error-trace capture |
| failed `mcp_tool_call` (`status:'failed'`) | the `tool_use` **plus** a `user` `tool_result{is_error:true}` | MCP-failure tracking |
| `item.completed` `todo_list` | `[]` (dropped) | see INV-7 |
| `turn.completed` / `turn.started` / `item.started` / `item.updated` / `error` | `[]` | see INV-2, INV-3 |

> **INV-2 (no result here).** The adapter never emits a Claude `result` message. `result` is emitted once by `codex-backend` on final completion (§4 / INV-8). *Reason:* double `result` over-counts `worker.resultMeta`.

> **INV-3 (terminal items only).** Only `item.completed` is mapped; `item.started`/`item.updated` yield `[]`. *Reason:* in-progress items would double-count tool calls and trip loop detection.

> **INV-4 (stable tool_use ids).** Every synthesized `tool_use` carries a stable `id` derived from the Codex `item.id` (file_change uses `${id}:${index}`). *Reason:* `handleMessage` correlates `tool_result.tool_use_id` against the stored toolCall for error traces; the toolCall push site must persist this id. *Guard:* `codex-events.test.ts`, `get-error-traces` paths.

> **INV-5 (failures are dual-emitted).** A failed command or MCP call emits **both** the `assistant` `tool_use` and a `user` `tool_result{is_error}`. *Reason:* error-trace + MCP-failure tracking consume the `user`/`tool_result` shape. *Guard:* `codex-events.test.ts`.

> **INV-6 (mcp arguments carried through).** `mcp_tool_call.arguments` is passed as `tool_use.input` when present. The SDK `.d.ts` omits `arguments`, but the CLI JSONL emits it (verified, §10). *Reason:* the output-requirement gate matches `mcp__buildd__buildd` calls by `input.action` (e.g. `create_pr`). *Guard:* `codex-events.test.ts` mcp case.

> **INV-7 (todo_list is not a tool_use).** `todo_list` items map to `[]`. *Reason:* repeated todo updates would trip `detectRepetitiveToolCalls`. The live todo still surfaces via channel-1 progress.

---

## 3. Worker-state invariants driven through the adapter

These are the integration requirements (R1/R2 from the parity work) that make the loop function — not just the mapping shape.

> **INV-8 (`lastAssistantMessage` is set for Codex).** `handleMessage`'s assistant branch sets `worker.lastAssistantMessage` from `agent_message` text (`workers.ts:~2213`). *Reason:* the review-loop exit gate (checks `<promise>DONE</promise>`) and the completion summary both read it; without it every Codex task burns all review iterations then exits with an empty summary. *Guard:* `codex-last-assistant-message.test.ts`.

> **INV-9 (commit→PR linkage).** PR detection fires via the **MCP `create_pr` arm** of the gate (INV-6), not via commit detection. Commit detection (Bash `git commit`) populates `commits` but does **not** populate `commits[].prUrl`. Do not claim commit-based PR detection.

---

## 4. Multi-turn loop + completion + abort

`CodexBackend` runs a **turn loop** on a single persistent Codex `Thread` (`thread.runStreamed(prompt)` is callable repeatedly). `CodexBackendConfig.inputStream` (an `AsyncIterable`) carries `workers.ts`'s review/nudge/steering enqueues into Codex, mirroring the Claude `streamInput` path (`workers.ts` passes `inputStream` at ~L1552/L1570).

Loop shape: run initial prompt → on `turn.completed`, park on `inputStream.next()` → a message drives another turn on the same thread; stream-end (or no stream) yields `complete` and returns.

> **INV-10 (single `complete`, single `result`).** `complete` is yielded in exactly one place (after the loop). The synthetic `result` (`resultEvent('success', …)`) is emitted once, with **aggregate** usage/cost accumulated across turns — never per turn. *Reason:* per-turn emission over-counts `worker.resultMeta`. *Anchor:* `codex-backend.ts` final-completion block (~L266). *Guard:* `codex-multiturn.test.ts`.

> **INV-11 (no `complete` leaks between turns).** Between turns the backend only ever *parks* on `it.next()`; it does not yield `complete`. When `workers.ts` breaks its consuming `for await` (DONE/error/exhausted), the runtime calls this generator's `.return()`, unwinding from the parked `await` without resuming past it. *Reason:* a mid-loop `complete` would make `workers.ts` exit early. *Guard:* `codex-multiturn.test.ts`.

> **INV-12 (abort reaches Codex).** `RunStreamedOpts.signal` is honored: the backend returns immediately if `signal.aborted` before start, and breaks the `for await` on abort mid-stream, which closes the SDK event generator whose `finally` kills the `codex exec` child. *Reason:* loop-detection, AskUserQuestion abort, user abort, and destroy all call `abortController.abort()`; without this the turn keeps running and cost keeps accruing. *Anchor:* `signal` checks in `codex-backend.ts` (~L83/L116/L225/L260); passed from `workers.ts:~1594`. *Guard:* `codex-multiturn.test.ts`.

> **INV-13 (budget enforcement).** For non-OAuth auth, when accumulated `totalCostUsd > maxBudgetUsd` the backend emits a final `result` (`error_max_budget_usd`) then an `error` and returns. OAuth (seat-based) is exempt.

---

## 5. Thread resume + CODEX_HOME persistence

> **INV-14 (resume by thread id, not sessionId).** A follow-up resumes the prior Codex thread via `RunStreamedOpts.resumeThreadId` → `codex.resumeThread(id)`. The id lives in `worker.codexThreadId` (set in `handleMessage` from the synthetic `system:init.session_id`, `workers.ts:~2056`) — **never** in `worker.sessionId` (which is Claude's resume key). `workers.ts` passes `resumeThreadId` only for `taskBackend==='codex'` (~L1597). *Guard:* `codex-resume.test.ts`, `codex-resume-branch.test.ts`.

> **INV-15 (stable per-worker CODEX_HOME).** Codex sessions are persisted under `$CODEX_HOME/sessions/`. The worker uses a **stable per-worker** CODEX_HOME (`stableCodexHomePath(workerId)`), not a per-run `mkdtemp`, so rollouts survive a restart. Auth/config/MCP are re-materialized each run **without** touching `sessions/`. Teardown (`teardownStableCodexHome`) happens only when the worker is truly terminal (`workers.ts:~481/489`). *Reason:* cross-restart resume (INV-14) finds no session otherwise. *Guard:* `codex-stable-home.test.ts`.

---

## 6. Role / skills / context — AGENTS.md + DONE sentinel

Codex has no Skill tool, no `settingSources`, and **no `instructions` thread option** (`ThreadOptions` is only `{model, sandboxMode, workingDirectory, skipGitRepoCheck}`). Parity is delivered via Codex's native **`AGENTS.md`** (re-read from cwd each turn).

> **INV-16 (AGENTS.md carries role/skills/CLAUDE.md).** When `taskBackend==='codex'`, the worker writes role persona + **inlined resolved skill content** + (when `useClaudeMd`) CLAUDE.md content into `AGENTS.md` in the repo cwd, and prepends a prompt pointer telling Codex to read it (`workers.ts:~1476-1526`). The file is restored/removed in the finally block (~L1978). *Guard:* `codex-instructions.test.ts`.

> **INV-17 (DONE sentinel instruction).** The AGENTS.md/preamble instructs Codex to emit `<promise>DONE</promise>` when complete. *Reason:* the review-loop exit gate (INV-8) depends on the sentinel; without the instruction the gate can never trip. *Anchor:* `DONE_SENTINEL`, `workers.ts:~1526/1663/1696`.

---

## 7. Sandbox / approval / effort — config.toml

The SDK exposes no approval/effort/sandbox-policy thread options, so these are written to `config.toml` by `writeCodexMcpConfig` (`apps/runner/src/codex-auth.ts`).

> **INV-18 (MCP auto-approve — was a live prod bug).** `writeCodexMcpConfig` emits `default_tools_approval_mode = "approve"` scoped to `[mcp_servers.buildd]` (`codex-auth.ts:~164`). *Reason:* headless `codex exec` has approval `never` with no TTY, so without this **every** buildd MCP call (`create_pr`, `update_progress`, `complete_task`, artifacts, memory) is auto-cancelled. Scope is minimal — it does not loosen approvals globally. *Guard:* `codex-mcp-config.test.ts`.

> **INV-19 (effort mapping).** `configuredEffort` maps to `model_reasoning_effort` in `config.toml` (`codex-auth.ts:~119-153`); buildd `max` collapses to codex `high`. *Reason:* otherwise `create_task { effort }` is a silent no-op for Codex. *Guard:* `codex-effort-config.test.ts`.

> **INV-20 (sandbox mapping).** buildd permission policy + `task.kind` → Codex `sandboxMode` (`read-only` | `workspace-write`; default `workspace-write`). Dangerous-bash blocking relies on the **Codex sandbox**, not buildd's PreToolUse hook (which has no Codex equivalent). *Guard:* `sandbox-inference.test.ts`.

---

## 8. Cost accounting

> **INV-21 (reasoning tokens billed as output).** `turn.completed.usage.reasoning_output_tokens` is folded into output-token cost (`codex-backend.ts:~181`). *Reason:* reasoning tokens bill as output but arrive in a separate field the estimator previously ignored, under-counting cost. *Guard:* `codex-backend.test.ts`.

Price-per-model is resolved by `priceForModel` with `CODEX_*_USD_PER_M_TOKENS` env overrides.

---

## 9. Structured output

The SDK has **no schema param** (`Input = string`). Structured output is best-effort:

> **INV-22 (parse + bounded repair).** When `outputSchema` is set, the backend `JSON.parse`s the agent's final text (tolerating code-fence prose via balanced-brace extraction) and checks load-bearing constraints (top-level `type` + `required`). On failure it self-drives up to `MAX_REPAIR_ATTEMPTS` (2) repair turns asking for valid JSON, independent of the external input stream. *Anchor:* `tryParseStructuredOutput`/`buildRepairPrompt`. *Guard:* `codex-structured-repair.test.ts`.

---

## 10. Verified SDK facts (assumption ledger — `@openai/codex-sdk` 0.44.0 / codex-cli 0.140)

A bump that breaks any of these breaks the spec above. Re-verify on SDK upgrade.

- Events: `thread.started{thread_id}`, `turn.started`, `turn.completed{usage}`, `turn.failed{error}`, `item.started|updated|completed{item}`, `error{message}`.
- `ThreadItem` union: `agent_message{id,text}`, `reasoning`, `command_execution{id,command,exit_code,status,aggregated_output}`, `file_change{changes:[{path,kind:'add'|'update'|'delete'}],status}`, `mcp_tool_call{id,server,tool,arguments,result,error,status}`, `web_search{query}`, `todo_list{items}`, `error`. **No `create` file-change kind exists.**
- `mcp_tool_call` **carries `arguments`** at runtime even though the `.d.ts` omits it (INV-6).
- `Thread` supports multiple consecutive turns; `thread.runStreamed(input: string)` is repeatable. `Input = string` — **no multimodal**.
- `codex.resumeThread(id, options)` exists; `thread.id` populated after the first turn starts. Sessions persist under `$CODEX_HOME/sessions/`; the SDK spawns `codex exec` with inherited `CODEX_HOME` and never overrides it.
- `ThreadOptions = {model, sandboxMode, workingDirectory, skipGitRepoCheck}` only — no `instructions`/`approvalMode`/`effort` (hence config.toml, §7).
- `turn.completed.usage` includes `reasoning_output_tokens` (INV-21).

---

## 11. Non-goals (documented, intentionally not built)

- **Subagents / agent teams / delegation:** no Codex SDK equivalent. Route delegation-heavy roles to Claude; surface a warning when a Codex task requests delegation.
- **File checkpointing / `rewindFiles`:** Claude-SDK-specific. Rely on git.
- **Images / multimodal:** `Input = string`. `resolvePrompt` throws on non-text prompts (`codex-backend.ts`); route image-attachment tasks to Claude.

---

## 12. Test coverage map

| Area | Tests |
|---|---|
| Event adapter mappings (INV 2–7) | `__tests__/unit/backends/codex-events.test.ts` |
| Multi-turn / abort / single-complete (INV 10–13) | `__tests__/unit/backends/codex-multiturn.test.ts` |
| `lastAssistantMessage` (INV-8) | `__tests__/unit/codex-last-assistant-message.test.ts` |
| Resume (INV-14) | `__tests__/unit/backends/codex-resume.test.ts`, `__tests__/unit/codex-resume-branch.test.ts` |
| Stable CODEX_HOME (INV-15) | `__tests__/unit/codex-stable-home.test.ts` |
| AGENTS.md role/skills (INV-16) | `__tests__/unit/codex-instructions.test.ts` |
| MCP approve / config (INV-18) | `__tests__/unit/codex-mcp-config.test.ts` |
| Effort mapping (INV-19) | `__tests__/unit/codex-effort-config.test.ts` |
| Sandbox mapping (INV-20) | `__tests__/unit/backends/sandbox-inference.test.ts` |
| Cost incl. reasoning tokens (INV-21) | `__tests__/unit/backends/codex-backend.test.ts` |
| Structured-output repair (INV-22) | `__tests__/unit/backends/codex-structured-repair.test.ts` |
| Backend selection | `__tests__/unit/backends/backend-factory.test.ts` |
