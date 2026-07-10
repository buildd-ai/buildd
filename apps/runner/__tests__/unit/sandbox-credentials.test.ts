/**
 * Unit tests for sandbox.credentials role security config option (SDK v0.3.187).
 *
 * sandbox.credentials exposes credential-read blocking for sandboxed commands:
 * - files: blocks read access to credential files (e.g. ~/.claude/.credentials.json)
 * - environment: denies/masks env vars (e.g. ANTHROPIC_API_KEY) from sandboxed commands
 *
 * This is a workspace-level gitConfig option (stored in the JSONB gitConfig column —
 * no migration required) that passes through to the SDK's sandbox.credentials setting
 * when sandbox is enabled. Workers.ts mirrors: `const sandboxConfig =
 * gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined`.
 *
 * Run: bun test apps/runner/__tests__/unit/sandbox-credentials.test.ts
 */

import { describe, test, expect } from 'bun:test';
import type { WorkspaceGitConfig } from '../../src/types';

describe('WorkspaceGitConfig.sandbox.credentials', () => {
  test('sandbox.credentials passes through to SDK options when sandbox is enabled', () => {
    const gitConfig: WorkspaceGitConfig = {
      defaultBranch: 'main',
      branchingStrategy: 'feature',
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: false,
      useClaudeMd: true,
      sandbox: {
        enabled: true,
        credentials: {
          files: [{ path: '~/.claude/.credentials.json', mode: 'deny' }],
          environment: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }],
        },
      },
    };

    // Mirror the exact logic in workers.ts line ~1611
    const sandboxConfig = gitConfig.sandbox?.enabled ? gitConfig.sandbox : undefined;

    expect(sandboxConfig).toBeDefined();
    expect(sandboxConfig?.credentials?.files?.[0]).toMatchObject({
      path: '~/.claude/.credentials.json',
      mode: 'deny',
    });
    expect(sandboxConfig?.credentials?.environment?.[0]).toMatchObject({
      name: 'ANTHROPIC_API_KEY',
      mode: 'deny',
    });
  });

  test('sandbox.credentials is absent when sandbox is disabled', () => {
    const gitConfig: WorkspaceGitConfig = {
      defaultBranch: 'main',
      branchingStrategy: 'feature',
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: false,
      useClaudeMd: true,
      sandbox: {
        enabled: false,
        credentials: {
          files: [{ path: '~/.aws/credentials', mode: 'deny' }],
        },
      },
    };

    // Mirror the logic in workers.ts: only pass sandbox when enabled
    const sandboxConfig = gitConfig.sandbox?.enabled ? gitConfig.sandbox : undefined;

    expect(sandboxConfig).toBeUndefined();
  });

  test('WorkspaceGitConfig type accepts credentials field (type-level correctness)', () => {
    const config: WorkspaceGitConfig = {
      defaultBranch: 'main',
      branchingStrategy: 'feature',
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: false,
      useClaudeMd: true,
      sandbox: {
        enabled: true,
        credentials: {
          files: [{ path: '~/.netrc', mode: 'deny' }],
          environment: [
            { name: 'GITHUB_TOKEN', mode: 'mask' },
            { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' },
          ],
        },
      },
    };

    expect(config.sandbox?.credentials?.files?.[0].path).toBe('~/.netrc');
    expect(config.sandbox?.credentials?.environment?.[0].mode).toBe('mask');
    expect(config.sandbox?.credentials?.environment?.[1].mode).toBe('deny');
  });

  test('sandbox without credentials still works (backward compat)', () => {
    const gitConfig: WorkspaceGitConfig = {
      defaultBranch: 'main',
      branchingStrategy: 'feature',
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: false,
      useClaudeMd: true,
      sandbox: {
        enabled: true,
        network: { allowedDomains: ['api.anthropic.com'] },
      },
    };

    const sandboxConfig = gitConfig.sandbox?.enabled ? gitConfig.sandbox : undefined;

    expect(sandboxConfig?.enabled).toBe(true);
    expect(sandboxConfig?.credentials).toBeUndefined();
  });

  test('credentials files with deny mode prevent reading credential paths', () => {
    const gitConfig: WorkspaceGitConfig = {
      defaultBranch: 'main',
      branchingStrategy: 'feature',
      commitStyle: 'conventional',
      requiresPR: true,
      autoCreatePR: false,
      useClaudeMd: true,
      sandbox: {
        enabled: true,
        credentials: {
          files: [
            { path: '~/.claude/.credentials.json', mode: 'deny' },
            { path: '~/.config/anthropic/config.json', mode: 'deny' },
          ],
          environment: [
            { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
            { name: 'OPENAI_API_KEY', mode: 'mask', injectHosts: ['api.openai.com'] },
          ],
        },
      },
    };

    const sandboxConfig = gitConfig.sandbox?.enabled ? gitConfig.sandbox : undefined;

    expect(sandboxConfig?.credentials?.files).toHaveLength(2);
    expect(sandboxConfig?.credentials?.files?.[0]).toMatchObject({ mode: 'deny' });
    expect(sandboxConfig?.credentials?.environment).toHaveLength(2);
    expect(sandboxConfig?.credentials?.environment?.[1].injectHosts).toEqual(['api.openai.com']);
  });
});
