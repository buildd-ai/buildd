# SDK Ecosystem Research — March 30, 2026

## Executive Summary

The Claude Agent SDK ecosystem continues rapid growth. SDK v0.2.87 is current (parity with CLI v2.1.87). Major platform shifts this week: **computer use in Claude Code/Cowork** (March 23), **Cowork Dispatch message delivery fix** (v2.1.87), and significant SDK API surface expansion with `getContextUsage()`, `taskBudget`, `reloadPlugins()`, and `enableChannel()`. Community ecosystem now indexes **9,600+ repositories** and **1,326+ agentic skills**. claude-mem hit 43.4K stars in days, signaling massive demand for session memory tooling.

---

## 1. SDK Releases (v0.2.80–v0.2.87)

### v0.2.87 (Mar 29)
- Parity with Claude Code v2.1.87
- Fixed Cowork Dispatch message delivery

### v0.2.86 (Mar 27)
- **`getContextUsage()`** — track context window usage by category (tokens by tool, user, assistant)
- `session_id` optional in `SDKUserMessage`
- TypeScript type fixes

### v0.2.85 (Mar 26)
- **`reloadPlugins()`** — hot-reload plugins and MCP servers without restarting session
- Fixed PreToolUse hooks with `permissionDecision: "ask"`

### v0.2.84 (Mar 26)
- **`taskBudget`** — API-side token budget awareness per task
- **`enableChannel()`** — programmatic MCP channel activation
- Exported `EffortLevel` type

### v0.2.83 (Mar 25)
- **`seed_read_state`** control subtype — inject file state into new sessions
- `session_state_changed` events now opt-in (reduce noise)

### v0.2.81 (Mar 20)
- Fixed `canUseTool` with `.claude/skills/` bypass-immune safety checks

### v0.2.80 (Mar 19)
- Fixed `getSessionMessages()` dropping parallel tool results

### v0.2.79 (Mar 18)
- Added `'resume'` to `ExitReason` type

### v0.2.77 (Mar 17)
- `api_retry` system messages for transient API errors

---

## 2. Claude Code CLI Changes (v2.1.80–v2.1.87)

### Major Features
| Feature | Version | Impact |
|---------|---------|--------|
| **Computer Use** | v2.1.85+ | Claude can interact with screen — open files, click, navigate. No setup required. Pro/Max only |
| **`--bare` flag** | v2.1.81 | 14% faster scripted calls — skips hooks/LSP/plugins. Ideal for CI/automation |
| **`--channels`** | v2.1.81 | MCP servers push messages into sessions; permission relay to phone |
| **PowerShell tool** | v2.1.84 | Windows opt-in preview |
| **Conditional hooks** | v2.1.85 | `if` field using permission rule syntax (e.g., `Bash(git *)`) |
| **Transcript search** | v2.1.83 | Press `/` in transcript mode, `n`/`N` to navigate |
| **`CwdChanged`/`FileChanged` hooks** | v2.1.83 | Reactive environment management |
| **`TaskCreated` hook** | v2.1.84 | Trigger on task creation |
| **`X-Claude-Code-Session-Id` header** | v2.1.86 | Proxies can aggregate requests by session |
| **MCP OAuth RFC 9728** | v2.1.85 | Protected Resource Metadata discovery |
| **Plugin allowlists** | v2.1.84 | `allowedChannelPlugins` managed setting |
| **`initialPrompt` in agent frontmatter** | v2.1.83 | Auto-submit prompts for agents |
| **Managed settings drop-in** | v2.1.83 | `managed-settings.d/` policy fragments |
| **Env scrubbing** | v2.1.83 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from subprocesses |

### Performance & Stability
- ~30ms startup improvement via parallel `setup()` (v2.1.84)
- ~80MB memory reduction on large repos (v2.1.80)
- Improved prompt cache hit rate for Bedrock/Vertex/Foundry (v2.1.86)
- Compact line-number format in Read tool reduces token usage (v2.1.86)
- `@` file autocomplete responsive in large git repos (v2.1.80)
- Fixed `--resume` dropping parallel tool results (v2.1.80)
- Fixed background subagents becoming invisible after compaction (v2.1.83)

### Breaking Changes
- `Ctrl+F` → `Ctrl+X Ctrl+K` for "stop all background agents" (v2.1.83)
- `tool_parameters` in OpenTelemetry hidden by default — requires `OTEL_LOG_TOOL_DETAILS=1` (v2.1.85)

---

## 3. Community Projects & Ecosystem

### Explosive Growth
- **9,600+ repositories** indexed in Claude Code plugin ecosystem (Mar 29)
- **1,326+ agentic skills** in installable library
- **150+ skills** on claudemarketplace.com
- **46+ official plugins** on Anthropic marketplace
- Claude Code itself: **82K+ GitHub stars**, 6.8K forks

### Trending Projects (New/Notable)

| Project | Stars | Description |
|---------|-------|-------------|
| **claude-mem** | 43.4K | Auto-captures session activity, compresses with AI, injects relevant context into future sessions. Fastest-growing Claude plugin in GitHub history |
| **agentic-flow** | 587 | Switch between affordable AI models in Claude Code/Agent SDK with cloud deploy |
| **claude-agent-server** | 554 | Sandboxed Claude agent environments with WebSocket control |
| **meridian** | 479 | Proxy bridging Anthropic SDK to enable Claude Max in third-party tools |
| **metabot** | 472 | Infrastructure for supervised, self-improving agent orgs with memory sharing and task scheduling |
| **oh-my-claudecode** | — | Multi-agent orchestration: Swarm Mode, Pipeline Mode, Ecomode (30-50% token savings) |
| **agent-orchestrator** (ComposioHQ) | — | Agent-agnostic orchestrator for Claude Code, Codex, Aider. Runtime-agnostic (tmux, Docker) |
| **ruflo** | — | Multi-agent swarm platform with RAG integration and native Claude Code support |
| **dorabot** | 213 | macOS 24/7 AI agents with memory, scheduled tasks, messaging integration |
| **ArcReel** | 90 | AI Agent-driven video generation workspace |

