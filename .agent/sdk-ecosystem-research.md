# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-07-20
**Previous scan**: 2026-07-13
**Current SDK version in Buildd**: `^0.3.168` (needs bump to ^0.3.215)
**Python SDK**: v0.2.123 (bundled with CLI v2.1.215)
**Claude Code CLI**: v2.1.215 (released July 19, 2026)

> **Note**: For SDK feature details and integration status, see [sdk-reference/](sdk-reference/).

---

## SDK Releases (v0.3.208 - v0.3.215) — July 14–19, 2026

### TypeScript SDK v0.3.215 (July 19, 2026) — current latest
- **Parity**: Updated to parity with Claude Code v2.1.215

### TypeScript SDK v0.3.214 (July 18, 2026)
- **New**: `set_permission_mode` now rejects unrecognized permission modes with a clear error; `'manual'` alias accepted at every ingress point
- **New**: Optional `subkind: 'scheduled-trigger'` on `task-notification` `SDKMessageOrigin` — marks sessions that are the fired prompt of a user-configured scheduled task
- **Fixed**: `applyFlagSettings({effortLevel})` now accepts `'max'` in its TypeScript type (runtime already supported it)
- **New**: Assistant messages truncated by `interrupt()` now carry `aborted: true` — consumers can distinguish a mid-stream partial from a completed message
- **New**: `subagent_type` and `subagent_retry` optional fields on `tool_progress` messages — clients can show when a subagent is waiting out an API rate-limit retry
- **New**: `system/init` `plugins` entries and `reload_plugins` response now include each plugin's manifest `version`
- **Fixed**: `SessionStart` hooks now correctly report source `"fork"` instead of `"resume"` when the session begins as a fork

### TypeScript SDK v0.3.212 (July 17, 2026)
- **Fixed**: Dash-leading `resumeSessionAt` and `sessionId` values now passed with equals-form argv (`--flag=value`) — prevents them being parsed as separate CLI flags
- **New**: Agent tool output now includes the resolved model when a mid-turn model swap changed the subagent's model

### TypeScript SDK v0.3.211 (July 15, 2026)
- **New**: `SDKAssistantMessage.timestamp` (ISO-8601) added to the live stream, matching `SDKUserMessage`; older emitters omit it — consumers should fall back to receive time
- **New**: `USAGE_LIMIT_ERROR_PREFIXES` and sibling exports (`@alpha`) — classify rate-limit error messages without hand-mirrored string lists
- **Fixed**: `--replay-user-messages` with `--include-partial-messages` emitting the turn-start user replay after the first content block instead of before the turn's content events
- **Fixed**: Process-exit errors now include CLI stderr output — failed child processes report their actual cause instead of only an exit code

### TypeScript SDK v0.3.210 (July 14, 2026)
- **New**: `timedOutAfterMs` field on `BashToolOutput` — set when a command is auto-backgrounded on timeout

### TypeScript SDK v0.3.209 (July 14, 2026)
- **Parity**: Updated to parity with Claude Code v2.1.209

### TypeScript SDK v0.3.208 (July 14, 2026) — bug fix release
- **Fixed**: Caller abort during a pending SDK hook callback was converted into hook success — PreToolUse-gated tools were executing after abort
- **Fixed**: Per-query resource leak in process tracking when CLI spawn fails (nonexistent or inaccessible executable path)
- **Fixed**: `UserPromptSubmit` hook exceeding its timeout killed the entire query with an empty error; now blocks the prompt with a clear timeout message and the session continues
- **Fixed**: `extraArgs` values that look like flags (e.g., `resume: '--version'`) being parsed as their own CLI flags; dash-leading values now bound with equals-form argv
- **Fixed**: Abort-listener leak: streaming queries sharing one `AbortController` no longer accumulate `abort` listeners on its signal after each completed query
- **Fixed**: `createSdkMcpServer` docs pointed at a nonexistent env var; MCP tool-call timeout knob is `MCP_TOOL_TIMEOUT`
- **Fixed**: Uncaught exception when writing to stdin after the Claude Code subprocess has exited

