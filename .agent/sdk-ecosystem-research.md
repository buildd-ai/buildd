# Claude Agent SDK Ecosystem Research

> Last updated: 2026-03-16
> Purpose: Track how the community uses the Claude Agent SDK and identify features/patterns Buildd should adopt.

## SDK Release Summary (since last update)

### v0.2.76 (Mar 14, 2026) — Latest
- **`forkSession(sessionId, opts?)`** — Branch conversations from a specific point. Enables A/B testing agent behavior and branching workflows.
- **`cancel_async_message`** control subtype — Drop a queued user message by UUID before execution
- **`planFilePath`** field added to `ExitPlanMode` tool input for hooks and SDK consumers
- **MCP elicitation hooks** — `SDKElicitationCompleteMessage` system message for handling MCP server input requests programmatically
- Parity with Claude Code v2.1.76

### v0.2.75 (Mar 13, 2026)
- Parity with Claude Code v2.1.75 (1M context window for Opus 4.6)

### v0.2.74 (Mar 12, 2026)
- **`renameSession(sessionId, title, opts?)`** — Programmatic session renaming
- **Fixed:** `import type` from `@anthropic-ai/claude-agent-sdk/sdk-tools` failing under NodeNext/Bundler module resolution (broken since v0.2.69)
- **Fixed:** Skills with `user-invocable: false` incorrectly included in `supportedCommands()` and `system:init` slash_commands/skills lists
- Parity with Claude Code v2.1.74

### v0.2.73 (Mar 11, 2026)
- **Fixed:** `options.env` being overridden by `~/.claude/settings.json` env block when not using `user` as a `settingSources` option
- Parity with Claude Code v2.1.73

### v0.2.72 (Mar 10, 2026)
- **`agentProgressSummaries`** option — Enable periodic AI-generated progress summaries for running subagents (foreground and background), emitted on `task_progress` events via new `summary` field
- **`getSettings().applied`** section — Runtime-resolved `model` and `effort` values
- **Fixed:** `toggleMcpServer` and `reconnectMcpServer` failing with "Server not found" for servers passed via `query({mcpServers})`
- Parity with Claude Code v2.1.72

### v0.2.71 (Mar 7, 2026)
- Parity with Claude Code v2.1.71
- No SDK-specific changes beyond CLI parity

### v0.2.70 (Mar 5, 2026)
- Fixed `type: "http"` MCP servers failing with HTTP 406 on Streamable HTTP servers that enforce `Accept` header
- Changed `AgentToolInput.subagent_type` to **optional** — defaults to `general-purpose` when omitted
- Parity with Claude Code v2.1.70

### v0.2.69 (Mar 4, 2026)
- Added `toolConfig.askUserQuestion.previewFormat` option (`'markdown'` or `'html'`) for AskUserQuestion preview content
- Added `supportsFastMode` field to `ModelInfo`
- Added `agent_id` (subagents) and `agent_type` (subagents and `--agent`) fields to hook events
- Fixed SDK-mode MCP servers getting disconnected when background plugin installation refreshes project MCP config
- Fixed: `system:init` and `result` events emit `'Task'` as Agent tool name again (reverted from `'Agent'`)
- Fixed malformed `updatedPermissions` blocking tool calls with ZodError
- Improved memory usage of `getSessionMessages()` for large sessions

### v0.2.68 (Mar 4, 2026)
- Opus 4.6 defaults to **medium effort** for Max/Team subscribers
- Re-introduced "ultrathink" keyword for high effort on next turn
- **Opus 4.0 and 4.1 removed** from first-party API (auto-migrate to 4.6)

### v0.2.64 (Mar 1, 2026)
- **`DirectConnectTransport`** — connect SDK to a running `claude server` instance over WebSocket. Supports stable session keys for persistent multi-turn across reconnects.
- `agent_id` and `agent_type` fields added to hook events (useful for subagent-specific hook logic)
- Fixed: `system:init` and `result` events emit `'Task'` as Agent tool name again (reverted unintentional breaking change)
- Fixed: malformed `updatedPermissions` no longer blocks tool calls with ZodError

### v0.2.63 (Feb 28, 2026)
- **`supportedAgents()`** method — query available subagents at runtime
- Fixed: MCP replacement tools no longer incorrectly denied in subagents
- Fixed: `pathToClaudeCodeExecutable` resolves bare command names via PATH

