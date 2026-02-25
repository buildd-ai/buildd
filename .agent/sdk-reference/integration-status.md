# Integration Status & Changelog

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## Buildd Integration Status (v0.2.55)

Features fully integrated in both `worker-runner.ts` and `local-ui/workers.ts`:
- `SDKTaskStartedMessage` — subagent lifecycle tracking
- `SDKRateLimitEvent` — rate limit surfacing to dashboard
- `SDKTaskNotificationMessage` — subagent completion tracking
- `SDKFilesPersistedEvent` — file checkpoint tracking
- All 13 hook events (PreToolUse, PostToolUse, PostToolUseFailure, Notification, PreCompact, PermissionRequest, TeammateIdle, TaskCompleted, SubagentStart, SubagentStop, SessionStart, SessionEnd, ConfigChange)
- Structured output via `outputFormat`
- File checkpointing via `enableFileCheckpointing`
- Agent teams via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Skills-as-subagents via `agents` option
- In-process MCP server (worker-runner.ts) and subprocess MCP server (local-ui)
- `sessionId` for worker/session correlation
- Claude Sonnet 4.6 in model lists

## Pending Enhancements (Buildd tasks created)

### From v0.2.49

| Enhancement | SDK Feature | Priority | Status |
|-------------|------------|----------|--------|
| Add `ConfigChange` hook for config audit trails | Enterprise security auditing of config changes | P3 | Task created |
| Use model capability discovery for dynamic effort/thinking | `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking` | P3 | Task created |
| Worktree isolation for subagents | `isolation: "worktree"` on agent definitions | P2 | Task created |
| Bump SDK pin to `>=0.2.49` | WASM memory fix, CWD recovery, non-interactive perf, MCP auth caching | P2 | Done (all packages at `>=0.2.49`) |
| Update 1M context beta to target Sonnet 4.6 | Sonnet 4.5 1M being removed | P2 | Task created |
| Expose `promptSuggestion()` in local-ui | Offer next-step suggestions in dashboard UI | P3 | Task created |
| Display permission suggestions in local-ui | `permission_suggestions` on safety check ask responses | P3 | Task created |

### From v0.2.50–0.2.55 (NEW)

| Enhancement | SDK Feature | Priority | Status |
|-------------|------------|----------|--------|
| Bump SDK pin to `>=0.2.55` | 9 memory leak fixes, headless startup perf, agent teams GC fix, tool result 50K threshold | **P1** | Recommended |
| Pass account identity env vars to SDK | `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL` for clean telemetry | **P1** | Recommended |
| Add `CLAUDE_CODE_DISABLE_1M_CONTEXT` workspace config | Cost control option for accounts that don't need 1M context | P2 | Recommended |
| WorktreeCreate/WorktreeRemove hooks for skill worktrees | Custom VCS setup/teardown when skills run in isolated worktrees | P3 | Recommended |
| Evaluate `claude remote-control` for external integrations | New subcommand enables local environment serving | P3 | Research needed |
| Update HTTP hooks to use `allowedEnvVars` | Security: env var interpolation now requires explicit allowlist | P2 | If using HTTP hooks |

## Completed Integrations

- **Background agent definitions** — `useBackgroundAgents` config adds `background: true` to skill-as-subagent definitions; `SubagentTask.isBackground` tracks background status in local-ui

