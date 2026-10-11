import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetSnapshot } from '@buildd/shared';
import { RunningNow } from './RunningNow';

const NOW = Date.UTC(2026, 0, 1, 12);
const w = (id: string, over: Record<string, unknown> = {}) => ({
  workerId: id, taskId: `t-${id}`, missionId: 'm1', label: 'db', rest: 'add index', title: 'feat(db): add index',
  roleSlug: null, roleName: null, roleColor: null, status: 'running', phase: null,
  startedAt: new Date(NOW - 40 * 60_000).toISOString(), question: null, ...over,
});
const fleet = {
  runners: [
    { id: 'r1', name: 'atlas', machine: null, maxSlots: 3, online: true, slots: [
      { index: 0, worker: w('a'), last: null, lane: { id: '0', bars: [] } },
      { index: 1, worker: w('b', { status: 'waiting_input', question: 'Per line or total?', missionId: null }), last: null, lane: { id: '1', bars: [] } },
      { index: 2, worker: null, last: null, lane: { id: '2', bars: [] } },
    ] },
    { id: 'r2', name: 'birch', machine: null, maxSlots: 2, online: false, slots: [] },
  ],
  sessions: { id: 'sessions', name: 'Your sessions', machine: null, maxSlots: 0, online: true, interactive: { running: 1 }, slots: [
    { index: 0, worker: w('c', { label: 'open_pr_outp', rest: 'pull_request 4191', title: '[friction] open_pr_outpaced_by_base: pull_request 4191' }), last: null, lane: { id: 's0', bars: [] } },
  ] },
  live: 2, capacity: 3, window: { from: 0, to: NOW },
} as unknown as FleetSnapshot;

const html = renderToStaticMarkup(<RunningNow fleet={fleet} now={NOW} missions={{ m1: { title: 'Ship it', landed: 1, total: 4 } }} />);

describe('RunningNow', () => {
  it('each runner says how busy it is, in words', () => {
    expect(html).toContain('atlas');
    expect(html).toContain('2 of 3 busy');
    expect(html).toContain('birch');
    expect(html).toContain('Offline');
  });
  it('one row per running task: name, mission, how long, and its state as a word', () => {
    expect(html).toContain('add index');
    expect(html).toContain('Ship it');
    expect(html).toContain('40m');
    expect(html).toContain('Working');
    expect(html).toContain('Needs input');
    expect(html).toContain('href="/app/tasks/t-a"');
  });
  it('people\'s own sessions are their own group, with readable names', () => {
    expect(html).toContain('Your sessions');
    expect(html).toContain('Open PR outpaced by base: PR #4191');
    expect(html).not.toContain('open_pr_outp');
  });
  it('a row labelled only with a PR number reads as its title', () => {
    const f = { ...fleet, sessions: null, runners: [{ ...fleet.runners[0], slots: [{ index: 0, worker: w('d', { label: 'ci', rest: '#4066', title: '[builder · after CI #1] fix(sentinel): page once per incident' }), last: null, lane: { id: '0', bars: [] } }] }] } as unknown as FleetSnapshot;
    const h = renderToStaticMarkup(<RunningNow fleet={f} now={NOW} />);
    expect(h).toContain('Page once per incident');
    expect(h).not.toContain('>#4066<');
  });
  it('no textures or hatching anywhere', () => {
    expect(html).not.toContain('state-cell');
    expect(html).not.toContain('data-pattern');
  });
});
