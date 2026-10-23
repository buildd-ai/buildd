/**
 * Activity: verified results, meaningful History and attribution (spec
 * 9430a28f R-4, R-5, R-6, AC-4, AC-5). Verification and attribution arrive on
 * the task rows from their canonical reads; this checks what Now and History
 * make of them, and that nothing is shown when nothing was recorded.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import {
  buildActivityEpisodes, buildActivityNow, filterEpisodes, filterNow, hiddenUnattributed,
  type ActivityTaskInput, type ActivityWorker,
} from './activity-delivery';
import { verificationClaim } from './activity-verification';
import { UNATTRIBUTED, attributionOf } from './activity-attribution';

const T = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`;
const NOW = Date.parse(T('12:00'));
const H1 = 'a1b2c3d4e5f6';
const H2 = 'd4e5f60718293';
const PR = 'https://github.com/example/project/pull/34';

const owner = (over: Partial<ActivityWorker> = {}): ActivityWorker => ({
  status: 'completed', startedAt: T('09:30'), completedAt: T('10:02'), updatedAt: T('10:02'), prUrl: PR, prNumber: 34, lastCommitSha: H1, prLifecycleStatus: 'ci_running', ...over,
});
const task = (over: Partial<ActivityTaskInput> = {}): ActivityTaskInput => ({
  id: 't34', title: 'Export email', status: 'completed', taskClass: 'work', missionId: null, createdAt: T('09:00'), updatedAt: T('10:02'), workers: [owner()], ...over,
});
const repair = (id: string, title: string, at: string, sha: string | null): ActivityTaskInput => ({
  id, title, status: 'completed', taskClass: 'attempt', parentTaskId: 't34', missionId: null, createdAt: T(at), updatedAt: T(at),
  workers: [{ status: 'completed', startedAt: T(at), completedAt: T(at), updatedAt: T(at), lastCommitSha: sha }],
});
const passed = verificationClaim({
  specId: 'spec-1', revision: 1, outcome: 'verified', currentHeadSha: H2,
  criteria: [{ criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: false, headSha: H2 }],
}, { title: 'Export email', approvedRevision: 1 }, Date.parse(T('11:02')));

const rowOf = (tasks: ActivityTaskInput[]) => buildActivityNow({ tasks, missions: [], rules, now: NOW }).groups.flatMap(g => g.rows)[0];
const episodeOf = (tasks: ActivityTaskInput[]) => buildActivityEpisodes({ tasks, missions: [], rules }).find(e => e.id === 't34')!;
const texts = (tasks: ActivityTaskInput[]) => episodeOf(tasks).steps.map(s => s.text);

describe('R-6 / AC-5: verification is shown only from a recorded outcome', () => {
  it('a Now row carries its task\'s claim', () => {
    const row = rowOf([task({ verification: passed })]);
    expect(row.verification?.state).toBe('passed');
    expect(row.verification?.criteria[0].criterionId).toBe('R-1');
  });

  it('a merged PR with no recorded outcome carries no claim: delivery is not conformance', () => {
    const ep = episodeOf([task({ workers: [owner({ mergedAt: T('11:04'), prLifecycleStatus: 'merged' })] })]);
    expect(ep.kind).toBe('landed');
    expect(ep.verification).toBeNull();
    expect(ep.steps.some(s => /verif/i.test(s.text))).toBe(false);
  });

  it('History tells the verdict as a step, at the time it was recorded', () => {
    const ep = episodeOf([task({ verification: passed, workers: [owner({ mergedAt: T('11:04'), prLifecycleStatus: 'merged' })] })]);
    expect(ep.verification?.state).toBe('passed');
    const step = ep.steps.find(s => s.text.startsWith('Verified'))!;
    expect(step).toMatchObject({ at: Date.parse(T('11:02')), text: `Verified against spec revision 1 on ${H2.slice(0, 7)}`, tone: 'success', void: false });
  });

  it('a stale verdict is a struck step, never a pass', () => {
    const stale = verificationClaim({
      specId: 'spec-1', revision: 1, outcome: 'unverified', currentHeadSha: H2,
      criteria: [{ criterionId: 'R-1', text: 'x', verdict: 'pass', stale: true, headSha: H1 }],
    }, { title: 'Export email', approvedRevision: 1 }, Date.parse(T('10:30')));
    const step = episodeOf([task({ verification: stale })]).steps.find(s => /spec/i.test(s.text))!;
    expect(step.void).toBe(true);
    expect(step.tone).toBe('muted');
    expect(step.text).not.toMatch(/^Verified/);
  });

  it('a failed criterion is named', () => {
    const failed = verificationClaim({
      specId: 'spec-1', revision: 1, outcome: 'fail', currentHeadSha: H2,
      criteria: [{ criterionId: 'AC-2', text: 'x', verdict: 'fail', stale: false, headSha: H2 }],
    }, { title: 'Export email', approvedRevision: 1 }, Date.parse(T('10:30')));
    expect(texts([task({ verification: failed })])).toContain('Spec check failed: AC-2 on revision 1');
  });
});

describe('R-5: History tells meaningful events; detail is marked, never spam', () => {
  it('a current CI failure is a step on the head it failed', () => {
    const steps = texts([task({ workers: [owner({ prLifecycleStatus: 'ci_failed', updatedAt: T('10:10') })] })]);
    expect(steps).toContain(`CI failed on ${H1.slice(0, 7)}`);
  });

  it('a CI repair says CI failed on the head before it, once, then the repair', () => {
    const steps = texts([
      task({ workers: [owner({ prLifecycleStatus: 'ci_running' })] }),
      repair('fx1', '[builder · after CI #1] Export email', '10:20', H2),
    ]);
    const i = steps.indexOf(`CI failed on ${H1.slice(0, 7)}`);
    expect(i).toBeGreaterThan(-1);
    expect(steps[i + 1]).toBe('Automatic repair 1: CI failed');
    expect(steps.filter(s => s.startsWith('CI failed'))).toHaveLength(1);
  });

  it('a reopen after the merge is its own step', () => {
    const steps = texts([task({
      status: 'in_progress',
      workers: [
        owner({ mergedAt: T('11:04'), prLifecycleStatus: 'merged' }),
        { status: 'running', startedAt: T('11:30'), updatedAt: T('11:30') },
      ],
    })]);
    expect(steps.slice(-2)).toEqual(['Merged', 'Reopened']);
  });

  it('a second run before anything finished is not a reopen', () => {
    const steps = texts([task({
      status: 'in_progress',
      workers: [owner({ prUrl: null, prNumber: null, prLifecycleStatus: null }), { status: 'running', startedAt: T('10:30'), updatedAt: T('10:30') }],
    })]);
    expect(steps).not.toContain('Reopened');
  });

  it('a new head is detail: told in full on demand, not a highlight', () => {
    const ep = episodeOf([task(), repair('fx1', '[builder · after review #1] Export email', '10:20', H2)]);
    expect(ep.steps.find(s => s.text.startsWith('New head'))?.detail).toBe(true);
    expect(ep.steps.find(s => s.text.startsWith('Automatic repair'))?.detail).toBeUndefined();
    expect(ep.steps.find(s => s.text === 'Build started')?.detail).toBeUndefined();
  });
});

describe('R-4 / AC-4: attribution and identity filters', () => {
  const names = new Map([['me', 'Me'], ['ada', 'Ada']]);
  const mine = task({ id: 't34', attribution: attributionOf({ createdByUserId: 'me', requesterSource: 'explicit' }, 'me', names) });
  const adas = task({ id: 't35', title: 'Ada work', attribution: attributionOf({ createdByUserId: 'ada', requesterSource: 'explicit' }, 'me', names) });
  const unknown = task({ id: 't36', title: 'Unknown work' });

  it('rows and episodes without recorded lineage read unattributed', () => {
    const n = buildActivityNow({ tasks: [unknown], missions: [], rules, now: NOW });
    expect(n.groups[0].rows[0].attribution).toEqual(UNATTRIBUTED);
    expect(buildActivityEpisodes({ tasks: [unknown], missions: [], rules })[0].attribution).toEqual(UNATTRIBUTED);
  });

  it('All never excludes unattributed work; a narrower filter says how much it leaves out', () => {
    const now = buildActivityNow({ tasks: [mine, adas, unknown], missions: [], rules, now: NOW });
    const all = filterNow(now, { scope: 'all', outcome: 'any', who: 'all' }).flatMap(g => g.rows.map(r => r.id));
    expect(all.sort()).toEqual(['t34', 't35', 't36']);
    const filed = filterNow(now, { scope: 'all', outcome: 'any', who: 'filed-by-me' }).flatMap(g => g.rows.map(r => r.id));
    expect(filed).toEqual(['t34']);
    expect(hiddenUnattributed(now.groups.flatMap(g => g.rows), 'filed-by-me')).toBe(1);
    expect(hiddenUnattributed(now.groups.flatMap(g => g.rows), 'all')).toBe(0);
  });

  it('History filters the same way', () => {
    const eps = buildActivityEpisodes({ tasks: [mine, adas, unknown], missions: [], rules });
    expect(filterEpisodes(eps, { scope: 'all', outcome: 'any', who: 'all' })).toHaveLength(3);
    expect(filterEpisodes(eps, { scope: 'all', outcome: 'any', who: 'for-me' }).map(e => e.id)).toEqual(['t34']);
    expect(hiddenUnattributed(eps, 'for-me')).toBe(1);
  });
});
