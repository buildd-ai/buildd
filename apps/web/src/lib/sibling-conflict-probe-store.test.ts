/**
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/sibling-conflict-probe-store.test.ts
 */
import { afterEach, describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/redis', () => ({ markDue: async () => {} }));
mock.module('@/lib/system-instruction-queue', () => ({ queueSystemInstruction: async () => true }));

const { siblingProbeHeartbeat } = await import('./sibling-conflict-probe-store');

function deps() {
  const seen = { loadProbe: 0, take: 0 };
  return {
    seen,
    deps: {
      loadProbe: async () => { seen.loadProbe++; return null; },
      takeRequests: async () => {
        seen.take++;
        return [{ id: 'p1', otherBranch: 'buildd/b', mergiraf: false, sharedFiles: ['x.ts'] }];
      },
    } as any,
  };
}

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('siblingProbeHeartbeat', () => {
  it('applies results, marks the workspace due on new touches, and hands out probes to a runner that supports them', async () => {
    const d = deps();
    const due: string[] = [];
    const out = await siblingProbeHeartbeat({
      workerId: 'a', workspaceId: 'ws', results: [{ probeId: 'p0', outcome: 'clean' }],
      supportsProbe: true, touchesMoved: true, terminal: false, deps: d.deps,
      markDue: async (job, member) => { due.push(`${job}:${member}`); },
    });
    expect(d.seen.loadProbe).toBe(1);
    expect(due).toEqual(['sibling-probe:ws']);
    expect(out).toEqual([{ probeId: 'p1', otherBranch: 'buildd/b', sharedFiles: ['x.ts'], mergiraf: false }]);
  });

  it('an older runner (no support flag) is never handed a probe, and no touches means not due', async () => {
    const d = deps();
    const due: string[] = [];
    const out = await siblingProbeHeartbeat({
      workerId: 'a', workspaceId: 'ws', results: undefined, supportsProbe: false, touchesMoved: false, terminal: false,
      deps: d.deps, markDue: async (job) => { due.push(job); },
    });
    expect(out).toEqual([]);
    expect(d.seen.take).toBe(0);
    expect(due).toEqual([]);
  });

  it('a terminal heartbeat takes no probe and marks nothing due', async () => {
    const d = deps();
    const due: string[] = [];
    expect(await siblingProbeHeartbeat({
      workerId: 'a', workspaceId: 'ws', results: undefined, supportsProbe: true, touchesMoved: true, terminal: true,
      deps: d.deps, markDue: async (job) => { due.push(job); },
    })).toEqual([]);
    expect(d.seen.take).toBe(0);
    expect(due).toEqual([]);
  });

  it('never throws, and SIBLING_PROBE_ENABLED=0 turns it off', async () => {
    const d = deps();
    d.deps.takeRequests = async () => { throw new Error('db down'); };
    expect(await siblingProbeHeartbeat({ workerId: 'a', workspaceId: 'ws', results: undefined, supportsProbe: true, touchesMoved: false, terminal: false, deps: d.deps })).toEqual([]);
    process.env.SIBLING_PROBE_ENABLED = '0';
    expect(await siblingProbeHeartbeat({ workerId: 'a', workspaceId: 'ws', results: undefined, supportsProbe: true, touchesMoved: false, terminal: false, deps: deps().deps })).toEqual([]);
  });
});
