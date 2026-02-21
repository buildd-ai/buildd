# Claude Agent SDK Ecosystem Research

> Last updated: 2026-02-20
> Purpose: Track how the community uses the Claude Agent SDK and identify features/patterns Buildd should adopt.

## Community Projects Using the SDK

### 1. Agentic Coding Flywheel Setup (Dicklesworthstone)
**What**: Bootstraps a fresh Ubuntu VPS into a complete multi-agent AI dev environment in 30 minutes.
**SDK Features Used**: Multi-agent coordination, Agent Mail MCP server for cross-agent work, advisory file reservations (leases) to prevent agent conflicts, persistent artifacts in git.
**Takeaway for Buildd**: Their Agent Mail MCP concept (inter-agent messaging via file-based leases) is interesting — Buildd already has a richer coordination model, but the "advisory file reservations" pattern could prevent workers from clobbering each other on shared repos.

### 2. ClaudeSwarm (simonstaton)
**What**: Self-hosted platform for running coordinated Claude agent swarms with React UI on GCP Cloud Run.
**SDK Features Used**: Express API managing Claude CLI processes, JWT auth, GCS-synced shared context, kill switch.
**Takeaway for Buildd**: Their **kill switch** (POST /api/kill-switch — blocks all API requests, persists to disk + GCS) is worth noting. Buildd's `abortController` approach is per-worker; a global kill switch would add a production safety net. Also validates the "web dashboard + remote workers" architecture that Buildd uses.

### 3. myclaude (cexll)
**What**: Multi-agent orchestration workflow system with intelligent routing.
**SDK Features Used**: 5-phase feature dev workflow (/do command), multi-agent orchestration (/omo), SPARV workflow (Specify→Plan→Act→Review→Vault), 11 core dev commands, task routing to different backends (codex, gemini, claude) with fallback.
**Takeaway for Buildd**: Their **task routing by type** (default→claude, UI→codex, quick-fix→gemini) with fallback prioritization is a pattern Buildd could adopt — route tasks to different models based on task type or complexity.

### 4. agentic-flow (ruvnet)
**What**: Framework to switch between alternative low-cost AI models in Claude Agent SDK.
**SDK Features Used**: Model switching, deployment patterns for hosted agents.
**Takeaway for Buildd**: Validates demand for multi-model support within agent SDK workflows.

### 5. parruda/swarm (Ruby)
**What**: Ruby gems for general-purpose AI agent systems with persistent memory, semantic search, node workflows.
**SDK Features Used**: SwarmMemory for persistent memory with semantic search, hook-based workflows.
**Takeaway for Buildd**: Their persistent memory with semantic search mirrors Buildd's workspace memory (`buildd_memory`). The node-based workflow system is an interesting alternative to Buildd's linear task model.

## Buildd's Current SDK Usage (What We Do Well)

| Feature | Status | Notes |
|---------|--------|-------|
| V1 Query API | Full | Correct choice for orchestration with CLAUDE.md, plugins, sandbox |
| Hooks (10/12) | Extensive | PreToolUse, PostToolUse, PostToolUseFailure, Notification, PermissionRequest, SessionStart, SessionEnd, PreCompact, TeammateIdle, TaskCompleted, SubagentStart, SubagentStop |
| Agent Teams | Full | Skill delegation, subagent lifecycle tracking |
| In-Process MCP | Full | buildd + buildd_memory tools via createSdkMcpServer() |
| Structured Outputs | Basic | JSON schema when task defines outputSchema |
| File Checkpointing | Enabled | enableFileCheckpointing: true |
| Session Resume | Full | Resume with sessionId + streamInput for multi-turn |
| Cost Tracking | Full | Per-worker budgets, per-model usage breakdowns |
| Rate Limit Detection | Full | SDK v0.2.45+ events + fallback detection |

## SDK Features We Don't Yet Use (Opportunities)

