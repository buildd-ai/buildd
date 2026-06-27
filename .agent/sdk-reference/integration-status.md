# Claude Agent SDK — Integration Status

**Last updated**: 2026-06-27
**SDK in package.json**: `^0.3.195` (up to date)
**Covered files**: `packages/core/worker-runner.ts`, `apps/runner/src/hook-factory.ts`

---

## Version Pin History

| Date | Version in Buildd | Latest at time | PR |
|------|------------------|----------------|-----|
| 2026-06-27 | ^0.3.195 | 0.3.195 | pending |
| 2026-06-18 | ^0.3.181 | 0.3.181 | pending |
| 2026-06-17 | ^0.3.179 | 0.3.179 | #861 |
| 2026-06-16 | ^0.3.178 | 0.3.178 | pending |
| 2026-06-14 | ^0.3.177 | 0.3.177 | #820 |
| 2026-06-11 | ^0.3.173 | 0.3.173 | #818 |
| 2026-06-08 | ^0.3.168 | 0.3.168 | #815 |
| 2026-06-05 | ^0.3.162 | 0.3.162 | pending |
| 2026-06-03 | ^0.3.161 | 0.3.161 | #787 |
| 2026-06-01 | ^0.3.158 | 0.3.159 | #788 |
| 2026-05-30 | ^0.3.158 | 0.3.158 | #785 |
| 2026-05-29 | ^0.3.156 | 0.3.156 | #784 |
| 2026-05-28 | ^0.3.153 | 0.3.153 | #783 |
| 2026-05-27 | ^0.3.150 | 0.3.152 | #746 (superseded) |
| 2026-04-20 | ^0.2.114 | 0.2.114 | — |

---

## Breaking Change Assessment (0.2.114 → 0.3.152)

### v0.3.142 Breaking Changes — **Status: Not affected**

| Breaking Change | Buildd Status |
|----------------|--------------|
| Removed v2 session API (`unstable_v2_*`) | Not used — Buildd uses `query()` |
| MCP non-blocking by default | Monitor: Buildd's MCP usage should still work; `alwaysLoad` available if needed |
| Task tools replace `TodoWrite` | Not affected at SDK level; may affect transcript parsing |
| `@anthropic-ai/sdk` peer ^0.93.0 | PR #746 already updates this |

---

## Enhancement Opportunities

### P0 — CRITICAL (June 15, 2026 — 1 day away)

**Audit for hardcoded model API version strings**
- `claude-sonnet-4-20250514` and `claude-opus-4-20250514` retire June 15; API requests using those strings return errors after that date
- Run: `grep -r '20250514' packages/ apps/` to find all exposure
- Migration: `claude-sonnet-4-20250514` → `claude-sonnet-4-6`, `claude-opus-4-20250514` → `claude-opus-4-8`
- `packages/core/model-aliases.ts` should abstract most of this — verify no strings escaped
- Also check Drizzle migration files or seed scripts that may reference model names

### P0 — URGENT (June 15, 2026)

**Notify users of Agent SDK billing split**
- Buildd workers invoke `claude -p` programmatically — this shifts to new credit pool on June 15
- Credit amounts: $20 (Pro), $100 (Max 5x), $200 (Max 20x), $0 (Enterprise — use API key)
- Action: Dashboard banner for workspace owners, docs update, recommend Enterprise users switch to API key billing
- Location: Dashboard UI, docs, potentially task detail page (credit consumption estimate)

### P2 — Medium Priority (new in 0.3.181)

**Surface `SDKRateLimitInfo` credit fields in task error UX (v0.3.181)**
- New: `errorCode`, `canUserPurchaseCredits`, and `hasChargeableSavedPaymentMethod` added to rate limit events
- Benefit: Buildd can distinguish "API overloaded" from "user out of credits" — show actionable message ("Add credits to resume this task") instead of a generic rate-limit error; conditionally surface a "Purchase credits" CTA
- Location: `packages/core/worker-runner.ts` (rate-limit event handler), task error display in dashboard
- Effort: Low (read new fields from rate-limit messages; thread through to Pusher progress/error event)

**Use `tool_use_meta` for human-readable tool labels + icons in dashboard (v0.3.179/0.3.181)**
- New (v0.3.179): Optional `tool_use_meta` sidecar on assistant messages with display-friendly tool names; New (v0.3.181): also includes `icon_url` per tool call, populated from MCP server directory metadata
- Benefit: Buildd's task detail view could display readable tool labels and MCP tool icons without custom mapping logic
- Location: `packages/core/worker-runner.ts` (message processing loop), dashboard task detail component
- Effort: Low (read `tool_use_meta` from assistant messages including `icon_url`; pass to Pusher progress event)

### P1 — High Priority (new in 0.3.163–0.3.178)

