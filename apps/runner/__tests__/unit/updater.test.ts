/**
 * Unit tests for the auto-update module.
 *
 * Run: cd apps/runner && bun test __tests__/unit/updater.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { execSync } from 'child_process';

// Mock execSync before importing updater
const mockExecSync = mock(() => 'abc1234\n');
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Import after mocking
const { getCurrentCommit, checkForUpdate, applyUpdate } = await import('../../src/updater');

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
