/**
 * `?state=runner-keys` shows Visual QA what the CI user's own data cannot:
 * a runner whose picks span two teams, a pick a team admin removed, a pick
 * out of reach, a long workspace name, and the admin list of runners from
 * other teams. Every action goes to a local api, never the network.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures?state=runner-keys' });

import { afterAll, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerKeysFixture } = await import('./RunnerKeysFixture');
const { RUNNER_KEYS_FIXTURE_STATE, isFixtureView } = await import('./visual-review-fixtures');

describe('RunnerKeysFixture', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));
  const all = (id: string, scope: ParentNode = container) => [...scope.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

  it('is a ?state= the fixtures page accepts', () => {
    expect(RUNNER_KEYS_FIXTURE_STATE).toBe('runner-keys');
    expect(isFixtureView('runner-keys')).toBe(true);
  });

  it('renders a runner whose picks are grouped under two teams', async () => {
    await act(async () => { root.render(createElement(RunnerKeysFixture)); });
    const row = all('runner-key-row')[0];
    expect(row).toBeDefined();
    const teams = all('runner-key-team', row).map((t) => t.textContent);
    expect(teams.length).toBe(2);
    expect(new Set(teams).size).toBe(2);
    expect(all('runner-key-pick', row).length).toBeGreaterThanOrEqual(4);
  });

  it('marks one pick removed by a team admin and one out of reach', () => {
    const picks = all('runner-key-pick');
    expect(picks.filter((p) => p.textContent?.includes('Removed by a team admin')).length).toBe(1);
    expect(picks.filter((p) => p.textContent?.includes('No longer reachable')).length).toBe(1);
  });

  it('has a pick with a long workspace name in a row that wraps', () => {
    const long = all('runner-key-pick').find((p) => (p.firstElementChild?.textContent?.length ?? 0) >= 48);
    expect(long).toBeDefined();
    expect(long!.firstElementChild!.className).toContain('break-words');
  });

  it('lists runners from other teams, each with Remove', () => {
    const rows = all('foreign-runner-row');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect([...r.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Remove')).toBe(true);
  });

  it('uses placeholder text only', () => {
    expect(container.textContent).not.toContain('—');
    expect(container.textContent).not.toMatch(/bld_[A-Za-z0-9]{12,}/);
  });
});
