# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-05-04
**Previous scan**: 2026-04-20
**Current SDK version in Buildd**: `^0.2.111` (latest: `0.2.126`)
**Python SDK**: v0.1.72 (latest)
**Claude Code CLI**: v2.1.126 (released May 1, 2026)

---

## SDK Releases (v0.2.114 - v0.2.126)

### TypeScript SDK v0.2.126 (May 1, 2026)
- **New**: `origin` field on result messages (`SDKResultSuccess` / `SDKResultError`) — forwards the triggering message's `SDKMessageOrigin` so consumers can distinguish user-prompted results from `task-notification` followups

### TypeScript SDK v0.2.123 (April 29, 2026)
- Updated to parity with Claude Code v2.1.123

### TypeScript SDK v0.2.122 (April 28, 2026)
- Updated to parity with Claude Code v2.1.122

### TypeScript SDK v0.2.121 (April 28, 2026)
- **New**: `updatedToolOutput` on `PostToolUseHookSpecificOutput` — replaces tool output for all tools (not just MCP)
- **Deprecated**: `updatedMCPToolOutput` (use `updatedToolOutput` instead)

### TypeScript SDK v0.2.119 (April 23, 2026)
- `excludeDynamicSections` now keeps static auto-memory instructions in the cacheable system-prompt block
- Long-running sessions now reconnect claude.ai-proxied MCP servers after transport-stream abort
- `SessionStore.append()` failures retried up to 3 times with short backoff before dropping batch and emitting `mirror_error`

### TypeScript SDK v0.2.118 (April 23, 2026)
- **New**: `Options.managedSettings` for embedders to pass policy-tier settings to the spawned CLI in-memory

### TypeScript SDK v0.2.117 (April 22, 2026)
- Updated to parity with Claude Code v2.1.117

### TypeScript SDK v0.2.116 (April 20, 2026)
- Updated to parity with Claude Code v2.1.116

---

## Python SDK Releases (v0.1.64 - v0.1.72)

### Python SDK v0.1.72 (May 1, 2026)
- Updated bundled CLI to v2.1.126

### Python SDK v0.1.71 (April 29, 2026)
- **New**: Domain allowlist fields for sandbox network config — `allowedDomains`, `deniedDomains`, `allowManagedDomainsOnly`, `allowMachLookup` on `SandboxNetworkConfig`
- Bundled CLI v2.1.123

### Python SDK v0.1.70 (April 28, 2026)
- **Fix**: In-process MCP tool results silently lost with older `mcp` versions — bumped `mcp` dependency floor to `>=1.19.0`
- **Fix**: Trio nursery corruption (`RuntimeError: Nursery stack corrupted`) on early cancellation with `options.stderr`
- Bundled CLI v2.1.122

### Python SDK v0.1.69 (April 28, 2026)
- Added docstrings to `ClaudeAgentOptions` fields for IDE autocompletion
- Bundled CLI v2.1.121

### Python SDK v0.1.68 (April 25, 2026)
- Bundled CLI v2.1.119

### Python SDK v0.1.67 (April 25, 2026)
- **Fix**: Trio compatibility restored (regression from v0.1.51) — uses sniffio-based dispatch for correct async primitive selection
- Added `sniffio>=1.0.0` as explicit runtime dependency
- Bundled CLI v2.1.120

### Python SDK v0.1.66 (April 23, 2026)
- Bundled CLI v2.1.119

### Python SDK v0.1.65 (April 23, 2026) — Major
- **New**: `SessionStore.list_session_summaries()` optional protocol method and `fold_session_summary()` helper for O(1)-per-session list views
- **New**: `import_session_to_store()` for replaying local on-disk sessions into any SessionStore adapter
- **New**: `display` field on `ThinkingConfig` types, forwarded as `--thinking-display` to CLI
- **New**: `ServerToolUseBlock` and `AdvisorToolResultBlock` content block types — surfaces server-executed tool calls
- **Fix**: `server_tool_use` and `advisor_tool_result` content blocks no longer silently dropped
- Bounded retry on session mirror append with UUID idempotency
- Bundled CLI v2.1.118

