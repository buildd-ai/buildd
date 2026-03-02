import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Mock child_process.execSync
const mockExecSync = mock((cmd: string) => Buffer.from(''));
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Mock fs.readFileSync
const mockReadFileSync = mock((path: string) => '');
mock.module('fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: () => true,
}));

import { scanEnvironment, type ScanConfig } from './env-scan';

describe('scanEnvironment', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();

    // Default: all `which` checks fail (no tools found)
    mockExecSync.mockImplementation((cmd: string) => {
      throw new Error('not found');
    });

    // Default: no MCP settings files
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
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
      if (typeof path === 'string' && path.includes('.claude/settings.json')) {
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
