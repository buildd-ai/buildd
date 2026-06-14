# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-06-08
**Previous scan**: 2026-06-01
**Current SDK version in Buildd**: `^0.3.168` (up to date)
**Python SDK**: v0.2.87+ (tracking CLI parity)
**Claude Code CLI**: v2.1.168 (released ~June 6, 2026)

> **Note**: For SDK feature details and integration status, see [sdk-reference/](sdk-reference/).

---

## SDK Releases (v0.3.160 - v0.3.168) — June 1–8, 2026

### TypeScript SDK v0.3.168 (June 6, 2026) — current latest
- Parity with Claude Code v2.1.168 — latest in the 0.3.16x series

### TypeScript SDK v0.3.160–168 (June 1–6, 2026) — key additions
- **New**: `agentProgressSummaries` option — enables periodic AI-generated progress summaries for running subagents (foreground + background), emitted on `task_progress` events via the new `summary` field. Gives SDK consumers visibility into long-running subagent work without polling.
- **New**: `reloadPlugins()` SDK method — reload plugins and receive refreshed commands, agents, and MCP server status without restarting the session.
- **New**: `getSettings()` `applied` section — returns runtime-resolved `model` and `effort` values (after defaults, env vars, and flags are applied). Useful for workers that need to confirm which model is actually running.
- **Fixed**: TypeScript types were resolving to `any` due to missing peer deps; fixed by adding `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` as explicit dependencies.
- **Fixed**: CJK and other multibyte text corrupted with `U+FFFD` in stream-JSON input/output when chunk boundaries split a UTF-8 sequence.
- **Fixed**: MCP server child processes not being cleaned up when an SDK `query()` session ends — prevented orphaned subprocesses.
- **Fixed**: `MaxListenersExceededWarning` when running 11+ concurrent `query()` calls.
- **Fixed**: Interrupt (`Esc`) sent at the very start of a turn being silently dropped in stream-json/SDK sessions, leaving the turn running with no "Interrupted" feedback.
- **Fixed**: Remote sessions becoming permanently stuck when a brief backend disruption occurred during worker registration at startup.
- **Fixed**: MCP per-server timeout config values below 1000ms being floored to a 1-second watchdog; sub-1000ms values now fall back to `MCP_TOOL_TIMEOUT` or default.
- **Security**: Bumped `@anthropic-ai/sdk` to `^0.81.0` and `@modelcontextprotocol/sdk` to `^1.29.0` to resolve GHSA-5474-4w2j-mq4c and transitive hono advisories.

### Claude Code CLI v2.1.160–168 — key additions
- **New**: `fallbackModel` setting — configure up to 3 fallback models tried in order when the primary model is overloaded or unavailable. `--fallback-model` now also applies to interactive sessions. Claude also retries a turn once on the fallback model when the API rejects an unexpected non-retryable error.
- **New**: Glob pattern support in deny rule tool-name position (`"*"` denies all tools); allow rules reject non-MCP globs, and unknown tool names in deny rules warn at startup.
- **Improved**: `claude update` now announces the target version before downloading, instead of going silent.
- **Improved**: Vim mode `/` in NORMAL mode opens reverse history search (like `Ctrl+R`), matching bash/zsh vi-mode.
- **Improved**: `/usage` breakdown now includes large session files; files are scanned with a streaming read so memory usage stays flat.
- **Improved**: Thinking summaries in the collapsed group now stay readable for at least 3 seconds, render as markdown, and cap at 10 lines (`Ctrl+O` shows full thinking).
- **Security**: `SendMessage` cross-session messaging hardened — relayed messages no longer carry user authority; receivers refuse relayed permission requests, and auto mode blocks them.
- **Fixed**: JetBrains IDE terminal flickering (IntelliJ, PyCharm, WebStorm) on 2026.1+ by enabling synchronized output.
- **Fixed**: `Shift+non-ASCII` characters being dropped in terminals using the Kitty keyboard protocol.
- **Fixed**: PowerShell command validation occasionally hanging far past its time budget on Windows.
- **Fixed**: Orphaned `claude --bg-pty-host` processes spinning at 100% CPU after daemon dies on macOS.
- **Fixed**: Model-not-found errors incorrectly suggesting `--model` when running via the SDK.
- **Fixed**: Auto mode unavailability message on Bedrock/Vertex/Foundry to correctly point to `CLAUDE_CODE_ENABLE_AUTO_MODE`.

