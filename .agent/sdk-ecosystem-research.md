# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-05-25
**Previous scan**: 2026-04-20
**Current SDK version in Buildd**: `^0.2.119` (latest: `0.3.150` — **major version jump, breaking changes**)
**Python SDK**: v0.2.87 (latest)
**Claude Code CLI**: v2.1.150 (released May 23, 2026)

> ⚠️ **Critical: June 15, 2026 deadline (3 weeks away)**
> - Agent SDK billing splits from subscription plans onto separate credit pools
> - Sonnet 4 + Opus 4 base model IDs retired (verify no Buildd config references these)
> - TS SDK `^0.2.119` → `^0.3.150` requires migration (v2 session API removed, TodoWrite deprecated)

---

## SDK Releases (v0.2.114 → v0.3.150)

### TypeScript Agent SDK v0.3.142 — Major Breaking Release (~May 2026)

This was the most significant release: version jumped from `0.2.x` to `0.3.x` with multiple breaking changes.

**Breaking Changes:**
- **v2 session API removed**: `unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`, `SDKSession`, `SDKSessionOptions` all removed. Migrate to `query()` — pass `AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` for session resumption.
- **MCP servers now connect in background by default**: Sessions start immediately; slow servers report `status: "pending"` in `init`. Use `MCP_CONNECTION_NONBLOCKING=0` to restore old blocking behavior, or mark `alwaysLoad: true` to require a server at turn 1.
- **Task tools replace TodoWrite**: Headless/SDK sessions now use `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` instead of `TodoWrite`. Consumers must accumulate by task ID (not replace a snapshot list).
- **Surfaced new message fields**: `request_id`, `subagent_type`, `task_description` now exposed on SDK message types and task system events.
- **Headless SDK sessions exit non-zero** on permanent transport close (401/403/404 or WS close).

### TypeScript Agent SDK v0.3.143

- `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` moved to `peerDependencies` (still bundled at runtime; auto-installed by npm/bun/pnpm; yarn classic users must add explicitly).

### TypeScript Agent SDK v0.3.144

- `error: 'model_not_found'` instead of generic `'invalid_request'` when a model is unavailable — enables programmatic detection.
- New `@anthropic-ai/claude-agent-sdk/extract` export with `extractFromBunfs(binPath)` for `bun build --compile` consumers.

### TypeScript Agent SDK v0.3.149

- Fixed `options.env` dropping `CLAUDE_AGENT_SDK_VERSION` when custom environment is supplied.

### TypeScript Agent SDK v0.2.136 (pre-breaking, ~April 28)

- `resolveSettings()` (alpha) — inspect effective merged settings without spawning the Claude CLI. Reads MDM (plist/HKLM/HKCU) for parity with CLI startup.
- `TodoWrite` tool formally deprecated (removal landed in 0.3.142).

### TypeScript Agent SDK v0.2.133 (~April 24)

- `unstable_v2_createSession` / `resumeSession` / `prompt` deprecated.
- Passing `'Skill'` in `allowedTools` deprecated — use the `skills` option instead.

---

## Python Agent SDK (v0.1.63 → v0.2.87)

The Python SDK had a parallel major version bump (0.1.x → 0.2.x) with analogous breaking changes.

### Python SDK v0.2.82 — Major Breaking Release (May 15, 2026)

**Breaking:**
- **MCP servers non-blocking by default** (same behavior as TS 0.3.142).
- **Task tools replace TodoWrite** (same migration path as TS).

**New:**
- `EffortLevel` type exported: `"low" | "medium" | "high" | "max" | "xhigh"`.
- Security fix: bumped `mcp` dependency to `>=1.23.0` to address CVE-2025-66416 (GHSA-9h52-p55h-vw2f).

### Python SDK v0.2.87 (May 23, 2026) — Latest

- CI workflows switched to Workload Identity Federation (short-lived tokens vs long-lived secrets).
- Bundles Claude Code CLI v2.1.150.

---

## Claude Code CLI Releases (v2.1.114 → v2.1.150)

### v2.1.149 — May 22, 2026

- `/usage` now shows **per-category cost breakdown** (skills, subagents, plugins, per-MCP-server).
- `/diff` detail view now keyboard-navigable (arrows, j/k, PgUp/PgDn, Space, Home/End).
- Markdown output renders GFM task list checkboxes (`- [ ]`/`- [x]`).
- Enterprise: `allowAllClaudeAiMcps` managed setting — loads all claude.ai cloud MCP connectors alongside `managed-mcp.json`.

### v2.1.142 — Task tools go default