### Notable Claude Code CLI Features (v2.1.72–2.1.76) — NEW
- **MCP elicitation** (v2.1.76) — MCP servers can request structured input mid-task via interactive dialog (form fields or browser URL). New `Elicitation` and `ElicitationResult` hooks to intercept/override responses.
- **`worktree.sparsePaths`** (v2.1.76) — Sparse checkout for `--worktree` in large monorepos. Check out only needed directories via git sparse-checkout.
- **`PostCompact` hook** (v2.1.76) — Fires after compaction completes. Enables post-compaction actions (e.g., memory save, progress update).
- **`/effort` command** (v2.1.76) — Set model effort level interactively.
- **Session naming** (v2.1.76) — `-n`/`--name` flag at startup; `/rename` shows name on prompt bar.
- **1M context for Opus 4.6** (v2.1.75) — Default for Max/Team/Enterprise plans (up from 200K).
- **`/color` command** (v2.1.75) — Set prompt-bar color per session. Useful for multi-session workflows.
- **Memory timestamps** (v2.1.75) — Last-modified timestamps on memory files for staleness reasoning.
- **Hook source display** (v2.1.75) — Permission prompts show whether hook comes from settings/plugin/skill.
- **`/context` suggestions** (v2.1.74) — Actionable suggestions for context-heavy tools, memory bloat, capacity warnings.
- **`autoMemoryDirectory`** (v2.1.74) — Configurable directory for auto-memory storage.
- **`modelOverrides`** (v2.1.73) — Map model picker entries to custom provider model IDs (Bedrock ARNs, etc.).
- **`agentProgressSummaries`** (v2.1.72) — AI-generated progress summaries for subagents.
- **`ExitWorktree` tool** (v2.1.72) — Leave an `EnterWorktree` session programmatically.
- **Simplified effort levels** (v2.1.72) — low/medium/high (removed max), new symbols ○◐●, `/effort auto` to reset.
- **Prompt cache optimization** (v2.1.72) — Fixed SDK `query()` prompt cache invalidation, reducing input token costs up to 12×.
- **Auto-compaction circuit breaker** (v2.1.76) — Stops after 3 consecutive failures instead of retrying indefinitely.
- **Improved background agents** (v2.1.76) — Killing a background agent now preserves partial results in context.

### Notable Claude Code CLI Features (v2.1.69–2.1.71)
- **`/loop` command** (v2.1.71) — Run prompts on recurring intervals (e.g., `/loop 5m check the deploy`). Built-in cron scheduling tools. Tasks auto-expire after 3 days.
- **Cron scheduling tools** (v2.1.71) — CronCreate/CronDelete/CronList for session-scoped recurring prompts
- **`InstructionsLoaded` hook event** (v2.1.69) — Fires when CLAUDE.md or `.claude/rules/*.md` files are loaded into context
- **`${CLAUDE_SKILL_DIR}` variable** (v2.1.69) — Skills can reference their own directory in SKILL.md content
- **`/claude-api` skill** (v2.1.69) — Built-in skill for building Claude API/SDK applications
- **VS Code activity bar sessions** (v2.1.70) — Spark icon lists all sessions; plans shown as markdown docs with comment feedback
- **Native MCP server management** (v2.1.70) — `/mcp` dialog in VS Code for enable/disable/reconnect/OAuth
- **Voice STT expansion** (v2.1.69) — 10 new languages (20 total)
- **`isolation: worktree` in agent definitions** (v2.1.50) — Declarative worktree isolation for subagents
- **`WorktreeCreate`/`WorktreeRemove` hooks** (v2.1.50) — Custom VCS setup/teardown for worktree isolation
- **Plugin marketplace** (v2.1.69) — Official Anthropic plugin marketplace with enterprise features; `strictKnownMarketplaces` for org control
- **Skill resume savings** (v2.1.70) — Skill listing no longer re-injected on `--resume` (~600 tokens saved)
- **Memory leak fixes** (v2.1.69–v2.1.71) — Extensive fixes: completed task state, MCP caching, REPL scopes, React memoCache, hook events, file history snapshots

## Community Projects Using the SDK

### Previously Tracked (1–11)

#### 1. Agentic Coding Flywheel Setup (Dicklesworthstone)
**What**: Bootstraps a fresh Ubuntu VPS into a complete multi-agent AI dev environment in 30 minutes.
**SDK Features Used**: Multi-agent coordination, Agent Mail MCP server for cross-agent work, advisory file reservations (leases) to prevent agent conflicts, persistent artifacts in git.
**Takeaway for Buildd**: Their Agent Mail MCP concept (inter-agent messaging via file-based leases) is interesting — Buildd already has a richer coordination model, but the "advisory file reservations" pattern could prevent workers from clobbering each other on shared repos.

#### 2. ClaudeSwarm (simonstaton)
**What**: Self-hosted platform for running coordinated Claude agent swarms with React UI on GCP Cloud Run.
**SDK Features Used**: Express API managing Claude CLI processes, JWT auth, GCS-synced shared context, kill switch.
**Takeaway for Buildd**: Their **kill switch** (POST /api/kill-switch — blocks all API requests, persists to disk + GCS) is worth noting. Buildd's `abortController` approach is per-worker; a global kill switch would add a production safety net.

#### 3. myclaude (cexll)
**What**: Multi-agent orchestration workflow system with intelligent routing.
**SDK Features Used**: 5-phase feature dev workflow (/do command), multi-agent orchestration (/omo), SPARV workflow (Specify→Plan→Act→Review→Vault), task routing to different backends (codex, gemini, claude) with fallback.
**Takeaway for Buildd**: **Task routing by type** (default→claude, UI→codex, quick-fix→gemini) is a pattern Buildd could adopt.

#### 4. agentic-flow (ruvnet)
**What**: Framework to switch between alternative low-cost AI models in Claude Agent SDK.
**Takeaway for Buildd**: Validates demand for multi-model support within agent SDK workflows.