### Python SDK (July 14–19, 2026)
- **v0.2.123**: Bundled CLI updated to v2.1.215 (current latest)
- **v0.2.122**: Bundled CLI updated to v2.1.214
- **v0.2.121**: Bug fixes for argv flag injection; hardened build scripts

---

## Claude Code CLI Releases (v2.1.208 - v2.1.215) — July 14–19, 2026

### v2.1.215 (July 19, 2026) — current latest
- **Changed**: `/verify` and `/code-review` now only run when **directly invoked** — no longer trigger automatically

### v2.1.214 (July 18, 2026)
- **Security**: Fixed permission bypass in Windows PowerShell 5.1 sessions
- **Security**: Fixed Bash permission analysis for file-descriptor redirects and long commands
- **Security**: Enhanced safety for `help` and `man` command execution; strengthened Docker command permission prompts
- **New**: `EndConversation` tool for managing abusive interactions
- **New**: Progress heartbeats for extended tool operations
- **Fixed**: PowerShell Unicode handling and background session management

### v2.1.212 (July 17, 2026)
- **New**: `/fork` creates **background session copies** while maintaining current work — each fork becomes an agent row
- **New**: Session-wide **WebSearch call limit** (default: 200) prevents runaway search agents
- **New**: Per-session **subagent spawn cap** (default: 200) prevents unbounded agent trees
- **New**: MCP tool calls exceeding 2 minutes **auto-move to background** — session stays responsive
- **New**: `/resume` command now provides a **session picker** for past sessions

### v2.1.211 (July 16, 2026)
- **New**: `--forward-subagent-text` flag for stream-json output — captures subagent text as it streams
- **Security**: Fixed permission preview character neutralization
- **Fixed**: Auto mode override behavior for `PreToolUse` hooks; Chrome file upload issues

### v2.1.210 (July 15, 2026)
- **New**: **Elapsed-time counter** on tool summary lines — live counter shows long-running tools are working instead of appearing frozen
- **Fixed**: Worktree isolation for subagents; permission rule compilation and caching; background agent result reporting

### v2.1.209 (July 14, 2026)
- **Fixed**: `/model` and other dialogs blocked in background agent sessions

### v2.1.208 (July 14, 2026)
- **New**: **Screen reader mode** — opt-in plain-text rendering via `--ax-screen-reader`, `CLAUDE_AX_SCREEN_READER=1`, or `"axScreenReader": true` in settings
- **New**: `vimInsertModeRemaps` setting — map two-key insert-mode sequences (e.g., `jj`) to Escape in vim mode
- **New**: `CLAUDE_CODE_PROCESS_WRAPPER` env var for corporate launcher support
- **New**: Mouse-click support in fullscreen menus
- **Improved**: Significant memory and performance optimizations

---

## Fable 5: Free Window Closed July 19, 2026

The twice-extended free period ended on schedule. Starting July 20, 2026:

| Plan | Fable 5 Access |
|------|----------------|
| Max / Team Premium | Permanently included at reduced rate — no per-token billing |
| Pro / Team Standard | One-time $100 usage credit granted; afterwards API billing at $10/$50 per MTok |
| Without usage credits enabled | Access stops — no grace period |

**Action for Buildd**: Add a visible warning to role cards using `claude-fable-5` for Pro/Standard workspace users. The `model-tiers` spec (`docs/design/model-tiers.md`) should reflect Fable 5 as `premium` tier with a plan-gated access note.

---

## Platform Announcements (July 14–20, 2026)

### Claude for Teachers (July 14, 2026)
Free for US K-12 educators. Library of teaching skills with direct connection to evidence-based curricula mapped to academic standards in all 50 states.

### Claude for Government (Beta)
Claude Code and Claude Cowork now available in a government-compliant environment.

### Cowork Mobile/Web Expansion
Sessions and files follow across devices. Background work, scheduled tasks, shared chat/projects, and mobile approvals work cross-device.

### Memory: Categorized Entries
Memory now stores individual categorized entries instead of a daily summary — richer per-category context injected into conversations.

### HIPAA Self-Serve Configuration
Enterprise and API orgs with a BAA can enable HIPAA configuration via a self-serve flow in the console.