---

## URGENT: Two Deadlines on June 15, 2026 — 7 Days Away

### 1. Model API Retirements (June 15, 2026)
`claude-sonnet-4-20250514` and `claude-opus-4-20250514` are retired from the Claude API on June 15. API requests using those exact model ID strings will return errors after that date — no grace period.

**Affected**: Any production code with hardcoded model version strings. Consumer Claude.ai and Claude Code managed environments are NOT affected (Anthropic handles model selection there).

**Migration**:
- `claude-sonnet-4-20250514` → `claude-sonnet-4-6`
- `claude-opus-4-20250514` → `claude-opus-4-8`
- Run `grep -r '20250514'` in your codebase to find all exposure points

**Buildd action**: Search `packages/core/` and `apps/` for hardcoded model version strings. The model alias layer in `packages/core/model-aliases.ts` should already abstract this, but verify no hardcoded strings escaped.

### 2. Agent SDK Billing Split (June 15, 2026)
(Covered in detail in previous scan — now 7 days away, not 14.)

---

## New Platform Features: Managed Agents Expansion (June 2026)

These features were announced at Code with Claude (May 6), and reached general/beta availability this week via the `managed-agents-2026-04-01` API beta header:

### Dreaming (Research Preview)
A scheduled process that reviews past agent sessions, extracts patterns, and curates the memory store so agents self-improve between runs. Dreaming operates without changing model weights — it's structured note-taking that surfaces recurring mistakes, convergent workflows, and team preferences across many sessions.

**Real-world results**: Harvey (legal AI) saw 6× higher task completion rates; Wisedocs processing medical documents 50% faster.

**Relevance for Buildd**: Buildd's workspace memory system (`buildd_memory`) covers the same use case at the workspace level. Dreaming is Anthropic's Managed Agent equivalent — validates the memory strategy, potentially offers learnings on memory curation algorithms.

### Multiagent Orchestration (Public Beta)
A lead agent decomposes a task and delegates to up to **20 specialist subagents** running in parallel on a shared filesystem. Each subagent has its own model, prompt, tools, and context window. Full trace visible in Claude Console. Coordinator is limited to depth-1 delegation (no sub-subagents) for predictability.

**Architecture**:
- Coordinator can send follow-up messages to any subagent mid-workflow
- Subagents retain conversation history between check-ins
- Available via `managed-agents-2026-04-01` beta header — no waitlist

**Vs Dynamic Workflows**: Multiagent Orchestration = Managed Agents platform (hosted), billed at $0.08/session-hour. Dynamic Workflows = self-hosted via Claude Code, up to 1,000 subagents, billed at token rates.

### Outcomes (Public Beta)
Write a rubric for what success looks like; a separate grader evaluates outputs against the criteria in its own context window and feeds corrections back to the agent. On Anthropic internal benchmarks: +10 points on hardest tasks. Pairs with Webhooks for fire-and-forget async workflows.

### Webhooks (Public Beta)
HTTP callback when an agent finishes. Enables event-driven production architectures without polling or held-open SSE streams.

**Relevance for Buildd**: Buildd already uses webhooks for task completion callbacks (`callbackUrl` in create_task). The Managed Agents pattern here is consistent with Buildd's own model.

---

## Security Guidance Plugin (GA — May 27, 2026)

Free for all users. Three-layer review system built into the Claude Code terminal:

1. **Per-edit pattern scan (zero cost)**: Deterministic regex match on every file edit — flags `eval()`, `os.system()`, `child_process.exec()`, `pickle` deserialization, DOM injection vectors, etc. No model call, no token cost.
2. **End-of-turn diff review**: LLM review (default: Opus 4.7) on the diff after each turn. Catches logic-level vulnerabilities (IDOR, SSRF, auth bypass, weak crypto). High-risk findings fed back to Claude for same-session fix.
3. **Agentic commit review**: On git commit, an SDK-driven reviewer uses Read/Grep/Glob to trace cross-file data flow. Catches multi-file IDOR, auth bypass, and cross-file SSRF.

