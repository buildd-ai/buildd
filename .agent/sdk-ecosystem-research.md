# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-05-11
**Previous scan**: 2026-04-20
**Current SDK version in Buildd**: `^0.2.119` (latest: `0.2.138`)
**Python SDK**: v0.1.80 (latest)
**Claude Code CLI**: v2.1.138 (released May 9, 2026)

---

## SDK Releases (v0.2.114 → v0.2.138)

### TypeScript SDK v0.2.138 (May 9, 2026)
- Updated to parity with Claude Code v2.1.138
- Internal fixes

### TypeScript SDK v0.2.136 (May 8, 2026)
- **New**: `resolveSettings()` (alpha) — inspect effective merged settings without spawning the CLI
- Reads MDM (plist/HKLM/HKCU) for parity with CLI startup
- **Deprecated**: `TodoWrite` tool — future versions switch to Task tools (`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`)

### TypeScript SDK v0.2.133 (May 7, 2026)
- **Deprecated**: Unstable V2 session API (`unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt`) — use `query()` instead
- **Deprecated**: Passing `'Skill'` in `allowedTools` — use the `skills` option instead
- Updated to parity with Claude Code v2.1.133

### TypeScript SDK v0.2.132 (May 6, 2026)
- Documented `applyFlagSettings()` and added support for `null` on top-level keys to clear flag-settings overrides

### TypeScript SDK v0.2.129 (May 6, 2026)
- Updated to parity with Claude Code v2.1.129

### TypeScript SDK v0.2.128 (May 4, 2026)
- Updated to parity with Claude Code v2.1.128

### TypeScript SDK v0.2.126 (May 1, 2026)
- **New**: `origin` field on result messages (`SDKResultSuccess` / `SDKResultError`)
- Forwards triggering message's `SDKMessageOrigin` to distinguish user-prompted results from `task-notification` followups

### TypeScript SDK v0.2.123 (April 29, 2026)
- Updated to parity with Claude Code v2.1.123

---

## Python SDK Releases (v0.1.63 → v0.1.80)

### Python SDK v0.1.80 (May 9, 2026)
- Updated bundled CLI to v2.1.138

### Python SDK v0.1.78 (May 8, 2026)
- Updated bundled CLI to v2.1.136

### Python SDK v0.1.77 (May 8, 2026)
- **Fixed**: Replaced generic `Command failed with exit code 1` exceptions with actionable error messages containing actual error text (e.g., "Reached maximum number of turns")
- **Deprecated**: `"Skill"` in `allowed_tools` — use `skills` option on `ClaudeAgentOptions`
- Updated bundled CLI to v2.1.133

### Python SDK v0.1.76 (May 6, 2026)
- **New**: `api_error_status: int | None` on `ResultMessage` for HTTP status codes (429, 500, 529, etc.)
- **Fixed**: `PermissionUpdate` deserialization in `ToolPermissionContext.suggestions`
- Added `PermissionUpdate.from_dict()` method

### Python SDK v0.1.74 (May 6, 2026) — **Major Feature Release**
- **New**: Hook event streaming with `include_hook_events` option
- **New**: Deferred hook decision support with `"defer"` option and `DeferredToolUse` dataclass
- **New**: Strict MCP config with `strict_mcp_config` option
- **New**: Permission context enrichment (`decision_reason`, `blocked_path`, `title`, `display_name`, `description`)
- **New**: `updatedToolOutput` in `PostToolUseHookSpecificOutput`
- **New**: `"xhigh"` effort level (Opus 4.7-specific)
- **New**: Subprocess cleanup on parent exit via `atexit` handler
- **Fixed**: `ResourceWarning` on disconnect (unclosed MemoryObjectReceiveStream)
- **Fixed**: Session `created_at` timestamp in `list_sessions()`
- Updated bundled CLI to v2.1.129

### Python SDK v0.1.73 (May 4, 2026)
- **New**: `session_store_flush` option (`"batched"` or `"eager"`)
- Eager mode enables near-real-time frame delivery for live-tailing UIs and crash-durability