### Admin API User Management (Beta)
Enterprise organizations can manage users programmatically — list/role/remove members, send invites, manage groups and custom roles.

---

## New Ecosystem Projects (Since July 13, 2026)

| Project | Stars | Description |
|---------|-------|-------------|
| **AAS Core** | 43.6K | Agent-first control plane for catalog discovery backed by 1,969+ agentic skills; CLI, local MCP, catalog, and plugin integration |
| **ARIS** (Auto-Research-In-Sleep) | 13.6K | Autonomous ML research agent with lightweight Markdown-only skills; runs overnight research loops and synthesizes findings |
| **Java Claude Code Plugins** | 323 | 23 production-grade Claude Code plugins: TDD enforcement hooks, git/PR workflows, spec-driven development, code review, project lifecycle automation |
| **Blueprint-Driven Dev** | 192 | 186 skills, 128 commands, 54 agents for structured Python project development using blueprint specs |
| **VILA-Lab/Dive-into-Claude-Code** | — | Systematic academic analysis of Claude Code for designing AI agent systems; includes architectural patterns and evaluation frameworks |

---

## SDK Releases (v0.3.169 - v0.3.207) — June 8 – July 13, 2026

### TypeScript SDK v0.3.207 (July 11, 2026) — current latest
- **Fixed**: `canUseTool` returning `{behavior: 'allow'}` without `updatedInput` was incorrectly treated as deny — tool now runs with original input per documented contract
- **New**: `AgentToolCompletedOutput` SDK type added, matching emitted object exactly for type-safe tool completion handlers

### TypeScript SDK v0.3.206 (July 10, 2026)
- **New**: `command_lifecycle` frames in stream-json and SDK sessions — reports each uuid-stamped message's terminal state: `queued`/`started`/`completed`/`cancelled`/`discarded`
- **Fixed**: Zero-API results no longer report stale `duration_api_ms`

### TypeScript SDK v0.3.205 (July 8, 2026)
- **New**: Interrupt control responses include `still_queued` field (UUIDs of queued async messages)
- **New**: `Query.interrupt()` returns typed `InterruptReceipt`
- **New**: `system/init` advertises `interrupt_receipt_v1` capability for feature detection
- **New**: Structured `name` and `body` fields added to peer-message session events

### TypeScript SDK v0.3.203 (July 7, 2026)
- **New**: `background_tasks_changed` system message — emits full set of live background tasks on every membership change; enables tracking all background agent activity without polling

### TypeScript SDK v0.3.202 (July 6, 2026)
- **New**: `parent_agent_id` field on subagent session messages — **enables depth-2+ agent trees** (previously max depth was 1)
- **Fixed**: `apply_flag_settings` with non-object settings value now returns control error instead of crashing

### TypeScript SDK v0.3.200 (July 3, 2026)
- **New**: `'manual'` accepted as alias for `'default'` permission mode
- **Fixed**: `onSetPermissionMode` callback not firing for SDK-hosted Remote Control sessions
- **Fixed**: `set_model` control request now rejects unrecognized model strings before latching

### TypeScript SDK v0.3.199 (July 2, 2026)
- **New**: `requestId` field on `canUseTool` callback options — enables out-of-band correlation for async permission responses
- **New**: Support for returning `null` from `canUseTool` to suppress automatic control response
- **New**: `blocked` field on `workflow_agent` progress events
- **New**: `mode:"mask"` and per-credential `injectHosts` added to `sandbox.credentials` settings

### TypeScript SDK v0.3.198 (July 1, 2026)
- **New**: Runtime warning when `canUseTool` configured alongside `allowedTools` or `bypassPermissions` (conflicting config detection)
- **New**: Per-server `request_timeout_ms` option in `mcp_set_servers` control request
- **Fixed**: `SDKUserMessage.isSynthetic` not being mapped to `isMeta` on ingestion
- **Fixed**: Workflow progress events silently dropping earliest agents from list

### TypeScript SDK v0.3.193 (mid-June)
- **New**: `promptSuggestions` option in Browser SDK `query()` — opt CLI into emitting follow-up suggestions
- **Fixed**: Brief console window flashes on Windows when spawning CLI subprocesses