**Install**: `plugin install security-guidance@claude-plugins-official` then `/reload-plugins`. Requires Claude Code CLI 2.1.144+.

**Results**: 30–40% decrease in security-related PR comments across Anthropic's internal rollout.

**Relevance for Buildd**: Workers that write application code could benefit from running the security plugin. Consider adding it as an optional feature in role configuration.

---

## Rate Limit Increases (May 6, 2026 — now in effect)

Anthropic doubled Claude Code 5-hour limits and significantly raised API rate limits, backed by the SpaceX Colossus 1 compute deal (300 MW, 220K+ NVIDIA GPUs):

| Tier | Previous Opus TPM | New Opus TPM | Change |
|------|-------------------|--------------|--------|
| Tier 1 | 30K | 500K | 16× |
| Tier 4 | 2M | 10M | 5× |

- **Claude Code 5-hour limits**: Doubled for Pro, Max, Team, and Enterprise
- **Peak-hour throttling**: Removed for Pro/Max
- **Weekly caps**: Unchanged (only 5-hour window was modified)
- No action required — changes applied automatically

**Relevance for Buildd**: Workers that were hitting 5-hour rate limits can now run longer tasks without throttling. Burst capacity for multi-worker missions improved.

---

## SDK Releases (v0.3.159) — June 2026

### TypeScript SDK v0.3.159 (May 31, 2026) — current latest
- **Parity with Claude Code v2.1.159** — internal infrastructure improvements, no user-facing changes

### Python SDK v0.2.87 (May 23, 2026) — major version bump
- **Major version jump from 0.1.x to 0.2.x** — this branch includes breaking changes mirroring the TS SDK 0.3.142 release:
  - v0.2.82 (May 15): **MCP servers now connect in background by default** (`status: "pending"` until ready)
  - v0.2.82: **Task tools replace `TodoWrite`** — `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`
  - v0.2.82: **New `EffortLevel` type export** — effort strings `"low"`, `"medium"`, `"high"`, `"max"`, `"xhigh"`
  - v0.2.86–87: CLI parity updates (v2.1.149–150)
  - CI switched from static API keys to Workload Identity Federation for short-lived tokens

---

## Major Feature: Dynamic Workflows + Opus 4.8 (May 28, 2026)

### Claude Opus 4.8 — New Model
Released May 28, 2026 alongside Dynamic Workflows. Available on Claude API, Bedrock, Vertex, Foundry.

**Key improvements for Buildd workers:**
- **Mid-conversation system messages**: Accepts `role: "system"` messages mid-conversation, after user turns — append updated instructions without restating the full system prompt. Preserves prompt cache hits on earlier turns and **reduces input cost on long agentic loops**.
- **Lower prompt cache minimum**: 1,024 tokens (down from higher limits on 4.7) — more cache hits on shorter system prompts
- **Fast mode**: 2.5× speed, same $5/$25/M pricing (described as "3× cheaper than prior models in fast mode")
- **Four times less likely** to let code flaws pass unreported — more reliable in agentic code tasks
- **Caveat**: Slightly less robust to agentic prompt injection than 4.7. Review sandboxing if using Opus 4.8 with untrusted input.

SDK model ID: `claude-opus-4-8`

### Dynamic Workflows — Up to 1,000 Parallel Subagents
Launched May 28, 2026 with Claude Code v2.1.154+. Available on all paid plans (Pro/Max/Team/Enterprise) and Claude API/Bedrock/Vertex/Foundry.

**Core concept**: Instead of orchestrating subagents turn-by-turn in context, Claude writes a **JavaScript orchestration script** for each task. A background runtime executes the script; the model's context window receives only the final verified answer.

**Agent SDK / headless mode**: Fully supported in `claude -p` and Agent SDK. In non-interactive mode, tool calls follow configured permission rules without prompts. Sub-agents always run in `acceptEdits` mode and inherit the session's tool allowlist.

