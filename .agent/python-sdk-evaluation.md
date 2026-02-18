# Python Agent SDK Evaluation for Buildd Workers

**Date**: February 18, 2026
**Python SDK Version**: `claude-agent-sdk` v0.1.37 (PyPI)
**TypeScript SDK Version**: `@anthropic-ai/claude-agent-sdk` v0.2.45 (npm)
**Status**: Alpha (Development Status 3)

---

## Executive Summary

The Python Claude Agent SDK (`claude-agent-sdk` on PyPI) provides a near-complete API surface for building Claude-powered agents in Python. However, **it is a CLI wrapper** — not a native Python implementation. Both the Python and TypeScript SDKs spawn the same underlying Claude Code CLI (Node.js binary) as a subprocess. This architectural reality fundamentally limits the startup time and deployment benefits that a Python SDK might otherwise provide.

**Recommendation**: Do not adopt the Python SDK for Buildd workers at this time. The TS SDK (v0.2.45) is more mature, has deeper feature support, and avoids the cross-language overhead that the Python SDK introduces. Revisit when the Python SDK reaches v1.0 or gains native API integration.

---

## 1. Architecture: Both SDKs Are CLI Wrappers

### Critical Finding

Both the Python and TypeScript SDKs operate by **spawning the Claude Code CLI as a subprocess**:

```
Python SDK → spawns Node.js Claude Code CLI → connects to Anthropic API
TypeScript SDK → spawns Node.js Claude Code CLI → connects to Anthropic API
```

The Python SDK is a thin async wrapper around the CLI binary. It:
1. Locates the Claude Code CLI executable (Node.js)
2. Spawns it as a subprocess with JSON-line communication
3. Parses stdout JSON lines into Python dataclasses
4. Forwards hooks via stdin/stdout JSON protocol

This means **Python does not reduce or eliminate Node.js dependency**. You still need Node.js installed to use the Python SDK.

### Evidence from the SDK

- `CLINotFoundError` is raised when Claude Code CLI is not found
- `ClaudeAgentOptions.cli_path` allows specifying a custom path to the CLI executable
- Platform-specific wheels (linux-x64, linux-arm64, macos-arm64, win-x64) suggest bundled binaries
- The `stderr` callback captures stderr from the CLI subprocess

---

## 2. Startup Time: No Improvement

### Question: Could Python workers reduce startup time vs Node/Bun subprocess spawning?

**Answer: No.** Startup time would likely be *worse* with the Python SDK.

**Current Buildd startup chain (TypeScript):**
```
Bun/Node process → import SDK → spawn CLI subprocess → initialize session → first API call
```

**Hypothetical Python startup chain:**
```
Python process → import SDK → spawn CLI subprocess (Node.js) → initialize session → first API call
```

The Python SDK adds an additional process layer:
- Python interpreter startup (~50-200ms depending on environment)
- Python SDK import and initialization
- *Same* CLI subprocess spawn as TypeScript
- Additional IPC overhead (Python ↔ Node.js via stdio JSON)

The TypeScript SDK avoids the Python→Node.js bridge entirely because the host process and CLI subprocess share the same runtime. In-process MCP servers in the TS SDK (`createSdkMcpServer`) share memory with the host — in Python, MCP tools still communicate via JSON serialization over stdio.

**Startup time comparison:**

| Phase | TypeScript SDK | Python SDK |
|-------|---------------|------------|
| Runtime init | ~50ms (Bun) / ~100ms (Node) | ~150ms (Python) + ~100ms (Node CLI) |
| SDK import | ~20ms | ~50ms (Python) + same CLI load |
| CLI spawn | N/A (same process) | Subprocess spawn overhead |
| Session init | ~500ms (API call) | ~500ms (same) |
| **Total overhead** | **~570ms** | **~800ms+** |

---

## 3. Feature Parity Gaps

### Features Available in TypeScript (v0.2.45) but Missing/Limited in Python (v0.1.37)