#### 5. parruda/swarm (Ruby)
**What**: Ruby gems for general-purpose AI agent systems with persistent memory, semantic search, node workflows.
**Takeaway for Buildd**: Persistent memory with semantic search mirrors Buildd's `buildd_memory`.

#### 6. claude-mem (thedotmack) — 32.8k stars
**What**: Claude Code plugin for persistent memory across sessions. Captures observations, compresses with AI, injects relevant context back.
**SDK Features Used**: Lifecycle hooks (SessionStart, PostToolUse, Stop, SessionEnd), MCP tools for search, SQLite + Chroma vector DB.
**Takeaway for Buildd**: **Progressive disclosure pattern** (search returns IDs first, fetch details on demand) directly applicable to `buildd_memory`.

#### 7. claude-agent-server (dzhng) — 527 stars
**What**: WebSocket wrapper for Claude Agent SDK in E2B sandboxes.
**Takeaway for Buildd**: **DirectConnectTransport** in SDK v0.2.64 makes this pattern first-class. Could simplify runner architecture.

#### 8. Ruflo (ruvnet) — 505 stars
**What**: Enterprise agent orchestration platform with multi-agent swarms, self-learning, and multi-provider support.
**Takeaway for Buildd**: (1) **WASM pre-processing** for trivial transforms. (2) **Agent performance tracking** — route to historically best-performing agents.

#### 9. dorabot (suitedaces) — 161 stars
**What**: macOS desktop app — 24/7 autonomous AI agent with memory, scheduled tasks, browser use, messaging integrations.
**Takeaway for Buildd**: **Scheduled task execution** pattern relevant to Buildd's scheduled tasks.

#### 10. MetaBot (xvirobotics) — 82 stars
**What**: Infrastructure for supervised, self-improving agent organizations with shared memory.
**Takeaway for Buildd**: **Agent factory** concept — programmatically generate skill definitions based on codebase analysis.

#### 11. Community Go SDKs (multiple authors)
**What**: 5+ unofficial Go implementations. Most active is M1n9X's with claimed full feature parity.
**Takeaway for Buildd**: Signals demand for non-JS/Python agent development.

### Added Mar 9 (12–17)

#### 12. Claude Code Agent Farm (Dicklesworthstone) — ~2k stars
**What**: Orchestration framework for running 20–50 Claude Code agents in parallel. Automated bug fixing, best-practices sweeps, lock-based coordination, and real-time tmux monitoring.
**SDK Features Used**: Parallel subprocess management, lock-based file coordination, heartbeat tracking, auto-recovery with adaptive idle timeout, 34 technology stack profiles.
**Architecture**: tmux-based — each agent gets its own pane. Central orchestrator distributes work items, monitors health via heartbeat, and restarts stalled agents. Git-based coordination with automatic backups.
**Takeaway for Buildd**: The **adaptive idle timeout** pattern (adjusting timeout based on work patterns) is directly useful for Buildd's worker management. Currently Buildd uses fixed timeouts; adaptive timeouts could prevent premature kills on complex tasks while catching truly stalled workers faster. Also, the **multi-stack profile** system (34 presets for Next.js, Rust, Go, etc.) could inspire workspace-specific default configurations.

#### 13. Agent Orchestrator (ComposioHQ) — 3.1k stars
**What**: Agent-agnostic orchestrator for parallel coding agents. Plans tasks, spawns agents, handles CI fixes, merge conflicts, and code reviews autonomously.
**SDK Features Used**: Agent-agnostic design (Claude Code, Codex, Aider), runtime-agnostic (tmux, Docker), tracker-agnostic (GitHub, Linear). Auto-detects language, package manager, SCM platform, and default branch.
**Architecture**: Generates `agent-orchestrator.yaml` from repo analysis, starts dashboard + orchestrator. CI failure → routes logs to agent for fix. PR approved + green CI → notification.
**Takeaway for Buildd**: Two standout patterns: (1) **CI failure auto-routing** — when CI fails on an agent's PR, automatically sends failure logs to an agent for fixing. Buildd could integrate this with GitHub Actions webhooks on worker PRs. (2) **Auto-detection of repo context** (language, package manager, SCM) eliminates manual workspace config. Buildd's workspace setup could auto-detect these on first task.

#### 14. claude-code-by-agents (baryhuang) — ~400 stars
**What**: Desktop app and REST API for multi-agent Claude Code orchestration. Coordinate local and remote agents through @mentions.
**SDK Features Used**: Multi-agent workspace with @agent mentions, local + remote agent coordination across machines, OAuth token integration (no API keys needed), REST API for chat/history/abort.
**Architecture**: Each agent instance runs on a different port. Remote agents configured to run on other machines. @mention syntax routes messages to specific agents.
**Takeaway for Buildd**: The **@mention routing** pattern for inter-agent communication is intuitive. While Buildd uses task-based coordination, an @mention-style syntax within worker instructions could enable workers to delegate to each other more naturally. Also, the multi-machine remote agent pattern validates Buildd's distributed worker model.