### Python SDK v0.1.71 (April 29, 2026)
- **New**: Domain allowlist fields on `SandboxNetworkConfig`: `allowedDomains`, `deniedDomains`, `allowManagedDomainsOnly`, `allowMachLookup`
- Updated bundled CLI to v2.1.123

---

## Claude Code CLI Releases (v2.1.114 → v2.1.138)

### v2.1.136 (May 8) — Major Stability Release
- `CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL` for enterprise telemetry
- `settings.autoMode.hard_deny` for unconditional auto-mode blocking rules
- Fixed MCP servers from `.mcp.json`, plugins, and claude.ai connectors disappearing after `/clear`
- Fixed rare login loop from concurrent credential writes
- Fixed MCP OAuth refresh tokens lost during concurrent refreshes
- Fixed API 400 error with redacted thinking blocks after tool calls
- Fixed `--resume` / `--continue` failing with underscore-containing project paths
- WSL2 image paste via PowerShell fallback
- Fixed `@` file picker not matching recently-created files
- Fixed `@`-mention failing in directories with >100 entries

### v2.1.133 (May 7) — Worktree & Focus Improvements
- `worktree.baseRef` setting (`fresh` | `head`) for worktree branching strategy
- `sandbox.bwrapPath` and `sandbox.socatPath` managed settings (Linux/WSL)
- `parentSettingsBehavior` admin-tier key for policy merge
- Hooks receive `effort.level` via JSON input and `$CLAUDE_EFFORT` env var
- Fixed parallel session 401 errors from refresh-token race conditions
- Fixed subagents not discovering project/user/plugin skills

### v2.1.132 (May 6)
- `CLAUDE_CODE_SESSION_ID` env var in Bash tool
- `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` to disable fullscreen renderer
- Fixed external SIGINT not running graceful shutdown
- Fixed `--resume` failing with surrogate-pair emoji corruption

### v2.1.129 (May 6) — Plugin & Gateway Updates
- `--plugin-url <url>` flag for fetching plugin `.zip` from URLs
- Gateway `/v1/models` discovery opt-in via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `skillOverrides` setting (`off`, `user-invocable-only`, `name-only`)
- `claude_code.pull_request.count` OTel metric for MCP tool PRs
- Ctrl+R history picker defaults to all prompts across all projects

### v2.1.128 (May 4)
- `--plugin-dir` accepts `.zip` archives
- MCP: `workspace` is now a reserved server name
- `EnterWorktree` creates branches from local HEAD (preserving unpushed commits)
- SDK hosts receive persistent `localSettings` suggestion for Bash permission prompts

### v2.1.126 (May 1)
- `claude project purge [path]` to delete all Claude Code state
- `claude auth login` accepts OAuth code pasted into terminal (WSL2, SSH, containers)
- `/model` picker lists models from gateway `/v1/models`
- **Security**: Fixed `allowManagedDomainsOnly` / `allowManagedReadPathsOnly` being ignored
- Fixed pasting oversized images (now downscaled)

### v2.1.122 (April 28)
- `ANTHROPIC_BEDROCK_SERVICE_TIER` env var (`default`, `flex`, `priority`)
- `/resume` search finds sessions from PR URLs
- `claude_code.at_mention` OTel log event

### v2.1.121 (April 28) — MCP & Hook Improvements
- `alwaysLoad` option for MCP server config (skip tool-search deferral)
- `claude plugin prune` to remove orphaned dependencies
- Type-to-filter search in `/skills`
- PostToolUse hooks can replace tool output for all tools
- MCP servers with transient errors auto-retry up to 3 times
- Vertex AI: X.509 certificate-based Workload Identity Federation

### v2.1.120 (April 28)
- `claude ultrareview [target]` subcommand for non-interactive CI reviews
- Skills can reference effort level with `${CLAUDE_EFFORT}`
- `AI_AGENT` env var for subprocess traffic attribution
- **Native tools**: `Glob` and `Grep` replaced by embedded `bfs` and `ugrep` (v2.1.117)