### High Priority
1. **`rewindFiles(messageUuid)`** — Checkpointing is enabled but rewind is never invoked. Could power an "undo" button in the dashboard.
2. **`effort` levels** (`low`/`medium`/`high`/`max`) — Could scale worker effort based on task priority. Quick tasks use `low`, critical bugs use `max`.
3. **`fallbackModel`** — Graceful degradation when primary model hits rate limits. Zero cost to implement.
4. **Dynamic Model Switching** (`setModel()`) — Already tested in E2E but not used in production. Could enable mid-session model escalation (start with Sonnet, escalate to Opus for complex reasoning).

### Medium Priority
5. **`canUseTool` function** — Cleaner separation of permission logic from PreToolUse observability hooks.
6. **Dynamic MCP Server Management** (`reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`) — Runtime tool hot-swap, MCP crash recovery.
7. **`thinking` / Extended Reasoning** — `{ type: 'adaptive' }` or `{ type: 'enabled', budgetTokens: N }` for complex architectural tasks.
8. **Plan Mode Review UI** — Currently plans are auto-approved. Could add dashboard step for human review.
9. **`additionalDirectories`** — Workers accessing shared monorepo packages outside CWD.

### New in v0.2.49
14. **`ConfigChange` hook** — Enterprise security auditing of config changes during worker sessions.
15. **Model capability discovery** (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`) — Runtime feature detection instead of hardcoded model assumptions.
16. **Worktree isolation** (`isolation: "worktree"` on agent definitions) — Subagents in isolated worktrees for parallel-safe work.
17. **Sonnet 4.6 1M context** — Sonnet 4.5 1M being removed; update 1M context beta to target Sonnet 4.6.

### Lower Priority
10. **`forkSession`** — A/B testing agent behavior, branching workflows.
11. **`resumeSessionAt`** — Rewind to specific conversation point.
12. **`setPermissionMode()`** — Dynamic permission escalation mid-session.
13. **`promptSuggestion()`** — SDK v0.2.47 feature for requesting prompt suggestions.

## Patterns From the Community Worth Adopting

### 1. Task-Type Routing (from myclaude)
Route tasks to different models based on task metadata:
- Bug fixes → fast model (Haiku/Sonnet)
- Architecture work → deep model (Opus with thinking enabled)
- UI tasks → model with visual capabilities
- Quick fixes → `effort: 'low'`, budget-limited

### 2. Advisory File Reservations (from ACFS)
Prevent multiple concurrent workers from editing the same files. Could implement as a PreToolUse hook that checks a file-lock table before allowing Write/Edit operations on shared paths.

### 3. Global Kill Switch (from ClaudeSwarm)
Complement per-worker abortController with a workspace-level kill switch that immediately cancels all active workers. Useful for runaway cost or safety scenarios.

### 4. Workflow Phases (from myclaude SPARV)
Specify → Plan → Act → Review → Vault — structured workflow phases that map naturally to:
- Specify = task description
- Plan = permissionMode: 'plan'
- Act = permissionMode: 'acceptEdits'
- Review = structured output with review checklist
- Vault = workspace memory save

### 5. Multi-Provider Fallback (from agentic-flow)
Configure fallback chains: Anthropic → Bedrock → Vertex. SDK supports multi-provider auth natively.

## SDK Changelog Deep-Dive (v0.2.45→latest)

> Analyzed: 2026-02-21
> SDK range: v0.2.45 → v0.2.50 (latest)
> CLI parity: v2.1.45 → v2.1.50
> Note: v0.2.48 was never published.

### Version Timeline

| SDK | CLI | Date | Headline |
|-----|-----|------|----------|
| 0.2.45 | 2.1.45 | Feb 17 | Sonnet 4.6 support, `task_started` message, `Session.stream()` fix, memory improvements |
| 0.2.46 | 2.1.46 | Feb 19 | Parity update only (CLI: orphaned process fix, claude.ai MCP connectors) |
| 0.2.47 | 2.1.47 | Feb 18 | `promptSuggestion()`, `tool_use_id` on task notifications |
| 0.2.49 | 2.1.49 | Feb 19 | `ConfigChange` hook, model capability discovery, permission suggestions, worktree isolation |
| 0.2.50 | 2.1.50 | Feb 20 | `WorktreeCreate`/`WorktreeRemove` hooks, `isolation: worktree` GA, memory leak fixes |

---

### Feature 1: `task_started` System Message (v0.2.45)

**What**: New `SDKTaskStartedMessage` emitted when subagent tasks register. Previously only `task_notification` existed (for completions).

**SDK Surface**: System message with `subtype: 'task_started'`, includes task ID, agent name, and tool_use_id.

**Buildd Status**: **Integrated.** Worker-runner handles `subtype === 'task_started'` in message processing and tracks in `subagentTasks` array.

**Recommendation**: **Skip** — already adopted.

---

### Feature 2: `Session.stream()` Background Task Fix (v0.2.45)

**What**: `Session.stream()` (V2 API) previously returned prematurely when background subagents were still running. Now holds back intermediate result messages until all tasks complete.

**Buildd Status**: **N/A.** Buildd uses V1 `query()` API, not V2 `Session.stream()`. The `query()` API already handled this correctly.

**Recommendation**: **Skip** — V2-only fix, doesn't affect Buildd's V1 integration.

---

### Feature 3: Memory Improvements for Shell Output (v0.2.45)

**What**: RSS no longer grows unboundedly with large shell command output. Buffers are released after processing.

**SDK Surface**: Internal optimization, no API changes.

**Buildd Status**: **Automatic** — benefits come from upgrading SDK version.

**Recommendation**: **Adopt now** (by pinning SDK ≥0.2.45, already done).

---

### Feature 4: `SDKRateLimitInfo` and `SDKRateLimitEvent` Types (v0.2.45 / CLI v2.1.45)

**What**: Typed rate limit status updates emitted during streaming. Includes provider, model, retry-after timing, and limit details.

**SDK Surface**: New types `SDKRateLimitInfo`, `SDKRateLimitEvent` on system messages.

**Buildd Status**: **Integrated.** Worker-runner parses rate limit events and emits `worker:rate_limit` for dashboard display.

**Recommendation**: **Skip** — already adopted.

---

### Feature 5: Claude Sonnet 4.6 Support (v0.2.45)

**What**: SDK supports new Sonnet 4.6 model. Sonnet 4.5 (1M) being phased out of Max plan.

**SDK Surface**: New model ID accepted in `model` option.

**Buildd Status**: **Integrated** in model validation. 1M context beta now targets Sonnet 4.6.

**Recommendation**: **Skip** — already adopted.

---

### Feature 6: `last_assistant_message` on Stop/SubagentStop Hooks (v0.2.47 / CLI v2.1.47)

**What**: Stop and SubagentStop hook inputs now include the agent's final assistant message. Useful for capturing completion summaries without parsing the full transcript.

**SDK Surface**: `last_assistant_message: string | undefined` field on hook input.

**Buildd Status**: **Integrated.** Stop hook captures `last_assistant_message` for completion summary. Documented in integration-status.md as completed.

**Recommendation**: **Skip** — already adopted.

---

### Feature 7: `promptSuggestion()` Method (v0.2.47)

**What**: New `Query` method that returns AI-generated prompt suggestions based on the current conversation context. Useful for "what should I do next?" UX.

**SDK Surface**: `queryInstance.promptSuggestion()` returns `Promise<string[]>`.

**Buildd Status**: **Not integrated.** Local-UI uses its own heuristic-based suggestions stored in `worker.promptSuggestions` rather than the SDK's model-powered feature. Listed as P3 in integration-status.md.

**Adoption opportunity**: Replace heuristic suggestions with model-aware ones. The SDK's version would provide more contextually relevant next-step prompts.

**Trade-off**: Each call costs tokens. Heuristic approach is free. Could offer as opt-in per workspace.

**Recommendation**: **Defer (P3).** Current heuristic approach works. Revisit when dashboard UX gets a next-step prompt feature.

---

### Feature 8: `tool_use_id` on Task Notifications (v0.2.47)

**What**: `task_notification` system messages now include `tool_use_id`, enabling correlation between subagent task completions and the originating tool call.

**SDK Surface**: `tool_use_id: string` field on task notification messages.

**Buildd Status**: **Integrated.** Documented as completed in integration-status.md. Used for subagent lifecycle tracking.

**Recommendation**: **Skip** — already adopted.

---

### Feature 9: `chat:newline` Keybinding Action (v0.2.47 / CLI v2.1.47)

**What**: New configurable keybinding action for multi-line input in interactive mode.

**Buildd Status**: **N/A.** Buildd workers run non-interactively.

**Recommendation**: **Skip** — interactive-only feature.

---

### Feature 10: Custom Agent Model Fix (v0.2.47 / CLI v2.1.47)

**What**: Bug fix — custom agent model field was being ignored in team teammates. Now correctly passes through.

**SDK Surface**: `model` field in agent definitions now works correctly.

**Buildd Status**: **Automatic** — Buildd uses `model: 'inherit'` in skill agent definitions. This fix ensures future per-skill model overrides would work.

**Recommendation**: **Adopt now** — no code changes needed, just ensures correctness on SDK ≥0.2.47.

---

### Feature 11: Plan Mode Preservation After Compaction (v0.2.47 / CLI v2.1.47)

**What**: Bug fix — plan mode state was lost after context compaction, causing agents to exit plan mode unexpectedly during long sessions.

**Buildd Status**: **Automatic** — benefits Buildd's plan-mode-required workers.

**Recommendation**: **Adopt now** (by running SDK ≥0.2.47, already done).

---

### Feature 12: `ConfigChange` Hook Event (v0.2.49)

**What**: New hook fires when configuration files (`.claude/settings.json`, `CLAUDE.md`, etc.) change during a session. Enables enterprise security auditing and optional blocking.

**SDK Surface**:
```typescript
hooks: {
  ConfigChange: [{
    hooks: [(input) => {
      // input.file_path: string — path that changed
      // input.change_type: 'created' | 'modified' | 'deleted'
      return { decision: 'block' | 'allow' };
    }]
  }]
}
```

**Buildd Status**: **Integrated.** Worker-runner registers ConfigChange hook. When `gitConfig.blockConfigChanges === true`, blocks all changes and emits `worker:config_change` event.

**Recommendation**: **Skip** — already adopted.

---

### Feature 13: Model Capability Discovery (v0.2.49)

**What**: SDK model info now includes `supportsEffort`, `supportedEffortLevels`, and `supportsAdaptiveThinking` fields. Enables runtime feature detection instead of hardcoded model-to-capability mappings.

**SDK Surface**: Fields on model info returned by `supportedModels()`:
```typescript
{
  supportsEffort: boolean;
  supportedEffortLevels: ('low' | 'medium' | 'high' | 'max')[];
  supportsAdaptiveThinking: boolean;
}
```

**Buildd Status**: **Integrated.** Worker-runner validates effort/thinking settings against model capabilities at startup and emits `worker:model_capabilities` with warnings.

**Recommendation**: **Skip** — already adopted.

---

### Feature 14: Permission Suggestions (v0.2.49)

**What**: When safety checks trigger an ask response, permission suggestions are now populated. Enables SDK consumers to display actionable permission options to users.

**SDK Surface**: Permission suggestions on ask-type responses.

**Buildd Status**: **Not directly relevant.** Buildd workers run in `acceptEdits` or `bypassPermissions` mode. Permission prompts are rare; when they occur, the PermissionRequest hook fires and is logged but not surfaced as user-actionable choices.

**Adoption opportunity**: For workers in `default` permission mode, could surface permission suggestions in the dashboard for human-in-the-loop approval.

**Recommendation**: **Defer (P3).** Low priority since most workers bypass permissions. Revisit if human-in-the-loop permission approval becomes a product feature.

---

### Feature 15: Worktree Isolation for Subagents (v0.2.49 SDK / GA in CLI v2.1.50)

**What**: Subagent definitions can specify `isolation: "worktree"` to run in isolated git worktrees. Prevents file conflicts during parallel subagent work. CLI v2.1.49 added `--worktree` flag; v2.1.50 added `WorktreeCreate`/`WorktreeRemove` hook events.

**SDK Surface**:
```typescript
agents: {
  'my-agent': {
    isolation: 'worktree',  // Each invocation gets its own worktree
    description: '...',
    prompt: '...',
    tools: [...],
  }
}
```

**CLI v2.1.50 additions**:
- `WorktreeCreate` hook: fires when worktree is created, receives `worktree_path`, `branch_name`
- `WorktreeRemove` hook: fires when worktree is cleaned up
- `claude agents` CLI command to list all configured agents

**Buildd Status**: **Partially integrated.** Worker-runner conditionally sets `isolation: 'worktree'` on skill agents when `gitConfig.useWorktreeIsolation === true`. However:
- `WorktreeCreate`/`WorktreeRemove` hooks (v2.1.50) are **not yet registered**
- No custom VCS setup/teardown logic in worktree lifecycle

**Adoption opportunity**:
1. Register `WorktreeCreate` hook to track which worktrees are active, emit dashboard events
2. Register `WorktreeRemove` hook to clean up any worktree-specific state
3. Use worktree path info for better subagent progress tracking

**Recommendation**: **Adopt now (P2).** Register the new worktree hooks to complete the integration. Minimal code change, high observability value.

---

### Feature 16: `background: true` on Agent Definitions (v0.2.49 / CLI v2.1.49)

**What**: Agent definitions can specify `background: true` for persistent background execution. Background agents continue running while the main agent proceeds.

**SDK Surface**:
```typescript
agents: {
  'monitor': {
    background: true,
    description: 'Long-running monitoring agent',
    prompt: '...',
    tools: [...],
  }
}
```

**Buildd Status**: **Documented but not integrated.** Workspace memory has a pattern observation about this feature. Worker-runner does not yet pass `background: true` to agent definitions.

**Adoption opportunity**: Enable background monitoring agents for long-running tasks (e.g., a lint-watcher agent that runs in parallel with the main coding agent).

**Recommendation**: **Defer (P3).** Use case is niche. Revisit when parallel workflow features are prioritized.

---

### Feature 17: `claude agents` CLI Command (v0.2.50 / CLI v2.1.50)

**What**: New CLI command `claude agents` lists all configured agents (from `.claude/agents/` directory and inline definitions).

**Buildd Status**: **N/A.** Buildd workers don't use the CLI interactively.

**Recommendation**: **Skip** — CLI-only, no SDK API surface.

---

### Feature 18: `startupTimeout` for LSP Servers (v0.2.50 / CLI v2.1.50)

**What**: MCP servers of type LSP now support a `startupTimeout` configuration for slow-starting language servers.

**Buildd Status**: **Not relevant currently.** Buildd's in-process MCP server doesn't use LSP transport. Could become relevant if Buildd adds external MCP servers with LSP transport.

**Recommendation**: **Skip** — no current use case.

---

### Feature 19: `CLAUDE_CODE_DISABLE_1M_CONTEXT` Environment Variable (v0.2.50 / CLI v2.1.50)

**What**: New env var to opt out of 1M context window even when using eligible models. Reduces cost at the expense of more frequent compaction.

**Buildd Status**: **Not integrated.** Could be useful for budget-sensitive workspaces.

**Adoption opportunity**: Expose as `gitConfig.disable1MContext` boolean. Workers on tight budgets could reduce cost by forcing standard context windows.

**Recommendation**: **Defer (P3).** Niche cost optimization. Existing `maxBudgetUsd` already controls spend.

---

### Feature 20: Opus 4.6 Fast Mode with 1M Context (v0.2.50 / CLI v2.1.50)

**What**: Opus 4.6 in fast mode now includes the full 1M context window (previously limited).

**Buildd Status**: **Automatic** — Buildd workers using Opus 4.6 benefit immediately.

**Recommendation**: **Skip** — automatic benefit from SDK upgrade.

---

### Feature 21: Agent Teams Memory Leak Fixes (v0.2.50 / CLI v2.1.50)

**What**: Multiple memory leak fixes:
- Completed teammate tasks now garbage collected
- Completed task state objects removed from AppState
- LSP diagnostic data cleaned up
- File history snapshots cleaned up
- Internal caches cleared after compaction

**Buildd Status**: **Critical for long-running workers.** These fixes address memory growth during extended agent team sessions — exactly the scenario Buildd workers encounter.

**Adoption opportunity**: Upgrade SDK to ≥0.2.50 to benefit from all memory fixes. This is the single most impactful operational improvement in the range.

**Recommendation**: **Adopt now (P1).** Upgrade SDK dependency to ≥0.2.50. Long-running workers with subagents will see significantly reduced memory usage.

---

### Feature 22: `WorktreeCreate` / `WorktreeRemove` Hook Events (v0.2.50 / CLI v2.1.50)

**What**: New hook events for custom VCS setup/teardown when worktrees are created or removed.

**SDK Surface**:
```typescript
hooks: {
  WorktreeCreate: [{
    hooks: [(input) => {
      // input.worktree_path: string
      // input.branch_name: string
      // Custom setup: install deps, copy .env, etc.
    }]
  }],
  WorktreeRemove: [{
    hooks: [(input) => {
      // input.worktree_path: string
      // Cleanup: remove temp files, close connections, etc.
    }]
  }]
}
```

**Buildd Status**: **Not yet registered.** Worker-runner has worktree isolation support but doesn't hook into the lifecycle events.

**Adoption opportunity**:
- `WorktreeCreate`: Log worktree creation, emit dashboard event, run `bun install` in new worktree, copy necessary env files
- `WorktreeRemove`: Clean up worktree-specific state, emit dashboard event for lifecycle tracking

**Recommendation**: **Adopt now (P2).** Completes the worktree isolation story. See Feature 15 for details.

---

### Feature 23: `CLAUDE_CODE_SIMPLE` Mode Improvements (v0.2.50 / CLI v2.1.50)

**What**: Simple mode now fully strips down: disables skills, session memory, custom agents, CLAUDE.md loading, MCP tools, attachments, and hooks. Also now includes file edit tool.

**Buildd Status**: **N/A.** Buildd workers don't use simple mode.

**Recommendation**: **Skip** — no Buildd use case.

---

### Feature 24: claude.ai MCP Connectors Support (v0.2.46 / CLI v2.1.46)

**What**: Support for MCP connectors configured in claude.ai web interface. Allows sharing MCP configurations between web and CLI.

**Buildd Status**: **Not relevant.** Buildd manages its own MCP configuration via `createSdkMcpServer()`.

**Recommendation**: **Skip** — no current use case.

---

### Feature 25: Improved MCP OAuth with Step-Up Auth (v0.2.49 / CLI v2.1.49)

**What**: MCP OAuth authentication now supports step-up auth and discovery caching. Auth failures are cached to prevent repeated slow failures.

**Buildd Status**: **Not directly relevant.** Buildd's MCP server is in-process, no OAuth involved. However, if Buildd adds support for user-configured external MCP servers, this would matter.

**Recommendation**: **Skip** — in-process MCP doesn't use OAuth.

---

### Feature 26: Deferred SessionStart Hook (v0.2.47 / CLI v2.1.47)

**What**: SessionStart hook execution is now deferred during startup, improving non-interactive startup performance.

**Buildd Status**: **Automatic** — Buildd workers benefit from faster startup since they run non-interactively.

**Recommendation**: **Skip** — automatic benefit.

---

### Feature 27: Plugin `settings.json` Support (v0.2.49 / CLI v2.1.49)

**What**: Plugins can now ship a `settings.json` for default configuration, reducing manual setup.

**Buildd Status**: **Not integrated.** Buildd supports plugin paths via `gitConfig.pluginPaths` but doesn't create or manage plugin settings.

**Adoption opportunity**: If Buildd ships its own plugins, they could include default settings.

**Recommendation**: **Defer (P4).** No Buildd-authored plugins exist yet.

---

### Feature 28: `Ctrl+F` to Kill Background Agents (v0.2.49 / CLI v2.1.49)

**What**: Interactive keybinding to kill background agents with two-press confirmation.

**Buildd Status**: **N/A.** Workers are non-interactive.

**Recommendation**: **Skip** — interactive-only.

---

### Feature 29: Non-Interactive Performance Improvements (v0.2.45–v0.2.50)

**What**: Cumulative startup and runtime performance improvements across multiple versions:
- v0.2.45: Removed eager session history loading
- v0.2.47: Deferred SessionStart hook, deferred imports in headless mode
- v0.2.49: Improved non-interactive startup performance
- v0.2.50: Deferred imports for headless mode

**Buildd Status**: **Automatic** — all workers run non-interactively and benefit directly.

**Recommendation**: **Adopt now** (by running SDK ≥0.2.50).

---

### Summary: Adoption Recommendations

#### Adopt Now (P1-P2)

| # | Feature | Version | Priority | Effort | Impact |
|---|---------|---------|----------|--------|--------|
| 21 | Agent teams memory leak fixes | v0.2.50 | **P1** | Pin SDK ≥0.2.50 | Fixes memory growth in long-running workers |
| 15 | `WorktreeCreate`/`WorktreeRemove` hooks | v0.2.50 | **P2** | ~30 lines | Completes worktree isolation observability |
| 29 | Non-interactive perf improvements | v0.2.45–50 | **P2** | SDK upgrade | Faster worker startup |

#### Defer (P3-P4)

| # | Feature | Version | Priority | Rationale |
|---|---------|---------|----------|-----------|
| 7 | `promptSuggestion()` | v0.2.47 | P3 | Heuristic approach works; token cost concern |
| 14 | Permission suggestions | v0.2.49 | P3 | Most workers bypass permissions |
| 16 | `background: true` agents | v0.2.49 | P3 | Niche use case for monitoring |
| 19 | `CLAUDE_CODE_DISABLE_1M_CONTEXT` | v0.2.50 | P3 | Budget already controlled via `maxBudgetUsd` |
| 27 | Plugin `settings.json` | v0.2.49 | P4 | No Buildd plugins exist yet |

#### Skip (No Action Needed)

| # | Feature | Reason |
|---|---------|--------|
| 1 | `task_started` message | Already integrated |
| 2 | `Session.stream()` fix | V2-only; Buildd uses V1 |
| 3 | Memory improvements | Automatic with SDK upgrade |
| 4 | Rate limit types | Already integrated |
| 5 | Sonnet 4.6 | Already integrated |
| 6 | `last_assistant_message` | Already integrated |
| 8 | `tool_use_id` | Already integrated |
| 9 | `chat:newline` | Interactive-only |
| 10 | Agent model fix | Automatic with SDK upgrade |
| 11 | Plan mode compaction fix | Automatic with SDK upgrade |
| 12 | `ConfigChange` hook | Already integrated |
| 13 | Model capability discovery | Already integrated |
| 17 | `claude agents` CLI | CLI-only, no SDK surface |
| 18 | LSP `startupTimeout` | No LSP MCP servers |
| 20 | Opus 4.6 fast 1M context | Automatic |
| 22 | See #15 | Combined with worktree hooks |
| 23 | Simple mode | Not used by workers |
| 24 | claude.ai MCP connectors | In-process MCP only |
| 25 | MCP OAuth step-up | In-process MCP only |
| 26 | Deferred SessionStart | Automatic |
| 28 | Ctrl+F kill agents | Interactive-only |

---

### Breaking Changes

**None identified** in the v0.2.45→v0.2.50 range. All changes are additive. The SDK maintains backward compatibility with existing V1 `query()` usage.

Notable deprecation signals:
- **Sonnet 4.5 (1M context)** removed from Max plan in v2.1.49. Buildd should ensure 1M context beta targets Sonnet 4.6 only.
- **V2 Session API** remains `unstable_v2_*` prefixed — no stability guarantees. Buildd's choice of V1 `query()` remains correct.

---

### Next Steps for Buildd

1. **Bump SDK pin to `>=0.2.50`** — get memory leak fixes (P1)
2. **Register `WorktreeCreate`/`WorktreeRemove` hooks** in worker-runner.ts — emit `worker:worktree_create` and `worker:worktree_remove` events for dashboard observability (P2)
3. **Create tasks** for P3 items when capacity allows
4. **Monitor** for v0.2.51+ — watch for V2 Session API stabilization, new hook events, and structured output improvements

