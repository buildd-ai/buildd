# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-05-18
**Previous scan**: 2026-04-20
**Current SDK version in Buildd**: `^0.2.119` (latest: `0.3.143`)
**Python SDK**: v0.2.82 (latest)
**Claude Code CLI**: v2.1.143 (released May 15, 2026)

---

## SDK Releases (v0.2.114 → v0.3.143)

### BREAKING: TypeScript SDK v0.3.142 (May 14, 2026)

The SDK jumped to v0.3.x with multiple breaking changes:

- **Removed v2 session API** — `unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`, `SDKSession`, `SDKSessionOptions` all removed (deprecated since 0.2.133). Use `query()` with `AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` to continue.
- **MCP servers connect in background by default** — Sessions start immediately; slow servers report `status: "pending"` in `init`. Set `MCP_CONNECTION_NONBLOCKING=0` for old behavior, or `alwaysLoad: true` per server.
- **TodoWrite replaced by Task tools** — Headless/SDK sessions now use `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` (deprecated since 0.2.136). Tool consumers must accumulate by task ID instead of replacing a snapshot list.
- Surfaced `request_id`, `subagent_type`, and `task_description` on SDK message types
- Headless `--sdk-url` sessions exit non-zero on permanent transport closure (401/403/404)

### TypeScript SDK v0.3.143 (May 15, 2026)
- `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` moved to `peerDependencies` (runtime unaffected — both bundled). Yarn classic users must add them explicitly.

### TypeScript SDK v0.2.141 (May 13, 2026)
- Exported Task tool types: `TaskCreateInput`/`TaskCreateOutput`, `TaskGetInput`/`TaskGetOutput`, `TaskUpdateInput`/`TaskUpdateOutput`, `TaskListInput`/`TaskListOutput`
- Aligned `@anthropic-ai/sdk` dependency to ^0.93.0

### TypeScript SDK v0.2.136 (May 8, 2026)
- Added `resolveSettings()` (alpha) — inspect effective merged settings without spawning CLI; reads MDM for parity with CLI startup
- **Deprecated** `TodoWrite` tool — future versions switch to Task tools

### TypeScript SDK v0.2.133 (May 7, 2026)
- **Deprecated** unstable V2 session API — use `query()` instead
- **Deprecated** passing `'Skill'` in `allowedTools` — use `skills` option instead

### TypeScript SDK v0.2.132 (May 6, 2026)
- Documented `applyFlagSettings()` reference; added `null` support on top-level keys to clear flag-settings overrides

### TypeScript SDK v0.2.126 (late April)
- Added `origin` to result messages (`SDKResultSuccess`/`SDKResultError`) — distinguishes user-prompted results from task-notification followups

### TypeScript SDK v0.2.121 (late April)
- Added `updatedToolOutput` to `PostToolUseHookSpecificOutput` for replacing tool output on all tools. `updatedMCPToolOutput` deprecated.

### TypeScript SDK v0.2.120 (late April)
- Added `skills` option (`string[] | 'all'`) to control which Skills load into the main session (TS parity with Python SDK)

### TypeScript SDK v0.2.119 (late April)
- Added `forwardSubagentText` option to stream subagent text deltas to SDK consumers
- `excludeDynamicSections` keeps static auto-memory in cacheable system-prompt block
- MCP server reconnection on transport-stream abort
- `SessionStore.append()` retry (3x with backoff) before dropping batch

### TypeScript SDK v0.2.118 (late April)
- Added `Options.managedSettings` for embedders to pass policy-tier settings to CLI in-memory

### Python SDK v0.2.82 (May 15, 2026)
- Latest release; major version bump to 0.2.x
- Wheels for Windows, Linux (x86_64/aarch64), macOS (x86_64/arm64)

### Python SDK v0.1.81 (May 11, 2026)
- Updated bundled CLI to v2.1.139

### Python SDK v0.1.80 (May 9, 2026)
- Updated bundled CLI to v2.1.138

### Python SDK v0.1.76 (May 6, 2026)
- Added `api_error_status` to `ResultMessage` for surfacing HTTP status codes (429, 500, 529)
- Fixed `ToolPermissionContext.suggestions` deserialization

---

## Claude Code CLI Releases (v2.1.114 → v2.1.143)