- `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` become the default planning mechanism.
- `TodoWrite` still functional but deprecated.
- Known issue: Task tools bypass `PreToolUse`/`PostToolUse` hooks (regression).
- Known issue: Task tools silently disabled in VS Code extension (`isTTY` check fails over pipes).

### v2.1.138-140 — May 8-9, 2026

- **`worktree.baseRef`** setting (`fresh | head`): controls whether `--worktree`, `EnterWorktree`, and agent-isolation worktrees branch from `origin/<default>` or local `HEAD`.
- **`sandbox.bwrapPath`** and **`sandbox.socatPath`** — specify custom binary paths for bubblewrap/socat on Linux/WSL.
- **`parentSettingsBehavior`** admin key (`first-wins | merge`) — opt managed settings into policy merge.
- **Hooks now receive effort level**: `effort.level` in JSON input, `$CLAUDE_EFFORT` env var.

### v2.1.136 — May 8, 2026

- `resolveSettings()` (alpha) — inspect effective merged settings.
- `TodoWrite` deprecated in CLI.

### v2.1.135 and earlier

- `/resume` supports background sessions (`claude --bg`). Background subagent completion shows elapsed duration.
- `/model` changes model for current session only; `d` sets default for new sessions.
- "extra usage" renamed to **"usage credits"**; `/extra-usage` → `/usage-credits` (old alias preserved).
- Plugin dependency enforcement: `claude plugin disable` refuses when another plugin depends on the target.
- Projected context cost in `/plugin` marketplace (per-turn and per-invocation estimates).
- Fixed: `context: fork` skill infinite loop (self-re-invocation).
- Fixed: stop hooks blocking forever (now exits after 8 consecutive blocks with warning).
- Fixed: `NO_COLOR`/`FORCE_COLOR` in `settings.json` env now applies to subprocesses only.
- Fixed: corrupt `.credentials.json` hanging CLI on startup.
- **Security — Bash CVE**: Fixed permission bypass where backslash-escaped flags could be auto-allowed as read-only and lead to arbitrary code execution.
- **Security — Windows clipboard CVE**: Clipboard writes no longer expose copied content in process CLI args visible to EDR/SIEM.

---

## Critical: June 15, 2026 Changes

### Agent SDK Billing Split

Anthropic separates programmatic usage from subscription limits starting June 15, 2026:

| Plan | Interactive limit (unchanged) | New Agent SDK credit |
|------|------------------------------|---------------------|
| Pro | Same | $20/month |
| Max 5x | Same | $100/month |
| Max 20x | Same | $200/month |

Covers: Claude Agent SDK, `claude -p`, Claude Code GitHub Actions, third-party agents (e.g., OpenClaw). Credit is metered at full API rates, resets monthly, no rollover. Must opt in once to activate.

**Workspace admins using subscription-based API access need to claim their credit and decide on overflow behavior.**

### Model Retirements on June 15

- **claude-sonnet-4** (base alias, `claude-sonnet-4-20250514`) — **RETIRED**
- **claude-opus-4** (base alias) — **RETIRED**

Buildd's current model aliases (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`) are safe. However, the following model IDs found in test fixtures need review:
- `claude-sonnet-4-20250514` (reconcile.test.ts, mcp-call-tracking.test.ts) — may be retired
- `claude-sonnet-4-5-20250929` — Sonnet 4.5, status unclear; prefer upgrading to `claude-sonnet-4-6`
- `claude-opus-4-5-20251101` — Opus 4.5, status unclear; prefer upgrading to `claude-opus-4-7`

Recommended replacement: `claude-sonnet-4-6-20260217` (full ID) or `claude-sonnet-4-6` (alias).

---

## Competitive Landscape Update

### Claude Code vs OpenAI Codex vs Google Jules (May 2026)

| Dimension | Claude Code | OpenAI Codex | Google Jules |
|-----------|-------------|--------------|--------------|
| Architecture | Synchronous terminal + IDE orchestrator | Desktop app with model router | Async task pool in cloud VMs |
| Models | Sonnet 4.6 (default), Opus 4.7 (deep) | GPT-5.3-Codex, GPT-5.4 | Gemini 3.1 |
| SWE-Bench | **80.8%** (best) | ~75% | ~72% |
| Terminal-Bench | 65.4% | **77.3%** (best) | 61% |
| Market share | **70%+ combined** (with Cursor, Copilot) | Growing | Niche |

**Key development**: MCP donated to the Linux Foundation; adopted by Anthropic, OpenAI, Microsoft, and Google. MCP is now the universal tool protocol.

---

## Community & Ecosystem

### GitHub Stars & Adoption (May 2026)

