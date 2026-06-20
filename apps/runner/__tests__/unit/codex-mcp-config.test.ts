/**
 * Unit tests for writeCodexMcpConfig — the CODEX_HOME/config.toml writer that
 * registers the Buildd MCP server for Codex workers.
 *
 * Regression: headless `codex exec` runs with approval policy "never", which
 * AUTO-CANCELS MCP tool calls unless the server (or tool) is configured to
 * auto-approve. The SDK exposes no approval flag, so the only lever is the
 * per-server `default_tools_approval_mode = "approve"` key in config.toml.
 * These tests assert that key is emitted alongside the existing server block.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeCodexMcpConfig } from '../../src/codex-auth';

function probeFsIsReal(): boolean {
  try {
    return fs.existsSync('/') && !fs.existsSync(join(tmpdir(), `__codex_mcp_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}

function fsTest(name: string, fn: () => void | Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-mcp-config.test] skipping "${name}" — fs is mocked by a sibling suite (covered when run in isolation)`);
      return;
    }
    await fn();
  });
}

describe('writeCodexMcpConfig', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  function write(): string {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-test-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
    });
    return fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
  }

  fsTest('writes the [mcp_servers.buildd] block with url, bearer token env var, enabled', () => {
    const content = write();
    expect(content).toContain('[mcp_servers.buildd]');
    expect(content).toContain('url = ');
    expect(content).toContain('workspace=ws_123');
    expect(content).toContain('worker=w_456');
    expect(content).toContain('bearer_token_env_var = "BUILDD_MCP_BEARER_TOKEN"');
    expect(content).toContain('enabled = true');
  });

  fsTest('auto-approves MCP tool calls so headless `codex exec` does not cancel them', () => {
    const content = write();
    // The fix: without this, codex exec (approval policy "never") cancels every
    // buildd MCP tool call with "user cancelled MCP tool call".
    expect(content).toContain('default_tools_approval_mode = "approve"');
  });

  fsTest('the approval setting lives inside the buildd server block (not a stray top-level key)', () => {
    const content = write();
    const serverIdx = content.indexOf('[mcp_servers.buildd]');
    const approvalIdx = content.indexOf('default_tools_approval_mode');
    expect(serverIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(serverIdx);
    // No other section header appears between the server header and the approval key.
    const between = content.slice(serverIdx, approvalIdx);
    expect(between.includes('\n[')).toBe(false);
  });
});
