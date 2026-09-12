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
import { buildCbmCodexStdioServer } from '../../src/cbm-enforcement';
import { CBM_BINARY_PATH } from '../../src/bwrap-mount-allowlist';

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

  fsTest('enables sandbox network access so the remote buildd MCP + git push work', () => {
    const content = write();
    // Codex's workspace-write sandbox disables outbound network by default, which
    // makes the remote buildd HTTP MCP unreachable (no create_pr / update_progress)
    // and blocks `git push`. Verified against codex-cli 0.140 (--strict-config prints
    // "network access enabled").
    expect(content).toContain('[sandbox_workspace_write]');
    expect(content).toContain('network_access = true');
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

describe('writeCodexMcpConfig — additional workspace/role MCP servers', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  function writeWithExtra(): { dir: string; content: string } {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-extra-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      additionalMcpServers: [
        { name: 'cue', url: 'https://cue.example.com/mcp', bearerTokenEnvVar: 'MCP_BEARER_CUE' },
      ],
    });
    return { dir, content: fs.readFileSync(join(dir, 'config.toml'), 'utf-8') };
  }

  fsTest('emits [mcp_servers.<name>] block for each additional server', () => {
    const { content } = writeWithExtra();
    expect(content).toContain('[mcp_servers.cue]');
    expect(content).toContain('url = "https://cue.example.com/mcp"');
    expect(content).toContain('bearer_token_env_var = "MCP_BEARER_CUE"');
    expect(content).toContain('enabled = true');
    expect(content).toContain('default_tools_approval_mode = "approve"');
  });

  fsTest('bearer token env var name is in the file but no raw token value is written', () => {
    const { content } = writeWithExtra();
    // Only the env var NAME is written; the actual secret value never enters config.toml.
    expect(content).toContain('bearer_token_env_var = "MCP_BEARER_CUE"');
    // Confirm there is no direct assignment of a token value (would look like bearer_token = "...")
    expect(content).not.toMatch(/^\s*bearer_token\s*=/m);
  });

  fsTest('additional server block appears before [sandbox_workspace_write]', () => {
    const { content } = writeWithExtra();
    const cueIdx = content.indexOf('[mcp_servers.cue]');
    const sandboxIdx = content.indexOf('[sandbox_workspace_write]');
    expect(cueIdx).toBeGreaterThanOrEqual(0);
    expect(sandboxIdx).toBeGreaterThan(cueIdx);
  });

  fsTest('buildd server block is still present alongside additional servers', () => {
    const { content } = writeWithExtra();
    expect(content).toContain('[mcp_servers.buildd]');
    expect(content).toContain('[mcp_servers.cue]');
  });

  fsTest('multiple additional servers each get their own block', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-multi-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      additionalMcpServers: [
        { name: 'cue', url: 'https://cue.example.com/mcp', bearerTokenEnvVar: 'MCP_BEARER_CUE' },
        { name: 'dispatch', url: 'https://dispatch.example.com/mcp', bearerTokenEnvVar: 'MCP_BEARER_DISPATCH' },
      ],
    });
    const content = fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.cue]');
    expect(content).toContain('[mcp_servers.dispatch]');
    expect(content).toContain('bearer_token_env_var = "MCP_BEARER_CUE"');
    expect(content).toContain('bearer_token_env_var = "MCP_BEARER_DISPATCH"');
  });

  fsTest('no additional servers emitted when additionalMcpServers is empty or omitted', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-empty-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      additionalMcpServers: [],
    });
    const content = fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
    // Only buildd should appear
    const serverMatches = content.match(/\[mcp_servers\./g) || [];
    expect(serverMatches).toHaveLength(1);
    expect(content).toContain('[mcp_servers.buildd]');
  });
});

