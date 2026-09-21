/**
 * Unit tests for Outbox — offline mutation queue with deduplication and backoff
 *
 * Run: bun test apps/runner/__tests__/unit/outbox.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';

// outbox.ts resolves `BUILDD_HOME || homedir()/.buildd` at import time, so this
// has to be set before the dynamic import below. scripts/run-unit-tests.ts
// normally injects it per test process; the fallback keeps a bare
// `bun test <file>` pointed somewhere harmless. 'fs' is mocked in this file, so
// nothing is created on disk either way.
process.env.BUILDD_HOME ??= join(tmpdir(), `buildd-outbox-test-${process.pid}`);

// In-memory fs mock
let mockFs: Record<string, string> = {};
let mkdirCalls: string[] = [];

mock.module('fs', () => ({
  existsSync: (path: string) => path in mockFs,
  readFileSync: (path: string) => {
    if (!(path in mockFs)) throw new Error('ENOENT');
    return mockFs[path];
  },
  writeFileSync: (path: string, data: string) => {
    mockFs[path] = data;
  },
  mkdirSync: (path: string, _opts?: any) => {
    mkdirCalls.push(path);
  },
}));

// Must import after mock.module
const { Outbox } = await import('../../src/outbox');

/**
 * The path outbox.ts itself resolved: `BUILDD_HOME || homedir()/.buildd`.
 *
 * These tests used to rebuild it from `process.env.HOME`, which happened to
 * agree only because nothing set BUILDD_HOME. scripts/run-unit-tests.ts now
 * gives every test process its own throwaway home, so the env var is the single
 * source of truth — and reading it here, rather than the real home, is what
 * keeps this file off scripts/test-home-isolation.test.ts's offender list.
 */
const OUTBOX_FILE = `${process.env.BUILDD_HOME}/outbox.json`;