#### 15. Awesome Claude Code (hesreallyhim) — curated list
**What**: Community-curated directory of skills, hooks, slash-commands, agent orchestrators, applications, and plugins.
**Status**: Tracks the growing ecosystem — agent orchestrators, productivity tools, MCP integrations, and enterprise plugins.
**Takeaway for Buildd**: Useful as a discovery channel. The categorization (skills, hooks, orchestrators, apps) mirrors Buildd's own extension model. Worth monitoring for new patterns and popular community tools.

#### 16. Official Plugin Marketplace (Anthropic)
**What**: Anthropic-managed directory of high-quality Claude Code plugins, available out of the box.
**Features**: Enterprise marketplace with partner integrations (GitLab, Replit, Harvey, Snowflake), `strictKnownMarketplaces` for org-level control, git-subdir plugin sources.
**Takeaway for Buildd**: The plugin marketplace ecosystem is maturing rapidly. Buildd's skills system could potentially integrate as a marketplace plugin, expanding distribution. The `strictKnownMarketplaces` pattern is relevant for enterprise Buildd deployments.

#### 17. claude-agent-kit (JimLiu)
**What**: Comprehensive AI agent development framework integrating Claude Agent SDK with frontend-to-backend solution.
**SDK Features Used**: `@claude-agent-kit/websocket` (Node.js WebSocket bridge), `@claude-agent-kit/bun-websocket` (Bun native WebSocket), `@claude-agent-kit/server` (session/streaming/persistence helpers).
**Architecture**: Modular packages — server helpers, WebSocket handlers, session management, client shims. Multi-runtime support (Node + Bun).
**Takeaway for Buildd**: The modular package structure (separate server, WebSocket, and client packages) is a clean pattern. If Buildd ever publishes SDK helpers for external integrations, this layered approach is worth emulating.

### New This Week (18–23)

#### 18. wshobson/agents — 31.4k stars
**What**: Production-ready plugin marketplace for Claude Code — 112 specialized agents, 16 orchestrators, 146 skills, 79 dev tools organized into 72 single-purpose plugins.
**Architecture**: Tiered model allocation by task complexity:
- Tier 1 (Opus 4.6): 42 agents for critical architecture, security, code review
- Tier 2 (Inherit/Flexible): 42 agents where users select model
- Tier 3 (Sonnet 4.6): 51 support agents for docs and testing
- Tier 4 (Haiku 4.5): 18 agents for operational tasks
**Key Patterns**: (1) **Progressive disclosure skill architecture** — 3-tier loading: metadata → instructions → resources on demand, minimizing token overhead. (2) **Composable multi-agent workflows** — full-stack feature development coordinates 7+ agents across backend/frontend/DB/test/security/deploy/observability. (3) **Selective installation** — each plugin loads only its specific agents/commands/skills without context bloat (avg 3.4 components per plugin).
**Takeaway for Buildd**: The **tiered model allocation** pattern is directly applicable — Buildd could auto-assign model tiers based on task category (architecture → Opus, testing → Sonnet, ops → Haiku). The **progressive disclosure** approach (metadata first, full instructions on demand) could significantly reduce token consumption in `buildd_memory` and skill loading. At 31.4k stars this is the most popular project in the ecosystem, validating demand for curated agent collections.

#### 19. VoltAgent/awesome-claude-code-subagents — 14k stars
**What**: Curated collection of 127+ specialized Claude Code subagents across 10 categories with interactive installer.
**Categories**: Core Development, Language Specialists (20+ languages), Infrastructure, Quality & Security, Data & AI, Developer Experience, Specialized Domains, Business & Product, Meta & Orchestration, Research & Analysis.
**Key Patterns**: (1) **Isolation-first design** — each subagent has its own isolated context space preventing cross-contamination. (2) **Fine-grained tool permissions** — per-subagent tool access rights configuration. (3) **Interactive installer** — browse categories, select agents, install/uninstall via shell script.
**Takeaway for Buildd**: The **category taxonomy** (10 categories spanning dev through business) maps well to Buildd's skill system. The **per-subagent tool permissions** pattern could enhance Buildd's skill definitions — currently skills get full tool access, but restricting tools per skill type would improve safety and reduce token waste. VoltAgent also maintains `awesome-agent-skills` (500+ cross-compatible skills for Claude Code, Codex, Gemini CLI, Cursor).

#### 20. parallel-code (johannesjo) — Open Source
**What**: Desktop app to run Claude Code, Codex CLI, and Gemini CLI side by side, each in its own git worktree.
**Architecture**: Each task gets its own branch and worktree automatically. Provider-agnostic — works with Claude Code, Codex, Gemini CLI from one interface. Keyboard-first control.
**Takeaway for Buildd**: Validates the **multi-provider parallel worktree** pattern. Buildd already uses worktrees for agent isolation, but this project shows users want a unified interface across providers. As Buildd considers multi-model support (e.g., routing tasks to Codex or Gemini for cost optimization), a provider-agnostic worktree manager is the UX users expect.

