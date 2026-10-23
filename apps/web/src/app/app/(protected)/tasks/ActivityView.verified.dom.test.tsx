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

/** Activity: verified results, meaningful History and attribution (spec 9430a28f R-4, R-5, R-6, AC-4, AC-5). */

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
  it('a Now row shows the claim: state, spec revision and commit, criteria on demand', () => {
    const now = buildActivityNow({ tasks: [live('t1', { verification: claim('passed') })], missions: [], rules, now: nowMs });
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} />);
      const v = m.container.querySelector('[data-row="t1"] [data-testid="activity-verification"]')!;
      expect(v.getAttribute('data-state')).toBe('passed');
      expect(v.textContent).toContain('Verified');
      expect(v.textContent).toContain('revision 1');
      expect(v.textContent).toContain(H2.slice(0, 7));
      act(() => v.querySelector('button')!.click());
      const crit = v.querySelector('[data-testid="activity-verification-criterion"]')!;
      expect(crit.textContent).toContain('R-1');
      expect(crit.textContent).toContain('Passes');
      expect(v.querySelector('a')?.getAttribute('href')).toBe('/app/specs/spec-1');
    } finally { m.done(); }
  });

  it('a stale claim never reads Verified', () => {
    const now = buildActivityNow({ tasks: [live('t1', { verification: claim('stale') })], missions: [], rules, now: nowMs });
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} />);
      const v = m.container.querySelector('[data-testid="activity-verification"]')!;
      expect(v.getAttribute('data-state')).toBe('stale');
      expect(v.textContent).not.toContain('Verified');
    } finally { m.done(); }
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

describe('R-5: History highlights, full chronology on demand', () => {
  it('Highlights by default leave detail steps out; All activity tells every step', () => {
    const tasks: ActivityTaskInput[] = [
      finished('t1', { workers: [{ ...finished('t1').workers[0] }] }),
      { id: 'fx1', title: '[builder · after review #1] Done t1', status: 'completed', taskClass: 'attempt', parentTaskId: 't1', missionId: null, createdAt: T('10:20'), updatedAt: T('10:30'),
        workers: [{ status: 'completed', startedAt: T('10:20'), completedAt: T('10:30'), updatedAt: T('10:30'), lastCommitSha: H2 }] },
    ];
    const history = buildActivityEpisodes({ tasks, missions: [], rules });
    const m = mount();
    try {
      m.render(<ActivityView mode="history" now={{ groups: [], inMotion: 0, liveAgents: 0 }} history={history} nowMs={nowMs} hrefs={hrefs} />);
      const text = () => m.container.querySelector('[data-testid="activity-episode"]')!.textContent ?? '';
      const lens = (label: string) => [...m.container.querySelectorAll('[data-testid="activity-history-lens"] button')].find(b => b.textContent === label)!;
      expect(lens('Highlights').getAttribute('aria-pressed')).toBe('true');
      expect(text()).toContain('Automatic repair 1');
      expect(text()).not.toContain('New head');
      act(() => lens('All activity').click());
      expect(text()).toContain('New head');
    } finally { m.done(); }
  });
});

describe('R-4 / AC-4: attribution and identity filters', () => {
  const tasks = [
    live('mine', { attribution: attributionOf({ createdByUserId: 'me', requesterSource: 'explicit' }, 'me', names) }),
    live('adas', { attribution: attributionOf({ createdByUserId: 'ada', requesterSource: 'parent', createdByWorkerId: 'w' }, 'me', names) }),
    live('unknown'),
  ];
  const now = buildActivityNow({ tasks, missions: [], rules, now: nowMs });

  it('each row says who it is for, and unknown work says Unattributed', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      const who = (id: string) => m.container.querySelector(`[data-row="${id}"] [data-testid="activity-attribution"]`)?.textContent;
      expect(who('mine')).toBe('Filed by you');
      expect(who('adas')).toBe('For Ada · filed by an agent');
      expect(who('unknown')).toBe('Unattributed');
    } finally { m.done(); }
  });

  it('identity filters appear only when reliable', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} />);
      expect(m.container.querySelector('[data-testid="activity-who"]')).toBeNull();
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      expect(m.container.querySelector('[data-testid="activity-who"]')).not.toBeNull();
    } finally { m.done(); }
  });

  it('a narrower filter says how much unattributed work it leaves out, and All brings it back', () => {
    const m = mount();
    try {
      m.render(<ActivityView mode="now" now={now} history={[]} nowMs={nowMs} hrefs={hrefs} identityFilters />);
      const rows = () => [...m.container.querySelectorAll('[data-testid="activity-now-row"]')].map(r => r.getAttribute('data-row')).sort();
      expect(rows()).toEqual(['adas', 'mine', 'unknown']);
      const chip = (label: string) => [...m.container.querySelectorAll('[data-testid="activity-who"] button')].find(b => b.textContent === label)!;
      act(() => chip('Filed by me').click());
      expect(rows()).toEqual(['mine']);
      const note = m.container.querySelector('[data-testid="activity-unattributed-hidden"]')!;
      expect(note.textContent).toContain('1 unattributed');
      act(() => note.querySelector('button')!.click());
      expect(rows()).toEqual(['adas', 'mine', 'unknown']);
      expect(chip('All').getAttribute('aria-pressed')).toBe('true');
    } finally { m.done(); }
  });
});
