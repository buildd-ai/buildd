# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-04-06
**Previous scan**: 2026-03-30
**Current SDK version in Buildd**: `^0.2.91` (latest: `0.2.92`)
**Claude Code CLI**: v2.1.88 through v2.1.92 released since last scan

---

## SDK Releases (v0.2.88 - v0.2.92)

### v0.2.92 (April 4, 2026)
- Parity with Claude Code v2.1.92
- No SDK-specific changes noted

### v0.2.91 (April 2, 2026)
- **`terminal_reason` field** on result messages — exposes why the query loop terminated (`completed`, `aborted_tools`, `max_turns`, `blocking_limit`, etc.)
- **`'auto'` permission mode** added to public `PermissionMode` type
- **Breaking**: `sandbox.failIfUnavailable` now defaults to `true` when `enabled: true` — query will error if sandbox deps missing instead of silently running unsandboxed

### v0.2.90 (April 1, 2026)
- Parity with Claude Code v2.1.90

### v0.2.89 (April 1, 2026)
- **`startup()` pre-warm** — pre-warms CLI subprocess before `query()`, making first query ~20x faster when startup cost can be paid upfront
- **`includeSystemMessages`** option for `getSessionMessages()`
- **`listSubagents()` / `getSubagentMessages()`** — retrieve subagent conversation history from sessions
- **`includeHookEvents`** — enable hook lifecycle messages (`hook_started`, `hook_progress`, `hook_response`)
- Fixed `ERR_STREAM_WRITE_AFTER_END` errors in single-turn queries with SDK MCP servers
- Fixed Zod v4 `.describe()` metadata dropped from `createSdkMcpServer` tool schemas
- Fixed MCP servers getting permanently stuck after connection race — now retry on next message
- Fixed error result messages to correctly set `is_error: true`

### v0.2.88
- Skipped in changelog (likely minor/internal)

---

## Claude Code CLI Releases (v2.1.88 - v2.1.92)

### v2.1.92 Highlights (April 4)
- `forceRemoteSettingsRefresh` policy — fail-closed startup until managed settings fetched
- Interactive **Bedrock setup wizard** from login screen
- Per-model and cache-hit breakdown in `/cost`
- `/release-notes` interactive version picker
- Remote Control session names use hostname as default prefix
- **Write tool 60% faster** on large files with tabs/`&`/`$`
- Removed `/tag` and `/vim` commands

### v2.1.91 Highlights (April 2)
- **MCP tool result persistence** up to 500K chars via `_meta["anthropic/maxResultSizeChars"]`
- `disableSkillShellExecution` setting
- Plugins can ship **executables under `bin/`**
- Edit tool uses shorter `old_string` anchors (fewer output tokens)
- Faster `stripAnsi` on Bun

### v2.1.90 Highlights (April 1)
- **`/powerup`** — 18 interactive lessons with animated demos
- `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` for offline environments
- `.husky` added to protected directories
- Fixed `--resume` prompt-cache miss regression (since v2.1.69)
- Fixed auto mode not respecting explicit user boundaries
- **SSE transport linear-time** fix (was quadratic)
- **SDK transcript writes** no longer slow down quadratically
- Removed `Get-DnsClientCache` from auto-allow (DNS cache privacy)

### v2.1.89 Highlights (April 1)
- **`"defer"` permission decision** for PreToolUse hooks — headless sessions can pause and resume
- `CLAUDE_CODE_NO_FLICKER=1` for flicker-free alt-screen rendering
- `PermissionDenied` hook with `{retry: true}` support
- Named subagents in `@` mention typeahead
- `MCP_CONNECTION_NONBLOCKING=true` for `-p` mode (5s bounded connections)
- Auto mode: denied commands now show in `/permissions` with retry
- Fixed autocompact thrash loop detection
- Fixed nested CLAUDE.md re-injected dozens of times in long sessions

### v2.1.88 (April 1)
- Fixed Cowork Dispatch message delivery

---

## Community & Ecosystem

### GitHub Stars & Adoption
- Claude Code: **82K+ GitHub stars** (up from ~81.6K last scan)
- **10,913 repos** indexed in plugin adoption metrics (up from 9,600+)
- **2,300+ skills**, **770+ MCP servers**, **95+ curated plugin repos**
- Plugin marketplace: "Anthropic Verified" badge for quality/safety review

