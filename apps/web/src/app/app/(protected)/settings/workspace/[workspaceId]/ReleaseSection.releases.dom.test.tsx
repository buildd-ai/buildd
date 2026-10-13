/**
 * Settings spec R-9 / AC-10: Recent releases lists releases that ran; skipped
 * ones fold into one line that expands on tap.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ReleaseSection } = await import('./ReleaseSection');

const release = (taskId: string, status: string, completedAt: string) => ({
  taskId, taskTitle: `Task ${taskId}`, missionId: null, completedAt, deployState: null, deployUrl: null, status, sha: null,
});
const recentReleases = [
  release('a', 'skipped', '2026-10-12T10:00:00Z'),
  release('b', 'completed', '2026-10-12T09:00:00Z'),
  release('c', 'skipped', '2026-10-11T10:00:00Z'),
  release('d', 'failed', '2026-10-11T09:00:00Z'),
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async (url: string) =>
    new Response(JSON.stringify(String(url).includes('last-release') ? { lastRelease: null, recentReleases } : {}), { status: 200 }),
  ) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const rows = () => [...host.querySelectorAll('[data-testid="recent-release-row"]')].map(r => r.textContent ?? '');

describe('ReleaseSection recent releases', () => {
  it('lists releases that ran, and folds the skipped ones into one line', async () => {
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

    expect(rows()).toHaveLength(2);
    expect(rows().some(t => t.includes('Task a') || t.includes('Task c'))).toBe(false);
    const fold = host.querySelector('[data-testid="recent-releases-skipped"]') as HTMLButtonElement;
    expect(fold.textContent).toMatch(/^2 skipped since /);
    expect(fold.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { fold.click(); });
    expect(rows()).toHaveLength(4);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
  });
});