#### 21. Emdash (generalaction, YC W26) — Open Source
**What**: Provider-agnostic agentic development environment. Run multiple coding agents in parallel, locally or over SSH on remote machines.
**Architecture**: Desktop app with git worktree isolation per agent. Supports any AI coding provider. Local and remote execution.
**Takeaway for Buildd**: A YC W26 company building in this space signals strong market validation. Their SSH-to-remote pattern is notable — Buildd's runner already runs remotely, but exposing a "remote agent" connection mode (SSH or WebSocket) for users who want to bring their own compute could be a differentiator. The fact that they're provider-agnostic reinforces that coordination (not model lock-in) is the value layer.

#### 22. Piebald-AI/claude-code-system-prompts
**What**: Tracks all parts of Claude Code's system prompt across versions — 18 builtin tool descriptions, subagent prompts (Plan/Explore/Task), utility prompts (CLAUDE.md, compact, statusline, magic docs, WebFetch, Bash, security review, agent creation).
**Takeaway for Buildd**: Useful reference for understanding how Claude Code structures its system prompts internally. Changes to system prompts across versions can explain behavioral shifts in workers. Worth monitoring when debugging unexpected worker behavior after SDK upgrades.

#### 23. Claude Agent SDK Official Demos (anthropics/claude-agent-sdk-demos)
**What**: Official Anthropic demo repository showcasing SDK patterns — V2 Session API (multi-turn, persistence), multi-agent research system with subagent coordination, branding assistant with HTML preview cards, React+Express WebSocket chat UI, spreadsheet processing, resume generation.
**Takeaway for Buildd**: The **multi-agent research system** demo (coordinating specialized subagents for research and report generation) is architecturally similar to Buildd's BRIEF mission type. The **V2 Session API patterns** (separate send/stream, session persistence) may eventually supersede V1 query() for interactive use cases. Worth tracking as V2 stabilizes.

### Deep-Dive Analyses (from prior weeks)

<details>
<summary>Agent Farm deep-dive (Mar 9) — adaptive timeout, heartbeat, recovery patterns</summary>

**Claude Code Agent Farm (Dicklesworthstone)** — Detailed implementation analysis:

1. **Adaptive Idle Timeout** (`calculate_adaptive_timeout()`): Tracks cycle times in sliding window of 20 cycles, sets timeout = 3× median, bounded [30s, 600s], only adjusts on >20% change, needs ≥3 samples before activating.
2. **File-Based Heartbeat**: `.heartbeats/agentNN.heartbeat` files, color-coded in dashboard (green <30s, yellow <60s, red >60s).
3. **Lock-Based Coordination**: Launch lock (atomic `O_CREAT|O_EXCL`, stale after 30s) + advisory work coordination (prompt-based, fragile).
4. **Auto-Recovery with Exponential Backoff**: `context` → `/clear` (soft), `error`/`idle` → full restart. Backoff: `min(300, 10 * 2^count)`.
5. **Stack Profiles**: 37 JSON configs with tech_stack, problem_commands, best_practices_files, timing params.
6. **Context % Detection**: Regex scrapes context remaining, triggers `/clear` below 20%.

**What to adopt**: Adaptive timeout, graduated restart, exponential backoff, stack presets, heartbeat age visualization.
**What NOT to adopt**: tmux architecture, terminal scraping, prompt-based coordination, single-machine constraint.

</details>

<details>
<summary>claude-code-by-agents assessment (Mar 9) — no novel patterns for Buildd</summary>

**Assessment**: Buildd's architecture already covers and exceeds this project's capabilities. @mention routing → Buildd's task+skill assignment. Multi-machine agents → Buildd's distributed worker claim. Their limitations (no persistence, no session resume, no real-time visibility) are problems Buildd already solves.

**Action**: None. Validates Buildd's architectural direction.

</details>

## Buildd's Current SDK Usage (What We Do Well)

| Feature | Status | Notes |
|---------|--------|-------|
| V1 Query API | Full | Correct choice for orchestration with CLAUDE.md, plugins, sandbox |
| Hooks (13/17) | Extensive | PreToolUse, PostToolUse, PostToolUseFailure, Notification, PermissionRequest, SessionStart, SessionEnd, PreCompact, TeammateIdle, TaskCompleted, SubagentStart, SubagentStop, ConfigChange. **Not yet using**: PostCompact, Elicitation, ElicitationResult, InstructionsLoaded |
| Agent Teams | Full | Skill delegation, subagent lifecycle tracking |
| In-Process MCP | Full | buildd + buildd_memory tools via createSdkMcpServer() |
| Structured Outputs | Basic | JSON schema when task defines outputSchema |
| File Checkpointing | Enabled | enableFileCheckpointing: true |
| Session Resume | Full | Resume with sessionId + streamInput for multi-turn |
| Cost Tracking | Full | Per-worker budgets, per-model usage breakdowns |
| Rate Limit Detection | Full | SDK v0.2.45+ events + fallback detection |
| Background Agents | Full | `background: true` on skill-as-subagent definitions |
| Effort Levels | Partial | Supported via task `model` field but not auto-mapped from priority |
| Worktree Isolation | Full | Workers use isolated worktrees |

## SDK Features We Don't Yet Use (Opportunities)