**Activation**:
- Include the word `workflow` anywhere in a prompt for one-off use
- `/effort ultracode` — session setting that enables auto-workflow mode (`xhigh` effort + automatic workflows)

**Token cost warning**: Dramatically higher token spend than standard sessions. One user consumed ~70% of a 5-hour window in ~30 minutes on ultracode. Recommend starting on scoped tasks.

**Ultracode vs Ultrathink**: Ultracode = session-wide workflow orchestration. Ultrathink = single-prompt deep reasoning (no extra agents, no session change).

**Real-world results**: Used to rewrite 750,000 lines of Bun from Zig to Rust in 11 days (99.8% test suite green).

---

## Billing Change — URGENT (June 15, 2026, 14 days away)

Starting June 15, 2026, Agent SDK and `claude -p` usage on **subscription plans** moves to a **separate monthly credit pool** at full API list prices:

| Plan | Monthly Agent SDK Credit |
|------|--------------------------|
| Pro | $20 |
| Max 5× | $100 |
| Max 20× | $200 |
| Enterprise seat | **$0** (use API key) |

**Covers**: Agent SDK, `claude -p`, Claude Code GitHub Actions, third-party apps using the SDK.  
**Does NOT cover**: Interactive Claude Code terminal/IDE usage, Claude.ai chat (still draw from subscription limits as before).

**What happens when credit runs out**: If usage credits are enabled, usage flows to pay-as-you-go at API rates. If not enabled, Agent SDK requests are blocked until the credit refreshes.

**No rollover** — credit resets monthly, per-user, non-transferable.

**Action for Buildd**: Buildd workers that use `claude -p` programmatically will now draw from this credit pool. Users need to know this. Enterprise users should switch to API key billing.

---

## SDK Releases (v0.3.150 - v0.3.152) — May 2026

### TypeScript SDK v0.3.152 (May 27, 2026) — current latest
- **New**: `SessionStart` hook can return `reloadSkills: true` to trigger skill re-scan mid-session
- **New**: `SessionStart` hook can set `hookSpecificOutput.sessionTitle` to label sessions
- **New**: `MessageDisplay` hook event — transform or suppress assistant message text before display
- Claude Code v2.1.152

### TypeScript SDK v0.3.149 (May 22, 2026)
- **Fixed**: `options.env` no longer drops `CLAUDE_AGENT_SDK_VERSION` when custom env is supplied
- **Docs**: `Options.env` replaces the subprocess environment (does not merge with `process.env`)

### TypeScript SDK v0.3.142 (May 14, 2026) — BREAKING
- Removed v2 session API (deprecated since 0.2.133). Use `query()`.
- MCP servers now connect in background by default; set `alwaysLoad: true` to require by turn 1
- Task tools (`TaskCreate/Update/Get/List`) replace `TodoWrite` in agent sessions
- Added `request_id`, `subagent_type`, `task_description` on SDK message types

### TypeScript SDK v0.2.141 (May 13, 2026)
- Task tool types exported from `@anthropic-ai/claude-agent-sdk/sdk-tools`
- `@anthropic-ai/sdk` peer aligned to ^0.93.0

See [sdk-reference/integration-status.md](sdk-reference/integration-status.md) for full change history since v0.2.114.

---

## SDK Releases (v0.2.104 - v0.2.114)

### TypeScript SDK v0.2.114 (April 18, 2026)
- Updated to parity with Claude Code v2.1.114
- **New**: `getSessionMessages()` function for reading session transcript history with pagination (limit/offset)
- **Fixed**: Reverted breaking change — `system:init` and `result` events now emit 'Task' as the Agent tool name again

### TypeScript SDK v0.2.112 (mid-April)
- Parity with Claude Code v2.1.112

### Python SDK v0.1.63 (April 18, 2026)
- Updated bundled CLI to v2.1.114

### Python SDK v0.1.62 (April 17, 2026)
- **New**: Top-level `skills` option in `ClaudeAgentOptions` — enable all, specific, or no skills
- Bundled CLI v2.1.113