**`Tool(param:value)` syntax for granular permission rules (v0.3.178)**
- New: Permission rules can now match on tool input parameters, e.g. `Agent(model:opus)` to block Opus subagents, `Bash(command:rm*)` to deny `rm`-class commands
- Benefit: Buildd's PreToolUse hook (`apps/runner/src/hook-factory.ts`) could be replaced or augmented with declarative permission rules in role config — less code, more auditable
- Location: `apps/web/src/lib/role-config.ts` (role permission array), `apps/runner/src/hook-factory.ts`
- Effort: Low (add `allowedTools`/`disallowedTools` entries with param syntax; verify hook still needed)

**`fallbackModel` setting for role resilience (v0.3.166)**
- New: Configure up to 3 fallback models tried in order when primary is overloaded or unavailable
- Benefit: Buildd workers could transparently fall back (e.g. Opus → Sonnet) instead of failing, improving task reliability under load
- Location: `apps/web/src/lib/role-config.ts`, worker settings packaging
- Effort: Low–Medium (add `fallbackModel` array to role config and inject into worker settings)

**`Stop`/`SubagentStop` hook `additionalContext` for graceful stop handling (v0.3.163)**
- New: Stop/SubagentStop hooks can return `hookSpecificOutput.additionalContext` to give Claude feedback and keep the turn going without being labeled a hook error
- Benefit: Buildd's hooks could provide structured guidance on stop conditions (e.g. "task limit reached, summarize progress") rather than hard-stopping or erroring
- Location: `apps/runner/src/hook-factory.ts`
- Effort: Low (hook already wired; add return value)

**Sub-agent nesting up to 5 levels deep (v0.3.172)**
- New: Sub-agents can now spawn their own sub-agents (recursive, up to 5 levels)
- Benefit: Buildd's orchestration model can support deeper delegation chains; missions could spawn nested planning → execution → verification agents automatically
- Note: Each sub-session is NOT tracked in Buildd's worker system — decide whether to expose or limit nesting
- Location: Role config, task creation UI, worker-runner.ts
- Effort: Medium (design decision on whether to allow/track/limit)

**Claude Fable 5 (Mythos-class) model in role selection (v0.3.170)**
- New: Fable 5 available as a model option; includes 1M context by default
- Benefit: Add to Buildd's model alias/routing layer for high-capability tasks
- Location: `packages/core/model-aliases.ts`, `packages/core/model-router.ts`
- Effort: Low (add alias entry once model ID is confirmed)

**Use `agentProgressSummaries` for live task progress (v0.3.162+)**
- New: `agentProgressSummaries: true` in SDK `query()` options emits periodic AI-generated summaries from subagents on `task_progress` events via the `summary` field
- Benefit: Buildd task detail page could display live progress updates without workers manually calling `update_progress` — zero instrumentation overhead
- Location: `packages/core/worker-runner.ts` (pass option in query call)
- Effort: Low (one-line SDK option, then surface `summary` in Pusher events / task progress updates)

**Adopt `fallbackModel` for worker reliability (v2.1.160+)**
- New: `fallbackModel` setting configures up to 3 fallback models when the primary is overloaded/unavailable
- Benefit: Fewer failed tasks during capacity spikes; retry on fallback is automatic
- Location: `packages/core/worker-runner.ts`, `apps/web/src/lib/role-config.ts`
- Effort: Low (add to worker settings or role config packaging)

**Add Claude Opus 4.8 to role model selection (v0.3.154)**
- Model ID: `claude-opus-4-8`; better agentic reliability; lower prompt cache minimum (1,024 tokens); mid-conversation system messages; fast mode at 2.5× speed
- **Caveat**: Slightly less robust to agentic prompt injection than 4.7 — document in role creation UI
- Location: `packages/core/model-aliases.ts`, `packages/core/model-router.ts`, default-roles seeding

**Use Opus 4.8 mid-conversation system messages to reduce runner costs**
- Opus 4.8 accepts `role: "system"` messages after user turns — inject updated instructions without restating the full system prompt, preserving cache hits
- Useful for long-running Buildd tasks where instructions evolve (e.g., "you've completed phase 1, now focus on X")
- Location: `packages/core/worker-runner.ts`
- Effort: Medium (requires Opus 4.8 model selection; add mid-turn system injection logic)

**Dynamic Workflows compatibility decision**
- A Buildd worker with Dynamic Workflows enabled will spawn up to 1,000 sub-sessions not tracked in Buildd's worker system
- Decide: allow/block workflows per task/role? Expose "ultracode" as a task option? Capture sub-session artifacts?
- Token cost warning: one session consumed 70% of a 5-hour window in 30 minutes — potentially needs a budget gate in Buildd
- Location: Role config, task creation UI, worker-runner.ts (could block `workflow` keyword or set effort ceiling)
- Effort: Medium (design decision + implementation)

