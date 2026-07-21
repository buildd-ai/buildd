import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Mock child_process.execSync
const mockExecSync = mock((cmd: string) => Buffer.from(''));
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Mock fs.readFileSync and existsSync
const mockReadFileSync = mock((path: string) => '');
const mockExistsSync = mock((path: string) => true);
mock.module('fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

import { scanEnvironment, checkBrowserCapability, checkBwrapSupport, type ScanConfig } from './env-scan';

describe('checkBwrapSupport', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    // Default: sysctl not present — fall through to bwrap test
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('unprivileged_userns_clone')) {
        throw new Error('ENOENT');
      }
      throw new Error('ENOENT');
    });
  });

  it('returns true when bwrap is installed and --unshare-user namespace test passes', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      if (typeof cmd === 'string' && cmd.includes('bwrap') && cmd.includes('--unshare-user')) return Buffer.from('ok\n');
      throw new Error('not found');
    });
    expect(checkBwrapSupport()).toBe(true);
  });

  it('returns false when bwrap is not installed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') throw new Error('not found');
      return Buffer.from('');
    });
    expect(checkBwrapSupport()).toBe(false);
  });

  it('returns false when bwrap is installed but --unshare-user namespace creation fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      if (typeof cmd === 'string' && cmd.includes('bwrap') && cmd.includes('--unshare-user')) {
        throw new Error('bwrap: No permissions to create a new namespace');
      }
      throw new Error('not found');
    });
    expect(checkBwrapSupport()).toBe(false);
  });

  it('returns false immediately when kernel sysctl unprivileged_userns_clone=0', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('unprivileged_userns_clone')) {
        return '0\n';
      }
      throw new Error('ENOENT');
    });
    // execSync should never be called when sysctl short-circuits
    mockExecSync.mockImplementation(() => { throw new Error('should not be called'); });
    expect(checkBwrapSupport()).toBe(false);
  });

  it('returns true when kernel sysctl is 1 and bwrap namespace test passes', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('unprivileged_userns_clone')) {
        return '1\n';
      }
      throw new Error('ENOENT');
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      if (typeof cmd === 'string' && cmd.includes('bwrap') && cmd.includes('--unshare-user')) return Buffer.from('ok\n');
      throw new Error('not found');
    });
    expect(checkBwrapSupport()).toBe(true);
  });

  it('returns false when setuid bwrap passes basic test but --unshare-user fails (false-positive scenario)', () => {
    // This is the key scenario: setuid bwrap can bind-mount without user namespaces,
    // but --unshare-user explicitly tests user namespace creation and fails.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which bwrap') return Buffer.from('/usr/bin/bwrap\n');
      if (typeof cmd === 'string' && cmd.includes('bwrap') && cmd.includes('--unshare-user')) {
        throw new Error('bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.');
      }
      if (typeof cmd === 'string' && cmd.includes('bwrap')) return Buffer.from('ok\n'); // old test would pass
      throw new Error('not found');
    });
    expect(checkBwrapSupport()).toBe(false);
  });
});

describe('checkBrowserCapability', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockImplementation(() => false); // no Playwright cache by default
  });

  it('returns true when system chromium binary is found and functional', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which chromium') return Buffer.from('/usr/bin/chromium\n');
      if (cmd === 'chromium --version') return Buffer.from('Chromium 120.0.0\n');
      throw new Error('not found');
    });

    expect(checkBrowserCapability()).toBe(true);
  });

  it('returns true when google-chrome binary is found', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which chromium') throw new Error('not found');
      if (cmd === 'which chromium-browser') throw new Error('not found');
      if (cmd === 'which google-chrome') return Buffer.from('/usr/bin/google-chrome\n');
      if (cmd === 'google-chrome --version') return Buffer.from('Google Chrome 120.0.0\n');
      throw new Error('not found');
    });

    expect(checkBrowserCapability()).toBe(true);
  });

  it('returns true when Playwright chromium binary is found in cache', () => {
    mockExistsSync.mockImplementation((path: string) => {
      // Simulate playwright cache directory existing
      return typeof path === 'string' && path.includes('ms-playwright');
    });
    mockExecSync.mockImplementation((cmd: string) => {
      // No system chromium
      if (typeof cmd === 'string' && cmd.startsWith('which ')) throw new Error('not found');
      // find returns a path
      if (typeof cmd === 'string' && cmd.includes('find') && cmd.includes('ms-playwright')) {
        return Buffer.from('/home/user/.cache/ms-playwright/chromium-1234/chrome-linux/chrome\n');
      }
      throw new Error('not found');
    });

    expect(checkBrowserCapability()).toBe(true);
  });

  it('returns false when no chromium binary is found anywhere', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    expect(checkBrowserCapability()).toBe(false);
  });

  it('returns false when chromium is on PATH but version output does not match', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which chromium') return Buffer.from('/usr/bin/chromium\n');
      if (cmd === 'chromium --version') return Buffer.from('something else entirely\n');
      throw new Error('not found');
    });

    expect(checkBrowserCapability()).toBe(false);
  });
});