- **4% of all GitHub commits** authored by Claude Code agents (held from April)
- **OpenClaw**: 247K+ stars (was 188K in March — explosive growth continues)
- Claude Code ecosystem: 70%+ market share in AI coding (combined Cursor/Copilot category)
- 1M token context windows are standard across frontier models
- MCP tool protocol: cross-industry standard, Linux Foundation-governed

### Trending Community Projects (New Since Last Scan)

| Project | Stars | Description |
|---------|-------|-------------|
| **OpenClaw** (Steinberger/independent foundation) | 247K | Self-hosted AI agent running in WhatsApp/Telegram/Slack/Discord; 13,700+ community skills on ClawHub; OpenAI-sponsored but MIT-licensed |
| **rohitg00/awesome-claude-code-toolkit** | Trending | 135 agents, 35 skills, 42 commands, 176+ plugins, 20 hooks — real-time token attribution with zero telemetry |
| **VoltAgent/awesome-claude-code-subagents** | Growing | 100+ specialized subagents installable via plugin marketplace (research analyst, trend analyst, competitive analyst, etc.) |
| **openinference-instrumentation-claude-agent-sdk** (Arize) | — | Drop-in OTel instrumentation for Python and TypeScript Agent SDK; produces AGENT + TOOL spans; Phoenix-compatible |
| **composio-claude-agent-sdk** | — | Composio tool integration for Claude Agent SDK |

### Observability Ecosystem: New Official Instrumentation

**Arize OpenInference** released both Python and TypeScript packages for Claude Agent SDK:
- Python: `pip install openinference-instrumentation-claude-agent-sdk`
- TypeScript: `npm install @arizeai/openinference-instrumentation-claude-agent-sdk`
- Captures `ClaudeAgentSDK.query` AGENT spans + TOOL child spans
- Attributes: `session.id`, `llm.model_name`, token counts, `llm.cost.total`
- Backend: any OTLP collector, Arize Phoenix (local or cloud), Langfuse, Grafana, Datadog

**New OTEL span attributes in SDK** (from changelog):
- `agent_id` and `parent_agent_id` on OTEL spans
- Background subagent spans now correctly nest under the dispatching Agent tool span
- Trace parenting fixed for background sessions

---

## Key Patterns & Developments

### 1. Task Tools Replace TodoWrite (Breaking, Already Shipped)

`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` are now the default in SDK 0.3.142 and CLI 2.1.142. `TodoWrite` is deprecated and will be removed. Key differences for Buildd workers:

- Workers observing `tool_use` blocks must switch from replacing a snapshot list to **accumulating by task ID**.
- `task_description` is now surfaced on SDK message types — enables richer logging.
- Known regression: Task tools bypass `PreToolUse`/`PostToolUse` hooks — if Buildd hooks monitor tool usage, they won't see task management events.

### 2. MCP Non-Blocking Connection Is Now Default

Sessions start immediately regardless of MCP server startup time. Servers report `status: "pending"` until ready. This is generally better for latency, but tools from slow servers won't be available on turn 1 unless marked `alwaysLoad: true`. Affects Buildd's MCP config packaging in `apps/web/src/lib/role-config.ts`.

### 3. worktree.baseRef Gives Agents Branch Control

The new `worktree.baseRef` setting (`fresh | head`) controls whether isolated worktrees branch from `origin/<default>` or local `HEAD`. This is directly relevant to Buildd's worktree-isolated task execution — workers can now configure whether to start from a clean origin or from in-progress work.

### 4. Hooks Receive Effort Level

Hooks now get `effort.level` in JSON input and `$CLAUDE_EFFORT` env var. Buildd hooks could use this to route telemetry differently for high-effort vs. low-effort runs.

### 5. resolveSettings() Enables Settings Inspection

New `resolveSettings()` (alpha) allows programmatic inspection of effective merged settings (MDM, policy, user, workspace) without spawning a Claude session. Useful for Buildd's role config packaging to verify what settings a worker will actually see.

### 6. SDK Credit Model Changes Buildd Economics

Starting June 15, programmatic usage (exactly what Buildd workers do) draws from a separate credit pool at full API rates. Workspace admins on subscription plans will have a $20–$200 monthly budget for agent runs before paying overage. This may affect Buildd's pricing model and workspace billing display.

### 7. OpenClaw: Competitor + Ecosystem Signal

OpenClaw's 247K stars and 13,700+ skills demonstrate massive demand for self-hosted, persistent AI agents with rich skill marketplaces. Validated patterns:
- Heartbeat daemon (wake on schedule, read a plan file, execute tasks)
- Per-group/per-channel system prompts
- Skills as the primary extension mechanism
- ClawHub as a skills distribution marketplace

