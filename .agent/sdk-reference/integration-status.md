# Claude Agent SDK — Integration Status

**Last updated**: 2026-05-27
**SDK in package.json**: `^0.3.150` (PR #746 open; latest available: `0.3.152`)
**Covered files**: `packages/core/worker-runner.ts`, `apps/runner/src/hook-factory.ts`

---

## Version Pin History

| Date | Version in Buildd | Latest at time | PR |
|------|------------------|----------------|-----|
| 2026-05-27 | ^0.3.150 | 0.3.152 | #746 (open) |
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

### P1 — High Priority

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
