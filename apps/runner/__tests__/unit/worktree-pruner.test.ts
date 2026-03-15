/**
 * Tests for worktree pruning logic.
 *
 * Uses a temporary directory to simulate repo structure with .buildd-worktrees/.
 * Mocks git commands to avoid requiring a real git repo.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to mock execSync before importing the module
import * as cp from 'child_process';

const originalExecSync = cp.execSync;
let execSyncCalls: Array<{ cmd: string; cwd?: string }> = [];
let execSyncMock: ReturnType<typeof spyOn>;

// Import after setup
import {
  gitWorktreePrune,
  pruneOrphanedWorktrees,
  pruneExpiredWorktrees,
  startupPrune,
  periodicPrune,
  type WorktreePruneOptions,
} from '../../src/worktree-pruner';

let tmpRepo: string;

function createWorktreeDir(name: string, ageMs?: number): string {
  const dir = join(tmpRepo, '.buildd-worktrees', name);
  mkdirSync(dir, { recursive: true });
  // Write a marker file so the directory isn't empty
  writeFileSync(join(dir, '.git'), 'gitdir: /fake');
  if (ageMs !== undefined) {
    const time = new Date(Date.now() - ageMs);
    utimesSync(dir, time, time);
  }
  return dir;
}

function makeWorkerMap(entries: Array<{ status: string; worktreePath?: string }>): Map<string, { status: string; worktreePath?: string }> {
  const map = new Map<string, { status: string; worktreePath?: string }>();
  for (let i = 0; i < entries.length; i++) {
    map.set(`worker-${i}`, entries[i]);
  }
  return map;
}

describe('worktree-pruner', () => {
  beforeEach(() => {
    tmpRepo = join(tmpdir(), `worktree-pruner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpRepo, '.buildd-worktrees'), { recursive: true });
    execSyncCalls = [];

    // Mock execSync to track calls and avoid real git operations
    execSyncMock = spyOn(cp, 'execSync').mockImplementation(((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd: cmd as string, cwd: opts?.cwd });
      // For `git worktree remove`, actually remove the directory (simulating real behavior)
      const removeMatch = (cmd as string).match(/git worktree remove --force "(.+)"/);
      if (removeMatch) {
        const path = removeMatch[1];
        if (existsSync(path)) {
          rmSync(path, { recursive: true, force: true });
        }
      }
      return '';
    }) as any);
  });

  afterEach(() => {
    execSyncMock.mockRestore();
    try {
      rmSync(tmpRepo, { recursive: true, force: true });
    } catch {}
  });

  describe('gitWorktreePrune', () => {
    test('runs git worktree prune in repo directory', () => {
      gitWorktreePrune(tmpRepo);
      expect(execSyncCalls).toEqual([
        { cmd: 'git worktree prune', cwd: tmpRepo },
      ]);
    });

    test('does not throw if git command fails', () => {
      execSyncMock.mockRestore();
      execSyncMock = spyOn(cp, 'execSync').mockImplementation(() => {
        throw new Error('git not found');
      });
      expect(() => gitWorktreePrune(tmpRepo)).not.toThrow();
    });
  });

  describe('pruneOrphanedWorktrees', () => {
    test('removes directories with no worker record', () => {
      createWorktreeDir('orphan-branch-1');
      createWorktreeDir('orphan-branch-2');
      const workers = makeWorkerMap([]);

      const removed = pruneOrphanedWorktrees(tmpRepo, workers);

      expect(removed).toBe(2);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'orphan-branch-1'))).toBe(false);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'orphan-branch-2'))).toBe(false);
    });

    test('keeps directories that have a worker record (any status)', () => {
      createWorktreeDir('active-branch');
      createWorktreeDir('done-branch');
      createWorktreeDir('orphan-branch');

      const workers = makeWorkerMap([
        { status: 'working', worktreePath: join(tmpRepo, '.buildd-worktrees', 'active-branch') },
        { status: 'done', worktreePath: join(tmpRepo, '.buildd-worktrees', 'done-branch') },
      ]);

      const removed = pruneOrphanedWorktrees(tmpRepo, workers);

      expect(removed).toBe(1);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'active-branch'))).toBe(true);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'done-branch'))).toBe(true);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'orphan-branch'))).toBe(false);
    });

    test('returns 0 when .buildd-worktrees does not exist', () => {
      rmSync(join(tmpRepo, '.buildd-worktrees'), { recursive: true, force: true });
      const workers = makeWorkerMap([]);
      expect(pruneOrphanedWorktrees(tmpRepo, workers)).toBe(0);
    });

    test('returns 0 when all directories have worker records', () => {
      createWorktreeDir('branch-a');
      const workers = makeWorkerMap([
        { status: 'error', worktreePath: join(tmpRepo, '.buildd-worktrees', 'branch-a') },
      ]);
      expect(pruneOrphanedWorktrees(tmpRepo, workers)).toBe(0);
    });
  });

  describe('pruneExpiredWorktrees', () => {
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();

    test('removes orphaned worktrees regardless of age', () => {
      createWorktreeDir('orphan-recent');
      const workers = makeWorkerMap([]);

      const removed = pruneExpiredWorktrees(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 24 * HOUR,
        now,
      });

      expect(removed).toBe(1);
    });

    test('removes expired worktrees for done/error workers', () => {
      createWorktreeDir('done-branch', 25 * HOUR); // 25h old
      createWorktreeDir('error-branch', 30 * HOUR); // 30h old

      const workers = makeWorkerMap([
        { status: 'done', worktreePath: join(tmpRepo, '.buildd-worktrees', 'done-branch') },
        { status: 'error', worktreePath: join(tmpRepo, '.buildd-worktrees', 'error-branch') },
      ]);

      const removed = pruneExpiredWorktrees(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 24 * HOUR,
        now,
      });

      expect(removed).toBe(2);
    });

    test('does NOT remove worktrees for active workers regardless of age', () => {
      createWorktreeDir('working-branch', 48 * HOUR);
      createWorktreeDir('waiting-branch', 48 * HOUR);
      createWorktreeDir('stale-branch', 48 * HOUR);

      const workers = makeWorkerMap([
        { status: 'working', worktreePath: join(tmpRepo, '.buildd-worktrees', 'working-branch') },
        { status: 'waiting', worktreePath: join(tmpRepo, '.buildd-worktrees', 'waiting-branch') },
        { status: 'stale', worktreePath: join(tmpRepo, '.buildd-worktrees', 'stale-branch') },
      ]);

      const removed = pruneExpiredWorktrees(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 24 * HOUR,
        now,
      });

      expect(removed).toBe(0);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'working-branch'))).toBe(true);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'waiting-branch'))).toBe(true);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'stale-branch'))).toBe(true);
    });

    test('does NOT remove non-expired worktrees for done workers', () => {
      createWorktreeDir('recent-done', 2 * HOUR); // 2h old, under 24h retention

      const workers = makeWorkerMap([
        { status: 'done', worktreePath: join(tmpRepo, '.buildd-worktrees', 'recent-done') },
      ]);

      const removed = pruneExpiredWorktrees(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 24 * HOUR,
        now,
      });

      expect(removed).toBe(0);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'recent-done'))).toBe(true);
    });

    test('uses custom retention period', () => {
      createWorktreeDir('short-lived', 2 * HOUR); // 2h old

      const workers = makeWorkerMap([
        { status: 'done', worktreePath: join(tmpRepo, '.buildd-worktrees', 'short-lived') },
      ]);

      const removed = pruneExpiredWorktrees(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 1 * HOUR, // 1h retention
        now,
      });

      expect(removed).toBe(1);
    });
  });

  describe('startupPrune', () => {
    test('runs git worktree prune then removes orphans', () => {
      createWorktreeDir('orphan');
      const workers = makeWorkerMap([]);

      startupPrune(tmpRepo, workers);

      // Should have called git worktree prune (start), git worktree remove, git worktree prune (end)
      const pruneCalls = execSyncCalls.filter(c => c.cmd === 'git worktree prune');
      expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'orphan'))).toBe(false);
    });
  });

  describe('periodicPrune', () => {
    const HOUR = 60 * 60 * 1000;

    test('combines orphan and expiry cleanup', () => {
      createWorktreeDir('orphan');
      createWorktreeDir('expired-done', 25 * HOUR);
      createWorktreeDir('active-working');

      const workers = makeWorkerMap([
        { status: 'done', worktreePath: join(tmpRepo, '.buildd-worktrees', 'expired-done') },
        { status: 'working', worktreePath: join(tmpRepo, '.buildd-worktrees', 'active-working') },
      ]);

      periodicPrune(tmpRepo, {
        activeWorkers: workers,
        retentionMs: 24 * HOUR,
      });

      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'orphan'))).toBe(false);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'expired-done'))).toBe(false);
      expect(existsSync(join(tmpRepo, '.buildd-worktrees', 'active-working'))).toBe(true);
    });
  });
});