### Python SDK v0.1.60 (April 16, 2026)
- **New**: Subagent transcript helpers — `list_subagents()`, `get_subagent_messages()`
- **New**: Distributed tracing with W3C trace context propagation (TRACEPARENT/TRACESTATE)
- **New**: Optional OpenTelemetry support (`pip install claude-agent-sdk[otel]`)
- **New**: Cascading session deletion (removes sibling subagent transcript directories)
- Bundled CLI v2.1.111

### Python SDK v0.1.57 (April 9, 2026)
- **New**: Cross-user prompt caching
- **New**: Auto permission mode
- **Fixed**: Thinking configuration handling
- Bundled CLI v2.1.96

---

## Claude Code CLI Releases (v2.1.101 - v2.1.114)

### v2.1.114 Highlights (April 18)
- Latest stable release

### v2.1.113 Highlights (April 17)
- **Architecture**: CLI now spawns native Claude Code binary instead of bundled JavaScript
- **New**: `sandbox.network.deniedDomains` setting to block specific domains
- Performance improvements from native binary execution

### v2.1.112 Highlights (April 16)
- Focus view improvements, stronger permissions and sandbox handling
- Richer status line and no-flicker UI improvements
- Better resume and transcript reliability
- Improved Bash and MCP stability
- Updated agent, image, and completion workflows
- Faster diff computation for large files
- Better MCP large-output truncation

### v2.1.111 Highlights (April 16)
- Distributed tracing support in CLI subprocess
- Subagent transcript management improvements

### v2.1.105 (April 13)
- Maintenance release

### v2.1.101 (April 10) — see previous scan

---

## Competitive Landscape Update

### Claude Code vs OpenAI Codex vs Google Jules (Q2 2026)

| Dimension | Claude Code | OpenAI Codex | Google Jules |
|-----------|-------------|--------------|--------------|
| Architecture | Synchronous terminal + IDE orchestrator | Desktop app with model router | Async task pool in cloud VMs |
| Models | Sonnet 4.6 (default), Opus 4.6/4.7 (deep) | GPT-5.3-Codex, GPT-5.4 | Gemini 3.1 |
| SWE-Bench | **80.8%** (best) | ~75% | ~72% |
| Terminal-Bench | 65.4% | **77.3%** (best) | 61% |
| Strength | Interactive dev, real-time collaboration | Desktop automation, background compute | Long-running refactors, test backfill |

**Key competitive moves this week:**
- **Codex** launched "Background Computer Use" (April 16) — macOS desktop automation with parallel agent sessions
- **Claude Code** desktop app rebuilt around parallel sessions with sidebar, integrated terminal, in-app editor, and diff viewer (April 15)
- Most agencies now run two agents in parallel — Claude Code for interactive + Jules for batch work

---

## Community & Ecosystem

### New Ecosystem Projects (Since May 27, 2026)

| Project | Description |
|---------|-------------|
| **Hivemind** | Plugin for Claude Code/Codex/OpenClaw adding persistent memory, context sync, and virtual filesystem hooks via Deeplake; supports long-term memory, RAG, and embeddings |
| **Claude-World** | AI-powered content pipeline (trend discovery → research → social publishing) + security scanner for Claude Skills (71K+ skills across 9 engines) |
| **Real-time Claude Agent Monitor** | SQLite/Node/React/WebSocket dashboard for tracking agent sessions, tool usage, and subagent orchestration via hooks |
| **openinference-instrumentation-claude-agent-sdk** (PyPI v0.1.5, May 29) | Official OpenInference OTEL instrumentation for Python SDK — traces queries as spans, captures prompts, token counts, tool calls; exports to Arize Phoenix |
| **Awesome Claude Code & Skills** (GetBindu) | Curated collection of production-ready Claude skills for coding, security, marketing, and specialized domains |

### New Enterprise Integration: Xcode 26.3
Apple announced that **Xcode 26.3** will include a native Claude Agent SDK integration for iOS/macOS/visionOS development. Specifically calls out hooks and subagents as the building blocks; uses Xcode Previews for visual feedback in SwiftUI editing.