### High Priority
1. **`rewindFiles(messageUuid)`** — Checkpointing is enabled but rewind is never invoked. Could power an "undo" button in the dashboard.
2. **`effort` levels** (`low`/`medium`/`high`/`max`) — Could scale worker effort based on task priority. Quick tasks use `low`, critical bugs use `max`. Note: Opus 4.6 now defaults to `medium` effort.
3. **`fallbackModel`** — Graceful degradation when primary model hits rate limits. Zero cost to implement.
4. **Dynamic Model Switching** (`setModel()`) — Already tested in E2E but not used in production. Could enable mid-session model escalation (start with Sonnet, escalate to Opus for complex reasoning).

### Medium Priority
5. **`canUseTool` function** — Cleaner separation of permission logic from PreToolUse observability hooks.
6. **Dynamic MCP Server Management** (`reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`) — Runtime tool hot-swap, MCP crash recovery.
7. **`thinking` / Extended Reasoning** — `{ type: 'adaptive' }` or `{ type: 'enabled', budgetTokens: N }` for complex architectural tasks.
8. **Plan Mode Review UI** — Currently plans are auto-approved. Could add dashboard step for human review.
9. **`additionalDirectories`** — Workers accessing shared monorepo packages outside CWD.

### New in v0.2.69–0.2.76
10. **`DirectConnectTransport`** (v0.2.64) — Connect to a running `claude server` over WebSocket. Stable session keys for persistent multi-turn across reconnects. Could fundamentally simplify Buildd's runner architecture.
11. **`supportedAgents()`** (v0.2.63) — Query available subagents at runtime. Could enable dynamic skill discovery in the dashboard.
12. **`agent_id` / `agent_type` in hook events** (v0.2.69) — Now in stable release. Subagent-specific hook logic. Enables per-skill cost tracking and monitoring.
13. **`supportsFastMode` in ModelInfo** (v0.2.69) — Runtime detection of fast mode support per model.
14. **`toolConfig.askUserQuestion.previewFormat`** (v0.2.69) — Configure preview content as markdown or HTML for AskUserQuestion.
15. **`InstructionsLoaded` hook event** (CLI v2.1.69) — Fires when CLAUDE.md/.claude/rules loaded. Could audit/validate worker configuration at startup.
16. **`/loop` + cron scheduling** (CLI v2.1.71) — Session-scoped recurring prompts. Auto-expire after 3 days. Buildd could use CronCreate for periodic health checks within worker sessions.
17. **Declarative `isolation: worktree`** (CLI v2.1.50) — Agent definitions can declare worktree isolation in frontmatter. Buildd skills could use this for safe parallel execution.
18. **HTTP hooks** (CLI v2.1.63) — POST JSON to URLs instead of shell commands. Could simplify Buildd's hook-to-API integrations.
19. **Auto-memory** (CLI v2.1.59) — Workers accumulate cross-session learnings per workspace. Evaluate against custom `buildd_memory` MCP.
20. **Worktree-shared configs** (CLI v2.1.63) — Project configs + auto-memory shared across git worktrees. Reduces setup for subagent worktree isolation.
21. **Plugin marketplace integration** — Buildd skills could be distributed as Claude Code plugins via marketplace.
22. **`agentProgressSummaries`** (v0.2.72) — **HIGH PRIORITY** — AI-generated progress summaries for subagents. Buildd workers already report progress, but enabling this would provide richer, auto-generated summaries without manual `update_progress` calls. Could power a "live summary" feature in the dashboard.
23. **`getSettings().applied`** (v0.2.72) — Runtime-resolved model and effort values. Could use this to log actual runtime config per worker for debugging and optimization.
24. **`forkSession`** (v0.2.76) — **NOW AVAILABLE** — A/B testing agent behavior, branching workflows. Could enable "try two approaches" pattern for complex tasks.
25. **`renameSession`** (v0.2.74) — Programmatic session renaming. Could set meaningful session names like task IDs for easier debugging.
26. **MCP elicitation** (v0.2.76/v2.1.76) — MCP servers can request structured input mid-task. New `Elicitation`/`ElicitationResult` hooks. Buildd's MCP server could use this for interactive task clarification without AskUserQuestion.
27. **`worktree.sparsePaths`** (v2.1.76) — Sparse checkout in worktrees. **HIGH PRIORITY** for Buildd's monorepo — workers only check out relevant packages instead of entire repo, reducing setup time and context.
28. **`PostCompact` hook** (v2.1.76) — Fire actions after compaction. Could auto-save progress or memory when context is compacted.
29. **`modelOverrides`** (v2.1.73) — Map model names to custom provider IDs. Enables Bedrock/Vertex integration without changing agent definitions.
30. **`autoMemoryDirectory`** (v2.1.74) — Custom auto-memory path. Could unify with `buildd_memory` storage.
31. **Prompt cache optimization** (v2.1.72) — Up to 12× input token cost reduction. Verify Buildd workers are benefiting from this fix.
32. **Auto-compaction circuit breaker** (v2.1.76) — Stops after 3 failures. Prevents runaway compaction loops that waste tokens.

