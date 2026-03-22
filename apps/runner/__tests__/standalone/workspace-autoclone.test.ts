/**
 * Auto-clone tests for workspace resolution.
 *
 * In standalone/ because unit/ test files mock.module('fs') which
 * poisons workspace.ts's real fs operations.
 *
 * Run: bun test __tests__/standalone/workspace-autoclone.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { createWorkspaceResolver } from '../../src/workspace';

function makeTmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `buildd-test-${label}-`));
}

function cleanup(dir: string) {
  execSync(`rm -rf "${dir}"`);
}

describe('Auto-Clone on Resolution Failure', () => {
  test('workspace with repo URL should auto-clone when no local match found', () => {
    const tmpRoot = makeTmpRoot('autoclone');

    try {
      const resolver = createWorkspaceResolver(tmpRoot);

      const result = resolver.resolve({
        id: 'ws-new',
        name: 'reddit-filter-safari',
        repo: 'https://github.com/maxjacu/reddit-filter-safari.git',
      });

      expect(result).not.toBeNull();
      expect(result).toContain('reddit-filter-safari');
      expect(existsSync(result!)).toBe(true);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('auto-clone should invalidate git cache so repo is discoverable on next resolve', () => {
    const tmpRoot = makeTmpRoot('autoclone-cache');

    try {
      const resolver = createWorkspaceResolver(tmpRoot);

      const result1 = resolver.resolve({
        id: 'ws-cache-test',
        name: 'reddit-filter-safari',
        repo: 'https://github.com/maxjacu/reddit-filter-safari.git',
      });
      expect(result1).not.toBeNull();

      // Second resolve should find it via name match (repo already on disk)
      const result2 = resolver.resolve({
        id: 'ws-cache-test',
        name: 'reddit-filter-safari',
        repo: 'https://github.com/maxjacu/reddit-filter-safari.git',
      });
      expect(result2).toBe(result1);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('auto-clone should NOT happen for workspaces without repo URL', () => {
    const tmpRoot = makeTmpRoot('noclone');

    try {
      const resolver = createWorkspaceResolver(tmpRoot);

      const result = resolver.resolve({
        id: 'ws-norepo',
        name: 'my-local-project',
        repo: null,
      });

      expect(result).not.toBeNull();
      expect(result).toContain('my-local-project');
      expect(existsSync(join(result!, '.git'))).toBe(false);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('auto-clone should use repo name from URL as directory name', () => {
    const tmpRoot = makeTmpRoot('dirname');

    try {
      const resolver = createWorkspaceResolver(tmpRoot);

      const result = resolver.resolve({
        id: 'ws-dirname',
        name: 'Some Custom Name',
        repo: 'https://github.com/maxjacu/reddit-filter-safari.git',
      });

      expect(result).not.toBeNull();
      expect(result!.endsWith('reddit-filter-safari')).toBe(true);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('debugResolve should show auto-clone attempt in attempts list', () => {
    const tmpRoot = makeTmpRoot('debug');

    try {
      const resolver = createWorkspaceResolver(tmpRoot);

      const debug = resolver.debugResolve({
        id: 'ws-debug',
        name: 'reddit-filter-safari',
        repo: 'https://github.com/maxjacu/reddit-filter-safari.git',
      });

      const cloneAttempt = debug.attemptedPaths.find(a => a.method === 'auto-clone');
      expect(cloneAttempt).toBeDefined();
      expect(cloneAttempt!.exists).toBe(true);
    } finally {
      cleanup(tmpRoot);
    }
  });
});