### v2.1.119 (April 23)
- `/config` settings persist to `~/.claude/settings.json`
- `prUrlTemplate` for custom code-review URLs
- `--from-pr` accepts GitLab, Bitbucket, GitHub Enterprise PR URLs
- Hooks: `PostToolUse`/`PostToolUseFailure` include `duration_ms`
- Vim visual mode (`v`) and visual-line mode (`V`) (v2.1.118)
- Hooks can invoke MCP tools directly via `type: "mcp_tool"` (v2.1.118)

### v2.1.117 (April 22)
- Forked subagents via `CLAUDE_CODE_FORK_SUBAGENT=1`
- Agent frontmatter `mcpServers` loaded for main-thread sessions
- `/resume` offers to summarize stale sessions
- `cleanupPeriodDays` covers `~/.claude/tasks/`, `shell-snapshots/`, `backups/`
- Default effort for Pro/Max on Opus 4.6/Sonnet 4.6 now `high`

### v2.1.116 (April 20)
- `/resume` up to 67% faster on large sessions (40MB+)
- Faster MCP startup; deferred `resources/templates/list` to first `@`-mention
- Thinking spinner shows progress inline
- Agent frontmatter `hooks:` fire in main-thread agent mode

---

## Competitive Landscape Update

### Claude Code vs OpenAI Codex vs Google Jules (May 2026)

| Dimension | Claude Code | OpenAI Codex | Google Jules |
|-----------|-------------|--------------|--------------|
| Architecture | Synchronous terminal + IDE + desktop app | Desktop app + headless remote server | Async task pool + CLI (Jules Tools) |
| Models | Opus 4.7 (deep), Sonnet 4.6 (default) | GPT-5.4 (native computer use, 1M ctx) | Gemini 2.5 Pro (advanced thinking) |
| SWE-Bench Verified | **87.6%** (Opus 4.7 Adaptive) | 85% (GPT-5.3 Codex) | ~72% |
| SWE-Bench Pro | Coming (see note) | N/A | N/A |
| Strength | Interactive dev, plugin ecosystem, enterprise controls | Remote sandboxes, computer use, multi-env | Async batch work, GitHub integration |

**Note**: SWE-bench Verified contamination concerns — OpenAI stopped reporting Verified scores, recommending SWE-Bench Pro instead. Claude Mythos Preview reportedly scores 93.9% on Verified.

**Key competitive moves this period:**
- **Codex** launched headless `remote-control` server mode, persisted `/goal` workflows, multi-environment sessions, and Bedrock auth support
- **Jules** exited beta, launched Jules Tools CLI for scriptable agent control, announced tiered pricing (Pro/Ultra)
- **Google I/O 2026** (May 19) expected to announce **Project Jitro** — next-gen Jules with KPI-driven autonomous coding (agent identifies what to change to move a metric)
- **Claude** launched Managed Agents dreaming, outcomes, multiagent orchestration; finance agent templates; Microsoft 365 integration

---

## Managed Agents Update (May 7, 2026)

Three major new capabilities announced:

### 1. Dreaming (Research Preview)
Scheduled process that reviews agent sessions and memory stores, extracts patterns, and curates memories for continuous agent improvement. Surfaces recurring mistakes, convergent workflows, and team-shared preferences that no single agent can see.

### 2. Outcomes
Write a rubric describing success criteria. A separate grader evaluates output against the rubric in its own context window (isolated from agent reasoning). When criteria aren't met, grader pinpoints what needs to change and the agent iterates.

### 3. Multiagent Orchestration
A lead agent breaks work into pieces and delegates to specialists with their own model, prompt, and tools. Specialists work in parallel on a shared filesystem. Example: lead investigates while subagents fan out through deploy history, error logs, metrics, and support tickets.

### 4. Webhooks
Define an outcome, let the agent run, get notified by webhook when done.

---

## Community & Ecosystem

