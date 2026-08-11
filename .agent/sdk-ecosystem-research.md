# Claude Agent SDK Ecosystem Research

**Last updated**: 2026-08-10
**Previous scan**: 2026-08-03
**Current SDK version in Buildd**: `^0.3.168` (needs bump to ^0.3.226)
**Python SDK**: v0.2.134 (bundled with CLI v2.1.226)
**Claude Code CLI**: v2.1.226 (released August 8, 2026)

> **Note**: For SDK feature details and integration status, see [sdk-reference/](sdk-reference/).

---

## ⚠️ URGENT: Two Deadlines Still Active

### ~~August 5, 2026: Claude Opus 4.1 API Retirement~~ — DONE

`claude-opus-4-1-20250805` is retired. Verify `packages/core/model-aliases.ts` contains no hardcoded reference (the audit was flagged last week).

### August 17, 2026: Legacy Workbench + Experimental Prompt APIs Retired

**7 days away.** Two items retire on the same date:

1. **Legacy Workbench** (`platform.claude.com/workbench`) — access ends permanently.
2. **Experimental prompt tools APIs** — three endpoints retired with no replacement:
   - `POST /v1/experimental/generate_prompt`
   - `POST /v1/experimental/improve_prompt`
   - `POST /v1/experimental/templatize_prompt`

### August 31, 2026: Claude Sonnet 5 Introductory Pricing Ends

Sonnet 5 reverts from $2/$10 → $3/$15 per MTok on September 1. Update cost estimates and billing alerts.

---

## SDK Releases (August 3 – August 10, 2026)

6 TypeScript SDK releases, 6 Python SDK releases, 6 CLI releases this week.

### TypeScript SDK v0.3.221 – v0.3.226

| Version | Key Changes |
|---------|-------------|
| **v0.3.221** | Improved `skills` option validation with clear error messages for malformed names; fixed external MCP servers not being connected before first turn |
| **v0.3.222** | Fixed `query({ sessionStore, resume })` not carrying user settings into resumed subprocess |
| **v0.3.223** | Added `resumeDropsTurn` option to declare which turn a truncating resume intends to drop; 529 overload result messages now include `api_error_status: 529`; bare headless emits `system/permission_denied` events when tool calls are auto-denied; documented `usage` vs `modelUsage` field distinction |
| **v0.3.224** | Added `crossSessionInbound` and `dialogExpiry` settings for cross-session message security; added `subkind: 'peer-send-message'` to `SDKMessageOrigin`; added `source: 'archive'` plugin config variant (install from HTTPS zip with SHA-256 pinning); added sandbox credential-masking fields (`decode: 'jwt'`, `maskClaims`, `extract`, `awsPairs`, `sigv4`); fixed long project paths resolving to wrong project's session directory |
| **v0.3.225** | Fixed background subagents in headless/SDK sessions never resuming when a background shell or Monitor they left running completed |
| **v0.3.226** | Parity update with CLI v2.1.226 |

### Python SDK v0.2.129 – v0.2.134

| Version | Key Changes |
|---------|-------------|
| **v0.2.129** | **Breaking**: Skill name validation — names with parentheses, commas, control characters, wildcards, leading `/`, or surrounding whitespace now raise `ValueError`; **Security fix**: skill names passed to `--allowedTools` were previously unchecked, allowing injection of extra permission rules via crafted names |
| **v0.2.130–v0.2.134** | CLI bundle bumps only (v2.1.222 → v2.1.226) |

### CLI v2.1.221 – v2.1.226

| Version | Key Changes |
|---------|-------------|
| **v2.1.221** | Focus view for VS Code (collapsible tool-activity summaries with live indicator); `mode: "mask"` sandbox credential file option; `prompt-audit` subcommand for auditing prompts/tool descriptions against older model patterns; security fixes for Bash permission-check bypass in zsh regex conditionals; PowerShell path quote fix; reduce prompt-cache costs |
| **v2.1.222** | Fixed worktree-isolated sessions executing destructive git commands; fixed PreToolUse hook bypass in background agent tasks; fixed stream idle timeout on custom gateway deployments; **removed ultraplan feature**; fixes for org-restricted model aliases, send-message summaries, Bedrock SSO |
| **v2.1.223** | Owner wildcard in marketplace managed settings; model restriction warnings for agents/workflows; `/teleport` hint for cloud sessions; fixed Bash permission-check bypass via crafted commands; security fixes for workflow script dynamic imports and agent `bypassPermissions` gaps; updated auto-compaction behavior for 1M context models |
| **v2.1.224** | **`claude self-hosted-runner`** public beta (Aug 6); archive plugin install from HTTPS zips; **removed 200-subagent spawn cap** (Dynamic Workflows now unbounded); cross-session messaging with `SendMessage` (sessions can now message each other directly); sandbox credential masking; sandbox filesystem deny-rule bypass fix on Linux/macOS; paste-change cancellation confirmation; `ANTHROPIC_BEDROCK_REGION_PREFIX` env var; many fixes for Remote Control, MCP, session directories |
| **v2.1.225** | Gateway spend-limit notifications (names cap, reset time, operator message); workspace trust prompts for `claude agents` in untrusted dirs; Remote Control messaging by session name; fixed cross-session messages undelivered in headless sessions; fixed conversation history corruption on Remote Control resume; improved error handling for `claude self-hosted-runner` |
| **v2.1.226** | Bug fixes and reliability improvements |

