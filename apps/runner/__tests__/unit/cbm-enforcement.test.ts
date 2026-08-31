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
  ensureCbmRuntimeDir,
  resolveCbmOutcome,
  CBM_BLOCKED_TOOLS,
  CBM_ALLOWED_TOOLS,
  CBM_TOOL_SURFACE,
  applyCbmToolBlocklist,
  deriveCbmBlockedTools,
  type CbmContext,
} from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

describe('per-worker daemon runtime dir', () => {
  test('activation exposes a runtime dir nested in the cache dir', () => {
    const r = buildCbmActivation({ ...BASE, workerId: 'worker-1' });
    expect(r.cbmRuntimeDir).toBe('/tmp/cbm-worker-1/run');
  });

  test('runtime dir is scoped per worker so concurrent workers get separate daemons', () => {
    // CBM 0.10.x refuses to start when an active account daemon holds a
    // different CBM_CACHE_DIR. Per-worker cache dirs therefore need per-worker
    // runtime dirs, or only the first concurrent worker on a host gets CBM.
    const a = buildCbmActivation({ ...BASE, workerId: 'worker-a' }).cbmRuntimeDir;
    const b = buildCbmActivation({ ...BASE, workerId: 'worker-b' }).cbmRuntimeDir;
    expect(a).not.toBe(b);
  });

  test('ensureCbmRuntimeDir creates the dir with mode 0700', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cbm-rt-'));
    const runtimeDir = ensureCbmRuntimeDir(cacheDir);
    expect(runtimeDir).toBe(join(cacheDir, 'run'));
    // 0.10.8 accepts 0755 and rejects 0777 ("not a usable private-directory
    // parent"); 0700 is the tightest mode that qualifies.
    expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(runtimeDir).mode & 0o002).toBe(0);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('ensureCbmRuntimeDir tightens the mode of a pre-existing dir', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cbm-rt-'));
    mkdirSync(join(cacheDir, 'run'), { mode: 0o755 });
    ensureCbmRuntimeDir(cacheDir);
    expect(statSync(join(cacheDir, 'run')).mode & 0o777).toBe(0o700);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('the daemon socket path stays inside the sun_path limit', () => {
    // <runtime>/cbm-daemon-<uid>/cbm-<16 hex>.anc must fit in 108 bytes.
    const runtimeDir = buildCbmActivation({
      ...BASE,
      workerId: '11111111-2222-3333-4444-555555555555',
    }).cbmRuntimeDir!;
    const socketPath = join(runtimeDir, 'cbm-daemon-1000', `cbm-${'0'.repeat(16)}.anc`);
    expect(socketPath.length).toBeLessThan(108);
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

  test('caps memory budget to 1024 MB', () => {
    expect(entry.env.CBM_MEM_BUDGET_MB).toBe('1024');
  });

  test('isolates the daemon runtime dir per worker', () => {
    expect(entry.env.CBM_RUNTIME_DIR).toBe('/tmp/cbm-abc-123/run');
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

describe('resolveCbmOutcome (final metric bucket)', () => {
  test('enforced wins regardless of how the server got mounted', () => {
    expect(resolveCbmOutcome({ enforced: true, mounted: true })).toBe('enforced');
    expect(resolveCbmOutcome({ enforced: true, mounted: false })).toBe('enforced');
  });

  // The regression: a worker with codebase-memory mounted by a connector or the
  // project's own .mcp.json, but not enforced by the harness, used to be recorded
  // as 'disabled' — a CBM-equipped session sitting in the metrics control group.
  test('mounted but not enforced is legacy_mcp_json, not disabled', () => {
    expect(resolveCbmOutcome({ enforced: false, mounted: true })).toBe('legacy_mcp_json');
  });

  test('neither enforced nor mounted is disabled', () => {
    expect(resolveCbmOutcome({ enforced: false, mounted: false })).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// C15(a) — the blocklist must apply on EVERY mount path
// ---------------------------------------------------------------------------

describe('applyCbmToolBlocklist', () => {
  test('blocks the destructive tools even when the runner did not mount CBM itself', () => {
    // A codebase-memory server can reach the agent without ever appearing in
    // queryOptions.mcpServers: the SDK loads project .mcp.json itself via
    // settingSources: ['user', 'project'], and the runner's own .mcp.json
    // injection only handles type === 'http' entries (CBM is stdio). Gating the
    // blocklist on "the runner mounted it" left that path unguarded.
    const disallowed = applyCbmToolBlocklist(undefined);
    for (const blocked of CBM_BLOCKED_TOOLS) {
      expect(disallowed).toContain(blocked);
    }
  });

  test('preserves tools the caller already disallowed', () => {
    const disallowed = applyCbmToolBlocklist(['WebFetch']);
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('mcp__codebase-memory__delete_project');
  });

  test('is idempotent — re-applying does not duplicate entries', () => {
    const once = applyCbmToolBlocklist(undefined);
    const twice = applyCbmToolBlocklist(once);
    expect(twice.sort()).toEqual(once.sort());
  });
});

describe('CBM tool classification', () => {
  test('every classified CBM tool is either allowed or blocked, never both', () => {
    const allowed = new Set<string>(CBM_ALLOWED_TOOLS);
    const blockedBare = CBM_BLOCKED_TOOLS.map(t => t.replace('mcp__codebase-memory__', ''));
    for (const bare of blockedBare) expect(allowed.has(bare)).toBe(false);
    expect(new Set([...allowed, ...blockedBare]).size).toBe(allowed.size + blockedBare.length);
  });

  test('an unallowed tool on the surface is blocked automatically', () => {
    // The deny decision is computed, not remembered: a tool that shows up on the
    // surface without being allowed is blocked without anyone editing a list.
    expect(deriveCbmBlockedTools(['search_graph', 'nuke_everything'], ['search_graph']))
      .toEqual(['mcp__codebase-memory__nuke_everything']);
    expect(deriveCbmBlockedTools(['search_graph'], ['search_graph'])).toEqual([]);
  });

  test('the shipped blocklist is that same decision over the shipped surface', () => {
    expect([...CBM_BLOCKED_TOOLS].sort())
      .toEqual(deriveCbmBlockedTools(CBM_TOOL_SURFACE, CBM_ALLOWED_TOOLS).sort());
  });

  test('the destructive tools are on the classified surface and not allowed', () => {
    for (const tool of ['delete_project', 'manage_adr', 'ingest_traces']) {
      expect(CBM_TOOL_SURFACE).toContain(tool as any);
      expect(CBM_ALLOWED_TOOLS).not.toContain(tool as any);
    }
  });
});
