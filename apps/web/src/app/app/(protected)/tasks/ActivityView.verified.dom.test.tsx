import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityEpisodes, buildActivityNow, type ActivityTaskInput } from '@/lib/activity-delivery';
import { verificationClaim } from '@/lib/activity-verification';
import { attributionOf } from '@/lib/activity-attribution';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ActivityView } = await import('./ActivityView');

/**
 * Activity: verification and attribution (spec 9430a28f r2 R-19, R-20, AC-4, AC-5).
 * Both stay in the data; neither is printed on a Now row (that detail is on the
 * task page), and History offers the identity filters only where they are reliable.
 */

const T = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`;
const nowMs = Date.parse(T('12:00'));
const H1 = 'a1b2c3d4e5f6';
const H2 = 'd4e5f60718293';
const PR = 'https://github.com/example/project/pull/34';
const hrefs = { now: '/app/tasks', history: '/app/tasks?view=history' };
const names = new Map([['me', 'Me'], ['ada', 'Ada']]);

const claim = (state: 'passed' | 'stale') => verificationClaim({
  specId: 'spec-1', revision: 1, outcome: state === 'passed' ? 'verified' : 'unverified', currentHeadSha: H2,
  criteria: [{ criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: state === 'stale', headSha: state === 'stale' ? H1 : H2 }],
}, { title: 'Export email spec', approvedRevision: 1 }, Date.parse(T('11:02')));

const live = (id: string, over: Partial<ActivityTaskInput> = {}): ActivityTaskInput => ({
  id, title: `Live ${id}`, status: 'in_progress', missionId: null, createdAt: T('09:00'), updatedAt: T('11:00'),
  workers: [{ status: 'running', startedAt: T('09:00'), updatedAt: T('11:00') }], ...over,
});
const finished = (id: string, over: Partial<ActivityTaskInput> = {}): ActivityTaskInput => ({
  id, title: `Done ${id}`, status: 'completed', taskClass: 'work', missionId: null, createdAt: T('09:00'), updatedAt: T('11:04'),
  workers: [{ status: 'completed', startedAt: T('09:30'), completedAt: T('10:02'), updatedAt: T('11:04'), prUrl: PR, prNumber: 34, lastCommitSha: H1, mergedAt: T('11:04'), prLifecycleStatus: 'merged' }],
  ...over,
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, render: (el: React.ReactElement) => act(() => root.render(el)), done: () => { act(() => root.unmount()); container.remove(); } };
}

describe('R-6: verification claims', () => {
  it('R-20: a Now row shows no claim; a passed or stale verdict is only the meter, and never "Verified"', () => {
    for (const state of ['passed', 'stale'] as const) {
      const now = buildActivityNow({ tasks: [live('t1', { verification: claim(state) })], missions: [], rules, now: nowMs });
      expect(now.groups[0].rows[0].verification?.state).toBe(state);
      const m = mount();
      try {
        m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} />);
        expect(m.container.querySelector('[data-row="t1"]')).not.toBeNull();
        expect(m.container.querySelector('[data-testid="activity-verification"]')).toBeNull();
        expect(m.container.textContent).not.toContain('Verified');
        expect(m.container.textContent).not.toContain(H2.slice(0, 7));
      } finally { m.done(); }
    }
  });

  it('a merged delivery with no recorded outcome shows no verification at all', () => {
    const history = buildActivityEpisodes({ tasks: [finished('t1')], missions: [], rules });
    const m = mount();
    try {
      m.render(<ActivityView mode="history" now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={history} nowMs={nowMs} hrefs={hrefs} />);
      expect(m.container.querySelectorAll('[data-testid="activity-episode"]')).toHaveLength(1);
      expect(m.container.querySelector('[data-testid="activity-verification"]')).toBeNull();
    } finally { m.done(); }
  });
});

describe('R-19 / AC-4: attribution and identity filters', () => {
  const tasks = [
    finished('mine', { attribution: attributionOf({ createdByUserId: 'me', requesterSource: 'explicit' }, 'me', names) }),
    finished('adas', { attribution: attributionOf({ createdByUserId: 'ada', requesterSource: 'parent', createdByWorkerId: 'w' }, 'me', names) }),
    finished('unknown'),
  ];
  const history = buildActivityEpisodes({ tasks, missions: [], rules });
  const now = buildActivityNow({ tasks: [live('l1', { attribution: tasks[0].attribution }), live('l2')], missions: [], rules, now: nowMs });

  it('Now rows never say who work is for, known or not, and Now has no identity filter', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      expect(m.container.querySelectorAll('[data-testid="activity-now-row"]')).toHaveLength(2);
      expect(m.container.querySelector('[data-testid="activity-attribution"]')).toBeNull();
      expect(m.container.querySelector('[data-testid="activity-who"]')).toBeNull();
      expect(m.container.textContent).not.toMatch(/Unattributed|Filed by you/);
    } finally { m.done(); }
  });

  it('History offers identity filters only when reliable', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="history" now={now} history={history} nowMs={nowMs} hrefs={hrefs} />);
      expect(m.container.querySelector('[data-testid="activity-who"]')).toBeNull();
      m.render(<ActivityView mode="history" now={now} history={history} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      expect(m.container.querySelector('[data-testid="activity-who"]')).not.toBeNull();
    } finally { m.done(); }
  });

  it('a narrower filter says how much unattributed work it leaves out, and All brings it back', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="history" now={now} history={history} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      const bars = () => m.container.querySelectorAll('[data-testid="activity-episode"]').length;
      expect(bars()).toBe(3);
      const chip = (label: string) => [...m.container.querySelectorAll('[data-testid="activity-who"] button')].find(b => b.textContent === label)!;
      act(() => chip('Filed by me').click());
      expect(bars()).toBe(1);
      const note = m.container.querySelector('[data-testid="activity-unattributed-hidden"]')!;
      expect(note.textContent).toContain('1 unattributed');
      act(() => note.querySelector('button')!.click());
      expect(bars()).toBe(3);
      expect(chip('All').getAttribute('aria-pressed')).toBe('true');
    } finally { m.done(); }
  });
});