### TypeScript SDK v0.3.187 (mid-June)
- **New**: `sandbox.credentials` added to SDK settings types — configure credential file and env var denial in sandboxed commands

### TypeScript SDK v0.3.169–186 (June 8–30, 2026)
- **Breaking** (0.3.185 range): v2 session API removed (deprecated since 0.2.133). `query()` is the sole API.
- **New**: `claude-fable-5` model and `fable` alias added to SDK model types
- **New**: `sessionStore` option (alpha) on `query()` — mirrors session transcripts to external storage
- **New**: `deleteSession()` function for removing sessions from disk or `SessionStore`
- **Fixed**: MCP resource tools not injected for servers added at runtime via `mcp_set_servers`
- **Fixed**: Long-running SDK sessions now reconnect claude.ai-proxied MCP servers after transport-stream abort
- **Fixed**: Control protocol deduplication dropping tool-use IDs after 1,000 resolutions (could cause duplicate `tool_result` deliveries in long sessions)
- Exported: `TaskCreateInput`, `TaskCreateOutput`, `TaskGetInput`, `TaskGetOutput` from `@anthropic-ai/claude-agent-sdk/sdk-tools`
- **New**: `prompt_id` field in hook input payloads — correlate hook events with OTel prompt-level events

### Python SDK (June–July 2026)
- **New**: Full `SessionStore` support at parity with TypeScript — `SessionStore` protocol with 5 methods, `InMemorySessionStore` reference, transcript mirroring via `--session-mirror`, 9 async store-backed helpers
- **New**: `ThinkingConfig` types (`ThinkingConfigAdaptive`, `ThinkingConfigEnabled`, `ThinkingConfigDisabled`) + `thinking` field on `ClaudeAgentOptions`
- **New**: `effort` field on `ClaudeAgentOptions` — supports `"low"`, `"medium"`, `"high"`, `"max"` for controlling thinking depth

---

## Claude Code CLI Releases (v2.1.169 - v2.1.207) — June 8 – July 13, 2026

### v2.1.207 (July 11, 2026) — current latest
- **New**: Auto mode enabled by default on Bedrock/Vertex/Foundry (no longer needs `CLAUDE_CODE_ENABLE_AUTO_MODE`)
- **Improved**: `/cd` now shows directory path suggestions matching `/add-dir` behavior
- **New**: `/doctor` check proposes trimming CLAUDE.md files by cutting derivable content
- **Improved**: `/commit-push-pr` auto-allows `git push` to the configured push remote (not just `origin`)
- **Security**: Remote managed settings from non-interactive runs no longer permanently recorded as consented
- **Fixed**: Terminal freeze during response streaming; worktree configuration issues

### v2.1.205–206 (July 8–10, 2026)
- **New**: `/doctor` expanded to full setup checkup
- **Fixed**: Auto-update binary downloads now stream to disk (~400 MB peak memory reduction)
- **Fixed**: Background agents showing stale "Running" status after resuming with SendMessage
- **Security**: Auto mode transcript tampering protection

### v2.1.203–204 (July 7–8, 2026)
- **New**: Login expiry warning shown before session interruption
- **New**: Grey ⏸ badge in footer when in manual permission mode
- **Fixed**: Hook events not streaming during `SessionStart` hooks in headless sessions (critical: caused remote workers to be idle-reaped mid-hook)
- **Fixed**: macOS stalling and context-usage indicator re-analyzing entire transcript after every turn

### v2.1.202 (July 7, 2026)
- **New**: "Dynamic workflow size" setting in `/config` — advisory control over agent count in dynamic workflows (small/medium/large)
- **New**: Richer OTel telemetry: `workflow.run_id` and `workflow.name` attributes on workflow-spawned agents
- **Fixed**: `/review` restored to single-pass operation; multiple crash/login fixes

### v2.1.200–201 (July 3–4, 2026)
- **Breaking**: Default permission mode changed to **Manual** (was Auto); `AskUserQuestion` dialogs now require explicit continuation
- **Fixed**: Crash loops, background session reliability across platforms (long-running commands survive process stop/restart/update including Windows)
- **Fixed**: Claude Sonnet 5 sessions no longer use mid-conversation system role for harness reminders

