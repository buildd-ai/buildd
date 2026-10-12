/**
 * Settings › Features › Task estimates: an owner/admin turns estimates on or
 * off for the team (PATCH /api/teams/[id]); a member sees the state only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/features', width: 390, height: 844 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => {
    const React = require('react');
    return React.createElement('a', { href, ...rest }, children);
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskEstimatesFeature, taskEstimatesStatusLine } = await import('./TaskEstimatesFeature');

const TEAM = '11111111-1111-4111-8111-111111111111';
const OFF_DEFAULT = { enabled: false, source: 'default' as const, defaultOn: false };

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render(props: Partial<Parameters<typeof TaskEstimatesFeature>[0]> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<TaskEstimatesFeature teamId={TEAM} initial={OFF_DEFAULT} canManage defaultOffReason="Not on by default yet." {...props} />);
  });
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('TaskEstimatesFeature', () => {
  it('an admin turns it on with one PATCH; the state says the team chose', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await render();
    expect(q('task-estimates-state')!.textContent).toBe('Off (the default)');
    await act(async () => { q('task-estimates-toggle')!.click(); });
    expect(calls).toEqual([{ url: `/api/teams/${TEAM}`, body: { taskEstimates: { enabled: true } } }]);
    expect(q('task-estimates-state')!.textContent).toBe('On, turned on by your team');
    expect(q('task-estimates-toggle')!.textContent).toBe('Turn off');
    expect(host.querySelector('a[href="/app/health/estimates"]')).not.toBeNull();
  });

  it('a refused save keeps the old state and says why', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })) as unknown as typeof fetch;
    await render();
    await act(async () => { q('task-estimates-toggle')!.click(); });
    expect(q('task-estimates-state')!.textContent).toBe('Off (the default)');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Forbidden');
  });

  it('a member sees the state and no control', async () => {
    await render({ canManage: false, initial: { enabled: true, source: 'team', defaultOn: false } });
    expect(q('task-estimates-toggle')).toBeNull();
    expect(q('task-estimates-state')!.textContent).toBe('On, turned on by your team');
  });

  it('says why it is not on by default, and says nothing once it is', async () => {
    await render();
    expect(q('task-estimates-default-reason')!.textContent).toContain('Not on by default yet.');
    act(() => root.unmount()); host.remove();
    await render({ defaultOffReason: null, initial: { enabled: true, source: 'default', defaultOn: true } });
    expect(q('task-estimates-default-reason')).toBeNull();
  });

  it('says it is a forecast, not a scheduler', async () => {
    await render();
    expect(q('feature-task-estimates')!.textContent).toContain('never decides what runs');
  });
});

describe('taskEstimatesStatusLine', () => {
  it('names an explicit opt-out against an on default', () => {
    expect(taskEstimatesStatusLine({ enabled: false, source: 'team', defaultOn: true })).toContain('turned off by your team');
    expect(taskEstimatesStatusLine({ enabled: true, source: 'default', defaultOn: true })).toBe('On (the default)');
  });
});
