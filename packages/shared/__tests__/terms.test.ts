import { describe, expect, it } from 'bun:test';
import {
  BANNED_WORDS, MISSION_STAGE_STEPS, TERMS, bannedWordsIn, displayTitle, findTerm, missionGateTerm, termFor,
  type InternalKind, type TermKey,
} from '../src/terms';
import { TaskStatus, WorkerStatus } from '../src/types';
import { DELIVERY_STATES } from '../../workflow-kernel/src/types';
import { WAITING_KIND_SPEC } from '../../core/waiting-reason';
import { STATE_KEYS } from '../../../apps/web/src/components/ui/states';

/** Every internal vocabulary the catalog must cover. Adding a value without a term fails here. */
const ENUMS: Array<[InternalKind, readonly string[]]> = [
  ['kernel', DELIVERY_STATES],
  ['task.status', Object.values(TaskStatus)],
  ['worker.status', Object.values(WorkerStatus)],
  ['mission.stage', MISSION_STAGE_STEPS],
  ['waiting', Object.keys(WAITING_KIND_SPEC)],
  ['strip', STATE_KEYS],
];

describe('terms catalog: totality', () => {
  for (const [kind, values] of ENUMS) {
    it(`every ${kind} value resolves to a term`, () => {
      const missing = values.filter((value) => !findTerm({ kind, value }));
      expect(missing).toEqual([]);
    });
  }

  it('an unseen value reads "reason unknown", never the raw enum', () => {
    expect(termFor({ kind: 'kernel', value: 'NEW_STATE' }).word).toBe('Not started: reason unknown');
  });

  it('no term word is itself a banned word', () => {
    for (const t of Object.values(TERMS)) {
      expect({ key: t.key, banned: bannedWordsIn(t.word).length + bannedWordsIn(t.short).length }).toEqual({ key: t.key, banned: 0 });
    }
  });

  it('every term has a one-sentence meaning and keys match', () => {
    for (const [key, t] of Object.entries(TERMS)) {
      expect(t.key).toBe(key as TermKey);
      expect(t.means).toMatch(/^[A-Z].*\.$/);
      expect(t.means).not.toMatch(/\.\s+\S/);
    }
  });
});

describe('terms catalog: held splits by cause (§2.1)', () => {
  it('a mission gate reads Not started until it first runs, then Paused', () => {
    expect(missionGateTerm({ armedAt: null }).word).toBe('Not started');
    expect(missionGateTerm({ armedAt: '2026-10-01T00:00:00Z' }).word).toBe('Paused');
    expect(termFor({ kind: 'mission.stage', value: 'on_hold', when: 'neverStarted' }).word).toBe('Not started');
    expect(termFor({ kind: 'mission.stage', value: 'on_hold' }).word).toBe('Paused');
  });

  it.each([
    ['task_held', 'Paused'],
    ['start_deferred', 'Scheduled'],
    ['budget_paused', 'Usage limit'],
    ['lease_overlap', 'Waiting for files'],
    ['pr_overlap_live', 'Waiting for files'],
    ['unknown', 'Not started: reason unknown'],
  ])('waiting kind %s reads %s', (value, word) => {
    expect(termFor({ kind: 'waiting', value }).word).toBe(word);
  });

  it('a runner hold reads Paused', () => {
    expect(termFor({ kind: 'runner', value: 'hold' }).word).toBe('Paused');
  });
});

describe('terms catalog: landing reads GitHub’s words (§2.2)', () => {
  it.each([
    ['LANDING', 'Merging'],
    ['MERGED', 'Merged'],
    ['SUPERSEDED', 'Merged in another PR'],
    ['CLOSED_UNMERGED', 'Closed without merging'],
    ['ABANDONED', 'Closed without merging'],
  ])('kernel %s reads %s', (value, word) => {
    expect(termFor({ kind: 'kernel', value }).word).toBe(word);
  });

  it('a completed task reads Merged with a merged PR and Done without one', () => {
    expect(termFor({ kind: 'task.status', value: 'completed', when: 'hasMergedPr' }).word).toBe('Merged');
    expect(termFor({ kind: 'task.status', value: 'completed' }).word).toBe('Done');
  });

  it('the strip landed / landing / not_landed states read Merged / Merging / Closed without merging', () => {
    expect(termFor({ kind: 'strip', value: 'landed' }).word).toBe('Merged');
    expect(termFor({ kind: 'strip', value: 'landing' }).word).toBe('Merging');
    expect(termFor({ kind: 'strip', value: 'not_landed' }).word).toBe('Closed without merging');
  });

  it('the mission stage delivered reads Done', () => {
    expect(termFor({ kind: 'mission.stage', value: 'delivered' }).word).toBe('Done');
    expect(TERMS['total.done_this_week'].word).toBe('Done this week');
  });
});

describe('BANNED_WORDS', () => {
  it.each([
    'held by a usage limit', 'mission is on hold', '[HELD]', 'Start mode: HELD', 'Landed this week', 'Landing',
    'Not landed', 'Shipped elsewhere', 'Delivered this week', 'Completed',
  ])('bans "%s"', (s) => {
    expect(bannedWordsIn(s).length).toBeGreaterThan(0);
  });

  it.each(['Paused', 'Merged', 'Closed without merging', 'Done this week', 'Completed 3 tasks today', 'threshold'])('allows "%s"', (s) => {
    expect(bannedWordsIn(s)).toEqual([]);
  });

  it('every entry says what to use and why', () => {
    for (const b of BANNED_WORDS) {
      expect(b.use.length).toBeGreaterThan(0);
      expect(b.why.length).toBeGreaterThan(0);
    }
  });
});

describe('displayTitle', () => {
  it('strips a retry key into an attempt label', () => {
    expect(displayTitle('[builder · after CI #1] fix(top): words')).toEqual({ title: 'fix(top): words', attempt: 'Fix 1 · CI failed' });
    expect(displayTitle('[builder · after review #2] x')).toEqual({ title: 'x', attempt: 'Fix 2 · review asked for changes' });
    expect(displayTitle('[builder · after conflict #1] [builder · after CI #3] x')).toEqual({ title: 'x', attempt: 'Fix 1 · merge conflict' });
  });

  it('leaves other titles alone', () => {
    expect(displayTitle('[reviewer] PR #12: x')).toEqual({ title: '[reviewer] PR #12: x' });
    expect(displayTitle('feat: plain')).toEqual({ title: 'feat: plain' });
  });
});