### Python SDK v0.1.64 (April 20, 2026) — Major
- **New**: Full `SessionStore` support at parity with TypeScript SDK — protocol with 5 methods (`append`, `load`, `list_sessions`, `delete`, `list_subkeys`)
- **New**: `InMemorySessionStore` reference implementation
- **New**: Reference adapters under `examples/session_stores/` — S3, Redis, and Postgres
- **New**: Transcript mirroring, session resume from store, 9 async store-backed helper functions
- Bundled CLI v2.1.116

---

## Claude Code CLI Releases (v2.1.115 - v2.1.126)

### v2.1.126 (May 1, 2026)
- `/model` picker lists models from gateway's `/v1/models` endpoint when `ANTHROPIC_BASE_URL` points at a compatible gateway
- **New**: `claude project purge [path]` to delete all Claude Code state for a project
- `--dangerously-skip-permissions` now bypasses prompts for protected paths (`.claude/`, `.git/`, `.vscode/`, shell config)
- **Security fix**: `allowManagedDomainsOnly`/`allowManagedReadPathsOnly` being ignored when higher-priority source lacked `sandbox` block
- Fixed images >2000px breaking sessions — auto-downscale on paste
- Fixed "Stream idle timeout" errors after Mac sleep and during long thinking pauses
- Windows: PowerShell 7 from Microsoft Store/MSI now detected
- Fixed Japanese/Korean/Chinese text rendering on Windows