describe('writeCodexMcpConfig — stdio servers (codebase-memory)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  function writeWithCbm(extra: Partial<Parameters<typeof writeCodexMcpConfig>[1]> = {}): string {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-stdio-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      stdioMcpServers: [buildCbmCodexStdioServer('/repo/.buildd-worktrees/b', '/tmp/cbm-w_456')],
      ...extra,
    });
    return fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
  }

  fsTest('emits a command/args stdio block for codebase-memory', () => {
    // Codex has no mcpServers option, so config.toml is the ONLY way the graph
    // reaches a Codex worker. The writer previously modelled HTTP servers only,
    // which is why CBM never got there — not anything intrinsic to Codex.
    const content = writeWithCbm();
    expect(content).toContain('[mcp_servers.codebase-memory]');
    expect(content).toContain(`command = ${JSON.stringify(CBM_BINARY_PATH)}`);
    expect(content).toContain('args = ["mcp"]');
    expect(content).toContain('enabled = true');
  });

  fsTest('auto-approves its tools (headless codex exec cancels unapproved MCP calls)', () => {
    const content = writeWithCbm();
    const block = content.slice(content.indexOf('[mcp_servers.codebase-memory]'));
    expect(block).toContain('default_tools_approval_mode = "approve"');
  });

  fsTest('withholds the destructive CBM tools via disabled_tools', () => {
    const content = writeWithCbm();
    expect(content).toContain('disabled_tools = ["delete_project", "manage_adr", "ingest_traces"]');
  });

  fsTest('scalar keys precede the nested env table (TOML scoping trap)', () => {
    // A bare `key = value` written AFTER a nested table header is scoped INTO that
    // table, and codex's --strict-config rejects the unknown field that results.
    // The same trap model_reasoning_effort hit.
    const content = writeWithCbm();
    const serverIdx = content.indexOf('[mcp_servers.codebase-memory]');
    const envIdx = content.indexOf('[mcp_servers.codebase-memory.env]');
    const approvalIdx = content.indexOf('default_tools_approval_mode', serverIdx);
    const disabledIdx = content.indexOf('disabled_tools', serverIdx);
    expect(envIdx).toBeGreaterThan(serverIdx);
    expect(approvalIdx).toBeGreaterThan(serverIdx);
    expect(approvalIdx).toBeLessThan(envIdx);
    expect(disabledIdx).toBeLessThan(envIdx);
  });

  fsTest('writes every CBM env var into the nested env table', () => {
    const content = writeWithCbm();
    const env = content.slice(content.indexOf('[mcp_servers.codebase-memory.env]'));
    expect(env).toContain('CBM_CACHE_DIR = "/tmp/cbm-w_456"');
    expect(env).toContain('CBM_RUNTIME_DIR = "/tmp/cbm-w_456/run"');
    expect(env).toContain('CBM_ALLOWED_ROOT = "/repo/.buildd-worktrees/b"');
    expect(env).toContain('CBM_AUTO_WATCH = "false"');
    expect(env).toContain('CBM_MEM_BUDGET_MB = "1024"');
  });

  fsTest('stdio block sits before [sandbox_workspace_write] and beside buildd + HTTP servers', () => {
    const content = writeWithCbm({
      additionalMcpServers: [
        { name: 'cue', url: 'https://cue.example.com/mcp', bearerTokenEnvVar: 'MCP_BEARER_CUE' },
      ],
    });
    const cbmIdx = content.indexOf('[mcp_servers.codebase-memory]');
    const sandboxIdx = content.indexOf('[sandbox_workspace_write]');
    expect(content).toContain('[mcp_servers.buildd]');
    expect(content).toContain('[mcp_servers.cue]');
    expect(cbmIdx).toBeGreaterThan(0);
    expect(sandboxIdx).toBeGreaterThan(cbmIdx);
  });

  fsTest('no stdio block when none is passed (existing config unchanged)', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-mcp-nostdio-'));
    dirs.push(dir);
    writeCodexMcpConfig(dir, {
      builddServer: 'https://buildd.dev',
      workspaceId: 'ws_123',
      workerId: 'w_456',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
    });
    const content = fs.readFileSync(join(dir, 'config.toml'), 'utf-8');
    expect(content).not.toContain('codebase-memory');
    expect(content).not.toContain('command =');
  });
});