### GitHub Stars & Adoption (April 20, 2026)
- **13,087 total repositories** indexed in awesome-claude-plugins collection
- Claude Code repo: 55K+ stars
- **4% of all GitHub commits** now authored by Claude Code agents
- Persona distillation wave: >50% of new repos are "distill thinking style into a Skill" variations

### Trending Community Projects (New/Updated Since June 1, 2026)

| Project | Stars | Description |
|---------|-------|-------------|
| **Everything Claude Code (ECC)** (affaan-m) | 100K+ | Most comprehensive agent harness — 135 agents, security scanning, memory optimization, model routing via NanoClaw v2, 12 language ecosystems. Anthropic Hackathon winner. |
| **Superpowers** | 94K+ | TDD-enforced dev framework — 7-phase workflow (Brainstorm→Spec→Plan→TDD→Subagent Dev→Review→Finalize). Literally deletes code written before tests exist. |
| **andrej-karpathy-skills** (multica-ai) | 156K | CLAUDE.md with Karpathy's 4 behavioral principles: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. Fastest-growing AI workflow repo. |
| **Taskmaster** | growing | AI project management layer — feed a PRD → breaks into ordered tasks with dependency tracking → exposes 36 MCP tools for Claude Code to execute sequentially. |
| **awesome-claude-code** (hesreallyhim) | growing | Curated directory of skills, hooks, slash-commands, orchestrators, plugins. The go-to ecosystem index. |
| **claude-mem** (thedotmack) | 64.1K | Auto-captures coding sessions, compresses with AI, injects context into future sessions |
| **open-agent-sdk-typescript** (codeany-ai) | 2.6K | Alternative agent framework without CLI dependencies, fully open source |
| **claude_telemetry** (TechNickAI) | — | OpenTelemetry wrapper logging tool calls, tokens, costs to Logfire/Sentry/Honeycomb/Datadog |

### Anthropic Business News (June 2026)
- **S-1 filing**: Anthropic confidentially submitted a draft S-1 to the SEC on June 1, 2026 — IPO process underway
- **$65B Series H**: Raised at $965B post-money valuation on May 28, 2026
- **SpaceX compute deal**: Colossus 1 data center (300 MW, 220K+ NVIDIA GPUs) — fueled the doubled rate limits
- **Glasswing expansion**: Project Glasswing extended to ~150 new orgs; Claude Security for codebase scanning added

### Observability Ecosystem Maturing
- **Langfuse** now has official Claude Agent SDK integration
- **claude_telemetry** provides drop-in OpenTelemetry wrapper
- Native SDK support for W3C trace context propagation
- OTEL metrics, logs/events, and traces protocols all supported

