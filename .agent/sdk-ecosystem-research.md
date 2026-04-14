# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-04-13
**Previous scan**: 2026-04-06
**Current SDK version in Buildd**: `^0.2.101` (latest: `0.2.104`)
**Claude Code CLI**: v2.1.93 through v2.1.101 released since last scan

---

## SDK Releases (v0.2.94 - v0.2.104)

### v0.2.104 (April 13, 2026)
- Changelog update only — no SDK-specific changes noted

### v0.2.101 (April 10, 2026)
- **Security**: Bumped `@anthropic-ai/sdk` to `^0.81.0` and `@modelcontextprotocol/sdk` to `^1.29.0` to resolve GHSA-5474-4w2j-mq4c and transitive hono advisories
- **Fixed**: Resume-session temp directory leaking on Windows/macOS APFS when `await using` disposal raced cleanup
- **Fixed**: `MaxListenersExceededWarning` when running 11+ concurrent `query()` calls

### v0.2.98 (April 9, 2026)
- Parity with Claude Code v2.1.98

### v0.2.97 (April 8, 2026)
- Parity with Claude Code v2.1.97

### v0.2.96 (April 8, 2026)
- Parity with Claude Code v2.1.96

### v0.2.94 (April 7, 2026)
- **Fixed**: `getContextUsage()` to include agents passed via `options.agents` in the `agents` breakdown
- **Fixed**: CJK/multibyte text corrupted with U+FFFD in stream-json when chunk boundaries split UTF-8 sequences
- **Fixed**: MCP server child processes not cleaned up when SDK `query()` session ends
- **Fixed**: Failed error-report write crashing SDK process with `unhandledRejection`

---

## Claude Code CLI Releases (v2.1.93 - v2.1.101)

### v2.1.101 Highlights (April 10)
- **`/team-onboarding`** command — generates teammate ramp-up guide from local Claude Code usage
- **OS CA certificate trust** by default — enterprise TLS proxies work without extra setup
- **`/ultraplan`** and remote sessions auto-create default cloud environment
- **Security**: Command injection fix in POSIX `which` fallback for LSP binary detection
- **Fixed**: Memory leak where long sessions retained dozens of historical message list copies
- **Fixed**: `--resume`/`--continue` losing conversation context on large sessions
- **Fixed**: Subagents not inheriting MCP tools from dynamically-injected servers
- **Fixed**: Sub-agents in isolated worktrees denied Read/Edit access to own worktree files
- SDK `query()` cleaning up subprocess and temp files on `break`/`await using`

### v2.1.98 Highlights (April 9)
- **Interactive Vertex AI setup wizard** from login screen
- **Monitor tool** for streaming events from background scripts
- **Subprocess sandbox** with PID namespace isolation on Linux
- **`CLAUDE_CODE_SCRIPT_CAPS`** — limit per-session script invocations
- **Security**: Bash tool permission bypass (backslash-escaped flags) fixed
- **Security**: Compound Bash commands bypassing forced permission prompts fixed
- **Fixed**: MCP HTTP/SSE connections accumulating ~50 MB/hr unreleased buffers on reconnect
- **Fixed**: 429 retries burning all attempts in ~13s — exponential backoff now applies as minimum
- `/agents` with tabbed layout (Running/Library tabs)

### v2.1.97 Highlights (April 8)
- **Focus view toggle** (`Ctrl+O`) in NO_FLICKER mode — shows prompt, one-line tool summary with edit diffstats, and final response
- **`refreshInterval`** status line setting to re-run command every N seconds
- **Fixed**: NO_FLICKER mode memory leak from API retries leaving stale streaming state
- **Fixed**: MCP HTTP/SSE connections accumulating ~50 MB/hr unreleased buffers
- Bridge sessions showing local git repo, branch, working directory on claude.ai card

### v2.1.96 (April 8)
- **Fixed**: Bedrock requests failing with 403 when using `AWS_BEARER_TOKEN_BEDROCK` (regression in v2.1.94)