### GitHub Stars & Adoption (May 2026)
- **Karpathy's CLAUDE.md**: 110K+ stars, GitHub Trending #1 for 28 consecutive weeks
- **600+ community tools** in the Claude Code ecosystem
- Plugin marketplaces: 425 plugins, 2,810 skills, 200 agents (ccpi), 400K+ via SkillKit
- **VoltAgent/awesome-agent-skills**: 1,000+ cross-platform agent skills (Claude, Codex, Gemini CLI, Cursor)
- Claude Code repo: continued growth past 55K stars

### Trending Community Projects (New Since Last Scan)

| Project | Description |
|---------|-------------|
| **OpenClaw** | 210K+ stars — Full personal AI assistant built on Claude |
| **Hermes Agent** | 61K stars — Self-improving agent with persistent memory |
| **Skyvern** | Browser automation via LLMs + computer vision — Grade A community pick (May 2) |
| **VoltAgent/awesome-agent-skills** | 1,000+ production-ready skills across all coding agents |
| **claude-code-plugins-plus-skills** | 425 plugins, 2,810 skills, 200 agents with ccpi CLI |
| **awesome-claude-code-toolkit** | 135 agents, 42 commands, 176+ plugins, 20 hooks, 14 MCP configs |

### Enterprise Ecosystem
- **Anthropic Finance Agent Templates** (May 5): 10 ready-to-run templates for financial services — pitchbook builder, KYC screener, month-end closer, earnings reviewer, valuation reviewer, etc. Ship as plugins in Claude Cowork/Code and cookbooks for Managed Agents
- **Microsoft 365 Integration**: Claude add-ins for Excel, PowerPoint, Word, Outlook (coming). Context carries between applications
- **Coder Agents** (May 8): Coder launched agent infrastructure, Snyk-Claude partnership for security
- **Enterprise RBAC**: Admins can organize users into groups with custom roles defining Claude capabilities per member

---

## Key Patterns & Developments

### 1. TodoWrite → Task Tools Migration
The TS SDK v0.2.136 deprecated `TodoWrite` in favor of new Task tools (`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`). This is a significant API evolution — Buildd's task system aligns well with this direction, but our runner should plan for the tool name change.

### 2. V2 Session API Deprecated → query()
v0.2.133 deprecated the unstable V2 session APIs. The new `query()` method is the canonical way to interact with agents. This simplifies the API surface but requires migration if using V2 patterns.

### 3. Hook Event Streaming Goes Live
Python SDK v0.1.74 added `include_hook_events` for streaming hook events, deferred hook decisions, and rich permission context. CLI v2.1.118 added `type: "mcp_tool"` hooks — hooks can now invoke MCP tools directly. This enables sophisticated middleware patterns.

### 4. Session Store Eager Flushing
Python SDK v0.1.73's `session_store_flush: "eager"` enables near-real-time frame delivery. Critical for live-tailing UIs and crash-durability. Buildd's dashboard could benefit from real-time session streaming.

### 5. xhigh Effort Level (Opus 4.7)
Python SDK v0.1.74 added `"xhigh"` — near-max quality at lower latency and cost. Opus 4.7 is designed for agentic workloads with fewer tool calls and better file-system memory usage.

### 6. Managed Agents Dreaming & Outcomes
The dreaming system (cross-session pattern extraction) and outcomes (rubric-graded evaluation loop) represent two patterns Buildd could adopt at the workspace level — using mission-level analysis to improve agent performance over time, and structured evaluation for task quality.

### 7. resolveSettings() Alpha
TS SDK v0.2.136 added `resolveSettings()` to inspect effective merged settings without spawning CLI. Useful for pre-flight checks and configuration validation in orchestration systems.

### 8. Native Glob/Grep Replacement
CLI v2.1.117 replaced `Glob` and `Grep` tools with embedded `bfs` and `ugrep` binaries. Faster file operations and no dependency on system-installed tools.

### 9. Forked Subagents
CLI v2.1.117 added `CLAUDE_CODE_FORK_SUBAGENT=1` for external builds. This enables more efficient subagent spawning by forking the parent process.