### v2.1.123 (April 29, 2026)
- Fixed OAuth authentication failing with 401 loop when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`

### v2.1.122 (April 28, 2026)
- **New**: `ANTHROPIC_BEDROCK_SERVICE_TIER` env var for Bedrock tier selection (default, flex, priority)
- Pasting PR URLs into `/resume` now finds the session that created that PR (GitHub, GitHub Enterprise, GitLab, Bitbucket)
- `/mcp` shows claude.ai connectors hidden by duplicate servers
- OpenTelemetry: numeric attributes now emitted as numbers, not strings
- Fixed `/branch` producing forks with "tool_use ids without tool_result" errors

### v2.1.121 (April 28, 2026)
- **New**: `alwaysLoad` option in MCP server config to skip tool-search deferral
- **New**: `claude plugin prune` to remove orphaned dependencies
- **New**: Type-to-filter search in `/skills`
- PostToolUse hooks can now replace tool output for all tools
- MCP servers with transient errors auto-retry up to 3 times
- Vertex AI: X.509 certificate-based Workload Identity Federation (mTLS ADC)
- `/terminal-setup` enables iTerm2 clipboard access for `/copy`

### v2.1.120 (April 28, 2026)
- **New**: `claude ultrareview [target]` — multi-agent cloud code review
- Windows: Git Bash no longer required; PowerShell used as shell tool when absent
- Skills can reference effort level with `${CLAUDE_EFFORT}`
- **New**: `AI_AGENT` env var set for subprocesses (attribution for `gh` traffic)
- Fixed `DISABLE_TELEMETRY` not suppressing usage metrics

### v2.1.119 (April 23, 2026)
- `/config` settings now persist to `~/.claude/settings.json` with precedence hierarchy
- **New**: `prUrlTemplate` setting for custom code-review URLs
- **New**: `CLAUDE_CODE_HIDE_CWD` env var
- `--from-pr` accepts GitLab/Bitbucket/GitHub Enterprise URLs
- `--print` mode honors agent `tools:` and `disallowedTools:`
- Hooks include `duration_ms` for tool execution time
- Fixed multi-line paste losing newlines with kitty protocol

### v2.1.118 (April 23, 2026)
- **New**: Vim visual mode (`v`) and visual-line mode (`V`)
- Merged `/cost` and `/stats` into `/usage`
- **New**: Custom themes from `/theme`; plugins can ship themes
- **New**: Hooks can invoke MCP tools via `type: "mcp_tool"`
- **New**: `DISABLE_UPDATES` env var to block all update paths
- WSL can inherit Windows-side managed settings via `wslInheritsWindowsSettings`
- Auto mode: include `"$defaults"` in rules to extend built-ins

### v2.1.117 (April 22, 2026)
- Forked subagents enabled on external builds with `CLAUDE_CODE_FORK_SUBAGENT=1`
- Agent frontmatter `mcpServers` loaded for main-thread sessions via `--agent`
- `/resume` offers summarization for stale large sessions
- Native builds: `Glob`/`Grep` tools replaced by embedded `bfs`/`ugrep`

### v2.1.116 (April 20, 2026)
- `/resume` on large sessions 67% faster (40MB+ sessions)
- Thinking spinner shows inline progress ("still thinking", "almost done")
- Auto-install missing plugin dependencies from added marketplaces

---

## Competitive Landscape Update

### Claude Code vs OpenAI Codex vs Google Jules (Q2 2026)

| Dimension | Claude Code | OpenAI Codex | Google Jules |
|-----------|-------------|--------------|--------------|
| Architecture | Synchronous terminal + IDE orchestrator | Desktop app with model router | Async task pool in cloud VMs |
| Models | Sonnet 4.6 (default), Opus 4.6/4.7 (deep) | GPT-5.3-Codex, GPT-5.4 | Gemini 3.1 |
| SWE-Bench | **80.8%** (best) | ~75% | ~72% |
| Strength | Interactive dev, multi-agent review | Desktop automation, background compute | Long-running refactors, test backfill |
| Extensibility | Deep — MCP, subagents, hooks, plugins | Limited harness extensibility | VM-level tool access |

**Key competitive moves this period:**
- Benchmark leaderboard "shuffles on every release" — industry consensus shifting to paradigm fit over raw scores
- Claude Code leads on OSWorld-Verified (broader computer use tasks)
- Most agencies now run two agents in parallel — Claude Code for interactive + Jules or Codex for batch work
- Codex's single desktop app process not suited for queuing dozens of background tasks
- Teams with mature PR review processes lean toward Jules; pairing-oriented teams prefer Claude Code

### Opus 4.7 Impact
- GA since April 16, 2026; default on Max and Team Premium plans
- **xhigh effort level**: recommended for most coding work (interactive `/effort` slider)
- **Task budgets**: token-target estimate for full agentic loop (thinking + tools + output)
- **Better file-system memory**: improved at maintaining scratchpads, notes files, and structured memory across turns
- **High-resolution image support**: up to 2576px / 3.75MP
- Requires Agent SDK v0.2.111+ (Buildd already satisfies this)

---

## Community & Ecosystem

### GitHub Stars & Adoption (May 4, 2026)
- **15,134 total repositories** indexed in awesome-claude-plugins (up from 13,087 on April 20 — +15.6% in 2 weeks)
- Claude Code repo: 55K+ stars
- **600+ community tools and projects** in the ecosystem
- Community SDK ports expanding beyond TS/Python into Go (5+ ports) and Elixir

### Trending Community Projects (New/Updated Since Last Scan)

| Project | Stars | Description |
|---------|-------|-------------|
| **claude-mem** (thedotmack) | 71.7K | Auto-capture sessions, AI compression, context injection (+7.6K stars since last scan) |
| **awesome-claude-code-toolkit** (rohitg00) | — | 135 agents, 35 skills (+400K via SkillKit), 42 commands, 176+ plugins, 20 hooks |
| **Dive-into-Claude-Code** (VILA-Lab) | — | Systematic reverse-engineering: source tree, module boundaries, tool inventories, architecture |
| **agents** (wshobson) | — | 185 specialized agents, 16 multi-agent orchestrators, 153 skills, 100 commands, 80 plugins |
| **everything-claude-code** (affaan-m) | — | Performance optimization system with agents, skills, hooks, memory, security scanning |
| **Claude-Code-Workflow** (catlog22) | — | JSON-driven multi-agent cadence-team development with Gemini/Qwen/Codex orchestration |

### Community SDK Ports

| Language | Project | Status |
|----------|---------|--------|
| **Go** | schlunsen/claude-agent-sdk-go | Production ready v0.1.0 |
| **Go** | M1n9X/claude-agent-sdk-go | Full parity with Python SDK (204 features, 12 hook events) |
| **Go** | partio-io/claude-agent-sdk-go | Go 1.26+, multi-turn, subagents |
| **Go** | dotcommander/agent-sdk-go | No API key required, uses authenticated CLI |
| **Elixir** | nshkrdotcom/claude_agent_sdk | v0.16.0, MIT license, production-ready |
| **Elixir** | guess/claude_code | Active on Hex.pm |

### MCP Ecosystem Growth
- **Meta MCP** (April 29, 2026): Official MCP for Facebook/Instagram ads — campaigns, audiences, A/B analysis
- **Salesforce MCP**: GA with full endpoint catalog — sObjects, Flows, Data 360, Prompt Builder, Tableau Next
- **Heroku MCP**: GA for managing apps and dynos
- **MuleSoft MCP**: GA for API design and deployment
- **Higgsfield MCP**: AI image/video generation from 30+ models
- Total MCP servers: 500+ public servers

---

## Key Patterns & Developments

### 1. SessionStore Becomes Production Infrastructure
The biggest development this period: SessionStore adapter pattern reached full parity between TypeScript and Python SDKs. The Python SDK (v0.1.64-v0.1.65) shipped:
- Full SessionStore protocol (append, load, list_sessions, delete, list_subkeys)
- Reference adapters for S3, Redis, and Postgres
- Batch session summaries with O(1)-per-session list views
- Local-to-store import for migrating existing sessions
- Bounded retry with UUID idempotency on mirror append

This is a fundamental shift: session transcripts are no longer ephemeral local files but durable, queryable data that can be stored in any backing store. Combined with the `getSessionMessages()` API from v0.2.114, this enables:
- Cross-machine session resume in serverless/container deployments
- Centralized transcript storage for audit and analysis
- Session migration between environments
- Cost attribution from stored transcripts

### 2. /ultrareview: Multi-Agent Cloud Code Review
Claude Code v2.1.120 introduced `/ultrareview` — a multi-agent review system that runs in the cloud:
- Specialist agents review from different angles: security, correctness, architecture, tests, performance, style
- Each agent reproduces its own findings before reporting (verification step filters noise)
- Runs as background task (5-10 minutes), costs $5-20 per review
- Available as `claude ultrareview [target]` CLI command for non-interactive use
- Pro/Max subscribers got 3 free runs (expired May 5, 2026)

### 3. Hooks Can Invoke MCP Tools
v2.1.118 added `type: "mcp_tool"` to hook definitions, enabling hooks to invoke MCP tools directly. Combined with PostToolUse hooks replacing any tool's output (v0.2.121 / v2.1.121), this creates a powerful interception layer:
- Pre/post processing of any tool call
- Custom tool output transformation
- MCP-based audit trails triggered by specific tool patterns
- Hook duration tracking via `duration_ms`

### 4. Opus 4.7 and xhigh Effort
Opus 4.7 (GA April 16) with the new xhigh effort level changes agent behavior:
- **Task budgets**: Agents can set token targets for full agentic loops
- **Better file-system memory**: Improved at maintaining notes and scratchpads across turns — directly relevant to Buildd's memory system
- **xhigh effort**: Recommended for most coding work, available via `/effort` slider
- `${CLAUDE_EFFORT}` variable in skills for effort-aware prompts

### 5. Native Tool Replacement
v2.1.117 replaced Glob/Grep with embedded `bfs`/`ugrep` in native builds. This is the continuation of the native binary transition from v2.1.113 — more shell tools are being replaced by native equivalents for performance and security.

### 6. Forked Subagents for External Builds
`CLAUDE_CODE_FORK_SUBAGENT=1` enables forked subagents on external builds (v2.1.117). Agent frontmatter `mcpServers` now load for main-thread sessions via `--agent`. This legitimizes the pattern of external agent harnesses (like Buildd) using the SDK's subagent capabilities.

### 7. Platform Expansion: Windows & WSL
Multiple CLI releases improved Windows support:
- PowerShell as primary shell (Git Bash no longer required)
- WSL inherits Windows-side managed settings
- Fixed CJK text rendering, PowerShell 7 detection
- Shows the SDK increasingly targeting enterprise Windows environments

---

## Recommendations for Buildd

### High Priority

1. **Bump SDK to ^0.2.126** — Buildd is currently on `^0.2.111`, 15 versions behind. Key gains: result message origin tracking (v0.2.126), universal tool output replacement in hooks (v0.2.121), MCP reconnection for long-running sessions (v0.2.119), and managedSettings for policy-tier passthrough (v0.2.118).

2. **Implement SessionStore for runner transcripts** — The SessionStore adapter pattern is now production-ready in both SDKs with reference implementations for S3, Redis, and Postgres. Buildd runners should store transcripts to a central store instead of relying on local disk. Benefits: cross-machine resume, task artifact extraction, post-mortem analysis, and centralized cost attribution. The Postgres adapter aligns with Buildd's existing Neon stack.

3. **Adopt universal tool output hooks** — v0.2.121's `updatedToolOutput` (replacing deprecated `updatedMCPToolOutput`) lets Buildd inject custom logic into any tool call. Use cases: audit logging, cost tracking per tool, output sanitization, and custom tool transformations. Combined with `duration_ms` hook tracking, this enables fine-grained tool-level observability.

4. **Expose effort level in role configuration** — The new `${CLAUDE_EFFORT}` variable and xhigh effort level mean different tasks need different effort settings. Buildd roles should be able to specify default effort levels. Simple tasks (chores, docs) can use `low`, while complex tasks (architecture, debugging) use `xhigh`.

### Medium Priority

5. **Leverage result message `origin` for task notification flows** — v0.2.126's `origin` field distinguishes user-prompted results from task-notification followups. Buildd can use this to differentiate between primary task results and secondary notifications, improving the dashboard's result display.

6. **Add /ultrareview integration** — The `claude ultrareview` CLI command enables non-interactive multi-agent code review. Buildd could offer this as a one-click action on PRs — run ultrareview before merge, attach the report as a task artifact. At $5-20 per review, it's cost-effective for critical PRs.

7. **Implement MCP tool hooks for audit trails** — v2.1.118's `type: "mcp_tool"` hooks enable MCP tools to be invoked from hooks. Buildd could use this to automatically log tool call patterns, detect anomalies, and trigger alerts on suspicious tool usage.

8. **Enable forked subagents** — Set `CLAUDE_CODE_FORK_SUBAGENT=1` in runner configuration. This enables parallel subagent execution, which can speed up complex tasks that benefit from concurrent exploration.

### Lower Priority

9. **Monitor community SDK ports** — The Go SDK ecosystem is maturing rapidly (5+ ports, one with full Python parity). If Buildd ever needs non-Node.js worker infrastructure, the Go SDK (M1n9X version with 204-feature parity) is viable.

10. **Evaluate Session Store batch summaries for task list views** — Python SDK v0.1.65's `fold_session_summary()` enables O(1)-per-session list views. If Buildd adds a "session history" view per task, this prevents expensive full-transcript loading.

11. **Adopt `alwaysLoad` for critical MCP servers** — v2.1.121's `alwaysLoad` config option skips tool-search deferral for specific MCP servers. Use this for Buildd's own MCP server to ensure tools are always available without discovery latency.

12. **Add `claude project purge` to runner cleanup** — v2.1.126's `claude project purge [path]` command cleanly removes all Claude Code state for a project. Useful for runner workspace cleanup between tasks to prevent state leakage.

13. **Windows runner support preparation** — With PowerShell as primary shell and WSL settings inheritance, Windows-based runners are becoming viable. Track demand and consider adding Windows runner installation instructions.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-05-04 | 0.2.114-0.2.126 | 0.1.63-0.1.72 | 2.1.114-2.1.126 | SessionStore GA, ultrareview, result origin, MCP tool hooks, Opus 4.7 xhigh, forked subagents, universal tool output hooks |
| 2026-04-20 | 0.2.104-0.2.114 | 0.1.54-0.1.63 | 2.1.101-2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94-0.2.104 | — | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | — | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | — | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
