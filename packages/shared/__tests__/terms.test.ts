import { describe, expect, it } from 'bun:test';
import {
  BANNED_WORDS, MISSION_STAGE_STEPS, NOUNS, TERMS, bannedWordsIn, displayTitle, findTerm, missionGateTerm, slotsInUse, termFor,
  titleWithAttempt,
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

describe('terms catalog: waiting, blocked, ready (§2.3)', () => {
  it.each([
    ['task.status', 'pending', 'Ready'],
    ['worker.status', 'idle', 'Ready'],
    ['strip', 'ready', 'Ready'],
    ['strip', 'queued', 'Blocked'],
    ['strip', 'blocked', 'Blocked'],
    ['waiting', 'dep_declared', 'Blocked'],
    ['worker.status', 'waiting_input', 'Has a question'],
    ['strip', 'waiting', 'Has a question'],
    ['strip', 'needs_you', 'Waiting on you'],
    ['kernel', 'AWAITING_PUSH', 'Waiting for push'],
    ['kernel', 'BLOCKED_ON_TRUNK', 'Blocked on base'],
  ] as const)('%s %s reads %s', (kind, value, word) => {
    expect(termFor({ kind, value }).word).toBe(word);
  });

  it('Waiting is always followed by its reason', () => {
    for (const t of Object.values(TERMS)) expect(t.word).not.toMatch(/^Waiting$/);
    expect(TERMS['wait.agent'].word).toBe('Waiting for an agent');
    expect(TERMS['wait.checks'].word).toBe('Waiting for checks');
    expect(TERMS['wait.review'].word).toBe('Waiting for review');
  });
});

describe('terms catalog: building, verifying, working (§2.4)', () => {
  it.each([
    ['task.status', 'assigned', 'Working'],
    ['task.status', 'in_progress', 'Working'],
    ['worker.status', 'starting', 'Working'],
    ['worker.status', 'running', 'Working'],
    ['strip', 'running', 'Working'],
    ['kernel', 'WORKING', 'Working'],
    ['strip', 'review', 'In review'],
    ['kernel', 'AWAITING_REVIEW', 'In review'],
    ['strip', 'fixing', 'Fixing'],
    ['kernel', 'REPAIRING', 'Fixing'],
    ['mission.stage', 'building', 'Building'],
    ['mission.stage', 'verifying', 'Verifying'],
  ] as const)('%s %s reads %s', (kind, value, word) => {
    expect(termFor({ kind, value }).word).toBe(word);
  });

  it('checks running on a revision read Checking', () => {
    expect(TERMS['pr.checking'].word).toBe('Checking');
  });

  it('capacity reads "N of M slots in use"', () => {
    expect(slotsInUse(2, 3)).toBe('2 of 3 slots in use');
    expect(slotsInUse(1, 1)).toBe('1 of 1 slot in use');
    expect(slotsInUse(0, 4, 'short')).toBe('0/4 in use');
  });
});

describe('BANNED_WORDS (slice 2)', () => {
  it.each([
    'Auditing', 'In audit', 'Repairing', 'Pending', 'Queued', 'Never started', 'Assigned', 'Starting', 'Running now',
    'waiting for a worker', '3 of 6 busy', 'every slot is busy',
  ])('bans "%s"', (s) => {
    expect(bannedWordsIn(s).length).toBeGreaterThan(0);
  });

  it.each(['Working', 'Ready', 'Blocked', 'Checking', 'Fixing', '2 of 3 slots in use', 'Waiting for an agent', 'a fix is queued behind CI'])(
    'allows "%s"', (s) => { expect(bannedWordsIn(s)).toEqual([]); });
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

  it('accepts a missing title', () => {
    expect(displayTitle(null)).toEqual({ title: '' });
    expect(displayTitle(undefined)).toEqual({ title: '' });
  });
});

describe('titleWithAttempt (§2.10): the plain-text form terminal, MCP, PR comment and notification surfaces print', () => {
  it('puts the attempt after the title, never the machine key', () => {
    expect(titleWithAttempt('[builder · after CI #1] fix(top): words')).toBe('fix(top): words · Fix 1 · CI failed');
    expect(titleWithAttempt('[builder · after review #2] x')).toBe('x · Fix 2 · review asked for changes');
  });

  it('returns a plain title unchanged', () => {
    expect(titleWithAttempt('feat: plain')).toBe('feat: plain');
    expect(titleWithAttempt(null)).toBe('');
  });
});

describe('terms catalog: local and session read as your session (§2.6)', () => {
  it('a mission set to run locally reads Run from your session', () => {
    expect(termFor({ kind: 'mission.executor', value: 'local' }).word).toBe('Run from your session');
    expect(termFor({ kind: 'waiting', value: 'mission_local' }).word).toBe('Run from your session');
  });

  it('a task claimed from an interactive session reads Running in your session', () => {
    expect(termFor({ kind: 'worker.runner', value: 'mcp' }).word).toBe('Running in your session');
    expect(TERMS['work.your_session'].short).toBe('your session');
  });

  it.each(['local session', 'a local-session mission', '[LOCAL]', 'LOCAL', 'building locally', 'Claim it from a local session.'])('bans "%s"', (s) => {
    expect(bannedWordsIn(s).length).toBeGreaterThan(0);
  });

  it.each(['Run from your session', 'Running in your session', 'local time', 'your local checkout'])('allows "%s"', (s) => {
    expect(bannedWordsIn(s)).toEqual([]);
  });
});

describe('terms catalog: runner, slot, agent (§2.7)', () => {
  it('names each noun once with what it means', () => {
    expect(NOUNS.runner.word).toBe('runner');
    expect(NOUNS.slot.word).toBe('slot');
    expect(NOUNS.agent.word).toBe('agent');
    expect(NOUNS.session.word).toBe('your session');
    for (const n of Object.values(NOUNS)) {
      expect(n.means).toMatch(/^[A-Z].*\.$/);
      expect(bannedWordsIn(n.word)).toEqual([]);
    }
  });

  it.each([
    "the account's worker limit is reached", 'Workers', 'Concurrent workers', 'Worker failed', 'a worker already has it',
    'SEATS FULL', 'Seat parallelism', 'on a subscription seat',
  ])('bans "%s"', (s) => {
    expect(bannedWordsIn(s).length).toBeGreaterThan(0);
  });

  it.each([
    'Clef runs on Workers AI', 'Create one with Workers Scripts edit access', 'Uploading Worker…',
    'GET /api/workers', 'workers.prUrl + workers.mergedAt', '2 of 3 slots in use',
  ])('allows "%s" (a Cloudflare product name, a path or a column)', (s) => {
    expect(bannedWordsIn(s)).toEqual([]);
  });

  it('an agent reading an MCP reply may see worker, never seat or LOCAL', () => {
    expect(bannedWordsIn('Use the worker ID to report progress.', { reader: 'agent' })).toEqual([]);
    expect(bannedWordsIn('Use the worker ID to report progress.').length).toBeGreaterThan(0);
    expect(bannedWordsIn('[LOCAL]', { reader: 'agent' }).length).toBeGreaterThan(0);
    expect(bannedWordsIn('on a subscription seat', { reader: 'agent' }).length).toBeGreaterThan(0);
  });
});