### Curated Collections
- **awesome-claude-code** (hesreallyhim) — skills, hooks, slash-commands, orchestrators, plugins
- **awesome-claude-code-toolkit** (rohitg00) — 135 agents, 35 skills, 42 commands, 150+ plugins, 19 hooks
- **awesome-agent-skills** (VoltAgent) — 1,000+ skills compatible with Claude Code, Codex, Cursor, Gemini CLI
- **awesome-claude-plugins** (quemsah) — Adoption metrics via n8n workflows

---

## 4. Emerging Patterns & Architecture

### Computer Use + Dispatch Pattern
- Claude Code can now interact with screen (point, click, navigate) — no setup
- Combined with Dispatch: agents perform complex GUI tasks while user is away
- Opens new automation surface: browser workflows, desktop app testing, visual verification

### `--bare` for High-Throughput Orchestration
- 14% faster cold start by skipping hooks/LSP/plugins
- Ideal for Buildd's worker model — each task run is ephemeral
- Requires `ANTHROPIC_API_KEY` (no OAuth), disables auto-memory

### Context Budget Management
- `getContextUsage()` enables monitoring context consumption in real-time
- `taskBudget` sets API-side token limits per task
- Pattern: check context → compact early → avoid expensive overflows

### Session State Injection
- `seed_read_state` lets you inject file contents at session start without tool calls
- Reduces turn count and token overhead for known-context tasks
- Pattern: pre-load workspace context → fewer early Read calls

### Plugin Hot-Reload
- `reloadPlugins()` refreshes MCP servers mid-session
- Enables dynamic skill loading: start lean → load specialized tools as needed
- Pattern: progressive skill activation based on task type

### Conditional Hooks
- `if` field on hooks enables selective execution (e.g., `Bash(git *)`)
- Reduces hook overhead: only fire for relevant tool calls
- Pattern: security hooks on destructive commands, logging hooks on file writes

### Multi-Agent Orchestration Maturation
- Agent Teams now experimental (3-5 teammates recommended)
- Key patterns: research/review, parallel module development, competing debugging hypotheses
- oh-my-claudecode adds Ecomode (30-50% token savings) and Pipeline/Swarm modes
- ComposioHQ agent-orchestrator is runtime-agnostic (tmux, Docker)

### Session Memory (claude-mem phenomenon)
- 43.4K stars signals massive unmet demand for cross-session memory
- Auto-capture → compress → inject pattern becoming standard
- Buildd already has workspace memory — validates our approach

---

## 5. Recommendations for Buildd

### High Priority

1. **Bump SDK to ≥0.2.87** ✅ Already done
   - Ensure runner uses `getContextUsage()` to monitor worker context health
   - Surface context usage in worker activity timeline

2. **Adopt `taskBudget` (v0.2.84)**
   - Set token budgets per task based on priority/complexity
   - Integrate with existing cost-limit logic for API key auth
   - Prevents runaway token consumption on complex tasks

3. **Use `--bare` for worker execution**
   - 14% faster cold start per task claim
   - Workers don't need hooks/LSP/plugin sync
   - Already using `ANTHROPIC_API_KEY` — compatible

4. **Implement `seed_read_state` for workspace context**
   - Inject CLAUDE.md, schema, and key files at session start
   - Reduces early Read tool calls and token waste
   - Especially valuable for retry tasks with known context

### Medium Priority

5. **Surface `getContextUsage()` in dashboard**
   - Show workers' context consumption in real-time
   - Alert when workers approach context limits
   - Enable smarter auto-compaction decisions

6. **Leverage conditional hooks**
   - Add `if` filters to runner hooks for selective execution
   - Example: only fire security checks on `Bash(rm *)`, `Bash(git push *)`
   - Reduces overhead per tool call

7. **Explore `reloadPlugins()` for dynamic skill loading**
   - Start workers with minimal skill set
   - Hot-load specialized skills when task type is determined
   - Reduces initial context overhead

8. **Monitor `--channels` for async worker communication**
   - MCP servers pushing messages into sessions
   - Could enable real-time instruction delivery without polling
   - Currently research preview — watch for stability

### Low Priority / Watch

9. **Computer Use integration** — when GA, could enable visual testing/verification tasks
10. **Agent Teams** — watch for stability; could enhance mission execution with parallel teammates
11. **Ecomode patterns** (from oh-my-claudecode) — token savings techniques for long-running workers
12. **claude-mem pattern** — cross-session memory injection; Buildd's workspace memory already covers this, but the auto-capture approach could inform improvements

---

## 6. Ecosystem Health Metrics

| Metric | Value | Trend |
|--------|-------|-------|
| SDK version | v0.2.87 | +11 versions since last scan (v0.2.76) |
| CLI version | v2.1.87 | +11 versions since last scan |
| GitHub repos indexed | 9,600+ | Up from ~5,000 last scan |
| Agentic skills | 1,326+ | Growing rapidly |
| Claude Code stars | 82K+ | +4K since last scan |
| Plugin marketplaces | 46+ official | Stable |
| Community marketplaces | 150+ on claudemarketplace.com | New metric |

---

*Research conducted: March 30, 2026*
*Buildd SDK version: v0.2.87 (current)*
*Next scan: ~April 6, 2026*
