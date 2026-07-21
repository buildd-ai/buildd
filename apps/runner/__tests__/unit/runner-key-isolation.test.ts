/**
 * Security regression tests — Tier 1: runner API key isolation
 *
 * Verifies that:
 * 1. RUNNER_CREDENTIAL_PATHS patterns match the paths that need read-blocking.
 * 2. The PreToolUse hook denies `Read` calls targeting credential paths.
 * 3. DANGEROUS_PATTERNS block bash commands that read credential files.
 * 4. BUILDD_API_KEY is not injected into cleanEnv (compile-time assertion).
 *
 * Design ref: docs/design/runner-workspace-isolation.md — Tier 1 / Option A
 *
 * Run: bun test apps/runner/__tests__/unit/runner-key-isolation.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { DANGEROUS_PATTERNS, RUNNER_CREDENTIAL_PATHS } from '@buildd/shared';

// ─── Module stubs (must precede importing workers / hook-factory) ─────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  getWorker: () => null,
}));

import { HookFactory } from '../../src/hook-factory';
import type { LocalWorker, Milestone } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorker(): LocalWorker {
  return {
    id: 'w1',
    taskId: 't1',
    taskTitle: 'test',
    workspaceId: 'ws1',
    workspaceName: 'test-ws',
    branch: 'main',
    status: 'working',
    hasNewActivity: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    milestones: [],
    currentAction: '',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
  } as LocalWorker;
}

const mockBuildd = { updateWorker: mock(async () => ({})) } as any;
const mockAddMilestone = mock((_w: LocalWorker, _m: Milestone) => {});
const mockEmit = mock(() => {});

function makeFactory(): HookFactory {
  return new HookFactory({
    config: {},
    buildd: mockBuildd,
    addMilestone: mockAddMilestone,
    emit: mockEmit,
    pendingPermissionRequests: new Map(),
  });
}

function buildPreToolUseEvent(toolName: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool_1',
  };
}

// ─── RUNNER_CREDENTIAL_PATHS ─────────────────────────────────────────────────

describe('RUNNER_CREDENTIAL_PATHS — pattern coverage', () => {
  function matches(path: string): boolean {
    return RUNNER_CREDENTIAL_PATHS.some(p => p.test(path));
  }

  test('matches ~/.buildd/config.json (runner API key file)', () => {
    expect(matches('/home/user/.buildd/config.json')).toBe(true);
    expect(matches('/root/.buildd/config.json')).toBe(true);
  });

  test('matches ~/.buildd/workers/ state files', () => {
    expect(matches('/home/user/.buildd/workers/w1.json')).toBe(true);
  });

  test('matches buildd-codex-homes/ credential directories', () => {
    expect(matches('/tmp/buildd-codex-homes/w1/auth.json')).toBe(true);
    expect(matches('/var/tmp/buildd-codex-homes/w2/config.toml')).toBe(true);
  });

  test('matches claude-cfg-* temp directories', () => {
    expect(matches('/tmp/claude-cfg-abc123/credentials.json')).toBe(true);
  });

  test('does NOT match normal project files', () => {
    expect(matches('/home/user/project/src/index.ts')).toBe(false);
    expect(matches('/home/user/project/.env')).toBe(false);
    expect(matches('/home/user/project/package.json')).toBe(false);
    // config.json inside a project is fine; only .buildd/config.json is blocked
    expect(matches('/home/user/project/config.json')).toBe(false);
  });

  test('does NOT match ~/.buildd/ paths that are not the API key or worker files', () => {
    // repos-cache.json is a reachable file but not a credential — not in scope for Tier 1
    // Only config.json and workers/ need blocking in this pass
    expect(matches('/home/user/.buildd/repos-cache.json')).toBe(false);
  });
});

// ─── Hook: Read tool blocking ─────────────────────────────────────────────────

describe('createPermissionHook — Read tool blocks credential paths', () => {
  test('denies Read of ~/.buildd/config.json', async () => {
    const factory = makeFactory();
    const hook = factory.createPermissionHook(makeWorker());
    const result = await hook(buildPreToolUseEvent('Read', {
      file_path: '/home/user/.buildd/config.json',
    }));
    const out = (result as any).hookSpecificOutput;
    expect(out?.permissionDecision).toBe('deny');
  });

  test('denies Read of a Codex per-worker auth.json', async () => {
    const factory = makeFactory();
    const hook = factory.createPermissionHook(makeWorker());
    const result = await hook(buildPreToolUseEvent('Read', {
      file_path: '/tmp/buildd-codex-homes/w2/auth.json',
    }));
    const out = (result as any).hookSpecificOutput;
    expect(out?.permissionDecision).toBe('deny');
  });

  test('denies Read of a Claude per-worker credentials.json', async () => {
    const factory = makeFactory();
    const hook = factory.createPermissionHook(makeWorker());
    const result = await hook(buildPreToolUseEvent('Read', {
      file_path: '/tmp/claude-cfg-abc123/credentials.json',
    }));
    const out = (result as any).hookSpecificOutput;
    expect(out?.permissionDecision).toBe('deny');
  });

  test('allows Read of normal project files', async () => {
    const factory = makeFactory();
    const hook = factory.createPermissionHook(makeWorker());
    const result = await hook(buildPreToolUseEvent('Read', {
      file_path: '/home/user/project/src/index.ts',
    }));
    const out = (result as any).hookSpecificOutput;
    expect(out?.permissionDecision).toBe('allow');
  });
});

// ─── DANGEROUS_PATTERNS: bash credential reads ────────────────────────────────

describe('DANGEROUS_PATTERNS — blocks bash reads of runner credential files', () => {
  function isDangerous(command: string): boolean {
    return DANGEROUS_PATTERNS.some(p => p.test(command));
  }

  test('blocks cat of ~/.buildd/config.json', () => {
    expect(isDangerous('cat ~/.buildd/config.json')).toBe(true);
  });

  test('blocks cat of runner config with absolute path', () => {
    expect(isDangerous('cat /home/user/.buildd/config.json')).toBe(true);
  });

  test('blocks listing Codex credential homes', () => {
    expect(isDangerous('ls /tmp/buildd-codex-homes/')).toBe(true);
  });

  test('blocks reading from a Codex credential home', () => {
    expect(isDangerous('cat /tmp/buildd-codex-homes/w1/auth.json')).toBe(true);
  });

  test('does NOT block normal git or build commands', () => {
    expect(isDangerous('git status')).toBe(false);
    expect(isDangerous('bun run build')).toBe(false);
    expect(isDangerous('cat src/index.ts')).toBe(false);
  });
});

// ─── BUILDD_API_KEY not injected into cleanEnv (static source check) ─────────

describe('BUILDD_API_KEY not present in cleanEnv injection', () => {
  test('workers.ts source does not assign cleanEnv.BUILDD_API_KEY', async () => {
    // Static guard: ensure the injection line was not re-added accidentally.
    // The runner key must never appear in cleanEnv — the MCP server Auth header
    // already carries it directly via queryOptions.mcpServers.buildd.headers.
    const src = await Bun.file(
      new URL('../../src/workers.ts', import.meta.url).pathname
    ).text();
    // The line `cleanEnv.BUILDD_API_KEY = ...` must not appear in the source.
    expect(src).not.toContain('cleanEnv.BUILDD_API_KEY');
  });
});