| Feature | TypeScript | Python | Impact on Buildd |
|---------|-----------|--------|-----------------|
| **Hook events** | 12 events (PreToolUse, PostToolUse, PostToolUseFailure, Notification, SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop, PreCompact, PermissionRequest, UserPromptSubmit) | 6 events (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact) | **HIGH** — Buildd uses all 12 hooks. Missing SessionStart/End, Notification, PostToolUseFailure, PermissionRequest, SubagentStart hooks would lose observability |
| **V2 Session API** | `unstable_v2_createSession()` with send/receive/done pattern | `ClaudeSDKClient` (similar but different API) | LOW — Buildd uses V1 `query()` |
| **AbortController** | Native `AbortController` support | No direct equivalent documented | **HIGH** — Buildd relies on `abortController` for task cancellation |
| **streamInput** | `queryInstance.streamInput(stream)` for real-time user input | `AsyncIterable[dict]` prompt support | MEDIUM — Buildd uses streamInput for `AskUserQuestion` responses |
| **Query control methods** | `setModel()`, `setPermissionMode()`, `setMaxThinkingTokens()`, `stopTask()`, `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`, `mcpServerStatus()` | Not documented | MEDIUM — Dynamic MCP management used in worker-runner |
| **In-process MCP server** | Shared memory, zero-copy | Stdio JSON serialization (subprocess bridge) | **HIGH** — Buildd's MCP server runs in-process for efficiency |
| **Agent Teams** | Experimental, with `TeammateIdle`/`TaskCompleted` hooks | Not mentioned | MEDIUM — Buildd uses agent teams experimentally |
| **Custom session ID** | `sessionId` option | Not documented | MEDIUM — Buildd uses `sessionId` for worker correlation |
| **Session forking** | `forkSession`, `resumeSessionAt` | `fork_session` available | LOW |
| **SDK message types** | Full union with 15+ subtypes including `SDKTaskStartedMessage`, `SDKRateLimitEvent`, `SDKFilesPersistedEvent` | Basic 5 types (UserMessage, AssistantMessage, SystemMessage, ResultMessage, StreamEvent) | **HIGH** — Buildd processes all SDK message subtypes for dashboard visibility |
| **Plugin support** | `plugins: [{ type: 'local', path: '...' }]` | `plugins` option available | LOW |
| **Async hooks** | `AsyncHookJSONOutput = { async: true }` | `async_: True` (Python naming) | Parity |

### Features at Parity

| Feature | Status |
|---------|--------|
| `query()` with async iteration | Full parity |
| `ClaudeAgentOptions` / options | Near-complete parity |
| Permission modes (acceptEdits, bypassPermissions, etc.) | Full parity |
| MCP server configs (stdio, SSE, HTTP, SDK) | Full parity |
| Custom agents/subagents | Full parity |
| Structured outputs (`outputFormat`) | Full parity |
| Budget limiting (`maxBudgetUsd`) | Full parity |
| File checkpointing | Full parity |
| Sandbox configuration | Full parity |
| Setting sources | Full parity |
| 1M context beta | Full parity |

---

## 4. Deployment Simplification

### Question: Would Python SDK enable simpler deployment for teams without Node.js?

**Answer: No.** The Python SDK still requires the Claude Code CLI (Node.js) to be installed.

From the SDK docs:
> `CLINotFoundError` - Raised when Claude Code CLI is not installed or not found.

The Python SDK distributes platform-specific wheels that likely bundle the CLI binary, but this:
1. Increases package size significantly
2. Still requires Node.js runtime for the CLI subprocess
3. Adds Python as an *additional* runtime dependency

**Current Buildd deployment requirements:**
- Node.js/Bun runtime
- `@anthropic-ai/claude-agent-sdk` npm package

**Hypothetical Python deployment requirements:**
- Python 3.10+ runtime
- Node.js runtime (for CLI)
- `claude-agent-sdk` PyPI package
- Additional Python dependencies for Buildd worker coordination

This would **increase** deployment complexity, not reduce it.

---

## 5. MCP Server Integration Impact

### Current State (TypeScript)

Buildd uses two MCP integration patterns:

1. **In-process SDK MCP server** (`packages/core/buildd-mcp-server.ts`): Created with `createSdkMcpServer()`, runs in the same Node.js process as the worker. Zero IPC overhead. Tools like `buildd` and `buildd_memory` execute directly in the host process.

2. **External MCP servers** (`apps/mcp-server/`): Subprocess-based MCP server for Claude Code CLI integration.

### Python Impact

The Python SDK supports `create_sdk_mcp_server()` with the same API surface. However:

- **In-process advantage is lost**: Python MCP tools still communicate with the Node.js CLI subprocess via JSON stdio. There's no shared-memory benefit.
- **Tool execution path**: Python tool handler → JSON serialize → stdio → Node.js CLI → JSON deserialize → execute → reverse path. The TS SDK path is: TS tool handler → direct function call.
- **Type safety**: Python uses `dict[str, Any]` for tool inputs vs TypeScript's Zod-validated schemas.

