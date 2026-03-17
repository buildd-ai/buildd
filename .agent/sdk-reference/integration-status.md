# Integration Status & Changelog

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## Buildd Integration Status (v0.2.77)

Features fully integrated in both `worker-runner.ts` and `runner/workers.ts`:
- `SDKTaskStartedMessage` — subagent lifecycle tracking
- `SDKRateLimitEvent` — rate limit surfacing to dashboard
- `SDKTaskNotificationMessage` — subagent completion tracking
- `SDKFilesPersistedEvent` — file checkpoint tracking
- All 13 original hook events (PreToolUse, PostToolUse, PostToolUseFailure, Notification, PreCompact, PermissionRequest, TeammateIdle, TaskCompleted, SubagentStart, SubagentStop, SessionStart, SessionEnd, ConfigChange) + 3 new hooks available: PostCompact, Elicitation, ElicitationResult (v0.2.76)
- Structured output via `outputFormat`
- File checkpointing via `enableFileCheckpointing`
- Agent teams via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Skills-as-subagents via `agents` option
- In-process MCP server (worker-runner.ts) and subprocess MCP server (runner)
- `sessionId` for worker/session correlation
- Claude Sonnet 4.6 in model lists

## Pending Enhancements (Buildd tasks created)

| Enhancement | SDK Feature | Priority | Status |
|-------------|------------|----------|--------|
| **Bump SDK pin to `>=0.2.77`** | Opus 4.6 64k default / 128k max output tokens, `allowRead` sandbox filesystem setting, compound bash permission rule fix, PreToolUse hook security fix, auto-updater memory leak fix, session resume memory optimization, Write tool CRLF fix, non-streaming cost tracking fix, worktree race condition fix, Agent tool `resume` parameter removed (use `SendMessage`), `SendMessage` auto-resumes stopped agents | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.76`** | MCP elicitation support, `Elicitation`/`ElicitationResult` hooks, `PostCompact` hook, `worktree.sparsePaths` setting, `/effort` slash command, deferred tools compaction fix, auto-compaction circuit breaker, stale worktree cleanup, code review inline comment confirmation | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.74`** | `autoMemoryDirectory` setting, `/context` optimization suggestions, managed policy `ask` rule enforcement, full model IDs in agent frontmatter, streaming memory leak fix, `SessionEnd` hook timeout config, `modelOverrides` setting, subagent model downgrade fix on Bedrock/Vertex, RTL text rendering fix, CPU freeze fix on complex bash permission prompts | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.72`** | Prompt cache fix (up to 12x input cost reduction), `ExitWorktree` tool, `Agent` model override restored, `/plan` with description, CLAUDE.md HTML comment hiding, worktree isolation fixes, parallel tool call fix, bash permission improvements | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.71`** | `/loop` command, cron scheduling, `SDKTaskStartedMessage.prompt` field, stdin freeze fix, background agent notification fix, `--print` hang fix, plugin fixes, CLI binary size reduction | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.70`** | API gateway compat, MCP cache fix, ToolSearch fix, compaction image preservation, reduced subagent token usage | **P1** | **Done** |
| **Bump SDK pin to `>=0.2.69`** | DirectConnectTransport, supportedAgents(), hook agent_id/agent_type, Opus 4.6 medium effort default, memory fixes, `/claude-api` skill, `/reload-plugins`, git instructions toggle | **P1** | **Done** |
| **Handle MCP elicitation in runner** | `Elicitation`/`ElicitationResult` hooks — surface MCP input requests in dashboard UI | **P2** | **New** |
| **Use `PostCompact` hook for compaction monitoring** | Track compaction frequency and token reduction for observability | **P3** | **New** |
| **Evaluate `worktree.sparsePaths` for runner** | Sparse checkout could speed up subagent worktree creation in large repos | **P3** | **New** |
| **Session history in dashboard** | `listSessions()` + `getSessionMessages()` — browse past worker conversations | **P1** | **New** |
| **Surface `task_progress` events in dashboard** | Real-time cost/progress for background subagents | **P2** | **New** |
| **Pass account identity env vars to SDK** | `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_ORGANIZATION_UUID` | **P2** | **New** |
| **Handle `WorktreeCreate`/`WorktreeRemove` hooks** | Custom setup/cleanup for subagent worktrees | **P3** | **New** |
| **Evaluate `remote-control` for hybrid execution** | `claude remote-control` — expanded to more users in v2.1.58 | **P3** | **New** |
| **Reduce tool result disk threshold** | Results > 50K persisted to disk (was 100K) — improves conversation longevity | **P3** | **Auto (CLI-side)** |
| **Use `persistSession: false` for ephemeral workers** | Skip disk persistence for fire-and-forget workers | **P3** | **New** |
| **Evaluate `spawnClaudeCodeProcess` for remote execution** | Custom process spawning for containers/VMs | **P3** | **New** |
| **Enable auto-memory for workers** | Workers accumulate cross-session learnings per workspace | **P3** | **New** |
| Add `ConfigChange` hook for config audit trails | Enterprise security auditing of config changes | P3 | Task created |
| Use model capability discovery for dynamic effort/thinking | `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking` | P3 | Task created |
| Worktree isolation for subagents | `isolation: "worktree"` on agent definitions | P2 | Task created |
| Update 1M context beta to target Sonnet 4.6 | Sonnet 4.5 1M being removed | P2 | Task created |
| Expose `promptSuggestion()` in runner | Offer next-step suggestions in dashboard UI | P3 | Task created |
| Display permission suggestions in runner | `permission_suggestions` on safety check ask responses | P3 | Task created |
| **Evaluate DirectConnectTransport for runner** | v0.2.64 — WebSocket connection to persistent `claude server`, stable session keys | **P1** | **New** |
| **Use `supportedAgents()` for dynamic skill discovery** | v0.2.63 — Query available subagents at runtime for dashboard display | **P2** | **New** |
| **Leverage `agent_id`/`agent_type` in hooks** | v0.2.64 — Per-skill cost tracking, subagent-specific monitoring | **P2** | **New** |
| **Evaluate HTTP hooks** | CLI v2.1.63 — POST JSON to URLs instead of shell commands | **P2** | **New** |
| **Progressive memory disclosure in buildd_memory** | Community pattern — Layered retrieval for ~10x token savings | **P2** | **New** |

## Completed Integrations

- **Background agent definitions** — `useBackgroundAgents` config adds `background: true` to skill-as-subagent definitions; `SubagentTask.isBackground` tracks background status in runner

- **SDK pin `>=0.2.77`** — All packages now pin `>=0.2.77`
- **SDK pin `>=0.2.76`** — All packages now pin `>=0.2.76`
- **SDK pin `>=0.2.74`** — All packages now pin `>=0.2.74`
- **SDK pin `>=0.2.72`** — All packages now pin `>=0.2.72`
- **SDK pin `>=0.2.71`** — All packages now pin `>=0.2.71`
- **SDK pin `>=0.2.70`** — All packages now pin `>=0.2.70`
- **SDK pin `>=0.2.69`** — All packages now pin `>=0.2.69`
- **SDK pin `>=0.2.68`** — All packages now pin `>=0.2.68`
- **SDK pin `>=0.2.49`** — All packages now pin `>=0.2.49`
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

## CLI v2.1.32–2.1.71 Changelog (SDK-Relevant)

| CLI Version | SDK Version | Key Changes |
|-------------|-------------|-------------|
| 2.1.77 | 0.2.77 | **Opus 4.6 64k default / 128k max output tokens**; **`allowRead` sandbox filesystem setting** (re-allow reads within `denyRead` regions); **`/copy N`** copies Nth-latest response; **Compound bash permission rule fix** (compound commands now save per-subcommand rules); **PreToolUse hook security fix** (`"allow"` no longer bypasses `deny` rules); **Auto-updater memory leak fix** (tens of GB from overlapping downloads); **Session resume optimization** (up to 45% faster, ~100-150MB less peak memory); **Progress message memory fix** (survived compaction); **Write tool CRLF fix**; **Non-streaming cost tracking fix**; **Beta schema stripping fix** (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`); **Worktree race condition fix** (stale cleanup vs resumed agent); **Agent tool `resume` removed** (use `SendMessage({to: agentId})`); **`SendMessage` auto-resumes stopped agents**; **macOS startup ~60ms faster** (parallel keychain read); **Background bash 5GB output kill**; auto-session naming from plans; `/fork` renamed to `/branch`; many terminal UI, clipboard, and IDE integration fixes |
| 2.1.76 | 0.2.76 | **MCP elicitation support** (structured input mid-task); **`Elicitation`/`ElicitationResult` hooks**; **`PostCompact` hook**; **`worktree.sparsePaths`** setting (sparse checkout for large monorepos); **`/effort` slash command**; `-n`/`--name` CLI flag for session display names; **deferred tools compaction fix** (array/number params rejected after compact); **auto-compaction circuit breaker** (stops after 3 retries); stale worktree cleanup; improved worktree startup perf; background agent partial result preservation on kill; model fallback notifications always visible; slash command "Unknown skill" fix; plan mode re-approval fix; voice mode keypress fix; 1M-context spurious errors fix; clipboard fix in tmux over SSH |
| 2.1.75 | 0.2.75 | **Code review inline comment confirmation** — `confirmed=true` required to post inline comments, preventing subagent probe comments from reaching customer PRs |
| 2.1.74 | 0.2.74 | **`/context` optimization suggestions**; **`autoMemoryDirectory` setting**; streaming memory leak fix (unbounded RSS growth); **managed policy `ask` rule enforcement** (security fix — user `allow`/skill `allowed-tools` can no longer bypass); full model IDs in agent frontmatter; `SessionEnd` hook timeout config (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`); MCP OAuth hang fix (port in use); RTL text rendering fix (Windows Terminal, VS Code); `--plugin-dir` local override behavior; LSP fix for Windows; voice mode macOS entitlement fix |
| 2.1.73 | 0.2.73 | **`modelOverrides` setting** (custom provider model IDs, Bedrock ARNs); **CPU freeze fix** on complex bash permission prompts; **skill file deadlock fix**; subagent model downgrade fix on Bedrock/Vertex/Foundry; bash output fix for multi-session projects; background bash process cleanup on agent exit; `SessionStart` hook double-fire fix on resume; Linux sandbox ripgrep fix; default Opus model updated to 4.6 on Bedrock/Vertex/Foundry; `/effort` command works during response; `/output-style` deprecated for `/config` |
| 2.1.72 | 0.2.72 | **Prompt cache fix** (up to 12x input cost reduction in `query()` calls); **`ExitWorktree` tool**; **`Agent` model override restored**; **`/plan` with description**; **CLAUDE.md HTML comment hiding**; **Simplified effort levels** (low/medium/high, removed max); **Bash permission improvements** (tree-sitter parsing, reduced false positives); **`/copy` write-to-file** (`w` key); **`CLAUDE_CODE_DISABLE_CRON`** env var; added `lsof`/`pgrep`/`tput`/`ss`/`fd`/`fdfind` to bash allowlist; parallel tool call fix (failed Read/WebFetch/Glob no longer cancels siblings); worktree isolation fixes (Task resume cwd, background notification paths); skill hooks double-fire fix; `/clear` no longer kills background agents; team agents inherit leader model; improved CPU utilization in long sessions; 510KB bundle size reduction; many plugin, voice, and permission rule fixes |
| 2.1.71 | 0.2.71 | **`/loop` command** (recurring prompt interval); **cron scheduling tools**; **`SDKTaskStartedMessage.prompt`** field (subagent prompt exposure); **rebindable voice push-to-talk key**; **CLI binary size reduction** (~3-5%); stdin freeze fix in long sessions; 5-8s startup freeze fix (CoreAudio); OAuth token refresh startup freeze fix; forked conversation plan isolation fix; Read tool oversized image fix; background agent completion notification fix (missing output path); `--print` hang fix with team agents; plugin installation persistence fix; claude.ai connector reconnection fix; improved bridge session reconnection after wake; deferred native image processor loading |
| 2.1.70 | 0.2.70 | **API gateway compat** (`ANTHROPIC_BASE_URL` proxy fix); **ToolSearch fix** (empty model responses after tool search); **MCP server cache fix** (prompt-cache bust with `instructions`); **Compaction image preservation** for prompt cache reuse; **Reduced subagent token usage** (more concise reports); **Remote Control poll rate** reduced ~300× (10min vs 1-2s); **Startup memory** reduced ~426KB; **Prompt input re-renders** reduced ~74%; VS Code spark icon + MCP management dialog; clipboard fix for CJK/emoji on Windows/WSL; Enter-over-SSH fix |
| 2.1.69 | 0.2.69 | **`/claude-api` skill**; **`/reload-plugins`** command; **`includeGitInstructions`** setting + `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` env var; **Remote Control naming** (`/remote-control <name>`); **Voice STT**: 10 new languages (20 total); effort level display in spinner; agent name in terminal title; **TLS proxy** `sandbox.enableWeakerNetworkIsolation` (macOS); `pluginTrustMessage` managed setting; numeric keypad support |
| 2.1.68 | 0.2.68 | **Opus 4.6 defaults to medium effort** (Max/Team); "ultrathink" keyword re-introduced; **Opus 4.0/4.1 removed** from first-party API (auto-migrate to 4.6) |
| 2.1.66 | 0.2.66 | Reduced spurious error logging |
| 2.1.63 | 0.2.63 | **`/simplify` and `/batch` slash commands**; **HTTP hooks** (POST JSON to URLs); **Project configs shared across worktrees**; `supportedAgents()` method; MCP replacement tool fix in subagents; 4+ memory leak fixes (bridge polling, MCP OAuth, hooks config, MCP caching); MCP OAuth manual URL fallback; `/clear` skills reset fix; `/model` active model display |
| 2.1.64 | 0.2.64 | **`DirectConnectTransport`** (WebSocket connection to `claude server`, stable session keys); `agent_id`/`agent_type` in hook events; `blobSavedTo` on ReadMcpResourceToolOutput; reverted `'Agent'` back to `'Task'` tool name (breaking change fix); malformed `updatedPermissions` no longer blocks with ZodError |
| 2.1.62 | 0.2.62 | Prompt suggestion cache regression fix |
| 2.1.61 | 0.2.61 | Concurrent config write corruption fix (Windows) |
| 2.1.59 | 0.2.59 | **Auto-memory** (persistent agent learnings, `/memory` command); **`/copy` command** (code block picker); smarter bash "always allow" prefix suggestions; **multi-agent memory optimization** (release completed subagent task state); MCP OAuth token refresh race fix; config file corruption fix (multiple instances); shell CWD-deleted error fix |
| 2.1.58 | 0.2.58 | **Remote Control expanded** to more users |
| 2.1.56 | 0.2.56 | VS Code Windows crash fix (another cause) |
| 2.1.55 | 0.2.55 | BashTool Windows EINVAL fix |
| 2.1.53 | 0.2.53 | **`listSessions()`** API; UI flicker fix; bulk agent kill aggregated notification; graceful shutdown stale Remote Control session fix; `--worktree` first-launch fix; Windows panic/crash/WASM fixes |
| 2.1.52 | 0.2.52 | VS Code Windows crash fix |
| 2.1.51 | 0.2.51 | `claude remote-control` subcommand; `task_progress` events for background agents; Bun binary fix; unbounded memory growth fix (UUID tracking); `session.close()` persistence fix; account identity env vars (`CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_ORGANIZATION_UUID`); tool result disk threshold 50K; plugin npm registry support; BashTool login shell skip; managed settings via plist/Registry |
| 2.1.50 | 0.2.50 | `WorktreeCreate`/`WorktreeRemove` hooks; `isolation: "worktree"` stable; `claude agents` CLI command; `CLAUDE_CODE_DISABLE_1M_CONTEXT` env var; Opus 4.6 1M context; `CLAUDE_CODE_SIMPLE` full strip-down; headless startup perf; LSP `startupTimeout`; 10+ memory leak fixes (teammate tasks, AppState, LSP, file history, CircularBuffer, TaskOutput, shell execution); symlink session resume fix; Linux glibc < 2.30 fix |
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

- **Opus 4.6 output token increase** — Default max increased to 64k, upper bound to 128k (v0.2.77). Benefits long-form Buildd worker outputs.
- **Auto-updater memory leak fix** — Overlapping binary downloads from repeated slash-command overlay open/close could accumulate tens of GB (v0.2.77). Critical for long-running runner processes.
- **Session resume optimization** — Up to 45% faster loading and ~100-150MB less peak memory on fork-heavy sessions (v0.2.77). Benefits workers resuming large sessions.
- **Progress message memory fix** — Progress messages no longer survive compaction, preventing unbounded memory growth (v0.2.77). Important for long-running workers.
- **Non-streaming cost tracking fix** — Cost and token usage now tracked when API falls back to non-streaming mode (v0.2.77). Ensures accurate Buildd cost reporting.
- **Worktree race condition fix** — Stale-worktree cleanup can no longer delete an agent worktree that was just resumed from a crash (v0.2.77). Prevents data loss for subagent worktrees.
- **Agent tool `resume` parameter removed** — Use `SendMessage({to: agentId})` instead (v0.2.77). Breaking change for any code using `resume` parameter.
- **`SendMessage` auto-resumes stopped agents** — No longer returns an error for stopped agents (v0.2.77). Simplifies agent lifecycle management.
- **Compound bash permission rule fix** — "Always Allow" on compound commands now saves per-subcommand rules instead of dead rules for full string (v0.2.77). Reduces repeated permission prompts in workers.
- **PreToolUse hook security fix** — `"allow"` from PreToolUse hooks can no longer bypass `deny` permission rules (v0.2.77). Security fix for enterprise managed settings.
- **Write tool CRLF fix** — Write tool no longer silently converts line endings when overwriting CRLF files (v0.2.77). Prevents file corruption.
- **Deferred tools compaction fix** — Deferred tools no longer lose input schemas (array/number parameters rejected) after conversation compaction (v0.2.76). Critical for long-running Buildd workers using ToolSearch/deferred tools.
- **Auto-compaction circuit breaker** — Auto-compaction now stops after 3 failed attempts instead of retrying indefinitely (v0.2.76). Prevents workers from getting stuck in compaction loops.
- **MCP elicitation support** — MCP servers can now request structured input mid-task via interactive dialogs (v0.2.76). Enables richer MCP tool interactions for Buildd workers.
- **PostCompact hook** — New hook fires after compaction completes (v0.2.76). Enables workers to react to compaction events for monitoring/logging.
- **Stale worktree cleanup** — Automatically cleans up worktrees left behind after interrupted parallel runs (v0.2.76). Prevents disk space leaks for workers using subagent worktrees.
- **Worktree sparse checkout** — `worktree.sparsePaths` setting enables sparse checkout for large monorepos (v0.2.76). Can significantly reduce worktree setup time for Buildd workers.
- **Background agent partial results** — Killing background agents now preserves partial results in conversation context (v0.2.76). Improves reliability when workers need to abort subagents.
- **Streaming memory leak fix** — Streaming API response buffers now released when generators terminate early, preventing unbounded RSS growth (v0.2.74). Critical for long-running Buildd workers.
- **Managed policy enforcement** — Managed policy `ask` rules can no longer be bypassed by user `allow` rules or skill `allowed-tools` (v0.2.74). Security fix for enterprise deployments.
- **Full model IDs in agent frontmatter** — Full model IDs (e.g., `claude-opus-4-5`) now accepted in agent frontmatter/config instead of being silently ignored (v0.2.74). Enables precise model pinning for Buildd skills.
- **CPU freeze fix** — Permission prompts for complex bash commands no longer trigger 100% CPU loops (v0.2.73). Improves reliability for workers executing complex shell commands.
- **Subagent model fix on cloud providers** — Subagents with `model: opus`/`sonnet`/`haiku` no longer silently downgraded on Bedrock/Vertex/Foundry (v0.2.73). Important for Buildd workers using cloud API providers.
- **Bash output multi-session fix** — Bash tool output no longer lost when running multiple sessions in same project directory (v0.2.73). Directly benefits concurrent Buildd workers.
- **Prompt cache fix** — Fixed prompt cache invalidation in SDK `query()` calls, reducing input token costs up to 12x (v0.2.72). **Critical** for Buildd worker cost efficiency.
- **Parallel tool call fix** — Failed Read/WebFetch/Glob no longer cancels sibling parallel tool calls (v0.2.72). Only Bash errors cascade. Improves reliability for workers running parallel searches.
- **Worktree isolation fixes** — Task tool resume now restores cwd correctly, and background task notifications include `worktreePath`/`worktreeBranch` (v0.2.72). Important for subagent isolation.
- **Team agents inherit leader model** — Team agents now inherit the leader's model instead of defaulting (v0.2.72). Ensures consistent model usage across agent teams.
- **`/clear` no longer kills background agents** — Only foreground tasks are cleared (v0.2.72). Prevents accidental termination of background subagents.
- **Skill hooks double-fire fix** — Hooks no longer fire twice per event when a hooks-enabled skill is invoked by the model (v0.2.72).
- **Improved CPU utilization** — Long sessions now use less CPU (v0.2.72). Directly benefits long-running runner workers.
- **Background agent notification fix** — Background agent completion notifications now include the output file path (v0.2.71). Critical for parent agents recovering subagent results after context compaction in Buildd workers.
- **`--print` hang fix** — `--print` mode no longer hangs forever when team agents are configured (v0.2.71). Exit loop no longer waits on long-lived `in_process_teammate` tasks.
- **Stdin freeze fix** — Long-running sessions no longer freeze on keystroke processing (v0.2.71). Important for interactive runner workers.
- **Plugin installation persistence** — Plugin installations no longer lost when running multiple Claude Code instances (v0.2.71).
- **Bridge reconnection improvement** — Bridge sessions reconnect within seconds after laptop wake instead of up to 10 minutes (v0.2.71).
- **ToolSearch empty response fix** — System-prompt-style tags in tool search results no longer confuse models into stopping early (v0.2.70). Critical for workers using ToolSearch/deferred tools.
- **MCP prompt-cache bust fix** — MCP servers with `instructions` connecting after first turn no longer bust the prompt cache (v0.2.70). Improves token efficiency for workers with late-connecting MCP servers.
- **Compaction image preservation** — Images now preserved during compaction for prompt cache reuse (v0.2.70). Benefits long-running workers with image context.
- **Reduced subagent token usage** — More concise subagent reports reduce token usage on multi-agent tasks (v0.2.70). Direct benefit for Buildd agent teams.
- **Tool name revert** — `system:init` and `result` events emit `'Task'` again (was briefly `'Agent'` in v0.2.63, reverted in v0.2.64). If Buildd parses these events, ensure `'Task'` is the expected name.
- **ZodError on malformed updatedPermissions** — SDK hosts returning invalid `updatedPermissions` in control responses no longer crash with ZodError; field is stripped with warning (v0.2.64).
- **4+ memory leak fixes** — bridge polling, MCP OAuth, hooks config, MCP tool/resource caching (v2.1.63)
- **10+ memory leak fixes** — Teammate tasks, AppState, LSP diagnostics, file history, CircularBuffer, TaskOutput, shell execution, UUID tracking — all fixed (v2.1.50–v2.1.51). Critical for long-running runner workers.
- **Bun binary compatibility** — Fixed SDK crash (`ReferenceError`) in `bun build --compile` binaries (v0.2.51)
- **`session.close()` persistence** — Fixed subprocess being killed before persisting session data, which broke `resumeSession()` (v0.2.51)
- **Tool result disk threshold** — Results > 50K chars (was 100K) now persisted to disk, reducing context window usage (v2.1.51)
- **WASM memory fix** — Fixed unbounded WASM memory growth during long sessions (v2.1.49)
- **CWD recovery** — Shell commands no longer permanently fail after a command deletes its own working directory (v2.1.49)
- **Non-interactive performance** — Improved performance in `-p` mode (v2.1.49) — benefits all Buildd workers
- **Permission suggestions on safety checks** — `permission_suggestions` now populated when safety checks trigger ask responses, enabling SDK consumers to display permission options (v2.1.49)
- **`disableAllHooks` managed settings fix** — Non-managed settings can no longer disable managed hooks set by enterprise policy (v2.1.49) — security fix
- **Startup perf: batched token counting** — MCP tool token counting batched into single API call; analytics token counting reduced (v2.1.49)
- **Orphaned process fix** — Claude Code processes no longer persist after terminal disconnect on macOS (v2.1.46)
- **Agent Teams env propagation** — tmux-spawned processes for Bedrock/Vertex/Foundry (v2.1.45)
- **Task tool crash** (ReferenceError on completion) fixed (v2.1.45)
- **V2 Session.stream()** no longer returns prematurely when background subagents run (v0.2.45)
- **Shell memory leak** — RSS no longer grows unboundedly with large command output (v0.2.45)
- **Background task notifications** now delivered in streaming SDK mode (v2.1.41)
- **Sandbox excluded commands** can no longer bypass `autoAllowBashIfSandboxed` (v2.1.34) — security fix