### Multi-Agent Orchestration Patterns
- **Orchestrator-worker pattern** (Anthropic's own research system): Opus leads, Sonnet subagents explore in parallel
- **Subagent depth limit**: Cannot spawn sub-subagents — prevents infinite nesting
- **Cost optimization**: Main session on Opus, focused sub-tasks on Sonnet
- **Production non-negotiables**: Durable state, hard cost caps, circuit breakers, tool permissioning, eval hooks

---

## Key Patterns & Developments

### 1. Observability Goes Native
The biggest shift this week: distributed tracing is now built into the SDK. W3C trace context propagation connects SDK ↔ CLI traces end-to-end. OpenTelemetry is optional but first-class (`pip install claude-agent-sdk[otel]`). This enables:
- Token cost attribution per task/user/tenant
- Tool call latency monitoring
- Session lifecycle tracing through subagent trees
- Integration with enterprise observability stacks (Datadog, Honeycomb, Grafana)

### 2. Skills API Becoming First-Class
The new `skills` option in Python SDK (`ClaudeAgentOptions(skills="all"|["specific"]|[])`) signals skills are graduating from "plugin hack" to core SDK concept. Combined with v2.1.94's plugin skills via `"skills": ["./"]`, this validates Buildd's role-based skill system.

### 3. Native Binary Architecture Shift
v2.1.113 switched from bundled JS to spawning a native binary. Implications:
- Better performance and lower memory
- Smaller package sizes
- May affect custom integrations that relied on Node.js internals

### 4. Session Transcript as Data
New `getSessionMessages()` (TS) and `get_subagent_messages()` / `list_subagents()` (Python) APIs treat transcripts as queryable data. This enables:
- Post-hoc analysis of agent decision-making
- Audit trails for compliance
- Training data extraction from production runs
- Cross-session context injection (like claude-mem's 64K-star approach)

### 5. Managed Agents Stabilizing
Now 12 days post-launch. Key updates from the ecosystem:
- $0.08/session-hour pricing confirmed stable
- Multi-agent coordination still in research preview (not yet GA)
- Early adopter results: Sentry going from flagged bug to PR autonomously
- Hybrid deployment (self-hosted + Managed Agents overflow) emerging as pattern

### 6. Desktop App Parallel Sessions
Anthropic rebuilt the Claude Code desktop experience around:
- Sidebar for managing multiple sessions (filter by status/project/environment)
- Integrated terminal for tests/builds
- In-app file editor
- Rebuilt diff viewer for large changesets
- Preview pane for HTML/PDF

---

## Recommendations for Buildd

### This Week (June 8, 2026)

**#0 — CRITICAL: Audit for hardcoded model API strings before June 15 (7 days)**
`claude-sonnet-4-20250514` and `claude-opus-4-20250514` API IDs retire on June 15. Any hardcoded string hits an error on June 16. Run `grep -r '20250514' packages/ apps/` to find exposure. `packages/core/model-aliases.ts` should shield most of this, but verify. Migration: Sonnet → `claude-sonnet-4-6`, Opus → `claude-opus-4-8`.

**#1 — URGENT: Dashboard billing change notice is now 7 days away**
The June 15 Agent SDK billing split (covered in detail last week) is now imminent. If the dashboard banner/docs update hasn't shipped, it needs to ship this week.

**#2 — Use `agentProgressSummaries` for live task visibility**
New in v0.3.162+: pass `agentProgressSummaries: true` to the SDK `query()` options to get periodic AI-generated progress summaries from subagents on `task_progress` events. This could be displayed on the Buildd task detail page as live progress updates without requiring workers to call `update_progress` manually. Location: `packages/core/worker-runner.ts`. Effort: Low.

**#3 — Adopt `fallbackModel` in worker runner for reliability**
New in CLI v2.1.160+: `fallbackModel` allows configuring up to 3 fallback models when the primary is overloaded. For Buildd workers, this means fewer failed tasks during Opus/Sonnet capacity spikes. Configure via role config or worker-runner settings. Location: `packages/core/worker-runner.ts`, `apps/web/src/lib/role-config.ts`. Effort: Low.

**#4 — Consider Security Guidance Plugin for code-writing roles**
The security plugin (free, 3-layer review) integrates at the Claude Code level. Buildd roles configured for application development (Builder, etc.) could declare it in their skill config. Would catch 30–40% of security PR issues before they reach review. Location: `apps/web/src/lib/default-roles.ts`, role skill config. Effort: Low.

### Still Urgent (From Previous Weeks)

**#5 — Expose Claude Opus 4.8 in Role model options**
`claude-opus-4-8` is now available and ships with meaningful improvements for agentic sessions: lower prompt cache threshold (1,024 tokens), mid-conversation system messages for cost-efficient long sessions, and better code reliability. Add it to role model selection. Note the prompt-injection caveat in docs.

**#6 — Consider Dynamic Workflows compatibility statement**
Buildd's coordination model (tasks + workers) and Dynamic Workflows are complementary but distinct. A Buildd worker running with Dynamic Workflows enabled will spawn up to 1,000 sub-sessions — these will each generate separate Claude sessions not tracked by Buildd's worker system. Decisions to make:
- Should Buildd workers allow or block Dynamic Workflows? (Token cost is extreme)
- Should Buildd expose an "ultracode" option per task or mission?
- If a Buildd worker uses workflows, should the sub-agent sessions be captured as task artifacts?

**#7 — Use Opus 4.8 mid-conversation system messages in worker runner**
Long-running Buildd tasks could benefit from mid-conversation system prompt injection (e.g., appending progress-aware instructions) without restating the full system prompt. This preserves cache hits and reduces input cost. Relevant in `packages/core/worker-runner.ts`.

### High Priority

1. **Adopt OpenTelemetry for worker observability** — The SDK now natively propagates W3C trace context. Buildd runners should set `CLAUDE_CODE_ENABLE_TELEMETRY=1` and export to a collector. This gives per-task token costs, tool call traces, and session-level metrics without custom instrumentation. The Langfuse integration is drop-in.

2. **Expose `skills` configuration per role** — Python SDK v0.1.62 added `skills` as a top-level agent option. Buildd roles should be able to specify which skills are available (`"all"`, specific list, or none). This is cleaner than the current `allowedTools` approach for skill-level control.

3. **Leverage `getSessionMessages()` for task analysis** — Use transcript data to build post-mortem analysis, extract patterns from successful tasks, and feed memory systems. The 64K-star claude-mem project validates that session history is extremely valuable.

4. **Monitor native binary transition** — v2.1.113's switch to spawning a native binary may affect runner packaging. Test that Buildd's runner Bun-based setup works correctly with this change.

### Medium Priority

5. **Implement distributed tracing end-to-end** — With W3C trace context propagation, Buildd can trace a task from API creation → worker claim → agent session → subagent execution → PR creation. This is the #1 observability gap.

6. **Add subagent transcript access to task artifacts** — The new `list_subagents()` and `get_subagent_messages()` APIs enable capturing subagent work as structured data. Save as task artifacts for debugging and review.

7. **Evaluate Managed Agents for overflow capacity** — At $0.08/session-hour + tokens, Managed Agents could serve as burst capacity when self-hosted runners are maxed. Route non-critical tasks there during peak load.

8. **Adopt cascading session deletion** — Python SDK v0.1.60 added cascading deletion of subagent transcripts. Ensure worker cleanup properly handles transcript directories to avoid disk bloat.

### Lower Priority

9. **Desktop parallel session UX inspiration** — Anthropic's rebuilt desktop (sidebar, status filters, integrated terminal) validates Buildd's dashboard design direction. Consider adopting the "filter by status/project" pattern in the missions view.

10. **Cross-user prompt caching** — Python SDK v0.1.57 added cross-user prompt caching. For workspaces running multiple agents with shared system prompts (roles), this could reduce costs significantly. Verify Buildd's runner benefits from this automatically.

11. **Network domain blocking** — The new `sandbox.network.deniedDomains` setting could be exposed in role configuration, allowing workspace admins to restrict which domains agents can access per role.

12. **Explore claude-mem pattern** — The 64K-star project's approach (auto-capture sessions → compress → inject into future sessions) is essentially what Buildd's memory system does at the workspace level. Study their compression strategy for memory efficiency gains.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-06-08 | 0.3.160-0.3.168 | 0.2.87+ | 2.1.160-2.1.168 | agentProgressSummaries, reloadPlugins(), fallbackModel, getSettings().applied, cross-session messaging hardening, glob deny rules, Managed Agents GA (Outcomes/Orchestration/Webhooks), Security Plugin GA, rate limits doubled, model retirement June 15 |
| 2026-06-01 | 0.3.159 | 0.2.87 | 2.1.159 | Dynamic Workflows + Ultracode (up to 1,000 subagents), Opus 4.8, billing split June 15, OpenInference OTEL, Python SDK major version bump to 0.2.x, Xcode 26.3 integration |
| 2026-05-27 | 0.3.150-0.3.158 | 0.1.63+ | 2.1.150-2.1.158 | Skills auto-loaded, Opus 4.8 preview, auto mode on Bedrock/Vertex/Foundry, tool_decision telemetry, worktree lifecycle improvements, streaming tool exec GA |
| 2026-04-20 | 0.2.104-0.2.114 | 0.1.54-0.1.63 | 2.1.101-2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94-0.2.104 | — | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | — | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | — | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