### 10. Enterprise Security Hardening
Multiple security fixes across this period: `allowManagedDomainsOnly` enforcement, `autoMode.hard_deny` rules, `parentSettingsBehavior` for policy merge, `blockedMarketplaces` enforcement on plugin install/update.

---

## Recommendations for Buildd

### High Priority

1. **Upgrade SDK to v0.2.138** — Buildd is 19 versions behind (`^0.2.119` → `0.2.138`). Key gains: `resolveSettings()`, result message origin tracking, TodoWrite→Task tools migration path, V2 session API deprecation warnings. The `^0.2.119` semver range may auto-resolve some of these, but explicit bumping ensures we test against the latest.

2. **Prepare for TodoWrite → Task Tools migration** — The SDK deprecated `TodoWrite` in v0.2.136. Buildd's runner and skill system should plan for the transition to `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`. This is a breaking change coming in a future major version.

3. **Adopt `session_store_flush: "eager"`** — For Buildd's real-time dashboard, eager session flushing enables near-real-time frame delivery. This would significantly improve the live-tailing experience when watching worker output.

4. **Implement Outcomes-style evaluation** — Managed Agents' outcomes pattern (rubric + independent grader + retry loop) maps directly to Buildd's verification system. Define success criteria per task, evaluate with a separate context, and iterate. This is more structured than our current `verificationCommand` approach.

### Medium Priority

5. **Leverage result message `origin` field** — v0.2.126 added `SDKMessageOrigin` to result messages. Use this to distinguish user-initiated results from task-notification followups in the runner, enabling better progress tracking and cost attribution.

6. **Expose `xhigh` effort level** — Opus 4.7's `"xhigh"` effort (Python SDK v0.1.74) offers near-max quality at lower cost. Buildd roles could expose this as an effort option between `high` and `max` for complex but latency-sensitive tasks.

7. **Add hook event streaming** — Python SDK v0.1.74's `include_hook_events` enables streaming pre/post tool use events. Buildd's dashboard could show tool-level activity in real-time, not just message-level updates.

8. **Adopt `strict_mcp_config`** — Python SDK v0.1.74 added `strict_mcp_config` for stricter MCP server validation. Enable this in production runners to catch configuration errors early.

9. **Monitor Dreaming pattern for workspace-level analysis** — Managed Agents' dreaming (cross-session pattern extraction, recurring mistake detection, convergent workflow identification) is a pattern Buildd could implement at the mission level. Analyze completed tasks to surface patterns that improve future task execution.

### Lower Priority

10. **Evaluate Managed Agents for burst capacity** — With webhooks now available, Managed Agents could serve as overflow when self-hosted runners are maxed. Route non-critical tasks there and get webhook notifications on completion.

11. **Plugin URL loading** — CLI v2.1.129's `--plugin-url` flag enables loading plugins from URLs. Buildd's role configuration system could distribute skill packages via R2 URLs using this mechanism.

12. **Finance agent template patterns** — Anthropic's 10 finance templates show a pattern: specialized agents with tool access + connectors + subagents packaged as deployable plugins. This validates Buildd's role/skill architecture and suggests an opportunity for template marketplace.

13. **worktree.baseRef setting** — CLI v2.1.133 added `worktree.baseRef` (`fresh` | `head`). Buildd's worktree creation could expose this, defaulting to `fresh` for clean branches or `head` for tasks that need unpushed local changes.

14. **Cross-platform skill libraries** — VoltAgent's 1,000+ skills work across Claude, Codex, Gemini CLI, and Cursor. Explore compatibility with Buildd's skill format and potential import/export.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-05-11 | 0.2.114-0.2.138 | 0.1.63-0.1.80 | 2.1.114-2.1.138 | TodoWrite→Task tools, V2 API deprecated, resolveSettings(), hook events, eager flush, xhigh effort, dreaming/outcomes, finance templates, MS365 integration |
| 2026-04-20 | 0.2.104-0.2.114 | 0.1.54-0.1.63 | 2.1.101-2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94-0.2.104 | — | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | — | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | — | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