### v2.1.94 Highlights (April 7)
- **Amazon Bedrock via Mantle** support (`CLAUDE_CODE_USE_MANTLE=1`)
- **Plugin skills** via `"skills": ["./"]` using frontmatter `name` for stable invocation
- **Changed**: Default effort level from medium to **high** for API-key, Bedrock/Vertex/Foundry, Team, and Enterprise users
- **Fixed**: Agents appearing stuck after 429 with long Retry-After — error now surfaces immediately
- **Fixed**: CJK/multibyte text corrupted with U+FFFD in stream-json on UTF-8 chunk boundaries

---

## Major Ecosystem Development: Claude Managed Agents (April 8, 2026)

Anthropic launched **Claude Managed Agents** in public beta — a hosted agent execution environment.

### What It Is
- Fully managed agent runtime: sandboxed code execution, checkpointing, credential management, scoped permissions, end-to-end tracing
- Developers define model, system prompt, tools, MCP servers, and skills — Anthropic handles orchestration
- Architecture decouples the "brain" (Claude + harness) from the "hands" (sandboxes + tools) from the "session" (event log)
- Long-running sessions that persist through disconnections

### Pricing
- Standard Claude token rates + **$0.08 per session-hour** for active agent runtime
- No flat monthly fee — scales with usage

### Multi-Agent Coordination (Research Preview)
- Agents can spin up and direct other agents for parallel work
- Requires separate access request (not in public beta yet)

### Launch Integrations
- Day-one: ClickUp, Slack, Notion
- Coming soon: Google Workspace (Gmail, Drive, Calendar), Microsoft 365, GitHub

### Early Adopters
- **Notion**: Teams delegate coding, slides, spreadsheets to Claude
- **Rakuten**: Specialist agents across departments, live in under a week
- **Asana**: AI Teammates that pick up assigned tasks inside projects
- **Sentry**: Agent goes from flagged bug to open PR, fully autonomous

### Competitive Positioning
- Competes directly with AWS Bedrock Agents and Google Vertex AI Agents
- Performance: up to 10-point task success improvement over standard prompting loops

---

## Community & Ecosystem

### GitHub Stars & Adoption
- Claude Code: **55K+ GitHub stars** (official repo)
- **claw-code** (Rust rewrite from source leak): hit 50K stars in 2 hours — all-time GitHub record
- Claude Code now authors **~4% of all GitHub commits** — a structural shift in software development
- **340+ community resources** across 20+ categories
- **awesome-claude-code** list: 2,300+ skills, 770+ MCP servers, 95+ curated plugin repos

### Trending Community Projects (New Since Last Scan)
- **Auto-Claude** — Autonomous multi-agent coding framework with kanban UI and full SDLC integration
- **Claude Squad** (smtg-ai) — Terminal app managing multiple Claude Code, Codex, and local agents in separate workspaces
- **ccpm** (6K stars) — Project management for Claude Code using GitHub Issues + Git worktrees for parallel agent execution
- **VoltAgent/awesome-claude-code-subagents** — Collection of 100+ specialized subagents
- **claudekit** — CLI toolkit with auto-save checkpointing, code quality hooks, and 20+ specialized subagents
- **CCHub** — Desktop app (Tauri v2 + React + Rust) for managing MCP marketplace, config profiles, skills, workflow templates

### Notable MCP Server Trends
- **Context7** (Upstash) — Live, version-specific library documentation injection into sessions
- **context-mode** — Process large outputs in sandboxed subprocesses, 98% context savings across 21 benchmarks
- **codebase-graph** — Knowledge graphs from source code with 42-language tree-sitter AST parsing
- **maestro-orchestrate** — Multi-agent orchestration with 22 specialized subagents and 4-phase workflows
- **gstack** (Y Combinator CEO Garry Tan) — Six skills bundling planning, review, and shipping

### Microsoft Agent Framework Integration
- Microsoft published official guide for building Claude agents with Microsoft Agent Framework
- Supports sequential, concurrent, handoff, and group chat workflows
- A2A protocol support for cross-framework agent communication

---

## Key Patterns & Developments

### 1. Claude Managed Agents — The Platform Play
Anthropic's biggest strategic move since Claude Code. Shifts from "SDK you host" to "platform we run." Key implications for Buildd:
- Potential competition: Managed Agents provides task lifecycle, sandboxing, and multi-agent coordination out of the box
- Opportunity: Buildd's orchestration layer adds workspace-level coordination, team roles, and mission tracking that Managed Agents doesn't provide
- Watch: Multi-agent coordination moving from research preview to GA