- **SDK pin `>=0.2.47`** — All packages now pin `>=0.2.47` (#94)
- **`last_assistant_message` in Stop hook** — Integrated in both workers.ts and worker-runner.ts (#92)
- **`tool_use_id` on task notifications** — Integrated (#90)
- **1M context beta** — Integrated conditionally for Sonnet models via `extendedContext` config
- **maxTurns** — Integrated in worker-runner.ts via workspace/task config
- **Effort/thinking controls** — `effort`, `thinking` options integrated (#82)
- **Fallback model** — `fallbackModel` option integrated (#81)

## Python SDK Evaluation (2026-02-18)

**Result: Not recommended for Buildd workers.** See [`.agent/python-sdk-evaluation.md`](../python-sdk-evaluation.md) for full evaluation. Key findings:
- Both Python (v0.1.37) and TypeScript (v0.2.45) SDKs spawn the same Node.js CLI subprocess
- Python SDK does not eliminate Node.js dependency or reduce startup time
- Significant feature gaps: missing `sessionId`, `AbortController`, `SessionStart`/`SessionEnd`/`Notification` hooks

---

## CLI v2.1.32–2.1.55 Changelog (SDK-Relevant)

| CLI Version | SDK Version | Key Changes |
|-------------|-------------|-------------|
| 2.1.55 | 0.2.55 | BashTool Windows EINVAL fix |
| 2.1.53 | 0.2.53 | Graceful shutdown stale session fix; bulk agent kill aggregate notification; `--worktree` first launch fix; WASM crash fixes (Linux x64, Windows) |
| 2.1.52 | 0.2.52 | VS Code Windows extension fix |
| 2.1.51 | 0.2.51 | `claude remote-control`; account identity env vars (`CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_ORGANIZATION_UUID`); HTTP hooks `allowedEnvVars` security; HTTP hooks sandbox routing; tool result 50K disk threshold (was 100K); BashTool login shell skip; plugin git timeout config; plugin npm registry support; `/model` picker human-readable labels; duplicate `control_response` fix |
| 2.1.50 | 0.2.50 | 9 memory leak fixes (agent teams, file history, TaskOutput, CircularBuffer, shell refs, LSP, completed tasks, caches, AppState); `WorktreeCreate`/`WorktreeRemove` hooks; `isolation: worktree` on agent defs; `claude agents` CLI; `CLAUDE_CODE_DISABLE_1M_CONTEXT`; Opus 4.6 1M fast mode; `CLAUDE_CODE_SIMPLE` enhancements; headless startup perf; LSP `startupTimeout`; session/symlink fix; prompt cache fix |
| 2.1.49 | 0.2.49 | `ConfigChange` hook; model capability discovery; worktree isolation; Sonnet 4.6 1M context; WASM memory fix; non-interactive perf; MCP auth caching; CWD recovery; Unicode edit fix; `permission_suggestions` on safety checks; `disableAllHooks` managed settings hierarchy fix; startup perf (analytics batching, MCP tool token batching); `--resume` picker XML tag fix |
| 2.1.47 | 0.2.47 | `promptSuggestion()`; `tool_use_id` on task notifications; `last_assistant_message` on Stop/SubagentStop; memory & perf improvements |
| 2.1.46 | 0.2.46 | claude.ai MCP connectors; orphaned process fix (macOS) |
| 2.1.45 | 0.2.45 | Sonnet 4.6; `SDKTaskStartedMessage`; `SDKRateLimitEvent`; Agent Teams Bedrock/Vertex env fix; Task tool crash fix |
| 2.1.44 | 0.2.44 | Auth refresh error fixes |
| 2.1.43 | 0.2.43 | AWS auth refresh 3-min timeout; structured-outputs beta header fix |
| 2.1.42 | 0.2.42 | Startup perf (deferred Zod); better prompt cache hit rates |
| 2.1.41 | 0.2.41 | Background task notifications in streaming SDK mode; MCP image crash fix; `claude auth` CLI commands |
| 2.1.39 | 0.2.39 | Terminal rendering perf; fatal error display fix; process hanging fix |
| 2.1.38 | 0.2.38 | Heredoc delimiter security fix; `.claude/skills` writes blocked in sandbox |
| 2.1.34 | 0.2.34 | Agent teams crash fix; sandbox `excludedCommands` bypass security fix |
| 2.1.33 | 0.2.33 | Agent memory; Task(agent_type) restriction; TeammateIdle/TaskCompleted hooks; PreToolUse `updatedInput` |
| 2.1.32 | 0.2.32 | Opus 4.6; agent teams research preview; auto memory; skills from additional dirs |

### Key Fixes for Buildd Workers

**v2.1.50–v2.1.55 (NEW)**:
- **Agent teams memory leak fix** — Completed teammate tasks now garbage collected from session state (v2.1.50) — critical for skills-as-subagents
- **9 memory leak fixes** — File history, TaskOutput, CircularBuffer, shell refs, LSP diagnostics, completed tasks, caches, AppState (v2.1.50) — critical for long-running workers
- **Headless startup perf** — Deferred WASM/UI imports for `-p` mode (v2.1.50) — benefits all workers
- **Tool result 50K threshold** — Reduced from 100K, improving context window usage (v2.1.51)
- **Account identity env vars** — `CLAUDE_CODE_ACCOUNT_UUID`/`CLAUDE_CODE_USER_EMAIL`/`CLAUDE_CODE_ORGANIZATION_UUID` (v2.1.51) — eliminates telemetry race condition
- **Graceful shutdown fix** — No longer leaves stale sessions during teardown (v2.1.53)
- **Bulk agent kill** — Single aggregate notification instead of one per agent (v2.1.53)
- **WASM crash fix** — Fixed interpreter crash on Linux x64 (v2.1.53)

**v2.1.49**:
- **WASM memory fix** — Fixed unbounded WASM memory growth during long sessions (v2.1.49)
- **CWD recovery** — Shell commands no longer permanently fail after a command deletes its own working directory (v2.1.49)
- **Non-interactive performance** — Improved performance in `-p` mode (v2.1.49) — benefits all Buildd workers
- **Permission suggestions on safety checks** — `permission_suggestions` now populated when safety checks trigger ask responses, enabling SDK consumers to display permission options (v2.1.49)
- **`disableAllHooks` managed settings fix** — Non-managed settings can no longer disable managed hooks set by enterprise policy (v2.1.49) — security fix
- **Startup perf: batched token counting** — MCP tool token counting batched into single API call; analytics token counting reduced (v2.1.49)

**Earlier**:
- **Orphaned process fix** — Claude Code processes no longer persist after terminal disconnect on macOS (v2.1.46)
- **Agent Teams env propagation** — tmux-spawned processes for Bedrock/Vertex/Foundry (v2.1.45)
- **Task tool crash** (ReferenceError on completion) fixed (v2.1.45)
- **V2 Session.stream()** no longer returns prematurely when background subagents run (v0.2.45)
- **Shell memory leak** — RSS no longer grows unboundedly with large command output (v0.2.45)
- **Background task notifications** now delivered in streaming SDK mode (v2.1.41)
- **Sandbox excluded commands** can no longer bypass `autoAllowBashIfSandboxed` (v2.1.34) — security fix