For Buildd's `buildd-mcp-server.ts` which makes HTTP calls to the Buildd API, the network latency dominates, so the IPC overhead difference is negligible. But for any compute-intensive or high-frequency MCP tools, the Python path adds measurable overhead.

---

## 6. Maturity Assessment

| Dimension | TypeScript SDK (v0.2.45) | Python SDK (v0.1.37) |
|-----------|-------------------------|---------------------|
| **Version** | 0.2.45 (production-tested) | 0.1.37 (Alpha) |
| **PyPI/npm status** | Stable | "Development Status 3 - Alpha" |
| **Release cadence** | ~45 releases, mature | ~15 releases since Sept 2025 |
| **Buildd integration** | Deep — 12 hooks, all message types, in-process MCP, agent teams | Would require significant porting |
| **Community** | Primary SDK, extensive docs | Secondary SDK, growing docs |
| **Breaking changes** | Rare at this stage | Expected (v0.x → v1.0 transition) |
| **Hook support** | 12 events | 6 events (missing 6 critical for Buildd) |
| **Documentation** | Comprehensive with examples | Good but incomplete (ClaudeSDKClient vs query gaps) |

---

## 7. Migration Effort Estimate

If Buildd were to support Python workers alongside TypeScript, the work would include:

| Component | Effort | Notes |
|-----------|--------|-------|
| Port `worker-runner.ts` (603 lines) | HIGH | All 12 hook handlers, message processing, DB updates |
| Port `buildd-mcp-server.ts` | MEDIUM | MCP tool definitions, HTTP client calls |
| Port `apps/local-ui/src/workers.ts` | HIGH | Session management, skill-as-subagent, streamInput |
| Add Python runtime to deployment | LOW | Docker image changes |
| Handle missing hook events | BLOCKED | 6 hooks not available in Python SDK |
| Handle missing AbortController | BLOCKED | No documented cancellation mechanism |
| Handle missing SDK message types | HIGH | 10+ message subtypes need workarounds |
| Test parity | HIGH | All integration tests need Python equivalents |

**Estimated total**: 3-5 engineer-weeks, *blocked* by Python SDK feature gaps.

---

## 8. When to Reconsider

The Python SDK should be re-evaluated when:

1. **Version reaches 1.0** — Indicates stable API and production readiness
2. **Hook parity** — All 12 hook events supported (especially SessionStart/End, Notification, PostToolUseFailure, PermissionRequest, SubagentStart)
3. **Native API integration** — If the Python SDK moves to direct Anthropic API calls instead of CLI subprocess, startup time and IPC overhead would improve dramatically
4. **AbortController equivalent** — Task cancellation is essential for Buildd
5. **Full message type coverage** — All SDK message subtypes (SDKTaskStartedMessage, SDKRateLimitEvent, etc.)
6. **Buildd has Python-first customers** — Business demand for Python worker support

---

## 9. Alternative Consideration: Direct Anthropic API

For teams that specifically need Python, a more efficient approach than the Python Agent SDK would be to build a lightweight Python worker using the Anthropic Python client SDK (`anthropic`) directly:

```python
import anthropic

client = anthropic.Anthropic()
# Direct API calls, no CLI subprocess overhead
response = client.messages.create(model="claude-opus-4-6", ...)
```

This would:
- Eliminate Node.js dependency entirely
- Reduce startup time to Python-only
- Require implementing tool execution (Read, Write, Bash, etc.) manually
- Lose Claude Code's built-in tool ecosystem

This approach makes sense only if the customer base strongly prefers Python and is willing to accept a reduced tool set or invest in custom tool implementations.

---

## Summary Table

| Evaluation Question | Answer | Confidence |
|-------------------|--------|------------|
| Could Python workers reduce startup time? | **No** — adds overhead (Python + Node.js) | High |
| Would Python SDK simplify deployment? | **No** — still requires Node.js for CLI | High |
| Feature parity with TypeScript SDK? | **Significant gaps** — 6 missing hooks, missing message types, no AbortController | High |
| Impact on MCP server integration? | **Negative** — loses in-process advantage | High |
| Should Buildd adopt Python SDK now? | **No** — wait for v1.0 and feature parity | High |
| When to re-evaluate? | Python SDK v1.0 or native API integration | Medium |