### Lower Priority
33. **`resumeSessionAt`** — Rewind to specific conversation point.
34. **`setPermissionMode()`** — Dynamic permission escalation mid-session.
35. **`promptSuggestion()`** — SDK v0.2.47 feature for requesting prompt suggestions.
36. **Model capability discovery** (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`) — Runtime feature detection instead of hardcoded model assumptions.
37. **`cancel_async_message`** (v0.2.76) — Drop queued messages by UUID. Edge case utility for multi-turn coordination.

## Patterns From the Community Worth Adopting

### Previously Identified (1–10)

#### 1. Task-Type Routing (from myclaude)
Route tasks to different models based on task metadata:
- Bug fixes → fast model (Haiku/Sonnet)
- Architecture work → deep model (Opus with thinking enabled)
- UI tasks → model with visual capabilities
- Quick fixes → `effort: 'low'`, budget-limited

#### 2. Advisory File Reservations (from ACFS)
Prevent multiple concurrent workers from editing the same files. Could implement as a PreToolUse hook that checks a file-lock table before allowing Write/Edit operations on shared paths.

#### 3. Global Kill Switch (from ClaudeSwarm)
Complement per-worker abortController with a workspace-level kill switch that immediately cancels all active workers. Useful for runaway cost or safety scenarios.

#### 4. Workflow Phases (from myclaude SPARV)
Specify → Plan → Act → Review → Vault — structured workflow phases that map naturally to Buildd's task lifecycle.

#### 5. Multi-Provider Fallback (from agentic-flow)
Configure fallback chains: Anthropic → Bedrock → Vertex. SDK supports multi-provider auth natively.

#### 6. Progressive Memory Disclosure (from claude-mem)
Layered retrieval to reduce token waste. Directly applicable to `buildd_memory` MCP tool.

#### 7. WebSocket Agent Transport (from claude-agent-server + SDK v0.2.64)
Use `DirectConnectTransport` for persistent multi-turn without subprocess lifecycle management.

#### 8. WASM Pre-Processing (from Ruflo)
Run trivial transforms via WebAssembly before invoking LLM for ~352x speedup and zero token cost.

#### 9. Agent Factory / Auto-Generated Skills (from MetaBot)
Programmatically generate skill definitions based on codebase analysis.

#### 10. Scheduled Autonomous Execution (from dorabot)
Cron-based agent wakeups with iCal RRULE scheduling. Now partially native with `/loop` + CronCreate.

### New Patterns (11–15)

#### 11. CI Failure Auto-Routing (from ComposioHQ Agent Orchestrator)
When CI fails on an agent's PR, automatically route failure logs to an agent for fixing:
- GitHub Actions webhook → parse failure → create fix task
- Agent receives CI logs + diff as context
- Fix, push, re-trigger CI — no human intervention
Buildd could hook into GitHub Actions status events on worker PRs to auto-create fix tasks.

#### 12. Adaptive Idle Timeout (from Claude Code Agent Farm)
Instead of fixed worker timeouts, adjust based on observed work patterns:
- Agent producing frequent tool calls → extend timeout
- Agent idle for N heartbeat intervals → shorter leash
- Recovery: auto-restart stalled agents with state from last checkpoint
Buildd's fixed timeout approach sometimes kills workers mid-complex-reasoning or lets truly stalled workers linger.

#### 13. Repo Context Auto-Detection (from ComposioHQ Agent Orchestrator)
Automatically detect language, package manager, SCM platform, and default branch on first task:
- Eliminates manual workspace configuration
- Generates optimal agent config (YAML) from repo analysis
- Could power Buildd's workspace onboarding — auto-discover stack and configure default skills/models.

#### 14. @Mention Inter-Agent Routing (from claude-code-by-agents)
Use @agent syntax for natural inter-agent delegation:
- `@frontend-agent please update the component` → routes to specialized agent
- Each agent can run on a different machine/port
- More intuitive than task ID-based coordination for human operators
Buildd could add @mention syntax in task descriptions to auto-assign subtasks to specific skills.

#### 15. Plugin-as-Distribution (from Anthropic Plugin Marketplace)
Distribute Buildd skills as Claude Code plugins via the official marketplace:
- Reaches Claude Code users who don't use Buildd directly
- Enterprise marketplace features (`strictKnownMarketplaces`) for org control
- `git-subdir` source type enables pointing to specific skill directories in a monorepo
Could expand Buildd's reach and provide a new distribution channel for workspace skills.

#### 11. Adaptive Idle Timeout (from Agent Farm)
Replace fixed worker timeouts with cycle-time-aware adaptive thresholds:
- Track last 20 work cycle durations (working→complete transitions)
- Set timeout = 3× median cycle time, bounded [30s, 600s]
- Only adjust on >20% change to prevent thrashing
- Needs ≥3 samples before activating (falls back to base timeout)
- Directly applicable to Buildd's runner heartbeat timeout (currently fixed 5 min)

#### 12. Graduated Restart Strategy (from Agent Farm)
Different recovery actions based on failure type:
- **Context exhaustion** → soft reset (`/clear` or SDK compact) — preserve session, free context
- **Heartbeat stale / error** → full worker restart
- **Idle too long** → full restart with new prompt
- Exponential backoff between restarts: `min(300, 10 * 2^restart_count)` seconds
- Max consecutive errors threshold before disabling worker entirely
- Prevents restart storms on systemic issues (rate limits, auth failures)

### New Patterns (16–20) — Added Mar 16

#### 16. Tiered Model Allocation (from wshobson/agents)
Assign models by task complexity tier instead of one-size-fits-all:
- **Tier 1** (Opus 4.6): Architecture, security, complex code review — 42 agents
- **Tier 2** (Inherit): User-selected model for general work — 42 agents
- **Tier 3** (Sonnet 4.6): Documentation, testing, support — 51 agents
- **Tier 4** (Haiku 4.5): Operational tasks, simple automation — 18 agents
Buildd could auto-assign model tiers based on task `category` field. Bug fixes → Sonnet, architecture → Opus, docs → Haiku. Already partially supported via task `model` field but not automated.

#### 17. Progressive Disclosure Skill Loading (from wshobson/agents)
Three-tier skill architecture that loads knowledge on demand:
- **Metadata** (always loaded): name, description, category — minimal tokens
- **Instructions** (loaded when invoked): step-by-step how-to — moderate tokens
- **Resources** (loaded on demand): full reference docs, examples — heavy tokens
Buildd's skills currently load everything at once. Progressive disclosure could cut skill token costs significantly, especially for workers with many attached skills.

#### 18. Per-Subagent Tool Permissions (from VoltAgent)
Configure specific tool access rights per subagent type:
- Security auditor gets Read + Grep only (no Write/Edit)
- Frontend agent gets Write + Edit but no Bash
- Infrastructure agent gets Bash but restricted to specific commands
Buildd skills currently inherit full tool access. Restricting tools per skill type improves safety and reduces accidental damage surface.

#### 19. Sparse Worktree for Monorepos (from CLI v2.1.76 + community)
Use `worktree.sparsePaths` to check out only needed directories:
- Worker on `apps/web` task only checks out `apps/web/` + `packages/shared/` + `packages/core/`
- Dramatically reduces clone time and disk usage for large monorepos
- Combined with `isolation: worktree`, enables lean parallel agents
Buildd workers currently clone the full repo. For Buildd's own monorepo (with `apps/` and `packages/`), sparse checkout based on task `project` field could speed up worker startup.

#### 20. Provider-Agnostic Worktree Management (from parallel-code, Emdash)
Desktop apps that run Claude Code, Codex, Gemini side-by-side in isolated worktrees:
- Each task gets its own branch + worktree automatically
- Provider selection per task (cost optimization, capability matching)
- Unified UI across providers
Validates that coordination layer (not model lock-in) is the value layer. As Buildd considers multi-model support, the UX expectation is seamless provider switching per task.

## Recommendations for Buildd (Priority Order)

### Immediate (This Sprint)
1. **Bump SDK to `>=0.2.76`** — Gets `agentProgressSummaries`, `forkSession`, MCP elicitation hooks, prompt cache fix (12× cost reduction), and auto-compaction circuit breaker. Previous recommendation was >=0.2.69; now 0.2.76 has substantial features.
2. **Enable `agentProgressSummaries`** — Auto-generated progress summaries for subagents without manual `update_progress` calls. Low effort, immediate dashboard value.
3. **Enable `worktree.sparsePaths`** — Configure sparse checkout for Buildd's monorepo. Workers only check out relevant `apps/` + `packages/` directories. Reduces worker startup time.
4. **Verify prompt cache optimization** — v2.1.72 fixed SDK `query()` prompt cache invalidation for up to 12× input token cost reduction. Verify Buildd workers are benefiting.

### Near-Term (Next 2 Sprints)
5. **Tiered model allocation** — Auto-assign model based on task category: architecture→Opus, bug fix→Sonnet, docs/ops→Haiku. Extends existing task `model` field with smart defaults.
6. **CI failure auto-routing** — Hook GitHub Actions status events to auto-create fix tasks when worker PRs fail CI (from ComposioHQ pattern)
7. **Adaptive idle timeout** — Replace fixed timeouts with heartbeat-based adaptive approach from Agent Farm pattern
8. **MCP elicitation for task clarification** — Use elicitation hooks so Buildd's MCP server can request structured input mid-task without AskUserQuestion
9. **`PostCompact` hook for auto-save** — Save progress/memory automatically when context is compacted
10. **Progressive skill loading** — Three-tier metadata→instructions→resources architecture to reduce token costs

### Medium-Term
11. **Per-skill tool permissions** — Restrict tool access per skill type (security auditor: read-only, frontend: no Bash, etc.)
12. **Evaluate DirectConnectTransport for runner** — Could replace subprocess management with WebSocket connection to persistent `claude server`
13. **Repo context auto-detection** — Auto-discover workspace stack and configure defaults on first task
14. **Plugin marketplace distribution** — Publish Buildd skills as Claude Code plugins
15. **`InstructionsLoaded` hook** — Audit/validate worker CLAUDE.md configuration at startup
16. **`forkSession` for A/B task approaches** — Try two implementation approaches in parallel, pick the better one
17. **Session-scoped `/loop` for health checks** — Use CronCreate within worker sessions for periodic self-monitoring
