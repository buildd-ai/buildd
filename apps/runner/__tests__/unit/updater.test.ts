/**
 * Unit tests for the auto-update module.
 *
 * Run: cd apps/runner && bun test __tests__/unit/updater.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach, beforeAll } from 'bun:test';
import { join } from 'path';

// Mock execSync before importing updater
const mockExecSync = mock(() => 'abc1234\n');
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Import after mocking
const { getCurrentCommit, checkForUpdate, applyUpdate, pruneStaleSdkVersions } = await import('../../src/updater');

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
  });

  test('returns success when commands succeed', () => {
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      callCount++;
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) {
        return callCount <= 1 ? 'old_sha\n' : 'new_sha\n';
      }
      return '';
    });

    const result = applyUpdate();
    expect(result.success).toBe(true);
  });

  test('returns failure when git fetch fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('fetch')) {
        throw new Error('network error');
      }
      return 'abc1234\n';
    });

    const result = applyUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
  });
});

describe('pruneStaleSdkVersions', () => {
  // This test exercises real symlink resolution, so it needs the real `fs`. Other
  // files in the runner unit suite install leaky `mock.module('fs', ...)` mocks
  // that persist into this file, so we clear them and grab the real modules here,
  // then inject the real `fs` into pruneStaleSdkVersions. Runs after the mocked
  // applyUpdate tests above, so their child_process mock is already spent.
  let fs: typeof import('fs');
  let root: string;

  beforeAll(() => {
    mock.restore();
    fs = require('fs');
  });

  const bunStore = () => join(root, 'node_modules', '.bun');

  /**
   * Creates a store version dir with a real package at
   * `.bun/<versionDir>/node_modules/@anthropic-ai/<pkgName>` and returns that path.
   */
  function makeStorePkg(versionDir: string, pkgName: string): string {
    const dir = join(bunStore(), versionDir, 'node_modules', '@anthropic-ai', pkgName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'package.json'), '{}');
    return dir;
  }

  /** Symlinks an app/package's sdk consumer link to a target store path. */
  function linkConsumer(group: string, member: string, target: string) {
    const nm = join(root, group, member, 'node_modules', '@anthropic-ai');
    fs.mkdirSync(nm, { recursive: true });
    fs.symlinkSync(target, join(nm, 'claude-agent-sdk'));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(join(require('os').tmpdir(), 'updater-prune-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns empty result when the store does not exist', () => {
    const result = pruneStaleSdkVersions(root, fs);
    expect(result).toEqual({ pruned: [], kept: [] });
  });

  test('keeps referenced version + native-binary dirs and deletes only stale sdk dirs', () => {
    const liveVer = '@anthropic-ai+claude-agent-sdk@0.3.201';
    const liveBin = '@anthropic-ai+claude-agent-sdk-linux-arm64@0.3.201';
    const staleVer = '@anthropic-ai+claude-agent-sdk@0.3.183';
    const staleBin = '@anthropic-ai+claude-agent-sdk-linux-arm64@0.3.183';
    const unrelated = 'zod@4.3.6';

    // Live version dir + its native binary dir, wired via symlink.
    const liveSdk = makeStorePkg(liveVer, 'claude-agent-sdk');
    const liveBinReal = makeStorePkg(liveBin, 'claude-agent-sdk-linux-arm64');
    fs.symlinkSync(liveBinReal, join(bunStore(), liveVer, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-arm64'));

    // Stale dirs (orphaned by a prior SDK bump) — should be deleted.
    makeStorePkg(staleVer, 'claude-agent-sdk');
    makeStorePkg(staleBin, 'claude-agent-sdk-linux-arm64');

    // Unrelated package — must never be touched.
    makeStorePkg(unrelated, 'zod');

    // Two live consumers pointing at the current version.
    linkConsumer('apps', 'runner', liveSdk);
    linkConsumer('packages', 'core', liveSdk);

    const { pruned, kept } = pruneStaleSdkVersions(root, fs);

    expect(new Set(kept)).toEqual(new Set([liveVer, liveBin]));
    expect(new Set(pruned)).toEqual(new Set([staleVer, staleBin]));

    expect(fs.existsSync(join(bunStore(), liveVer))).toBe(true);
    expect(fs.existsSync(join(bunStore(), liveBin))).toBe(true);
    expect(fs.existsSync(join(bunStore(), staleVer))).toBe(false);
    expect(fs.existsSync(join(bunStore(), staleBin))).toBe(false);
    expect(fs.existsSync(join(bunStore(), unrelated))).toBe(true);
  });

  test('deletes nothing when the keep-set is empty (broken/half-installed tree)', () => {
    // Store has sdk dirs but no live consumer symlink resolves.
    makeStorePkg('@anthropic-ai+claude-agent-sdk@0.3.201', 'claude-agent-sdk');
    makeStorePkg('@anthropic-ai+claude-agent-sdk@0.3.183', 'claude-agent-sdk');
    // A dangling consumer link (target missing) must not seed the keep-set.
    linkConsumer('apps', 'runner', join(bunStore(), 'does-not-exist'));

    const { pruned, kept } = pruneStaleSdkVersions(root, fs);

    expect(kept).toEqual([]);
    expect(pruned).toEqual([]);
    expect(fs.existsSync(join(bunStore(), '@anthropic-ai+claude-agent-sdk@0.3.201'))).toBe(true);
    expect(fs.existsSync(join(bunStore(), '@anthropic-ai+claude-agent-sdk@0.3.183'))).toBe(true);
  });
});
