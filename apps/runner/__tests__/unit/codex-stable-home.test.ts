/**
 * Phase 1C / R5: stable per-worker CODEX_HOME lifecycle.
 *
 * Verifies:
 * - ensureStableCodexHome creates a stable, worker-id
 *   keyed dir under CODEX_HOME_ROOT.
 * - Re-ensuring the home + rewriting config.toml (a "second run") does NOT delete the
 *   `sessions/` subtree — resumable rollouts survive.
 * - The path is stable across calls (same worker id → same dir).
 * - teardownStableCodexHome removes the whole dir (terminal teardown), and is
 *   idempotent.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import * as fsModule from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } = fsModule;

import {
  ensureStableCodexHome,
  stableCodexHomePath,
  writeCodexMcpConfig,
  teardownStableCodexHome,
} from '../../src/codex-auth';

function probeFsIsReal(): boolean {
  try {
    return existsSync('/') && !existsSync(join(tmpdir(), `__codex_fs_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}
function fsTest(name: string, fn: () => void | Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-stable-home.test] skipping "${name}" — fs is mocked by a sibling suite`);
      return;
    }
    await fn();
  });
}

let root: string | undefined;
let prevRoot: string | undefined;
const workerId = 'w-stable-1';

beforeEach(() => {
  // Only touch real fs when it isn't mocked by a sibling suite. The fsTest
  // bodies are no-ops in that case, so leaving root unset is fine.
  if (!probeFsIsReal()) return;
  prevRoot = process.env.CODEX_HOME_ROOT;
  root = mkdtempSync(join(tmpdir(), 'codex-root-'));
  process.env.CODEX_HOME_ROOT = root;
});

afterEach(() => {
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    root = undefined;
  }
  if (prevRoot === undefined) delete process.env.CODEX_HOME_ROOT;
  else process.env.CODEX_HOME_ROOT = prevRoot;
});

describe('stable per-worker CODEX_HOME (Phase 1C / R5)', () => {
  fsTest('stableCodexHomePath is keyed by worker id and stays under the root', () => {
    const p = stableCodexHomePath(workerId);
    expect(p.startsWith(root)).toBe(true);
    expect(p).toBe(stableCodexHomePath(workerId)); // stable across calls
  });

  fsTest('re-ensuring the home + rewriting config does NOT delete the sessions subtree', () => {
    // First run: ensure the home + write MCP config + simulate a session rollout.
    const { codexHome } = ensureStableCodexHome(workerId);
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '20');
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, 'rollout-thread-abc.jsonl');
    writeFileSync(rollout, '{"thread":"abc"}\n');
    writeCodexMcpConfig(codexHome, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws1',
      workerId,
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
    });
    expect(existsSync(rollout)).toBe(true);

    // Second run: re-ensure + rewrite config (simulating a follow-up resume).
    const { codexHome: codexHome2 } = ensureStableCodexHome(workerId);
    writeCodexMcpConfig(codexHome2, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws1',
      workerId,
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
    });

    // Same dir, and the rollout is STILL there.
    expect(codexHome2).toBe(codexHome);
    expect(existsSync(rollout)).toBe(true);
    expect(readFileSync(rollout, 'utf-8')).toContain('abc');
    // config.toml was (re)written with the MCP server.
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf-8')).toContain('[mcp_servers.buildd]');
  });

  fsTest('ensureStableCodexHome (no credential) creates the dir without auth.json', () => {
    const { codexHome } = ensureStableCodexHome(workerId);
    expect(existsSync(codexHome)).toBe(true);
    expect(existsSync(join(codexHome, 'auth.json'))).toBe(false);
  });

  fsTest('teardownStableCodexHome removes the dir and is idempotent', () => {
    const { codexHome } = ensureStableCodexHome(workerId);
    expect(existsSync(codexHome)).toBe(true);
    teardownStableCodexHome(workerId);
    expect(existsSync(codexHome)).toBe(false);
    expect(() => teardownStableCodexHome(workerId)).not.toThrow();
  });
});