### GitHub Agent HQ (New)
- GitHub launched **Agent HQ** — multi-agent orchestration platform in GitHub
- Supports **Claude, Codex, and Copilot** side-by-side in PRs
- Available to Copilot Pro+ and Enterprise subscribers
- `@Claude` mention in PR comments for complex debugging and architectural review
- Agent activity logged and reviewable in PR history

### Trending Community Projects
- **everything-claude-code** (140K stars) — agent harness performance optimization with skills, instincts, memory, security for Claude Code, Codex, Opencode, Cursor
- **claude-mem** (43.4K+ stars) — auto-capture session memory across sessions
- **agent-orchestrator** (ComposioHQ) — parallel coding agent spawning with CI fixes, merge conflicts, code reviews
- **ruflo** — multi-agent swarm platform with enterprise architecture, RAG integration, native Claude Code/Codex support
- **awesome-claude-plugins** — automated adoption metrics via n8n workflows
- **awesome-claude-code** — curated skills, hooks, slash commands, orchestrators directory

### Notable Plugin Ecosystem Trends
- Top MCP servers: Figma, Playwright, Vercel, PostgreSQL, GitHub
- Plugin `bin/` executables — new in v2.1.91, expanding toolchain capabilities
- MCP result persistence (500K chars) enables richer tool responses (DB schemas, large indexes)
- `disableSkillShellExecution` for enterprise security hardening

---

## Key Patterns & Developments

### 1. Subagent Observability
The SDK now provides deep subagent introspection:
- `listSubagents()` / `getSubagentMessages()` for conversation history
- `agentProgressSummaries` for periodic AI-generated progress on running subagents
- `supportedAgents()` to query available subagents
- `terminal_reason` to understand why agents stopped

### 2. Session Lifecycle Control
- `startup()` pre-warm for **~20x faster** first query
- `"defer"` hook permission for pause/resume workflows
- `MCP_CONNECTION_NONBLOCKING=true` for faster headless startup
- Autocompact thrash loop detection prevents runaway sessions

### 3. Enterprise Hardening
- `forceRemoteSettingsRefresh` — fail-closed managed settings
- `sandbox.failIfUnavailable` defaults to `true` (breaking change)
- `disableSkillShellExecution` for controlled environments
- DNS cache privacy (removed auto-allow for cache inspection)
- Plugin `bin/` executables with proper sandboxing

### 4. Multi-Agent Orchestration Maturation
- GitHub Agent HQ: official multi-model agent coordination
- ComposioHQ agent-orchestrator: task planning → parallel agent spawning → CI fix
- Named subagents with `@` mention typeahead for better discoverability
- Auto mode boundary enforcement improvements

---

## Recommendations for Buildd

### High Priority

1. **Bump SDK to `^0.2.92`** — picks up `terminal_reason` field (useful for worker failure diagnosis) and sandbox hardening

2. **Adopt `startup()` pre-warm** — workers can pre-warm the CLI subprocess, making the first query ~20x faster. This is a significant latency improvement for task execution.

3. **Use `terminal_reason` for worker status** — surface why a worker's session ended (`max_turns`, `max_budget_usd`, `aborted_tools`, etc.) in the dashboard. Better diagnostics than generic "completed" or "failed".

4. **Adopt MCP result persistence (500K chars)** — our MCP server can return larger results (full task context, workspace schemas) without truncation using `_meta["anthropic/maxResultSizeChars"]`.

### Medium Priority

5. **Implement `"defer"` hook pattern** — for tasks needing human approval mid-execution, workers could pause at a tool call and resume when approved. Maps well to "waiting_input" state.

6. **Surface subagent observability** — use `listSubagents()` and `agentProgressSummaries` to show sub-task progress in the dashboard when workers spawn subagents.

7. **Leverage `MCP_CONNECTION_NONBLOCKING=true`** — for worker startup in `-p` mode, bound MCP connection wait to 5s. Prevents hangs when MCP servers are slow.

8. **Add `/powerup`-style onboarding** — the interactive lesson system is a validated UX pattern. Consider something similar for new Buildd users.

### Lower Priority

9. **GitHub Agent HQ integration** — as Agent HQ matures, Buildd could position as the orchestration layer that coordinates tasks across Claude, Codex, and Copilot agents via `@` mentions.

10. **Plugin bin/ executables** — explore shipping custom CLI tools as part of role configs, now that plugins support executables under `bin/`.

---

## Version History

| Date | SDK Versions | CLI Versions | Key Changes |
|------|-------------|-------------|-------------|
| 2026-04-06 | 0.2.88-0.2.92 | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
