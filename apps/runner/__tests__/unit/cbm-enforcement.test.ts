/**
 * Unit tests for CBM enforcement (cbm-enforcement.ts).
 *
 * Covers: activation gates (worktree, Codex, opt-out, binary), env var correctness,
 * MCP entry shape, and the blocked-tool list.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildCbmActivation,
  buildCbmMcpEntry,
  CBM_BLOCKED_TOOLS,
  CBM_ALLOWED_TOOLS,
  type CbmContext,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

/** A pathExists stub that pretends the CBM binary is present. */
const binaryPresent = (p: string) => p === CBM_BINARY_PATH;
/** A pathExists stub that pretends the CBM binary is absent (old image). */
const binaryAbsent = () => false;

const BASE: CbmContext = {
  workerId: 'abc-123',
  worktreePath: '/repo/.buildd-worktrees/branch-x',
  isCodexTask: false,
  cbmRoleDisabled: false,
  pathExists: binaryPresent,
};

describe('buildCbmActivation', () => {
  test('enforces for a repo-backed Claude task with binary present', () => {
    const result = buildCbmActivation(BASE);
    expect(result.enforced).toBe(true);
    expect(result.cbmBinaryPath).toBe(CBM_BINARY_PATH);
    expect(result.cbmCacheDir).toBe('/tmp/cbm-abc-123');
  });

  test('skips when no worktree (coordination workspace / service role)', () => {
    const result = buildCbmActivation({ ...BASE, worktreePath: undefined });
    expect(result.enforced).toBe(false);
    expect(result.cbmBinaryPath).toBeUndefined();
    expect(result.cbmCacheDir).toBeUndefined();
  });

  test('skips for Codex tasks', () => {
    const result = buildCbmActivation({ ...BASE, isCodexTask: true });
    expect(result.enforced).toBe(false);
  });

  test('skips when role has opted out (cbmRoleDisabled)', () => {
    const result = buildCbmActivation({ ...BASE, cbmRoleDisabled: true });
    expect(result.enforced).toBe(false);
  });

  test('skips when binary is not on host (old image, silent degradation)', () => {
    const result = buildCbmActivation({ ...BASE, pathExists: binaryAbsent });
    expect(result.enforced).toBe(false);
  });

  test('cache dir is scoped per worker id (no shared-state collision)', () => {
    const r1 = buildCbmActivation({ ...BASE, workerId: 'worker-1' });
    const r2 = buildCbmActivation({ ...BASE, workerId: 'worker-2' });
    expect(r1.cbmCacheDir).toBe('/tmp/cbm-worker-1');
    expect(r2.cbmCacheDir).toBe('/tmp/cbm-worker-2');
  });
});

describe('buildCbmMcpEntry', () => {
  const entry = buildCbmMcpEntry('/repo/.buildd-worktrees/branch-x', '/tmp/cbm-abc-123');

  test('is a stdio server pointing at the CBM binary', () => {
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe(CBM_BINARY_PATH);
    expect(entry.args).toEqual(['mcp']);
  });

  test('sets CBM_CACHE_DIR to the per-worker directory', () => {
    expect(entry.env.CBM_CACHE_DIR).toBe('/tmp/cbm-abc-123');
  });

  test('sets CBM_ALLOWED_ROOT to the worktree path', () => {
    expect(entry.env.CBM_ALLOWED_ROOT).toBe('/repo/.buildd-worktrees/branch-x');
  });

  test('disables auto-watch (no background FS watcher inside sandbox)', () => {
    expect(entry.env.CBM_AUTO_WATCH).toBe('false');
  });

  test('caps memory budget to 512 MB', () => {
    expect(entry.env.CBM_MEM_BUDGET_MB).toBe('512');
  });

  test('CBM_ALLOWED_ROOT reflects the actual sessionCwd (no stale path)', () => {
    const entry2 = buildCbmMcpEntry('/repo/.buildd-worktrees/other-branch', '/tmp/cbm-xyz');
    expect(entry2.env.CBM_ALLOWED_ROOT).toBe('/repo/.buildd-worktrees/other-branch');
    expect(entry2.env.CBM_CACHE_DIR).toBe('/tmp/cbm-xyz');
  });
});

describe('CBM_BLOCKED_TOOLS', () => {
  test('blocks delete_project', () => {
    expect(CBM_BLOCKED_TOOLS).toContain('mcp__codebase-memory__delete_project');
  });

  test('blocks manage_adr (would write ADR files into the repo)', () => {
    expect(CBM_BLOCKED_TOOLS).toContain('mcp__codebase-memory__manage_adr');
  });

  test('blocks ingest_traces', () => {
    expect(CBM_BLOCKED_TOOLS).toContain('mcp__codebase-memory__ingest_traces');
  });

  test('has exactly 3 blocked tools', () => {
    expect(CBM_BLOCKED_TOOLS.length).toBe(3);
  });
});

describe('CBM_ALLOWED_TOOLS', () => {
  test('contains exactly 12 allowed tools', () => {
    expect(CBM_ALLOWED_TOOLS.length).toBe(12);
  });

  test('includes all required read/query tools', () => {
    for (const tool of [
      'search_graph', 'trace_path', 'detect_changes', 'query_graph',
      'get_graph_schema', 'get_code_snippet', 'get_architecture', 'search_code',
      'index_repository', 'index_status', 'list_projects', 'check_index_coverage',
    ]) {
      expect(CBM_ALLOWED_TOOLS).toContain(tool as any);
    }
  });

  test('blocked tools are not in the allowed list', () => {
    const allowedSet = new Set(CBM_ALLOWED_TOOLS);
    for (const blocked of CBM_BLOCKED_TOOLS) {
      // Blocked tools use the mcp__ prefix; allowed tools are bare names — no overlap expected
      const bareName = blocked.replace('mcp__codebase-memory__', '');
      expect(allowedSet.has(bareName as any)).toBe(false);
    }
  });
});