**Skills auto-loaded from `.claude/skills` — validate Buildd skill delivery (v0.3.157)**
- New: Plugins in `.claude/skills` are now auto-loaded without a marketplace entry
- Benefit: Buildd already writes skill files to `.claude/skills/` in worker worktrees; confirm workers pick them up without explicit marketplace config — could simplify the role-config packaging pipeline
- Location: `apps/web/src/lib/role-config.ts`, `.claude/skills/`
- Effort: Low (verify existing behavior; potentially remove marketplace-registration step)

**Support Claude Opus 4.8 model (v0.3.154)**
- New: `claude-opus-4-8` model available; defaults to high-effort reasoning mode
- Benefit: Buildd's model alias/routing layer should recognize and expose this model
- Location: `packages/core/model-aliases.ts`, `packages/core/model-router.ts`, default-roles seeding
- Effort: Low–Medium (add alias entries, test routing)

**Set session title via `SessionStart` hook (v0.3.152)**
- New: `hookSpecificOutput.sessionTitle` in SessionStart response
- Benefit: labels sessions in Claude telemetry/logs with Buildd task ID or task title
- Location: `packages/core/worker-runner.ts` → `sessionStartHook`
- Effort: Low (2-line change)

**Use `MessageDisplay` hook for dashboard streaming (v0.3.152)**
- New: `MessageDisplay` hook fires before assistant messages are displayed
- Benefit: could filter/sanitize output before it reaches the Pusher stream, or add structured markers
- Location: `apps/runner/src/hook-factory.ts`
- Effort: Medium

### P2 — Medium Priority

**`agent` field in `settings.json` for dispatched sessions (v0.3.157)**
- New: Dispatched SDK sessions now respect the `agent` field in `settings.json`; override with `--agent <name>`
- Benefit: Buildd could specify a default role/agent in the worker's settings, enabling role-specific behavior without extra flag passing
- Location: `packages/core/worker-runner.ts`, `apps/web/src/lib/role-config.ts`
- Effort: Low (configure via settings packaging)

**Worktrees unlocked after agent finishes (v0.3.157)**
- New: Claude-managed worktrees are left unlocked after agent completion
- Benefit: Buildd's worktree cleanup (`git worktree remove`/`prune`) should now work without manual unlocking
- Location: Worktree lifecycle management in `apps/runner/`
- Effort: Minimal (verify cleanup scripts work; remove any manual unlock calls if present)

**MCP server `CLAUDE_CODE_SESSION_ID` env var (v0.3.154)**
- New: Stdio MCP server subprocesses receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` in their env
- Benefit: Buildd's MCP server can read this to correlate MCP calls with the SDK session
- Location: `apps/web/src/app/api/mcp/route.ts`
- Effort: Low (read and pass through if needed)

**Skill hot-reload via `reloadSkills` (v0.3.152)**
- New: `SessionStart` can return `reloadSkills: true` to re-scan skills mid-session
- Benefit: allows deploying new skills to running workers without restart
- Location: `packages/core/worker-runner.ts` → `sessionStartHook`
- Effort: Medium (needs a trigger mechanism — e.g., Pusher event or API endpoint)

**Use `origin` on result messages for task-notification routing (v0.2.126)**
- `SDKResultSuccess.origin` distinguishes user-prompted vs `task-notification` followups
- Benefit: cleaner routing logic for background task completions
- Location: `packages/core/worker-runner.ts` → message processing loop
- Effort: Low

**Handle `model_not_found` distinctly (v0.3.144)**
- `error: 'model_not_found'` is now separate from generic `'invalid_request'`
- Benefit: better fallback logic in `discoverModelCapabilities()`
- Location: `packages/core/worker-runner.ts`
- Effort: Low

### P3 — Lower Priority

**Update E2E tests for Task tools (v0.3.142)**
- Agents no longer use `TodoWrite`; they use `TaskCreate`/`TaskUpdate`/`TaskList`
- Any transcript-parsing tests expecting `TodoWrite` should be updated
- Effort: Low, but requires identifying affected tests

**`resolveSettings()` for runner config validation (v0.2.136)**
- Alpha API to inspect effective settings without spawning the CLI
- Could validate worker config before task execution
- Effort: Low, but API is still alpha

**`updatedToolOutput` for PostToolUse hooks (v0.2.121)**
- Replace `updatedMCPToolOutput` calls if any exist
- Effort: Minimal (search for deprecated field)

---

## Deprecated APIs — Action Needed

| API | Deprecated Since | Replacement | Status |
|-----|-----------------|-------------|--------|
| `updatedMCPToolOutput` | v0.2.121 | `updatedToolOutput` | Check hook-factory.ts |
| `'Skill'` in `allowedTools` | v0.2.133 | `skills` option | Check role-config.ts packaging |
| `unstable_v2_*` session APIs | v0.2.133 → **removed** v0.3.142 | `query()` | Not used in Buildd |
| `TodoWrite` tool | v0.2.136 → **replaced** v0.3.142 | `TaskCreate/Update/Get/List` | Internal agent behavior |