### v2.1.198–199 (July 1–2, 2026)
- **New**: Chrome integration out of preview — GA for all direct Anthropic plan users. Claude drives browser via Claude in Chrome extension (tabs, clicks, forms, console logs, shared login state)
- **New**: `/dataviz` skill added to CLI
- **New**: Draft PR handoff for background agents
- **New**: Background notifications for agents
- **Fixed**: Background-agent daemon killing itself every ~50 seconds after unclean shutdown; streaming recovery and retry logic

### v2.1.197 (July 1, 2026)
- **New**: **Claude Sonnet 5 becomes default model** — 1M-token context window, adaptive thinking on by default, `xhigh` effort support. Promotional pricing $2/$10 per MTok through August 31, 2026.

### v2.1.184–196 (June 8–30, 2026)
- **New**: Background subagents — Claude keeps working while subagents run and picks up results when finished (no more pausing to wait); still runs foreground when result needed before continuing
- **New**: Agent Teams simplification — `TeamCreate`/`TeamDelete` tools removed; every session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` now has one implicit team — spawn teammates directly via Agent tool `name` parameter
- **New**: MCP `roots/list` now includes session's additional working directories; `notifications/roots/list_changed` sent when set changes
- **New**: Bedrock upgraded to Claude Opus 4.8 as default
- **Fixed**: Orphaned `claude --bg-pty-host` processes at 100% CPU on macOS (was in v0.3.168 but fully resolved now)

---

## Major Model Releases (June–July 2026)

### Claude Sonnet 5 (June 30, 2026) — now default in Claude Code
- **Context**: 1M-token context window, 128K max output — first Sonnet with frontier-scale context natively
- **Pricing**: $2/$10 per MTok input/output through Aug 31; $3/$15 afterwards
- **Performance**: Near-Opus 4.8 quality on coding/agentic tasks at 2–2.5× lower cost
- **Adaptive thinking**: On by default; disable with `"thinking": {"type": "disabled"}`
- **Effort**: First Sonnet to support `xhigh` effort (recommended for hard coding/agentic work)
- **Tokenizer**: Updated tokenizer — same input maps to **1.0–1.35× more tokens** vs. previous Sonnet models
- **Breaking API**: `temperature`, `top_p`, `top_k` at non-default values return 400; manual `thinking: {type: "enabled"}` returns 400 — use `effort` parameter instead
- **Model ID**: `claude-sonnet-5`
- **Safety**: Cyber safeguards enabled by default; lower undesirable behavior than Sonnet 4.6
- **SDK**: Use `claude-sonnet-5` model ID; now available as the `sonnet` alias

### Claude Fable 5 — Saga (June 9 – July 19, 2026)
- **Released**: June 9, 2026 alongside Claude Mythos 5
- **Pulled**: June 12 — US export controls applied after Amazon researchers found safeguard bypass; access suspended globally
- **Returned**: July 1 — export controls lifted; Anthropic deployed improved safety classifier (blocks bypass technique >99%)
- **CAISI**: US DoC Center for AI Standards verified safeguards as "extraordinarily strong"
- **Free access extended**: Through **July 19, 2026** (twice extended); 50% of weekly limits on Pro/Max/Team
- **Pricing after July 19**: $10/$50 per MTok input/output (usage credits)
- **Model ID**: `claude-fable-5` (alias: `fable`)
- **Claude Code requirement**: v2.1.170+ to use Fable 5
- **Note**: Fable 5 draws from the same weekly usage pool but consumes it faster
- **Competitive context**: OpenAI GPT-5.6 ("Sol") reached GA the same week, narrowing the gap on coding benchmarks

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

### New Ecosystem Projects (Since June 8, 2026)

| Project | Description |
|---------|-------------|
| **Persistent Context / Memory Engine** | Captures everything an agent does per session, compresses with AI, injects relevant context into future sessions — compatible with Claude Code, Codex, Gemini, Hermes, Copilot, OpenCode, and more |
| **AI Research Skill** | Agent skill that researches any topic across Reddit, X, YouTube, HN, Polymarket, and the web then synthesizes a grounded summary — 51.8K stars |
| **Agent Harness Performance Optimization System** | 229K-star meta-harness for skills, instincts, memory, security, and research-first development across Claude Code, Codex, Opencode, Cursor |
| **Free AI Gateway** | Single endpoint with 231+ providers (50+ free); RTK+Caveman stacked compression (15–95% token savings), smart auto-fallback, MCP/A2A, multimodal APIs |
| **OfficeCLI** | First Office suite built for AI agents — reads, edits, and automates Word, Excel, PowerPoint without Office installed; single binary, open source |
| **AI Research Skill** (51.8K stars) | Researches across Reddit, X, YouTube, HN, Polymarket, and the web → grounded summary |
| **Curated Agent Skills Collection** | 1,000+ agent skills from official dev teams and community, compatible with Claude Code, Codex, Gemini CLI, Cursor |

### New Enterprise Integration: Xcode 26.3
Apple announced that **Xcode 26.3** will include a native Claude Agent SDK integration for iOS/macOS/visionOS development. Specifically calls out hooks and subagents as the building blocks; uses Xcode Previews for visual feedback in SwiftUI editing.

### GitHub Stars & Adoption (July 2026)
- **600+ community tools and projects** in Claude Code ecosystem
- **Karpathy's CLAUDE.md**: 110K+ stars — held #1 weekly GitHub Trending for 28 consecutive days
- Monthly AI agent category: 17.7K new stars; AI skills: 6.7K; MCP: 2.3K
- Open-source alternatives: OpenHands 80.5K stars, Goose 51.1K stars, Cline 8M VS Code installs

### Trending Community Projects (Updated July 2026)

| Project | Stars | Description |
|---------|-------|-------------|
| **Agent Harness Performance Optimization** | 229K | Meta-harness for skills, memory, security, research-first dev across Claude Code + Codex + Cursor |
| **Karpathy's CLAUDE.md** (multica-ai) | 110K | 4 behavioral principles: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. 28 days #1 GitHub Trending. |
| **Everything Claude Code (ECC)** (affaan-m) | 100K+ | Most comprehensive agent harness — 135 agents, NanoClaw v2 model routing, 12 language ecosystems |
| **Superpowers** | 94K+ | TDD-enforced dev framework — 7-phase workflow. Deletes code written before tests exist. |
| **AI Research Skill** | 51.8K | Multi-platform research agent (Reddit, X, YT, HN, Polymarket, web) |
| **claude-mem** (thedotmack) | 64.1K | Auto-capture → compress → inject session memory |
| **Taskmaster** | growing | PRD → ordered tasks with deps → 36 MCP tools for Claude Code execution |
| **open-agent-sdk-typescript** (codeany-ai) | 2.6K | Alternative agent framework without CLI dependencies |
| **claude_telemetry** (TechNickAI) | — | OTel wrapper for tool calls, tokens, costs → Logfire/Sentry/Honeycomb/Datadog |

### Earlier Projects (Still Relevant, Since May 27, 2026)

| Project | Description |
|---------|-------------|
| **Hivemind** | Plugin for Claude Code/Codex/OpenClaw: persistent memory, context sync, virtual filesystem hooks via Deeplake |
| **Claude-World** | AI-powered content pipeline + security scanner for 71K+ Claude Skills across 9 engines |
| **Real-time Claude Agent Monitor** | SQLite/Node/React/WebSocket dashboard for agent sessions, tool usage, subagent orchestration via hooks |
| **openinference-instrumentation-claude-agent-sdk** (PyPI v0.1.5) | Official OpenInference OTEL instrumentation for Python SDK |

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

### This Week (July 20, 2026)

**#0 — Bump SDK to ^0.3.215 (was ^0.3.207)**
Buildd is still pinned to `^0.3.168`. Latest is `0.3.215`. Key fixes since last scan: `UserPromptSubmit` hook timeout killing entire sessions, abort-listener leak accumulation in concurrent queries, `extraArgs` flag parsing breaking session CLI args, PreToolUse gate bypass on caller abort. Location: `packages/core/package.json`. Effort: Trivial.

**#1 — Use `subkind: 'scheduled-trigger'` to distinguish scheduled task sessions**
SDK v0.3.214 added `subkind: 'scheduled-trigger'` to `task-notification` session events. This directly matches Buildd's `taskSchedules` system — workers spawned by a schedule can now self-identify without parsing the task description. Wire this into `worker-runner.ts` to tag schedule-originated runs in analytics and dashboard display. Effort: Low.

**#2 — Surface `aborted: true` in task timeline for interrupted turns**
SDK v0.3.214: assistant messages truncated by `interrupt()` now carry `aborted: true`. Buildd's task detail page can use this to show a visual "⚠ Interrupted" badge on partial turns, distinguishing them from completed turns. Location: `apps/web/src/app/app/(protected)/tasks/[id]/` and related event rendering. Effort: Low.

**#3 — Show subagent rate-limit retry state in live task view**
SDK v0.3.214: `subagent_type` and `subagent_retry` fields on `tool_progress` messages. When a subagent is waiting out an API rate-limit retry, Buildd can surface this as "⏳ subagent retrying (429)" instead of appearing frozen. Helps users understand long-running tasks vs stuck tasks. Effort: Low.

**#4 — Track `timedOutAfterMs` on Bash outputs for performance analysis**
SDK v0.3.210: `BashToolOutput.timedOutAfterMs` set when a command is auto-backgrounded. Buildd could capture this in task metadata to surface commands that consistently time out, helping workspace admins identify slow scripts. Effort: Low.

**#5 — Warning: Add Fable 5 credit-burn notice to role cards**
Free period ended July 19. Pro/Standard users now burn usage credits at $10/$50/MTok when using `claude-fable-5` roles. Add a visible warning badge on role cards using Fable 5 for these plan tiers. Location: `apps/web/src/app/app/(protected)/team/page.tsx`, role card component. Effort: Low.

**#6 — Adopt `USAGE_LIMIT_ERROR_PREFIXES` for rate-limit error classification**
SDK v0.3.211 exports `USAGE_LIMIT_ERROR_PREFIXES` and siblings (`@alpha`). Buildd's worker-runner currently hand-matches rate-limit error strings. Replace with the official prefix list to stay in sync with new rate-limit message formats as Anthropic evolves them. Location: `packages/core/worker-runner.ts`. Effort: Low.

**#7 — Enforce subagent spawn cap in Buildd mission config**
CLI v2.1.212 added per-session subagent spawn cap (default: 200). For Buildd's cost-control use case, exposing this cap in mission settings would let workspace admins bound the blast radius of a single mission run. Pair with the existing `maxConcurrentTasks` setting. Effort: Low–Medium.

**#8 — Use `/fork` pattern for mission branching (new CLI v2.1.212)**
`/fork` creates a background session copy while the current session continues. This maps well to Buildd's mission orchestrator pattern — an organizer can fork a session mid-task to explore an alternative approach without blocking the main branch. Relevant for the orchestrator design in `apps/web/src/lib/orchestrator-workspace.ts`. Effort: Medium.

**#9 — Add `SDKAssistantMessage.timestamp` to task event timeline**
SDK v0.3.211 adds ISO-8601 timestamps on assistant messages in the live stream. Buildd can use these for precise per-message timing in the task detail timeline, enabling latency analysis (time from tool call to response). Effort: Low.

**#10 — Upgrade Python SDK to v0.2.123**
Python SDK now at v0.2.123 (bundled CLI v2.1.215). If Buildd has any Python worker integrations or uses the Python SDK in tooling, bump to pick up the argv bug fixes in v0.2.121. Effort: Trivial.

### Still Relevant (From Previous Weeks)

**#11 — Use `agentProgressSummaries` for live task visibility**
New in v0.3.162+: periodic AI-generated progress summaries on `task_progress` events. Still valid; workers on v0.3.168 already have this. Surface these summaries on the Buildd task detail page.

**#12 — Security Guidance Plugin for code-writing roles**
3-layer security review (pattern scan + LLM diff review + commit review). Add to default Builder role config. Requires CLI v2.1.144+.

**#13 — OpenTelemetry worker observability**
W3C trace context propagation now built-in. Set `CLAUDE_CODE_ENABLE_TELEMETRY=1` in workers. OTel `workflow.run_id`/`workflow.name` attributes (new in v2.1.202) also enable reconstructing entire workflow runs from telemetry data.

**#14 — `SessionStore` for transcript persistence**
Consider storing task session transcripts in R2/Neon via the new `sessionStore` alpha option. Feeds the memory system and enables task replay.

**#15 — Leverage `getSessionMessages()` for task post-mortems**
Use transcript data for pattern extraction and memory system feeding.

**#16 — Dynamic Workflows compatibility decision**
Still needs a product decision: should Buildd workers be allowed to spawn Dynamic Workflows (up to 1,000 sub-agents)? Token costs are high. Options: block by default, opt-in per task/mission, or expose "ultracode mode" as a premium feature.

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-07-20 | 0.3.208-0.3.215 | 0.2.121-0.2.123 | 2.1.208-2.1.215 | Fable 5 free period ended (Jul 19), /fork background sessions, subagent spawn cap (200), WebSearch cap (200), MCP >2min auto-background, elapsed-time counter on tool lines, subkind:scheduled-trigger, aborted:true on interrupted turns, subagent_type/retry on tool_progress, USAGE_LIMIT_ERROR_PREFIXES, timedOutAfterMs on Bash, screen reader mode, /verify /code-review now invoke-only, Claude for Teachers, Cowork mobile/web, Memory categorized entries |
| 2026-07-13 | 0.3.169-0.3.207 | SessionStore parity | 2.1.169-2.1.207 | Sonnet 5 default (1M ctx), Fable 5 launch/suspension/return, background subagents non-blocking, Agent Teams simplified, Chrome GA, command_lifecycle frames, parent_agent_id (depth-2+ trees), background_tasks_changed, sessionStore (alpha), /dataviz skill, Manual default permission mode, /doctor enhancements |
| 2026-06-08 | 0.3.160-0.3.168 | 0.2.87+ | 2.1.160-2.1.168 | agentProgressSummaries, reloadPlugins(), fallbackModel, getSettings().applied, cross-session messaging hardening, glob deny rules, Managed Agents GA (Outcomes/Orchestration/Webhooks), Security Plugin GA, rate limits doubled, model retirement June 15 |
| 2026-06-01 | 0.3.159 | 0.2.87 | 2.1.159 | Dynamic Workflows + Ultracode (up to 1,000 subagents), Opus 4.8, billing split June 15, OpenInference OTEL, Python SDK major version bump to 0.2.x, Xcode 26.3 integration |
| 2026-05-27 | 0.3.150-0.3.158 | 0.1.63+ | 2.1.150-2.1.158 | Skills auto-loaded, Opus 4.8 preview, auto mode on Bedrock/Vertex/Foundry, tool_decision telemetry, worktree lifecycle improvements, streaming tool exec GA |
| 2026-04-20 | 0.2.104-0.2.114 | 0.1.54-0.1.63 | 2.1.101-2.1.114 | OTel tracing, getSessionMessages, skills API, native binary, desktop rebuild, subagent transcript helpers |
| 2026-04-13 | 0.2.94-0.2.104 | — | 2.1.93-2.1.101 | Managed Agents launch, security hardening cycle, Vertex AI wizard, Focus view, /team-onboarding, subprocess sandbox |
| 2026-04-06 | 0.2.88-0.2.92 | — | 2.1.88-2.1.92 | startup() pre-warm, terminal_reason, MCP 500K persistence, /powerup, Agent HQ |
| 2026-03-30 | 0.2.80-0.2.87 | — | 2.1.80-2.1.87 | getContextUsage(), taskBudget, --bare, seed_read_state, conditional hooks |
| 2026-03-24 | Pre-0.2.80 | — | Pre-2.1.80 | Agent Teams, Plugin system, V2 TS interface, Worktree support |
