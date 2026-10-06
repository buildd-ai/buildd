/**
 * `--attach-orphan` (run-attach.ts): the agent restarted while this container
 * kept running. It cannot re-open the exec stream of the runner it started, so
 * it execs this to wait on that runner and report its exit code.
 */
import { describe, expect, test } from 'bun:test';
import { EXIT_NOT_ATTACHABLE, runAttachOrphan, type AttachDeps } from '../../src/run-attach';
import { parseOnceArgs } from '../../src/run-once';

function deps(over: Partial<AttachDeps> & { exitAfterPolls?: number; code?: number } = {}): AttachDeps & { logs: string[] } {
  let polls = 0;
  const logs: string[] = [];
  return {
    readPid: () => 4242,
    readExit: () => (over.exitAfterPolls !== undefined && polls++ >= over.exitAfterPolls ? (over.code ?? 0) : null),
    isAlive: () => true,
    sleep: async () => {},
    log: (m) => logs.push(m),
    pollMs: 1,
    graceMs: 3,
    ...over,
    logs,
  };
}

describe('runAttachOrphan', () => {
  test('waits for the live runner and returns its recorded exit code', async () => {
    const d = deps({ exitAfterPolls: 3, code: 0 });
    expect(await runAttachOrphan({ workerId: 'w-1' }, d)).toBe(0);
  });

  test('passes a parked exit through unchanged', async () => {
    expect(await runAttachOrphan({ workerId: 'w-1' }, deps({ exitAfterPolls: 0, code: 4 }))).toBe(4);
  });

  test('a runner that already finished while the agent was away: its code, no waiting', async () => {
    const d = deps({ readExit: () => 1, isAlive: () => false });
    expect(await runAttachOrphan({ workerId: 'w-1' }, d)).toBe(1);
  });

  test('no pid record: not attachable', async () => {
    expect(await runAttachOrphan({ workerId: 'w-1' }, deps({ readPid: () => null }))).toBe(EXIT_NOT_ATTACHABLE);
  });

  test('runner gone with no exit record (killed): not attachable after a grace read', async () => {
    let reads = 0;
    const d = deps({ isAlive: () => false, readExit: () => (reads++ >= 99 ? 0 : null) });
    expect(await runAttachOrphan({ workerId: 'w-1' }, d)).toBe(EXIT_NOT_ATTACHABLE);
    expect(reads).toBeGreaterThan(1);
  });

  test('exit record that lands just after the process vanishes is still picked up', async () => {
    let reads = 0;
    const d = deps({ isAlive: () => false, readExit: () => (++reads >= 3 ? 0 : null) });
    expect(await runAttachOrphan({ workerId: 'w-1' }, d)).toBe(0);
  });
});

describe('parseOnceArgs --attach-orphan', () => {
  test('--attach-orphan <id> --task <id>', () => {
    expect(parseOnceArgs(['bun', 'i.ts', '--once', '--attach-orphan', 'w-1', '--task', 't-1']))
      .toEqual({ once: true, taskId: 't-1', attachOrphanWorkerId: 'w-1' });
    expect('error' in parseOnceArgs(['bun', 'i.ts', '--once', '--attach-orphan', 'w-1'])).toBe(true);
    expect('error' in parseOnceArgs(['bun', 'i.ts', '--once', '--attach-orphan', 'w', '--park-orphan', 'w', '--task', 't'])).toBe(true);
  });
});
