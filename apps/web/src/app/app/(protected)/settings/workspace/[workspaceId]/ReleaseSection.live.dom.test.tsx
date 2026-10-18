/**
 * Spec 3ef37387 R-21: the release section refreshes on release:updated on its
 * workspace channel instead of polling every 10 s while a deploy builds; a
 * once-a-minute read is only the fallback.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type Handler = (data: unknown) => void;
const channels = new Map<string, Map<string, Handler[]>>();
function emit(channel: string, event: string, data: unknown) {
  for (const fn of channels.get(channel)?.get(event) ?? []) fn(data);
}
mock.module('@/lib/pusher-client', () => ({
  CHANNEL_PREFIX: '',
  subscribeToChannel: (name: string) => {
    const handlers = channels.get(name) ?? new Map<string, Handler[]>();
    channels.set(name, handlers);
    return {
      bind: (e: string, fn: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
      unbind: (e: string, fn: Handler) => handlers.set(e, (handlers.get(e) ?? []).filter(f => f !== fn)),
    };
  },
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ReleaseSection } = await import('./ReleaseSection');

// A deploy still building: the old section polled every 10 s for this.
const building = {
  lastRelease: { taskId: 'a', taskTitle: 'Task a', completedAt: '2026-10-12T10:00:00Z', releaseResult: { deployState: 'BUILDING' } },
  recentReleases: [],
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let reads = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  reads = 0;
  channels.clear();
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes('last-release')) { reads++; return new Response(JSON.stringify(building), { status: 200 }); }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function render() {
  await act(async () => {
    root.render(
      <ReleaseSection
        workspaceId="ws-1"
        teamId="team-1"
        initialReleaseConfig={{ enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev' } as never}
        effectiveTrigger="on_mission_complete"
        hasRepo
        canEdit
      />,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('ReleaseSection listens for release:updated', () => {
  it('a release:updated on the workspace channel re-reads the release history', async () => {
    await render();
    expect(reads).toBe(1);
    await act(async () => { emit('workspace-ws-1', 'release:updated', { releaseId: 'r-1' }); });
    await act(async () => { await new Promise(r => setTimeout(r, 700)); });
    expect(reads).toBe(2);
  });

  it('does not poll every 10 s while a deploy builds', async () => {
    await render();
    await act(async () => { await new Promise(r => setTimeout(r, 10_600)); });
    expect(reads).toBe(1);
  }, 15_000);
});