---

## New Platform Features (August 3–10, 2026)

### Self-Hosted Runner (Public Beta, August 6)

`claude self-hosted-runner` lets Team/Enterprise orgs run Claude Code cloud sessions on their own compute. Anthropic handles auth and session routing; actual execution runs on customer machines.

- **Two modes**: Fixed (constant pool) or On-demand (orchestrator starts/stops runners as sessions queue)
- **Setup**: Write environment secret to file, run `claude self-hosted-runner --environment-secret-file=<path> --base-dir=<path>`
- **Who it's for**: Teams whose network, tooling, or compliance requirements require agent execution on their own infra

**Relevance for Buildd**: This is a direct alternative to Buildd's workers for orgs that want cloud-session experience without Anthropic's compute. Buildd's value proposition shifts: we coordinate tasks across sessions (including self-hosted ones), provide observability, mission orchestration, and cost controls that `claude self-hosted-runner` alone doesn't offer.

### Cross-Session Messaging (CLI v2.1.224 / TS SDK v0.3.224)

Sessions can now message each other directly via `SendMessage`. Key security model:
- Messages to a session running with bypassed permissions → held for approval dialog
- `crossSessionInbound` setting controls whether to auto-deliver or require approval
- `dialogExpiry` (default 5 min) drops a held message if left unattended
- Remote Control can now target a session by name (v2.1.225)

**Relevance for Buildd**: Buildd already provides session messaging via `send_agent_message` at the platform level. The native CLI feature means workers could now communicate peer-to-peer without going through Buildd's API — relevant for designing mission orchestration where workers collaborate directly.

### Inference Hooks for Enterprise DLP (August 5)

Anthropic launched inference hooks (Enterprise beta) — every prompt is routed to the org's security server for allow/deny before reaching the model.

- Integrates with Zscaler, Palo Alto Networks, Netskope, Proofpoint
- Covers chat, Claude Code, and Cowork sessions from a single org-level config
- Response-side enforcement planned (not yet available — current hook is prompt-only)
- 5-second timeout; Anthropic waits for verdict before generating

**Relevance for Buildd**: For enterprise Buildd deployments, positioning alongside inference hooks is a compliance story. Workers can operate within a perimeter where every task prompt passes org DLP rules before execution.

### Subagent Spawn Cap Removed (CLI v2.1.224)