### 8. Subagent Attribution Now Native

`subagent_type` and `task_description` surfaced on SDK message types, plus `agent_id`/`parent_agent_id` on OTEL spans, enable true agent attribution in traces. Buildd can now attribute costs and work to specific subagent types automatically.

---

## Recommendations for Buildd

### 🔴 Critical (Before June 15, 2026)

1. **Upgrade SDK from `^0.2.119` to `^0.3.150`** in `apps/runner/package.json`. The 0.3.x branch has breaking changes (Task tools default, v2 session API removed, MCP non-blocking default). Plan migration:
   - If any Buildd runner code uses `unstable_v2_createSession`, switch to `query()` with `AsyncIterable`.
   - Update any `tool_use` monitoring that replaces snapshot lists to accumulate by task ID.
   - Set `MCP_CONNECTION_NONBLOCKING=0` if MCP tools must be available on turn 1.

2. **Audit model IDs for June 15 retirement**. Safe: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`. At risk: `claude-sonnet-4-20250514` (in test files), and any role configs using base Sonnet 4/Opus 4 aliases. Replace with `claude-sonnet-4-6` and `claude-opus-4-7`.

3. **Communicate June 15 billing change to workspace admins**. Buildd workspaces using subscription-based runners will be affected. Consider adding a dashboard notice for workspaces using `authType: oauth` (subscription) vs. API key.

### 🟡 High Priority

4. **Adopt Arize OpenInference instrumentation** for worker sessions (`openinference-instrumentation-claude-agent-sdk`, both Python and TS). This is now the standard OTel path for Claude Agent SDK — drop-in, no custom instrumentation needed. Integrates with Langfuse, Datadog, Grafana, Arize Phoenix.

5. **Expose `worktree.baseRef` in role config** — allow workspace admins to choose `fresh` (branch from `origin/<default>`) vs. `head` (branch from local HEAD). Relevant to `apps/web/src/lib/role-config.ts` and the config packaging system.

6. **Hook effort level routing** — use `$CLAUDE_EFFORT` / `effort.level` in Buildd worker hooks to tag telemetry and task records by effort tier. Enables cost attribution by effort level.

7. **Add `allowAllClaudeAiMcps` to enterprise role configs** — enterprise workspaces can now load all claude.ai MCP connectors without listing them individually in `managed-mcp.json`.

### 🟢 Medium Priority

8. **Use `resolveSettings()` for config validation** in the role config packaging pipeline. Before packaging a role config bundle to R2, call `resolveSettings()` to verify what effective settings the worker will see. Catches MDM/policy overrides early.

9. **Surface `subagent_type` in task activity feed** — the SDK now exposes `subagent_type` and `task_description` on message types. Buildd's worker event stream can use these to categorize subagent work types in the dashboard.

10. **Plan for Task tools hook bypass** — Tasks tools (`TaskCreate` etc.) bypass `PreToolUse`/`PostToolUse` hooks. If Buildd uses hooks to monitor tool usage for security or billing, add explicit handling for task tool events in a different hook type.

11. **Investigate `context: fork` skill pattern** — Claude Code fixed an infinite loop where a skill using `context: fork` could repeatedly re-invoke itself. This is worth understanding for Buildd's role/skill execution model. The fix means fork-based skills are now safe to deploy.

### 🔵 Lower Priority

12. **Skills marketplace inspiration from ClawHub/OpenClaw** — OpenClaw's 13,700+ community skills and ClawHub distribution model validates Buildd's skills direction. Consider how public skill sharing could work in Buildd's model.

13. **Track composio-claude-agent-sdk** — Composio provides a broad toolset (Jira, GitHub, Slack, etc.) via a simple integration. Could be a fast path for adding common tool integrations to Buildd roles.

14. **GFM task list checkboxes in markdown** — CLI v2.1.149 renders `- [ ]`/`- [x]` checkboxes in markdown output. Buildd's task display could benefit from this in worker output rendering.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-05-25 | 0.2.133–0.3.150 | 0.1.64–0.2.87 | 2.1.115–2.1.150 | Task tools replace TodoWrite, MCP non-blocking default, v2 session API removed, resolveSettings(), worktree.baseRef, hooks get effort level, model retirements June 15, billing split June 15, OpenClaw 247K stars, Arize OTel instrumentation |
| 2026-04-20 | 0.2.104–0.2.114 | 0.1.54–0.1.63 | 2.1.101–2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94–0.2.104 | — | 2.1.93–2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88–0.2.92 | — | 2.1.88–2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80–0.2.87 | — | 2.1.80–2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