### 2. Security Hardening Cycle
This week saw aggressive security fixes:
- Bash tool permission bypass via backslash-escaped flags
- Compound Bash commands bypassing forced permission prompts
- Subprocess PID namespace isolation on Linux
- `CLAUDE_CODE_SCRIPT_CAPS` to limit script invocations
- Command injection in POSIX `which` fallback
- These fixes reinforce the importance of sandboxing in worker execution

### 3. Enterprise & Multi-Cloud Maturation
- Interactive Vertex AI setup wizard (alongside existing Bedrock wizard)
- Amazon Bedrock via Mantle support
- OS CA certificate trust for enterprise TLS proxies
- `forceRemoteSettingsRefresh` for fail-closed managed settings
- Default effort level raised to **high** for paid users

### 4. Observability & Developer Experience
- Focus view (`Ctrl+O`) for distraction-free output
- `/team-onboarding` for team ramp-up guide generation
- Monitor tool for background script event streaming
- Status line `refreshInterval` for live data
- `/agents` tabbed layout with Running/Library tabs
- Bridge sessions showing git context on claude.ai

### 5. MCP Ecosystem: Context Efficiency as Key Differentiator
- Tool Search (lazy loading) reduces context usage by up to 95%
- context-mode plugin: 98% context savings
- MCP result persistence (500K chars) enables richer tool responses
- MCP HTTP/SSE memory leak fix (50 MB/hr) — critical for long-running workers

---

## Recommendations for Buildd

### High Priority

1. **Bump SDK to `^0.2.104`** — picks up security fix (GHSA-5474-4w2j-mq4c), concurrent query fix (11+ sessions), and temp directory cleanup. Current `^0.2.101` already gets v0.2.101 fixes but not v0.2.104.

2. **Monitor Managed Agents GA timeline** — Managed Agents is the biggest competitive signal. Buildd's value-add is workspace-level orchestration (missions, roles, team coordination, memory) that Managed Agents doesn't provide. Position Buildd as the orchestration layer *on top of* Managed Agents rather than competing with it.

3. **Apply security learnings to worker execution** — The Bash permission bypass fixes highlight risks in worker sandboxing. Ensure workers can't use backslash-escaped flags or compound commands to escape restrictions. Consider PID namespace isolation (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`).

4. **Leverage default effort=high change** — v2.1.94 changed default effort from medium to high for API-key users. Buildd workers may see higher quality but also higher costs. Consider exposing effort level as a task/role configuration.

### Medium Priority

5. **Explore Managed Agents as an alternative worker runtime** — Instead of self-hosted runners, tasks could execute on Managed Agents infrastructure. Benefits: sandboxing, checkpointing, credential management built-in. Cost: $0.08/session-hour + tokens.

6. **Adopt Focus view pattern for dashboard** — The `Ctrl+O` Focus view (prompt → one-line tool summary → response) is a validated UX for showing agent work. Apply similar distillation in task detail views.

7. **Implement `/team-onboarding` equivalent** — Auto-generate workspace ramp-up guides from existing task history, role definitions, and memory. Reduces onboarding friction for new team agents.

8. **Use Context7 pattern for workspace context** — Context7's approach of injecting version-specific documentation could apply to workspace-specific context (schemas, conventions, patterns) injected into worker sessions.

### Lower Priority

9. **Evaluate Microsoft Agent Framework integration** — The A2A protocol enables cross-framework agent communication. Buildd could coordinate Claude agents alongside Azure OpenAI or GitHub Copilot agents.

10. **Investigate context-mode pattern** — 98% context savings from sandboxed output processing could significantly extend worker session lifetimes on complex tasks.

11. **Consider Managed Agents for burst capacity** — When self-hosted runners are at capacity, overflow tasks could route to Managed Agents. Hybrid execution model.

---

## Version History

| Date | SDK Versions | CLI Versions | Key Changes |
|------|-------------|-------------|-------------|
| 2026-04-13 | 0.2.94-0.2.104 | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