The 200-subagent cap introduced in June is gone. Dynamic Workflows are now unbounded in subagent count (total agent count cap of 1,000 per workflow still enforced by the Workflow tool harness on Buildd's side).

### `system/permission_denied` Events in Bare Headless (TS SDK v0.3.223)

When tool calls are auto-denied in bare headless/SDK sessions, the session now emits `system/permission_denied` stream events. Previously, Buildd's task timeline saw silent gaps where permission-denied tool calls simply didn't appear. These events allow surfacing denials as explicit timeline entries.

### `sandbox.filesystem.disabled` Setting

New setting to skip filesystem isolation while keeping network egress control. Useful for roles where filesystem isolation causes friction (e.g., build tools that need to read/write outside the project dir) but network control is still required.

---

## Anthropic Business News (August 3–10, 2026)

- **IPO**: Confidential S-1 filed June 1. October listing targeted; prediction markets now forecast median listing date of November 30, 2026. Valuation: $965B.
- **Claude Design**: Design tool for branded decks, landing pages, prototypes, one-pagers in one conversational interface — exports to PDF, PPTX, Canva, HTML, handoff to Claude Code.
- **Claude for Government (Public Beta)**: FedRAMP High environment with Claude Code + Cowork for U.S. federal/state/local agencies. Launched July 7. Available at claude.com/solutions/government.
- **Inference Hooks**: Enterprise DLP beta (see above).
- **AI for Science Grants**: Up to $50,000 in Claude credits for rare genetic disease researchers.

---

## Recommendations for Buildd

### This Week (August 10, 2026)

**#0 — Bump SDK to ^0.3.226 / Python to ^0.2.134**
Six TS SDK releases and six Python SDK releases this week. Most Python releases are CLI bundle bumps, but v0.2.129 contains a breaking skill-name validation change and a security fix. Location: `packages/core/package.json`. Effort: Trivial.

**#1 — Fix Python SDK skill-name injection (v0.2.129 security fix)**
If any Buildd code path builds `ClaudeAgentOptions(skills=[...])` from user-supplied role slugs or tool names, upgrade to v0.2.129 immediately. Prior versions passed names unchecked into `--allowedTools`, allowing injection of extra permission rules via crafted names. Location: `packages/core/worker-runner.ts`. Effort: Trivial (upgrade); Low (audit for user-controlled skill names).

**#2 — Use `system/permission_denied` events for task timeline (TS SDK v0.3.223)**
Bare headless sessions now emit `system/permission_denied` stream events when tool calls are auto-denied. Buildd's task event timeline can now show explicit "permission denied" entries instead of silent gaps. Map to a new `tool_denied` event type in the task feed. Location: `packages/core/worker-runner.ts`, `apps/web/src/app/api/workers/[id]/route.ts`. Effort: Low.

**#3 — Add `resumeDropsTurn` to Buildd's interrupt/resume flow (TS SDK v0.3.223)**
When a Buildd worker is interrupted mid-turn and then resumed, the resume can now declare which turn to drop via `resumeDropsTurn`. This avoids replaying a partial assistant turn that was cut off by interrupt, producing cleaner session state. Location: `packages/core/worker-runner.ts` (resume logic). Effort: Low.

**#4 — Investigate `claude self-hosted-runner` as a Buildd Enterprise deployment mode**
The self-hosted runner lets enterprise customers keep agent execution on their own infra while Buildd coordinates tasks. This could be a strong enterprise upsell story: "Buildd + self-hosted runners = full task coordination on your compute." Evaluate: can Buildd workers be deployed as self-hosted runner pools? Product decision needed. Effort: Medium (investigation).

**#5 — Add `crossSessionInbound`/`dialogExpiry` to role config schema**
With native cross-session messaging now available, workers with `bypassPermissions` will receive peer messages held for approval. Buildd's role config should expose `crossSessionInbound` (auto-deliver vs. require approval) and `dialogExpiry` so workspace admins can tune this. Location: `apps/web/src/lib/role-config.ts`, role schema in `packages/shared/src/types.ts`. Effort: Low.

**#6 — Expose `sandbox.filesystem.disabled` in role configuration**
New setting allows skipping filesystem isolation while keeping network egress control. Add to role config schema alongside `sandbox.network.strictAllowlist` for a complete sandbox posture panel. Location: `apps/web/src/lib/role-config.ts`. Effort: Low.

**#7 — Surface `api_error_status: 529` in task error UI (TS SDK v0.3.223)**
Result messages for repeated 529 overload failures now carry `api_error_status: 529`. Buildd's task error display can show a dedicated "Anthropic overloaded" state with retry guidance instead of a generic error. Location: task detail view. Effort: Low.

**#8 — Add archive-source plugin install to workspace skill setup**
v2.1.224 allows installing plugins from HTTPS-hosted zips without git or npm, with SHA-256 pinning. This could simplify distributing private Buildd skills that aren't on npm — just host a zip and reference it with a hash. Update the skill registration UI to support `source: 'archive'` as a plugin source type. Location: `apps/web/src/app/app/(protected)/team/`. Effort: Medium.

**#9 — Update workspace Sonnet 5 billing forecast before August 31**
Sonnet 5 standard pricing ($3/$15/MTok) takes effect September 1. Any Buildd workspace budget forecast or cost-estimate that was set against the $2/$10 intro rate needs updating. Affects the budget forecast card (HealthClient.tsx). Effort: Low.

### Still Relevant (From August 3, 2026)

**#10 — Update model-tier config for Claude Opus 5** (see prior week)
**#11 — Use `tool_result_meta` for denied/interrupted tool classification** (SDK v0.3.216)
**#12 — Wire `cancel_queued` to interrupt endpoint** (SDK v0.3.219)
**#13 — Fix billing accuracy with `canonicalModel` + `provider`** (SDK v0.3.218)
**#14 — Surface `fast_mode_disabled_reason` in role/task UI** (SDK v0.3.219)
**#15 — Add `terminal_reason` to task completion payload** (Python v0.2.126)
**#16 — Expose subagent depth and concurrency caps in mission/role config** (SDK v0.3.217)
**#17 — Adopt `sandbox.network.strictAllowlist` for locked-down roles** (SDK v0.3.219)
**#18 — Evaluate `codebase-memory-mcp` for token reduction** (32K-star project)
**#19 — Adopt mid-conversation tool changes beta for dynamic tool config** (Fable 5/Opus 5)

### Still Relevant (Older)

**#20 — Use `agentProgressSummaries` for live task visibility** (v0.3.162+)
**#21 — OpenTelemetry worker observability**
**#22 — `SessionStore` for transcript persistence** (alpha)
**#23 — Dynamic Workflows compatibility decision** (now truly unbounded — cap removed)

---

## Platform: `agent-memory-2026-07-22` Header Now in Effect

On July 22, 2026, `managed-agents-2026-04-01` adopted the same list behavior as `agent-memory-2026-07-22`. This means:

- Memory listing (`GET /v1/memory_stores/{id}/memories`) now returns a stable server-defined order
- `order_by` and `order` params are ignored
- `depth` accepts only `0`, `1`, or omitted (other values → 400)
- `path_prefix` must end with `/` and matches whole path segments (not substrings)
- Page cursors issued without the header are no longer valid with it — restart from first page when adopting

**SDK versions that send the new header automatically**: Python 0.116.0, TypeScript 0.110.0, CLI 1.16.0. Sending both `managed-agents-2026-04-01` AND `agent-memory-2026-07-22` returns a 400 — don't stack them.

**Buildd action**: If Buildd adds Managed Agent memory store integration, use the new header from the start. If any existing code explicitly passes `managed-agents-2026-04-01` on memory calls, replace it with `agent-memory-2026-07-22`.

---

## Security: Anthropic Cybersecurity Evaluation Incident Disclosure (July 30, 2026)

Anthropic disclosed that three of its AI models — Opus 4.7, Mythos 5, and an internal research model — accessed real company systems during internal cyber capability evaluations. The earliest incident was April 2026.

**Root cause**: A misconfiguration between Anthropic and its evaluation partner (Irregular). The models were instructed they were in simulated environments without internet, but internet access was inadvertently left enabled.

**Impact**: Models exploited weak passwords and unauthenticated services (not zero-days). No lasting harm, no confirmed sensitive data exfiltration.

**Anthropic framing**: "closer to a harness and operational failure than a model alignment failure" — the models behaved according to their instructions; the instructions were wrong about the environment.

**Relevance for Buildd**: Workers executing code or running security-adjacent tasks in eval/test contexts must have proper sandbox isolation. The incident validates Buildd's bwrap sandboxing work (CBM-3). Ensure that eval-mode workers don't have unintended network access paths; the `sandbox.network.strictAllowlist` (added in CLI v2.1.219) is the right control here.

---

## Ecosystem: Agent Client Protocol (ACP) Goes Mainstream

ACP is a JSON-RPC 2.0 standard created by Zed Industries (August 2025, registry co-launched with JetBrains January 2026). It solves the N×M problem: instead of each AI agent needing a plugin per editor, agents register once and work anywhere.

**Current status (July 2026)**:
- 38 registered agents (Claude Code, Gemini CLI, Codex, GitHub Copilot, Goose, Cursor, and 32+ others)
- 12+ editor integrations (Zed + JetBrains natively; Neovim, Emacs, VS Code via community plugins)

**Relationship to MCP**: Complementary, not competing. ACP = editor↔agent transport. MCP = agent↔tools. Both run simultaneously in typical setups.

**Claude Agent SDK support**: Via `@agentclientprotocol/claude-agent-acp` adapter (also `@zed-industries/claude-code-acp`). No official first-party Anthropic SDK support yet — community-maintained adapter.

**Relevance for Buildd**: Low urgency, medium strategic interest. If Buildd ever ships a Buildd IDE extension or wants to position workers as "any-editor" agents, ACP is the standard to implement. Worth tracking but no immediate action needed.

---

## Anthropic Business News (July 27–August 3, 2026)

### IPO Roadshow in Progress
Pre-roadshow investor meetings began July 15. Public S-1 filing expected August–September 2026, with pricing potentially October–November. Buildd operates at Anthropic's API tier — IPO timing may affect enterprise pricing and partnership terms.

### Position on Open-Weights Models (July 27)
Anthropic published its formal stance on open-weights AI. Summary: Anthropic continues to prioritize safety over open-weights release speed; maintains closed-weights strategy for frontier models. Strategic continuity — no change to SDK access model.

### Cognizant Partnership Expansion (July 27)
Cognizant and Anthropic expanded their enterprise partnership to bring Claude to enterprise clients. Broadens Claude Code's enterprise addressable market.

---

## New Ecosystem Projects (Since July 27, 2026)

| Project | Stars | Description |
|---------|-------|-------------|
| **OpenCode** (sst/opencode) | 161K+ | Leading open-source alternative to proprietary coding agents; runs in terminal, desktop, IDE. Built by SST creators. |
| **OpenClaw** | 188K | Open-source computer-use platform (Claude API wrapper); 565+ community skills, Google Workspace integration, persistent memory. Fastest-growing repo in the ecosystem. |
| **Mem0** | 55.7K | Universal self-improving memory layer for AI agents — stores compressed session memories across model providers. |
| **claude-agent-acp** | — | Community adapter: Claude Agent SDK ↔ Agent Client Protocol. Enables Claude workers in Zed, JetBrains, etc. |

---

## Recommendations for Buildd

### This Week (August 3, 2026)

**#0 — URGENT: Verify `claude-opus-4-1` is not used anywhere** (retires TODAY)
Run `grep -r 'opus-4-1' packages/ apps/`. Check `packages/core/model-aliases.ts`, role configs, and any hardcoded model strings in mission templates. Migration: `claude-opus-4-8`. Effort: Trivial. Deadline: TODAY.

**#1 — Audit use of experimental prompt APIs before August 17**
Check for any Buildd code calling `/v1/experimental/generate_prompt`, `/v1/experimental/improve_prompt`, or `/v1/experimental/templatize_prompt`. These retire August 17 with no replacement. If used for skill generation or task template tooling, remove or replace before then. Effort: Low. Deadline: August 17.

**#2 — Add Sonnet 5 pricing sunset alert to dashboard** (August 31 deadline)
Sonnet 5 introductory rate ($2/$10/MTok) ends August 31. Buildd role cards and cost estimates that cite Sonnet 5 pricing should show a "Rate changes Sep 1" notice. New rate: $3/$15. Effort: Low. Deadline: August 31.

**#3 — Update memory store integration to use `agent-memory-2026-07-22` header**
If Buildd adds Managed Agent memory store integration, use the `agent-memory-2026-07-22` header from the start — not the legacy `managed-agents-2026-04-01`. SDK 0.110.0+ sends it automatically. Effort: Trivial (new integration only).

**#4 — Use `sandbox.network.strictAllowlist` for security-critical roles**
The Anthropic cybersecurity eval incident (July 30) reinforces that unintended network access in agentic contexts is a real risk. For high-security or cost-sensitive Buildd roles, `sandbox.network.strictAllowlist` (CLI v2.1.219) is the right posture — positive allowlist that denies all non-listed hosts without prompting. Effort: Low. Already in previous recommendations (#8 from July 27).

### Still Relevant (From July 27, 2026)

**#5 — Bump SDK to ^0.3.220** (#0 from last week)
**#6 — Update model-tier config for Claude Opus 5** (#1 from last week)
**#7 — Use `tool_result_meta` for denied/interrupted tool classification** (#2)
**#8 — Wire `cancel_queued` to Buildd's interrupt endpoint** (#3)
**#9 — Fix billing accuracy with `canonicalModel` + `provider`** (#4)
**#10 — Surface `fast_mode_disabled_reason` in role/task UI** (#5)
**#11 — Add `terminal_reason` to task completion payload** (#6)
**#12 — Expose subagent depth/concurrency caps in role config** (#7)
**#13 — Evaluate `codebase-memory-mcp` for token reduction** (#9)
**#14 — Adopt mid-conversation tool changes beta for dynamic tool config** (#10)

---

## MAJOR: Claude Opus 5 (July 24, 2026)

**API ID**: `claude-opus-5` — new default Opus model in Claude Code as of v2.1.219.

| Spec | Value |
|------|-------|
| Context window | 1M tokens |
| Max output | 128K tokens |
| Pricing (input/output) | $5 / $25 per MTok — identical to Opus 4.8 |
| Fast mode | 2× price, 2.5× speed |
| Knowledge cutoff | May 2026 |
| Availability | Claude API, Bedrock, Google Cloud, Microsoft Foundry |

**Benchmarks** (vs predecessors):
- **Frontier-Bench**: Doubles Opus 4.8's score; surpasses all competitors
- **CursorBench 3.2**: Within 0.5% of Fable 5 at half the cost
- **ARC-AGI 3**: 3× next-best model on novel problem-solving
- **OSWorld 2.0**: Exceeds Fable 5 at ~⅓ the cost

**Breaking API changes** (affects Buildd model-tier config):
- `xhigh` or `max` effort + `thinking: {type: "disabled"}` → 400 error. Thinking is mandatory at xhigh/max effort.
- Opus 4.7 fast mode removed — requests targeting Opus 4.7 in fast mode now error (no fallback).
- Effort level is now the primary control mechanism (not temperature/top_p).

**Positioning**: Start with Opus 5 for most premium work. Escalate to Fable 5 only when tasks justify 2× the token cost. Opus 5 has no data-retention requirement (Fable 5 requires 30 days).

---

## SDK Releases (v0.3.216 - v0.3.220) — July 20–25, 2026

### TypeScript SDK v0.3.220 (July 25, 2026) — current latest
- **Parity**: Updated to parity with Claude Code v2.1.220

### TypeScript SDK v0.3.219 (July 24, 2026)
- **New**: Opt-in `cancel_queued` on interrupt control request — cancels queued/pending-dispatch messages alongside the abort. Capability: `interrupt_cancel_queued_v1`
- **New**: `fast_mode_disabled_reason` on result and init messages — SDK hosts can explain to users why fast mode is off
- **New**: `DirectoryAdded` lifecycle hook event on control protocol — fires when `/add-dir` registers a new working directory mid-session
- **New**: `sandbox.network.strictAllowlist` in SDK settings types — deterministically denies non-allowlisted hosts in sandboxed commands
- **New**: `workflowSizeGuideline` in SDK settings types — advisory dynamic-workflow size control
- **Fixed**: Initialize response reporting stale `fast_mode_state` from spawn-time model after a model switch

### TypeScript SDK v0.3.218 (July 22, 2026)
- **New**: `SkillToolOutput.background: true` when a forked skill was dispatched as a detached background agent
- **New**: `canonicalModel` and `provider` on each `modelUsage` entry in result messages — downstream billing can look up the correct rate table for `costUSD`
- **Fixed**: Result event's `api_error_status` was null for 429/529 errors delivered mid-stream; now correctly reports 429/529

### TypeScript SDK v0.3.217 (July 21, 2026)
- **Changed**: Subagent spawn depth cap default changed — v0.3.217 initially set cap to 1 (no nested subagents by default); CLI v2.1.219 revised to depth 3. Set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to override.
- **New**: Concurrent subagent cap added: default 20, override with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
- **Fixed**: Remote Control sessions not re-sending pending permission prompts to clients that connect after the prompt appeared

### TypeScript SDK v0.3.216 (July 20, 2026)
- **New**: `skippedLinks` count in `rewindFiles` responses — tracks paths refused by rewind safety guards
- **New**: `tool_result_meta` sidecar on user messages — exposes `non_execution_kind` and `user_feedback` fields, letting consumers classify denied/interrupted/cancelled tool calls without string-matching the result prose
- **New**: `user_message_uuid` and `request_sent_wall_ms` on success result messages — enables cross-host request-latency correlation

### Python SDK (July 20–25, 2026)
- **v0.2.128** (July 25): Bundled CLI updated to v2.1.220
- **v0.2.127** (July 24): **Critical bug fix** — `query()` no longer closes stdin on the first `result` frame when background tasks are still running. Previously caused SDK-MCP tool calls from background tasks to fail with `"Stream closed"` and silently bypassed PreToolUse hooks
- **v0.2.126** (July 22): `ResultMessage.terminal_reason` — typed enum why query loop ended (`"completed"`, `"max_turns"`, `"aborted_streaming"`, `"aborted_tools"`, etc.); `model_usage` now typed as `dict[str, ModelUsage]` with `canonicalModel` and `provider` fields
- **v0.2.125** (July 21): Bundled CLI v2.1.217
- **v0.2.124** (July 20): **Security** — blocked `.bat`/`.cmd` CLI spawning on Windows (CVE-2024-27980 class); Windows cmd.exe metacharacter rejection for `resume`/`session_id` values; dash-prefixed `extra_args` now use `--flag=value` form; bundled CLI v2.1.216

---

## Claude Code CLI Releases (v2.1.216 - v2.1.220) — July 20–25, 2026

### v2.1.220 (July 25, 2026) — current latest
- Parity release with SDK v0.3.220

### v2.1.219 (July 24, 2026)
- **New**: Claude Opus 5 (`claude-opus-5`) introduced as the default Opus model; `/model` picker shows "Opus (1M context)"
- **New**: `sandbox.network.strictAllowlist` — deny non-allowlisted hosts without prompting (stronger than `deniedDomains`)
- **New**: `DirectoryAdded` hook fires after `/add-dir` registers new working directories
- **New**: `workflowSizeGuideline` setting — configurable advisory dynamic-workflow size
- **New**: Nested subagent forwarding in stream-json for depth-2+ subagents when `--forward-subagent-text` is set
- **Changed**: Subagent spawn depth 3 by default; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to override
- **Changed**: Opus 4.7 removed from fast mode — `/fast` now applies to Opus 5 and Opus 4.8 only
- **Fixed**: `claude -p` text output dropping answers on mid-stream API errors

### v2.1.218 (July 22, 2026)
- **New**: `/code-review` now runs as a background subagent (conversation stays clean)
- **New**: Screen reader announcements for text deletions (`Option+Delete`, `Ctrl+W`)
- **Fixed**: Windows path corruption — `\u`-prefixed segments no longer convert to CJK characters
- **Fixed**: `/ultrareview` accepts descriptive arguments (e.g., "review my auth changes")
- **Fixed**: Multi-line paste collapsing in terminals encoding newlines as Ctrl+J
- **Improved**: Auto-mode dangerous-rm and suspicious-path checks no longer open permission dialogs

### v2.1.217 (July 21, 2026)
- **New**: Emoji shortcode autocomplete (`:heart:` → ❤️) with `emojiCompletionEnabled` setting toggle
- **New**: Warnings for failing transcript writes and disabled session saving
- **Fixed**: Windows auto-update now auto-restores missing `claude.exe`
- **Fixed**: Background session isolation: symlinked directories canonicalized to prevent escape
- **Fixed**: Auto-compact never triggering for Opus 4.8 on Bedrock
- **Fixed**: Corporate mTLS, TLS, OAuth scope, and proxy settings now honored in Desktop sessions
- **Security**: Managed settings no longer allow telemetry redirection via lower-scope overrides
- **Security**: Brace expansion in CLAUDE.md/SKILL.md budgeted to prevent OOM-kill

### v2.1.216 (July 20, 2026)
- **New**: `sandbox.filesystem.disabled` setting — skip filesystem isolation while maintaining network controls
- **New**: `/context` shows explicit warning when conversation exceeds context window
- **Performance**: Fixed quadratic message normalization slowdown in long sessions (multi-second stalls eliminated)
- **Performance**: Reduced per-tool-call CPU overhead via tool-pool assembly caching
- **Fixed**: Auto mode no longer denies commands with "HTTP 401" after OAuth token expiration
- **Fixed**: Resumed background agent sessions restore original agent prompt and tool restrictions
- **Fixed**: Worktree-isolated subagents blocked from redirecting git to shared checkout
- **Fixed (Windows)**: PowerShell 5.1 UTF-16LE file writing incompatibility; Python Unicode errors

---

## Developer Platform Announcements (July 20–27, 2026)

### Claude Managed Agents Enhancements (July 22)
- **New**: Effort levels configurable on agent model settings
- **New**: Webhook lifecycle events for environments and memory stores
- **New**: Sessions seedable with up to 50 initial events — eliminates separate setup calls
- **New**: Thread-level event delta streaming added
- **Changed**: API version field now optional for agent updates

### API Beta Features (July 24)
- **Mid-conversation tool changes** (`mid-conversation-tool-changes-2026-07-01` beta header): Add or remove tools between turns while preserving the prompt cache. Available on Fable 5, Mythos 5, Opus 4.8, and Opus 5.
- **Server-side fallbacks** (`server-side-fallback-2026-07-01` beta header): `"default"` mode applies Anthropic's recommended fallback models by refusal category.
- **`agent-memory-2026-07-22`** beta header: Memory listing now returns a stable server-defined order.
- **API key expiration**: New expiration settings in Claude Console with email reminders before expiry.
- **Trusted Devices for Remote Control Admins** (Team/Enterprise): Verify devices before Remote Control sessions begin.

---

## New Ecosystem Projects (Since July 20, 2026)

| Project | Stars | Description |
|---------|-------|-------------|
| **usestrix/strix** | ~42K | AI penetration testing — behaves like a real security researcher with dynamic testing and PoC validation |
| **DeusData/codebase-memory-mcp** | ~32K | MCP server that indexes functions/classes across 158 languages for structural code queries; reduces token usage significantly |
| **HKUDS/Vibe-Trading** | ~24K | Converts natural language into backtests with 452 pre-built alpha factors |
| **MadsLorentzen/ai-job-search** | ~23K | Job application automation built on Claude Code |
| **JustVugg/colibri** | ~14.7K | Pure-C inference engine running 744B-parameter models on consumer hardware (~25GB RAM) |
| **langchain-ai/openwiki** | ~11.8K | CLI that automatically generates and maintains AI-friendly documentation for codebases |
| **xai-org/grok-build** | ~9.3K | xAI's open-source coding agent CLI — direct Claude Code competitor, Apache 2.0 |
| **Nutlope/hallmark** | ~10K | Design skill: 57 "slop-test" gates + pre-emit self-critique for coding agents |

**Most relevant for Buildd:**
- `codebase-memory-mcp`: 32K stars; could reduce token costs for workers on large codebases — worth evaluating as optional MCP server in role config
- `strix`: AI security pen-testing; complements Buildd's Security Guidance Plugin initiative
- `grok-build`: xAI entering the coding agent CLI market — competitive signal

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

### This Week (July 27, 2026)

**#0 — Bump SDK to ^0.3.220 (was ^0.3.168)**
Latest TS SDK is 0.3.220 (parity with CLI v2.1.220). Python SDK at v0.2.128. The Python v0.2.127 fix (premature stdin closure killing SDK-MCP calls from background tasks) is **critical for any worker using `run_in_background`** — PreToolUse hooks were being silently bypassed. Location: `packages/core/package.json`. Effort: Trivial.

**#1 — Update model-tier config for Claude Opus 5**
`claude-opus-5` (July 24): near-Fable-5 performance at Opus 4.8 pricing ($5/$25/MTok). Breaking: `xhigh`/`max` effort + `thinking: disabled` → 400 error. Opus 4.7 fast mode removed. Actions:
- Update `packages/core/model-aliases.ts` — `opus` alias should point to `claude-opus-5`
- Update `docs/design/model-tiers.md` — Opus 5 is now `premium` default tier; Fable 5 is `premium+` (2× cost)
- Add API guard in worker-runner for Opus 5 xhigh/max effort calls to not pass `thinking: disabled`
Effort: Low.

**#2 — Use `tool_result_meta` for denied/interrupted tool classification in task timeline**
SDK v0.3.216: `tool_result_meta` sidecar on user messages exposes `non_execution_kind` and `user_feedback`. Buildd's task detail timeline currently string-matches result prose to classify cancelled tool calls. Replace with this typed field for correctness and resilience against message format changes. Effort: Low.

**#3 — Wire `cancel_queued` to Buildd's interrupt endpoint**
SDK v0.3.219: opt-in `cancel_queued` on interrupt control request (capability `interrupt_cancel_queued_v1`). Add an optional `cancelQueued=true` query param to `POST /api/workers/[id]/interrupt` — when set, also clears the message queue so queued messages don't execute after interrupt. Effort: Low.

**#4 — Fix billing accuracy with `canonicalModel` + `provider` on model usage**
SDK v0.3.218 / Python v0.2.126: `canonicalModel` and `provider` fields on each `modelUsage` entry in result messages. Buildd's cost tracking in worker outcome processing can use `canonicalModel` to look up the correct rate table instead of inferring from the task's `model` field (which may not match if a fallback fired). Effort: Low.

**#5 — Surface `fast_mode_disabled_reason` in role/task UI**
SDK v0.3.219: `fast_mode_disabled_reason` field on result and init messages. When a Buildd worker runs in fast mode but the CLI disables it (e.g., Fable 5 + wrong plan tier, or Opus 5 at xhigh effort without thinking), surface this reason as a tooltip or badge on the task card. Effort: Low.

**#6 — Add `terminal_reason` to task completion payload**
Python v0.2.126: `ResultMessage.terminal_reason` exposes why the query loop ended (`"completed"`, `"max_turns"`, `"aborted_streaming"`, `"aborted_tools"`). Map these to Buildd task outcomes: `"max_turns"` → task needs loop increase, `"aborted_tools"` → worker encountered permission block. Location: `packages/core/worker-runner.ts`. Effort: Low.

**#7 — Expose subagent depth and concurrency caps in mission/role config**
SDK v0.3.217 / CLI v2.1.219: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) are now available. Add to role `requiredEnvVars` or mission env config so workspace admins can bound blast radius. Pairs with existing `maxConcurrentTasks`. Effort: Low.

**#8 — Adopt `sandbox.network.strictAllowlist` for locked-down roles**
SDK v0.3.219 / CLI v2.1.219: Positive allowlist that denies all non-listed hosts without prompting. Stronger than `deniedDomains` (which is a denylist). For high-security or cost-sensitive roles, this is the right posture. Add to role configuration schema. Effort: Low.

**#9 — Evaluate `codebase-memory-mcp` for token reduction**
32K-star project indexes code structure across 158 languages for structural queries. Workers doing large-codebase tasks currently burn significant tokens re-reading file structure. Adding `codebase-memory-mcp` as an optional MCP in role config could reduce token spend substantially. Investigate: test on a representative Buildd Builder role task. Effort: Medium.

**#10 — Adopt mid-conversation tool changes beta for dynamic tool config**
New API beta (`mid-conversation-tool-changes-2026-07-01`) on Fable 5, Mythos 5, Opus 4.8, Opus 5. Allows adding/removing tools between turns while preserving prompt cache. Relevant for Buildd's role-based tool access model — an organizer could add tools to a running worker session. Requires updating `POST /api/workers/[id]/instruct` to support tool-set changes. Effort: Medium.

**#11 — Seed Managed Agent sessions with initial events (July 22 API)**
Managed Agents now support up to 50 seed events per session — eliminates separate setup calls and reduces time-to-first-turn. Relevant if Buildd adds Managed Agent execution as a backend option. Effort: Low (future work).

### Still Relevant (From July 20, 2026)

**#12 — Use `subkind: 'scheduled-trigger'` to distinguish scheduled task sessions** (SDK v0.3.214)
**#13 — Surface `aborted: true` in task timeline for interrupted turns** (SDK v0.3.214)
**#14 — Show subagent rate-limit retry state in live task view** (SDK v0.3.214)
**#15 — Track `timedOutAfterMs` on Bash outputs for performance analysis** (SDK v0.3.210)
**#16 — Add Fable 5 credit-burn notice to role cards** (Fable 5 free period ended July 19)
**#17 — Adopt `USAGE_LIMIT_ERROR_PREFIXES` for rate-limit error classification** (SDK v0.3.211)
**#18 — Add `SDKAssistantMessage.timestamp` to task event timeline** (SDK v0.3.211)

### Still Relevant (Older)

**#19 — Use `agentProgressSummaries` for live task visibility** (v0.3.162+)
**#20 — Security Guidance Plugin for code-writing roles** (requires CLI v2.1.144+)
**#21 — OpenTelemetry worker observability** (W3C trace context, OTel workflow attributes)
**#22 — `SessionStore` for transcript persistence** (alpha option on `query()`)
**#23 — Dynamic Workflows compatibility decision** (up to 1,000 subagents; product decision needed)

---

## Version History

| Date | SDK Versions (TS) | SDK Versions (Py) | CLI Versions | Key Changes |
|------|-------------------|-------------------|-------------|-------------|
| 2026-08-10 | 0.3.221-0.3.226 | 0.2.129-0.2.134 | 2.1.221-2.1.226 | **`claude self-hosted-runner`** public beta (Aug 6, Team/Enterprise) — own-compute cloud sessions; cross-session messaging native (SendMessage peer-to-peer with crossSessionInbound/dialogExpiry security model); **inference hooks Enterprise DLP** beta (real-time allow/deny per prompt, Zscaler/Palo Alto/Netskope); **200-subagent cap removed** (Dynamic Workflows now unbounded); system/permission_denied events in bare headless; resumeDropsTurn for cleaner interrupt-resume; sandbox.filesystem.disabled setting; archive-source plugin install (HTTPS zip + SHA-256 pin); Python v0.2.129 skill-name injection security fix (breaking: malformed names now ValueError); ultraplan feature removed; Focus view for VS Code; prompt-audit subcommand; gateway spend-limit notifications in CLI |
| 2026-08-03 | 0.3.220 (no new) | 0.2.128 (no new) | 2.1.220 (no new) | **Opus 4.1 retired (Aug 5)**, Workbench+experimental prompt APIs retire Aug 17, Sonnet 5 intro pricing ends Aug 31, agent-memory-2026-07-22 header in effect, Anthropic cybersecurity eval incident (Opus 4.7/Mythos 5 accessed real systems via misconfigured harness), ACP (Agent Client Protocol) reaches 38 agents/12+ editors, OpenCode 161K stars, OpenClaw 188K stars, Anthropic IPO roadshow underway |
| 2026-07-27 | 0.3.216-0.3.220 | 0.2.124-0.2.128 | 2.1.216-2.1.220 | **Claude Opus 5** (Jul 24, $5/$25/MTok, 1M ctx, near-Fable-5 perf), tool_result_meta sidecar, cancel_queued interrupt, fast_mode_disabled_reason, DirectoryAdded hook, canonicalModel+provider on modelUsage, terminal_reason typed, subagent depth cap (default 3, env override), concurrent subagent cap (20), sandbox.network.strictAllowlist, /code-review as background subagent, mid-conversation tool changes beta, server-side fallback beta, Python stdin-closure bug fix (critical: prevented background MCP calls), codebase-memory-mcp (32K stars), grok-build (xAI competitor) |
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
