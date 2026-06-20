/**
 * Unit tests for the reasoning-effort key emitted into CODEX_HOME/config.toml
 * (Phase 3C). `ThreadOptions` has no reasoning-effort field, so buildd maps its
 * configuredEffort (low/medium/high/max) to the codex-cli `model_reasoning_effort`
 * top-level config key.
 *
 * KEY EVIDENCE (codex-cli 0.140.0, validated live with `codex exec --strict-config`):
 *   - `model_reasoning_effort = "high"` is ACCEPTED and applied (CLI prints
 *     `reasoning effort: high`).
 *   - `reasoning_effort` (no `model_` prefix) is REJECTED: "unknown configuration
 *     field `reasoning_effort`".
 *   - The key MUST be a TOP-LEVEL key emitted BEFORE the `[mcp_servers.buildd]`
 *     table header. If placed after the table header, TOML parses it as
 *     `mcp_servers.buildd.model_reasoning_effort`, which strict-config rejects.
 *   - Allowed values: minimal | low | medium | high. buildd's `max` maps to
 *     `high` (codex has no `max`).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeCodexMcpConfig } from '../../src/codex-auth';

function probeFsIsReal(): boolean {
  try {
    return fs.existsSync('/') && !fs.existsSync(join(tmpdir(), `__codex_effort_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}

function fsTest(name: string, fn: () => void | Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-effort-config.test] skipping "${name}" — fs is mocked by a sibling suite (covered when run in isolation)`);
      return;
    }
    await fn();
  });
}

describe('writeCodexMcpConfig — reasoning effort (Phase 3C)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  function write(effort?: 'low' | 'medium' | 'high' | 'max'): string {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-effort-test-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      ...(effort ? { effort } : {}),
    });
    return fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
  }

  fsTest('emits model_reasoning_effort when an effort is provided', () => {
    const content = write('high');
    expect(content).toContain('model_reasoning_effort = "high"');
  });

  fsTest('low/medium pass through unchanged', () => {
    expect(write('low')).toContain('model_reasoning_effort = "low"');
    expect(write('medium')).toContain('model_reasoning_effort = "medium"');
  });

  fsTest('buildd `max` maps to codex `high` (codex has no max)', () => {
    const content = write('max');
    expect(content).toContain('model_reasoning_effort = "high"');
    expect(content).not.toContain('"max"');
  });

  fsTest('omits the key entirely when no effort is provided (no silent default)', () => {
    const content = write();
    expect(content).not.toContain('model_reasoning_effort');
  });

  fsTest('effort key is TOP-LEVEL, emitted BEFORE the [mcp_servers.buildd] table header', () => {
    // Critical: a key after a table header is parsed INTO that table
    // (mcp_servers.buildd.model_reasoning_effort) which strict-config rejects.
    const content = write('high');
    const effortIdx = content.indexOf('model_reasoning_effort');
    const tableIdx = content.indexOf('[mcp_servers.buildd]');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeLessThan(tableIdx);
    // No table header appears before the effort key.
    expect(content.slice(0, effortIdx).includes('[')).toBe(false);
  });

  fsTest('still emits the MCP server block + approval mode alongside the effort key', () => {
    const content = write('medium');
    expect(content).toContain('[mcp_servers.buildd]');
    expect(content).toContain('default_tools_approval_mode = "approve"');
  });
});
