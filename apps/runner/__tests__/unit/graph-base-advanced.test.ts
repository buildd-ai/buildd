import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `graph:base-advanced` — the runner half of Option A′'s codebase-graph
 * freshness.
 *
 * When a task PR merges into a mission integration branch the mission's base
 * has moved, so any seed keyed on that base ref is stale. The seed cache is a
 * directory on THIS host, so the web app can only send a notification; the
 * runner does the work.
 *
 * The whole path is advisory — the seed also refreshes on the next claim in the
 * mission — so what matters here is that it (a) refreshes with the right key
 * when it can, (b) stays silent rather than guessing when it cannot, and
 * (c) never throws into the Pusher callback, because an exception there takes
 * out the subscription that also delivers `task:assigned`.
 */

const refreshCalls: Array<{ repoPath: string; baseRef: string }> = [];
let refreshOutcome = 'spawned';
let refreshThrows = false;

mock.module('../../src/cbm-enforcement', () => ({
  refreshCbmSeedForBaseAdvance: (input: { repoPath: string; baseRef: string }) => {
    if (refreshThrows) throw new Error('spawn failed');
    refreshCalls.push(input);
    return refreshOutcome;
  },
}));

const { PusherManager } = await import('../../src/pusher-manager');

const WORKSPACE = { id: 'ws-1', name: 'demo-app', repo: 'https://github.com/example/demo-app' };

let resolvedPath: string | null = '/home/agent/project/demo-app';
let resolverThrows = false;
const resolveCalls: Array<{ id: string }> = [];

function makeManager() {
  // No pusherKey → `initialize()` is never called and no socket is opened.
  // We drive the handler directly, which is the unit under test.
  return new PusherManager(
    { pusherChannelPrefix: '', acceptRemoteTasks: true } as never,
    {} as never,
    {
      getWorkers: () => new Map(),
      emit: () => {},
      emitCommand: () => {},
      abort: async () => {},
      sendMessage: async () => {},
      rollback: async () => {},
      recover: async () => {},
      sendHeartbeat: () => {},
      claimPendingTasks: async () => {},
      claimAndStart: async () => null,
      getProbedWorkers: () => new Set<string>(),
      resolveRepoPath: (ws: { id: string }) => {
        resolveCalls.push({ id: ws.id });
        if (resolverThrows) throw new Error('resolver blew up');
        return resolvedPath;
      },
    } as never,
  );
}

/** Invoke the private handler the Pusher bind calls. */
function deliver(data: unknown, workspace = WORKSPACE) {
  const mgr = makeManager() as unknown as {
    handleBaseAdvanced: (ws: typeof WORKSPACE, d: unknown) => void;
  };
  mgr.handleBaseAdvanced(workspace, data);
}

beforeEach(() => {
  refreshCalls.length = 0;
  resolveCalls.length = 0;
  resolvedPath = '/home/agent/project/demo-app';
  resolverThrows = false;
  refreshThrows = false;
  refreshOutcome = 'spawned';
});

describe('handleBaseAdvanced', () => {
  it('refreshes the seed keyed on the advertised base ref and the local path', () => {
    deliver({ repoFullName: 'example/demo-app', baseRef: 'mission/checkout-arc-1a2b3c4d' });
    expect(refreshCalls).toEqual([
      { repoPath: '/home/agent/project/demo-app', baseRef: 'mission/checkout-arc-1a2b3c4d' },
    ]);
  });

  it('does nothing when the payload carries no base ref', () => {
    // Refreshing "the default slot" instead would rebuild the trunk seed in
    // response to a mission merge — useless, and misleading in the log.
    deliver({ repoFullName: 'example/demo-app' });
    expect(refreshCalls).toEqual([]);
    expect(resolveCalls).toEqual([]);
  });

  it('does nothing when baseRef is not a string', () => {
    deliver({ repoFullName: 'example/demo-app', baseRef: 42 });
    expect(refreshCalls).toEqual([]);
  });

  it('does nothing on an empty payload', () => {
    deliver({});
    deliver(null);
    deliver(undefined);
    expect(refreshCalls).toEqual([]);
  });

  it('stays silent when this runner has no checkout of the workspace', () => {
    // Every runner on the workspace channel receives the event; only the ones
    // holding a clone can act. A null path must not become a refresh of some
    // other directory.
    resolvedPath = null;
    deliver({ repoFullName: 'example/demo-app', baseRef: 'mission/checkout-arc-1a2b3c4d' });
    expect(resolveCalls).toEqual([{ id: 'ws-1' }]);
    expect(refreshCalls).toEqual([]);
  });

  it('does not throw when the resolver throws', () => {
    // An exception escaping here kills the workspace subscription, which also
    // delivers task:assigned — so a cache hint would stop the runner claiming.
    resolverThrows = true;
    expect(() =>
      deliver({ repoFullName: 'example/demo-app', baseRef: 'mission/checkout-arc-1a2b3c4d' }),
    ).not.toThrow();
    expect(refreshCalls).toEqual([]);
  });

  it('does not throw when the refresh itself throws', () => {
    refreshThrows = true;
    expect(() =>
      deliver({ repoFullName: 'example/demo-app', baseRef: 'mission/checkout-arc-1a2b3c4d' }),
    ).not.toThrow();
  });

  it('passes the workspace through so the path is resolved per workspace', () => {
    const other = { id: 'ws-2', name: 'other-app', repo: null };
    deliver({ repoFullName: 'example/other-app', baseRef: 'mission/other-99887766' }, other);
    expect(resolveCalls).toEqual([{ id: 'ws-2' }]);
  });
});
