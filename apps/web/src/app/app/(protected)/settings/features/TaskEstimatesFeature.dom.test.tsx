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
    root.render(<TaskEstimatesFeature teamId={TEAM} initial={OFF_DEFAULT} canManage {...props} />);
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
    expect(q('task-estimates-state')!.textContent).toBe('Off (default)');
    await act(async () => { q('task-estimates-toggle')!.click(); });
    expect(calls).toEqual([{ url: `/api/teams/${TEAM}`, body: { taskEstimates: { enabled: true } } }]);
    expect(q('task-estimates-state')!.textContent).toBe('On for this team');
    expect(q('task-estimates-toggle')!.textContent).toBe('Turn off');
    expect(host.querySelector('a[href="/app/health/estimates"]')).not.toBeNull();
  });

  it('a refused save keeps the old state and says why', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })) as unknown as typeof fetch;
    await render();
    await act(async () => { q('task-estimates-toggle')!.click(); });
    expect(q('task-estimates-state')!.textContent).toBe('Off (default)');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Forbidden');
  });

  it('a member sees the state and no control', async () => {
    await render({ canManage: false, initial: { enabled: true, source: 'team', defaultOn: false } });
    expect(q('task-estimates-toggle')).toBeNull();
    expect(q('task-estimates-state')!.textContent).toBe('On for this team');
  });

  it('shows only this team\'s state: nothing about other teams or the rollout', async () => {
    for (const initial of [OFF_DEFAULT, { enabled: false, source: 'team' as const, defaultOn: true }]) {
      await render({ initial });
      const text = q('feature-task-estimates')!.textContent ?? '';
      expect(text).not.toMatch(/other teams/i);
      expect(text).not.toMatch(/not on by default|not been checked|accuracy check/i);
      act(() => root.unmount()); host.remove();
    }
    await render();
  });

  it('says it is a forecast, not a scheduler', async () => {
    await render();
    expect(q('feature-task-estimates')!.textContent).toContain("Estimates don't affect which tasks run or when");
  });
});

describe('taskEstimatesStatusLine', () => {
  it('names an explicit opt-out against an on default', () => {
    expect(taskEstimatesStatusLine({ enabled: false, source: 'team' })).toBe('Off for this team');
    expect(taskEstimatesStatusLine({ enabled: true, source: 'default' })).toBe('On (default)');
  });
});
