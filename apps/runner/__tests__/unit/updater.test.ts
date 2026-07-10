/**
 * Unit tests for the auto-update module.
 *
 * Run: cd apps/runner && bun test __tests__/unit/updater.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';

// Clear any leaked module mocks from earlier-loaded suite files so the updater
// (imported below) and our scaffolding both bind to the REAL fs. Only
// child_process is mocked, so the git/bun commands are no-ops and the sole real
// side effect is fs.rmSync on node_modules — which lets us assert the
// clean-reinstall behaviour for real by pointing applyUpdate at a temp dir.
mock.restore();
const nodeFs = require('fs') as typeof import('fs');
const TMP_HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'updater-home-'));

const mockExecSync = mock(() => 'abc1234\n');
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Import after mocking
const { getCurrentCommit, checkForUpdate, applyUpdate } = await import('../../src/updater');

const NODE_MODULES = join(TMP_HOME, 'node_modules');

afterAll(() => {
  nodeFs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('getCurrentCommit', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  test('returns trimmed SHA from git rev-parse', () => {
    mockExecSync.mockReturnValue('abc1234def5678\n');
    const result = getCurrentCommit();
    expect(result).toBe('abc1234def5678');
    expect(mockExecSync).toHaveBeenCalledWith('git rev-parse HEAD', expect.objectContaining({
      encoding: 'utf-8',
    }));
  });

  test('returns null when git command fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    const result = getCurrentCommit();
    expect(result).toBeNull();
  });
});

describe('checkForUpdate', () => {
  test('returns true when SHAs differ', () => {
    expect(checkForUpdate('abc1234', 'def5678')).toBe(true);
  });

  test('returns false when SHAs match', () => {
    expect(checkForUpdate('abc1234', 'abc1234')).toBe(false);
  });

  test('returns false when current is null', () => {
    expect(checkForUpdate(null, 'abc1234')).toBe(false);
  });

  test('returns false when latest is null', () => {
    expect(checkForUpdate('abc1234', null)).toBe(false);
  });

  test('returns false when both are null', () => {
    expect(checkForUpdate(null, null)).toBe(false);
  });
});

describe('applyUpdate', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    // Rebuild a node_modules tree (with a stale .bun store dir) that the clean
    // reinstall is expected to blow away.
    nodeFs.rmSync(NODE_MODULES, { recursive: true, force: true });
    nodeFs.mkdirSync(join(NODE_MODULES, '.bun', '@aws-sdk+client-s3@3.1.0'), { recursive: true });
  });

  test('clean-reinstalls: removes node_modules before a frozen bun install', () => {
    const commands: string[] = [];
    let nodeModulesPresentAtInstall: boolean | null = null;
    mockExecSync.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (typeof cmd === 'string' && cmd.includes('bun install')) {
        // Ordering guarantee: node_modules must already be gone by install time.
        nodeModulesPresentAtInstall = nodeFs.existsSync(NODE_MODULES);
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return 'sha\n';
      return '';
    });

    const result = applyUpdate(TMP_HOME, nodeFs);

    expect(result.success).toBe(true);
    // The install step is a frozen (fail-fast) install.
    expect(commands.some(c => c.includes('bun install --frozen-lockfile'))).toBe(true);
    // rm happened strictly before the install ran...
    expect(nodeModulesPresentAtInstall).toBe(false);
    // ...and (since the mocked install is a no-op) the tree stays removed.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(false);
  });

  test('verifies bun is runnable before removing node_modules', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bun --version')) {
        throw new Error('bun: command not found');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return 'sha\n';
      return '';
    });

    const result = applyUpdate(TMP_HOME, nodeFs);

    expect(result.success).toBe(false);
    expect(result.error).toContain('bun: command not found');
    // A broken bun must not leave us with a wiped tree.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(true);
  });

  test('returns failure without throwing when bun install fails after the rm', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bun install')) {
        throw new Error('lockfile out of sync');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return 'sha\n';
      return '';
    });

    let result: any;
    // Preserve the contract the caller relies on: a failed reinstall never throws
    // (so the live process keeps serving) and reports success:false (so no exit 75).
    expect(() => { result = applyUpdate(TMP_HOME, nodeFs); }).not.toThrow();
    expect(result.success).toBe(false);
    expect(result.error).toContain('lockfile out of sync');
  });

  test('returns failure when git fetch fails (node_modules untouched)', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('fetch')) {
        throw new Error('network error');
      }
      return 'abc1234\n';
    });

    const result = applyUpdate(TMP_HOME, nodeFs);
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
    // Failure occurred before the rm, so node_modules is intact.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(true);
  });
});