### v2.1.143 (May 15, 2026)
- Plugin dependency enforcement: `claude plugin disable` refuses when another enabled plugin depends on the target (with copy-pasteable disable-chain hint); `claude plugin enable` force-enables transitive dependencies
- Projected context cost (tokens) shown in `/plugin` marketplace browse pane
- `worktree.bgIsolation: "none"` lets background sessions edit the working copy directly
- Background sessions preserve model and effort level after waking from idle
- Shift+Tab in attached agent sessions cycles auto mode

### v2.1.139 (May 12, 2026) — **Major Release**
- **`/goal` command** — Set a completion condition; agent loops autonomously until a supervisor validates the goal is met. Works in interactive, `-p`, and Remote Control. Tracks elapsed time, turns, and tokens.
- **Agent View** (`claude agents`) — CLI dashboard showing all sessions (running, waiting, done) in a single table. Dispatch, monitor, reply, navigate with keyboard shortcuts. Session state persisted in `~/.claude/jobs/<id>/state.json`.
- Session management commands: `claude attach <id>`, `claude logs <id>`, `claude stop <id>`, `claude respawn <id>`, `claude rm <id>`
- Haiku-class model generates one-line summaries per session (every 15s + end of turn)
- New `claude agents` flags: `--add-dir`, `--settings`, `--mcp-config`, `--plugin-dir`, `--permission-mode`, `--model`, `--effort`, `--dangerously-skip-permissions`
- Fast mode now uses Opus 4.7 by default

### v2.1.136 (May 7, 2026)
- Added `worktree.baseRef` setting (`fresh` | `head`) — worktrees branch from `origin/<default>` or local HEAD
- `sandbox.bwrapPath` and `sandbox.socatPath` managed settings (Linux/WSL)
- Hooks receive effort level via `effort.level` JSON field and `$CLAUDE_EFFORT` env var
- `/terminal-setup` enables iTerm2 clipboard access (works from tmux)
- MCP servers auto-retry (3x) on transient startup errors
- Vertex AI X.509 certificate-based Workload Identity Federation (mTLS ADC)

### v2.1.126 (May 4, 2026) — **BREAKING Security Fix**
- Fixed `allowManagedDomainsOnly`/`allowManagedReadPathsOnly` being ignored
- `/model` picker lists models from gateway's `/v1/models` endpoint when `ANTHROPIC_BASE_URL` set
- `claude project purge` for full state cleanup
- `--dangerously-skip-permissions` expanded scope
- Pasted OAuth code for restricted networks

### v2.1.124-125 (May 1, 2026)
- **CVE fix**: Windows clipboard writes no longer expose content in process command-line arguments visible to EDR/SIEM telemetry
- Fixed >22KB selections not reaching clipboard
- PowerShell: bare `--` no longer mis-flagged as stop-parsing token
- Fixed Agent SDK hang on malformed tool name in parallel tool call batch