describe('Outbox', () => {
  beforeEach(() => {
    mockFs = {};
    mkdirCalls = [];
  });

  describe('shouldQueue', () => {
    test('queues PATCH worker updates', () => {
      const outbox = new Outbox();
      expect(outbox.shouldQueue('PATCH', '/api/workers/w123')).toBe(true);
    });

    test('queues POST memory saves', () => {
      const outbox = new Outbox();
      expect(outbox.shouldQueue('POST', '/api/workspaces/ws1/memory')).toBe(true);
    });

    test('queues POST plan submissions', () => {
      const outbox = new Outbox();
      expect(outbox.shouldQueue('POST', '/api/workers/w1/plan')).toBe(true);
    });

    test('rejects GET requests', () => {
      const outbox = new Outbox();
      expect(outbox.shouldQueue('GET', '/api/workers/w123')).toBe(false);
    });

    test('rejects claim requests', () => {
      const outbox = new Outbox();
      expect(outbox.shouldQueue('POST', '/api/workers/claim')).toBe(false);
    });

    test('rejects non-worker PATCH endpoints', () => {
      const outbox = new Outbox();
      // e.g. PATCH to a sub-resource like /api/workers/w123/cmd
      expect(outbox.shouldQueue('PATCH', '/api/workers/w123/cmd')).toBe(false);
    });
  });

  describe('enqueue', () => {
    test('adds entry and persists to disk', () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', JSON.stringify({ status: 'running' }));

      expect(outbox.count()).toBe(1);
      const entries = outbox.getEntries();
      expect(entries[0].method).toBe('PATCH');
      expect(entries[0].endpoint).toBe('/api/workers/w1');
      expect(entries[0].retries).toBe(0);
    });

    test('deduplicates PATCH to same endpoint — keeps latest', () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', JSON.stringify({ status: 'running' }));
      outbox.enqueue('PATCH', '/api/workers/w1', JSON.stringify({ status: 'completed' }));

      expect(outbox.count()).toBe(1);
      const entries = outbox.getEntries();
      expect(entries[0].body).toContain('completed');
    });

    test('keeps separate entries for different endpoints', () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');
      outbox.enqueue('PATCH', '/api/workers/w2', '{}');

      expect(outbox.count()).toBe(2);
    });

    test('skips enqueueing for non-queuable requests', () => {
      const outbox = new Outbox();
      outbox.enqueue('GET', '/api/tasks', undefined);

      expect(outbox.count()).toBe(0);
    });
  });

  describe('flush', () => {
    test('returns early with zeros when no handler set', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');
      const result = await outbox.flush();
      expect(result).toEqual({ flushed: 0, failed: 0, remaining: 1 });
    });

    test('flushes successfully and removes entries', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');
      outbox.enqueue('POST', '/api/workspaces/ws1/memory', '{}');

      outbox.setFlushHandler(async () => true);
      const result = await outbox.flush();

      expect(result.flushed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.remaining).toBe(0);
      expect(outbox.count()).toBe(0);
    });

    test('increments retries on failure and keeps entries', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      outbox.setFlushHandler(async () => false);
      const result = await outbox.flush();

      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
      expect(outbox.getEntries()[0].retries).toBe(1);
    });

    test('drops entries after 10 retries', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      // Simulate 10 failed flushes
      outbox.setFlushHandler(async () => false);
      for (let i = 0; i < 10; i++) {
        await outbox.flush();
      }

      // The 10th flush should drop the entry
      expect(outbox.count()).toBe(0);
    });

    test('handles exceptions from flush handler same as failure', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      outbox.setFlushHandler(async () => { throw new Error('network error'); });
      const result = await outbox.flush();

      expect(result.remaining).toBe(1);
      expect(outbox.getEntries()[0].retries).toBe(1);
    });
  });

  describe('backoff', () => {
    test('doubles interval on failure', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      outbox.setFlushHandler(async () => false);
      await outbox.flush();

      // Access private flushInterval to verify backoff
      expect((outbox as any).flushInterval).toBe(60_000); // 30s * 2
    });

    test('resets interval on success', async () => {
      const outbox = new Outbox();

      // First: fail to increase backoff
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');
      outbox.setFlushHandler(async () => false);
      await outbox.flush();
      expect((outbox as any).flushInterval).toBe(60_000);

      // Then: succeed to reset
      outbox.setFlushHandler(async () => true);
      await outbox.flush();
      expect((outbox as any).flushInterval).toBe(30_000);
    });

    test('caps interval at 5 minutes', async () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      outbox.setFlushHandler(async () => false);
      // Flush many times to hit cap
      for (let i = 0; i < 20; i++) {
        // Re-add since it may get dropped
        if (outbox.count() === 0) {
          outbox.enqueue('PATCH', '/api/workers/w1', '{}');
        }
        await outbox.flush();
      }

      expect((outbox as any).flushInterval).toBeLessThanOrEqual(300_000);
    });
  });

  describe('persistence', () => {
    test('loads entries from disk on construction', () => {
      // Pre-populate the mock outbox file at the path the module resolved
      mockFs[OUTBOX_FILE] = JSON.stringify({
        entries: [
          { id: 'old-1', method: 'PATCH', endpoint: '/api/workers/w1', timestamp: Date.now(), retries: 2 },
        ],
        updatedAt: Date.now(),
      });

      const outbox = new Outbox();
      expect(outbox.count()).toBe(1);
      expect(outbox.getEntries()[0].id).toBe('old-1');
      expect(outbox.getEntries()[0].retries).toBe(2);
    });

    test('handles corrupt JSON gracefully', () => {
      mockFs[OUTBOX_FILE] = '{not valid json!!!';

      const outbox = new Outbox();
      expect(outbox.count()).toBe(0);
    });

    test('handles missing file gracefully', () => {
      const outbox = new Outbox();
      expect(outbox.count()).toBe(0);
    });
  });

  describe('clear', () => {
    test('empties queue and persists', () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');
      outbox.enqueue('PATCH', '/api/workers/w2', '{}');
      expect(outbox.count()).toBe(2);

      outbox.clear();
      expect(outbox.count()).toBe(0);
      expect(outbox.getEntries()).toEqual([]);
    });
  });

  describe('getEntries', () => {
    test('returns a copy (not internal reference)', () => {
      const outbox = new Outbox();
      outbox.enqueue('PATCH', '/api/workers/w1', '{}');

      const entries = outbox.getEntries();
      entries.pop(); // mutate the returned array

      expect(outbox.count()).toBe(1); // internal state unchanged
    });
  });
});