describe('scanEnvironment', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();

    // Default: all `which` checks fail (no tools found)
    mockExecSync.mockImplementation((cmd: string) => {
      throw new Error('not found');
    });

    // Default: no MCP settings files
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    // Default: no playwright cache
    mockExistsSync.mockImplementation(() => false);
  });

  it('returns correct shape with no tools/env/mcp', () => {
    const env = scanEnvironment();

    expect(env.tools).toEqual([]);
    expect(env.envKeys).toBeInstanceOf(Array);
    expect(env.mcp).toEqual([]);
    expect(env.labels.type).toBe('local');
    expect(env.labels.os).toBeDefined();
    expect(env.labels.arch).toBeDefined();
    expect(env.labels.hostname).toBeDefined();
    expect(env.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes "browser" in envKeys when headless Chromium is available', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which chromium') return Buffer.from('/usr/bin/chromium\n');
      if (cmd === 'chromium --version') return Buffer.from('Chromium 120.0.0\n');
      throw new Error('not found');
    });

    const env = scanEnvironment();
    expect(env.envKeys).toContain('browser');
  });

  it('does NOT include "browser" in envKeys when Chromium is absent', () => {
    // All execSync calls fail → no chromium found
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const env = scanEnvironment();
    expect(env.envKeys).not.toContain('browser');
  });

  it('detects installed tools with version', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('not found');
      if (cmd === 'which node') return Buffer.from('/usr/local/bin/node\n');
      if (cmd === 'node --version') return Buffer.from('v22.1.0\n');
      if (cmd === 'which git') return Buffer.from('/usr/bin/git\n');
      if (cmd === 'git --version') return Buffer.from('git version 2.43.0\n');
      throw new Error('not found');
    });

    const env = scanEnvironment();

    expect(env.tools).toContainEqual({ name: 'node', version: '22.1.0' });
    expect(env.tools).toContainEqual({ name: 'git', version: '2.43.0' });
    expect(env.tools.find(t => t.name === 'docker')).toBeUndefined();
  });

  it('detects tool without version when --version fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('not found');
      if (cmd === 'which docker') return Buffer.from('/usr/bin/docker\n');
      if (cmd === 'docker --version') throw new Error('timeout');
      throw new Error('not found');
    });

    const env = scanEnvironment();

    expect(env.tools).toContainEqual({ name: 'docker' });
  });

  it('detects present env keys without leaking values', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    const originalDb = process.env.DATABASE_URL;

    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    process.env.DATABASE_URL = 'postgres://localhost/test';

    try {
      const env = scanEnvironment();

      expect(env.envKeys).toContain('ANTHROPIC_API_KEY');
      expect(env.envKeys).toContain('DATABASE_URL');
      // Must NOT contain the actual values
      expect(JSON.stringify(env)).not.toContain('sk-ant-secret');
      expect(JSON.stringify(env)).not.toContain('postgres://localhost/test');
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
      if (originalDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDb;
    }
  });

  it('advertises backend:codex without leaking Codex auth', () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.OPENAI_API_KEY = 'sk-openai-secret';
    delete process.env.CODEX_HOME;

    try {
      const env = scanEnvironment();
      expect(env.envKeys).toContain('OPENAI_API_KEY');
      expect(env.envKeys).toContain('backend:codex');
      expect(JSON.stringify(env)).not.toContain('sk-openai-secret');
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('ignores empty env keys', () => {
    const original = process.env.SLACK_TOKEN;
    process.env.SLACK_TOKEN = '';

    try {
      const env = scanEnvironment();
      expect(env.envKeys).not.toContain('SLACK_TOKEN');
    } finally {
      if (original === undefined) delete process.env.SLACK_TOKEN;
      else process.env.SLACK_TOKEN = original;
    }
  });

  it('reads MCP servers from settings files', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('.claude') && path.includes('settings.json')) {
        return JSON.stringify({
          mcpServers: {
            slack: { command: 'npx', args: ['slack-mcp'] },
            github: { command: 'gh-mcp' },
          },
        });
      }
      throw new Error('ENOENT');
    });

    const env = scanEnvironment();

    expect(env.mcp).toContain('slack');
    expect(env.mcp).toContain('github');
  });

  it('deduplicates MCP servers across settings files', () => {
    mockReadFileSync.mockImplementation(() => {
      return JSON.stringify({
        mcpServers: { buildd: { command: 'buildd-mcp' } },
      });
    });

    const env = scanEnvironment();

    // Both global and project settings have "buildd", should appear once
    const builddCount = env.mcp.filter(s => s === 'buildd').length;
    expect(builddCount).toBe(1);
  });

  it('supports extraTools via ScanConfig', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('not found');
      if (cmd === 'which my-custom-tool') return Buffer.from('/usr/bin/my-custom-tool\n');
      if (cmd === 'my-custom-tool --version') return Buffer.from('1.0.0\n');
      throw new Error('not found');
    });

    const config: ScanConfig = {
      extraTools: [{ name: 'custom', cmd: 'my-custom-tool' }],
    };

    const env = scanEnvironment(config);

    expect(env.tools).toContainEqual({ name: 'custom', version: '1.0.0' });
  });

  it('supports extraEnvKeys via ScanConfig', () => {
    const original = process.env.MY_CUSTOM_KEY;
    process.env.MY_CUSTOM_KEY = 'some-value';

    try {
      const config: ScanConfig = { extraEnvKeys: ['MY_CUSTOM_KEY'] };
      const env = scanEnvironment(config);

      expect(env.envKeys).toContain('MY_CUSTOM_KEY');
    } finally {
      if (original === undefined) delete process.env.MY_CUSTOM_KEY;
      else process.env.MY_CUSTOM_KEY = original;
    }
  });
});