### v2.1.123 (May 1, 2026)
- Fixed OAuth 401 retry loop when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` set

### v2.1.122 (May 1, 2026)
- `ANTHROPIC_BEDROCK_SERVICE_TIER` env var for Bedrock tier selection (`default`, `flex`, `priority`)
- Pasting PR URL into `/resume` search box finds the session that created that PR (GitHub, GHE, GitLab, Bitbucket)

### Performance & Stability (across May releases)
- Sub-agent progress summaries now hit prompt cache, cutting `cache_creation` token cost ~3x
- Fixed memory leaks: unbounded growth on many images, `/usage` leaking ~2GB on large transcripts, leak on long-running tool failures
- `context-1m-2025-08-07` beta retired (April 30) — 1M context now standard on Sonnet 4.6, Opus 4.6, Opus 4.7

---

## Code with Claude Event (May 6-7, SF; May 19-20, London; June 10-11, Tokyo)

Anthropic's first developer conference shipped five major features (no new models):

### 1. Dreaming (Research Preview)
Scheduled process that reviews agent sessions and memory stores, extracts patterns, and curates memories automatically. Harvey reported 6x task completion improvement; Wisedocs cut document review time 50%.

### 2. Outcomes (Public Beta)
Write a rubric defining success criteria. A separate grading agent scores output against the rubric. If below threshold, kicks task back for another run. +8.4% task success on docx, +10.1% on pptx in internal benchmarks.

### 3. Multi-Agent Orchestration (Public Beta)
Lead agent delegates to specialist agents working in parallel on shared filesystem. Console provides full execution traceability. Up to 25 concurrent threads per container.

### 4. Claude Finance
10 pre-built financial agents: pitch builder, meeting preparer, market researcher, evaluation reviewer, month-end closer, and more.

### 5. Add-ins (Microsoft 365)
Claude now lives inside Excel, PowerPoint, and Word. Outlook queued.

### Other Announcements
- 5-hour rate limits doubled on every paid tier; peak-hours reduction removed for Pro/Max
- Roadmap teased: "context windows that feel infinite," higher judgment/code taste, improved multi-agent coordination
- Boris Cherny (creator of Claude Code): "There is literally no manually written code anywhere in Anthropic anymore"

---

## Billing Change: Agent SDK Credit Split (June 15, 2026)

**Critical for Buildd**: Starting June 15, Claude Agent SDK, `claude -p`, GitHub Actions, and third-party SDK apps move off subscription rate-limit pools onto separate monthly credits metered at full API list prices.

| Tier | Monthly SDK Credit |
|------|-------------------|
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team | $100/seat |
| Enterprise | $200/seat |

- Credits do not roll over
- Interactive Claude Code (terminal) stays on subscription limits
- Overflow is opt-in "extra usage" at API rates (default off)
- When credits exhaust without extra usage enabled, SDK requests stop until next billing cycle
- Community reaction was strongly negative — power users calculated 25-40x effective price increase for programmatic workloads
- Also on June 15: `claude-sonnet-4-20250514` and `claude-opus-4-20250514` model IDs retire from API

---

## Competitive Landscape Update

### SWE-bench Benchmarks (May 2026)

| Benchmark | #1 | #2 | #3 |
|-----------|----|----|-----|
| SWE-bench Verified | Claude Mythos Preview (93.9%) | Claude Opus 4.7 Adaptive (87.6%) | GPT-5.3 Codex (85%) |
| SWE-bench Pro | Claude Opus 4.7 (64.3%) | GPT-5.5 (58.6%) | Gemini 3.1 Pro (54.2%) |
| Terminal-Bench 2.0 | GPT-5.5 (82.7%) | Claude Opus 4.7 (69.4%) | Gemini 3.1 Pro (68.5%) |

**Key context**: OpenAI stopped self-reporting SWE-bench Verified scores (Feb 2026) due to contamination — frontier models can reproduce verbatim gold patches. SWE-bench Pro is the more reliable benchmark now.

### Claude Code vs OpenAI Codex vs Google Jules (May 2026)

| Dimension | Claude Code | OpenAI Codex | Google Jules |
|-----------|-------------|--------------|--------------|
| Architecture | CLI + Agent View dashboard | Desktop + mobile + Chrome extension | Async cloud VMs |
| Models | Sonnet 4.6 (default), Opus 4.7 (fast/deep) | GPT-5.3-Codex, GPT-5.5 | Gemini 3.1 |
| SWE-bench Pro | **64.3%** (best) | 58.6% | 54.2% |
| Terminal-Bench | 69.4% | **82.7%** (best) | 68.5% |
| Key differentiator | /goal + Agent View + Dreaming | Mobile app + Chrome ext + Windows sandbox | Goal-oriented "Jitro" rewrite coming |
| Weekly users | ~326K commits/day (~10% of GitHub) | 4M+ weekly active | Out of beta, free+paid tiers |

**Key competitive moves this month:**
- **Codex** shipped mobile app integration, Chrome extension for parallel browser work, Windows sandbox, persisted /goal workflows, and Bedrock support. 4M+ weekly active users (up from 2M in March).
- **Jules** appears stagnant externally, but Google is building "Jitro" (next-gen Jules) — KPI-driven development where agent autonomously identifies what to change to move a metric. Expected reveal at Google I/O (May 19).
- **Claude Code** shipped /goal, Agent View, Dreaming, Outcomes, multi-agent orchestration at Code with Claude event. Anthropic doubled rate limits.

---

## Community & Ecosystem

### GitHub Adoption (May 2026)
- Claude Code authors ~326K+ commits/day (~10% of all public GitHub commits)
- Claude Code repo: 55K+ stars
- `/goal` being called "the single most underrated AI feature of 2026" by early adopters

### Trending Community Projects

| Project | Stars | Description |
|---------|-------|-------------|
| **VILA-Lab/Dive-into-Claude-Code** | Growing | Deep analysis: only 1.6% of Claude Code is AI logic, 98.4% is deterministic infra. Includes log parser, prompt corpus across 170+ releases, clean-room rewrites |
| **supermemoryai/supermemory** | High | Hybrid memory and retrieval engine with strong benchmark performance |
| **EquilateralAgents Open Core** | — | 22 self-learning AI agents with memory, pattern recognition, workflow optimization |
| **wshobson/agents** | — | Multi-agent orchestration framework for Claude Code |
| **hesreallyhim/a-list-of-claude-code-agents** | — | Curated directory of Claude Code sub-agents and resources |

### Observability Ecosystem
- **Langfuse** official Claude Agent SDK integration (stable)
- **Datadog** partnership showcased at Code with Claude
- **openinference-instrumentation-claude-agent-sdk** on PyPI — OpenInference/Arize integration
- Native SDK support for W3C trace context propagation unchanged

### The `/goal` Convergence
Every major AI lab shipped the same primitive in the last six weeks: Anthropic (`/goal` in Claude Code), OpenAI (persisted `/goal` in Codex), Nous Research (Hermes). Consistent naming signals industry settling on a shared interface for autonomous agent loops.

---

## Key Patterns & Developments

### 1. TodoWrite → Task Tools Migration (CRITICAL for Buildd)
The biggest SDK change since the rename. v0.3.142 replaced TodoWrite with TaskCreate/TaskUpdate/TaskGet/TaskList. Key differences:
- Task tools use accumulate-by-ID semantics (not snapshot replacement)
- Each task has its own lifecycle: create → update status → get → list
- Surfaced `request_id`, `subagent_type`, `task_description` on events
- **Buildd action**: The runner's tool handling must be updated if consuming TodoWrite events from SDK sessions. The existing Buildd task system already uses ID-based tracking, so the conceptual alignment is good.

### 2. Agent View + /goal = Fleet Management Primitive
Claude Code v2.1.139 turned the CLI into a fleet management system:
- Start a session with `/goal` → send to background with `/bg` → monitor from Agent View
- Session state persisted in `~/.claude/jobs/<id>/state.json` — scriptable
- Supervisor architecture: separate Claude session validates goal completion
- **Buildd implication**: This pattern is what Buildd does at the coordination layer. Agent View could complement Buildd by providing local session management while Buildd handles cross-machine orchestration.

### 3. Dreaming = Platform-Level Memory Compaction
Anthropic's Dreaming feature (research preview) reviews agent sessions and memory stores, extracts patterns, and curates memories automatically. This is essentially what Buildd's workspace memory + claude-mem pattern does, but built into the platform.
- **Buildd implication**: Monitor Dreaming's GA timeline. When it ships, Buildd's memory system could delegate compaction to Dreaming rather than running custom logic. The workspace memory system remains valuable for cross-agent knowledge sharing — Dreaming operates per-session.

### 4. Outcomes = Built-in Quality Gates
Outcomes (public beta) implements rubric-based evaluation with a separate grading agent. This maps directly to Buildd's `verificationCommand` pattern but uses AI judgment instead of deterministic checks.
- **Buildd implication**: Could expose Outcomes rubrics as a role configuration option — "verify this task's output against this quality rubric" alongside or instead of shell-based verification commands.

### 5. Billing Split Forces Architecture Decisions
The June 15 credit split means programmatic SDK usage is now metered at API rates. For Buildd:
- Runners using subscription auth will hit $200/month SDK credit limits
- API key auth (`bld_xxx`) is already metered — no change there
- Workspaces running many parallel agents on subscription auth will exhaust credits fast
- **Buildd action**: Document the billing change for users. Consider exposing credit usage tracking. May need to recommend API keys over subscription auth for heavy SDK usage.

### 6. v0.3.x as Migration Checkpoint
The v0.3.x bump is a natural migration checkpoint for Buildd:
- MCP servers connecting in background by default may affect runner MCP setup
- Task tools replacing TodoWrite requires consumer-side changes
- peerDependencies change (v0.3.143) may affect Bun bundling
- **Buildd action**: Test v0.3.143 thoroughly before bumping. The `^0.2.119` pin won't auto-upgrade to 0.3.x (semver), so the bump is deliberate.

---

## Recommendations for Buildd

### Urgent (Before June 15)

1. **Prepare for billing split** — Document the Agent SDK credit split for workspace users. Runners using subscription auth will now draw from a $200/month credit pool instead of unlimited subscription usage. Consider adding credit usage tracking to the dashboard. Recommend API key auth for heavy programmatic workloads.

2. **Plan v0.3.x SDK migration** — v0.3.142's breaking changes (Task tools, MCP background connect, v2 session API removal) require deliberate migration. Buildd is on `^0.2.119` which won't auto-bump. Create a dedicated task to test and migrate to v0.3.143, prioritizing Task tool consumer changes.

3. **Retire deprecated model IDs** — `claude-sonnet-4-20250514` and `claude-opus-4-20250514` retire June 15. Audit any hardcoded model IDs in role configs and runner code.

### High Priority

4. **Adopt Task tool types** — v0.2.141 exported `TaskCreateInput`/`TaskCreateOutput` etc. The runner should import and use these types for type-safe task handling once on v0.3.x.

5. **Leverage Agent View session state** — Session state in `~/.claude/jobs/<id>/state.json` is scriptable. Buildd runners could read this to provide richer observability (session-level status, turn count, token usage) without custom instrumentation.

6. **Expose `skills` option per role** — Both TS (v0.2.120) and Python SDKs now support `skills` as a top-level option. Buildd roles should specify which skills load (`"all"`, specific list, or none) — cleaner than `allowedTools` for skill-level control. Note: `'Skill'` in `allowedTools` is deprecated (v0.2.133).

7. **Evaluate Outcomes for quality gates** — Outcomes (public beta) enables rubric-based evaluation by a separate grading agent. Could complement or replace `verificationCommand` for subjective quality assessment. Explore exposing "success rubrics" in role/task configuration.

### Medium Priority

8. **Monitor Dreaming for memory delegation** — When Dreaming reaches GA, Buildd's memory compaction could delegate to the platform. The workspace memory system remains distinct (cross-agent knowledge sharing vs per-session pattern extraction).

9. **Implement `agentProgressSummaries`** — The new option (noted in SDK changelog) enables periodic AI-generated progress summaries for subagents, emitted on `task_progress` events via `summary` field. Could pipe directly into Buildd's progress reporting.

10. **Test MCP background connection default** — v0.3.142 changed MCP servers to connect in background by default. Verify Buildd's MCP server setup works correctly — use `alwaysLoad: true` for critical servers needed on turn 1.

11. **Adopt `resolveSettings()` for diagnostics** — v0.2.136's alpha `resolveSettings()` can inspect effective merged settings without spawning CLI. Useful for runner startup diagnostics and config validation.

### Lower Priority

12. **Explore `/goal` for long-running tasks** — `/goal` + supervisor architecture could be leveraged for mission-level work where tasks span multiple turns. The supervisor validation pattern maps to Buildd's verification concept.

13. **Session management UX inspiration** — Agent View's design (status indicators, keyboard navigation, inline replies, Haiku summaries) validates Buildd's dashboard direction. The "filter by status/project" pattern and session-level token tracking are worth adopting.

14. **Sub-agent progress caching** — Sub-agent progress summaries now hit the prompt cache (~3x cost reduction on `cache_creation`). Verify Buildd runners benefit automatically, or enable explicitly.

15. **`worktree.baseRef` setting** — v2.1.136 added `fresh` | `head` control for worktree base. Buildd's worktree management could expose this as a task/role configuration option.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-05-18 | 0.2.114-0.3.143 | 0.1.63-0.2.82 | 2.1.114-2.1.143 | v0.3.x breaking (Task tools, MCP bg connect), /goal, Agent View, Dreaming, Outcomes, billing split, Code with Claude event |
| 2026-04-20 | 0.2.104-0.2.114 | 0.1.54-0.1.63 | 2.1.101-2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94-0.2.104 | — | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | — | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | — | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
