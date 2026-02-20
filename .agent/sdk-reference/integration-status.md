# Integration Status & Changelog

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## Buildd Integration Status (v0.2.49)

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

| Enhancement | SDK Feature | Priority | Status |
|-------------|------------|----------|--------|
| Add `ConfigChange` hook for config audit trails | Enterprise security auditing of config changes | P3 | Task created |
| Use model capability discovery for dynamic effort/thinking | `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking` | P3 | Task created |
| Worktree isolation for subagents | `isolation: "worktree"` on agent definitions | P2 | Task created |
| Bump SDK pin to `>=0.2.49` | WASM memory fix, CWD recovery, non-interactive perf, MCP auth caching | P2 | Task created |
| Update 1M context beta to target Sonnet 4.6 | Sonnet 4.5 1M being removed | P2 | Task created |
| Expose `promptSuggestion()` in local-ui | Offer next-step suggestions in dashboard UI | P3 | Task created |

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

## CLI v2.1.32–2.1.49 Changelog (SDK-Relevant)

| CLI Version | SDK Version | Key Changes |
|-------------|-------------|-------------|
| 2.1.49 | 0.2.49 | `ConfigChange` hook; model capability discovery; worktree isolation; Sonnet 4.6 1M context; WASM memory fix; non-interactive perf; MCP auth caching; CWD recovery; Unicode edit fix |
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

- **WASM memory fix** — Fixed unbounded WASM memory growth during long sessions (v2.1.49)
- **CWD recovery** — Shell commands no longer permanently fail after a command deletes its own working directory (v2.1.49)
- **Non-interactive performance** — Improved performance in `-p` mode (v2.1.49) — benefits all Buildd workers
- **Orphaned process fix** — Claude Code processes no longer persist after terminal disconnect on macOS (v2.1.46)
- **Agent Teams env propagation** — tmux-spawned processes for Bedrock/Vertex/Foundry (v2.1.45)
- **Task tool crash** (ReferenceError on completion) fixed (v2.1.45)
- **V2 Session.stream()** no longer returns prematurely when background subagents run (v0.2.45)
- **Shell memory leak** — RSS no longer grows unboundedly with large command output (v0.2.45)
- **Background task notifications** now delivered in streaming SDK mode (v2.1.41)
- **Sandbox excluded commands** can no longer bypass `autoAllowBashIfSandboxed` (v2.1.34) — security fix
