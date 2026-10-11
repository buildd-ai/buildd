import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { incidentStateLine, incidentAffected, projectIncident, type IncidentForView, type IncidentVerdictView } from './incident-view';

describe('incident page words', () => {
  const now = new Date('2026-10-09T23:00:00Z');
  it('says severity, status and how often in one line', () => {
    expect(incidentStateLine({ severity: 'critical', status: 'open', occurrenceCount: 14, recurrenceCount: 0, firstSeenAt: new Date('2026-10-09T20:00:00Z') }, now))
      .toBe('Critical · Open · seen 14 times since 3h ago');
    expect(incidentStateLine({ severity: 'high', status: 'acknowledged', occurrenceCount: 1, recurrenceCount: 2, firstSeenAt: new Date('2026-10-09T22:30:00Z') }, now))
      .toBe('High · Acknowledged · seen once since 30m ago · came back 2 times');
  });
  it('lists affected tasks and PRs as links, at most 10 of each', () => {
    const a = incidentAffected({ taskIds: Array.from({ length: 12 }, (_, i) => `t${i}`), workerIds: [], prNumbers: [7] });
    expect(a.tasks).toHaveLength(10);
    expect(a.tasks[0]).toEqual({ id: 't0', label: 'Task t0', href: '/app/tasks/t0' });
    expect(a.moreTasks).toBe(2);
    expect(a.prs).toEqual([{ label: 'PR #7' }]);
  });
  it('uses a task\'s human title when it is known', () => {
    const a = incidentAffected({ taskIds: ['1a2b3c4d-0000'], workerIds: [], prNumbers: [] }, new Map([['1a2b3c4d-0000', 'Add the export button']]));
    expect(a.tasks[0].label).toBe('Add the export button');
  });
});

// ── The one projection (docs/specs/failure-incident-recovery.md §9, §17.1) ──

const NOW = '2026-10-11T14:00:00.000Z';
const TASK = '1a2b3c4d-1111-2222-3333-444455556666';

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 2,
    cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: TASK }],
    blockers: [{ kind: 'pr', id: '77', state: 'open', observedAt: NOW }],
    overlappingPaths: ['apps/web/src/lib/a.ts'],
    observation: { observedAt: '2026-10-11T13:55:00.000Z', source: 'sweep', evidenceRevision: 'rev1' },
    firstSeenAt: '2026-10-11T12:00:00.000Z', lastSeenAt: '2026-10-11T13:55:00.000Z', lastProgressAt: null,
    owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting for PR #77 to land.', key: 'recovery:i1:g2' },
    nextCheckAt: '2026-10-11T14:20:00.000Z',
    verification: { predicate: 'subjects_moved', params: {} },
    budget: { spent: 0, limit: 3, deadlineAt: '2026-10-11T18:00:00.000Z', spentKeys: [] },
    attempts: [],
    ...over,
  };
}

function incident(over: Partial<IncidentForView> = {}): IncidentForView {
  return {
    id: 'i1', status: 'open', severity: 'high', rule: 'path_overlap_stall', linkedFixTaskId: null,
    firstSeenAt: '2026-10-10T02:00:00.000Z', lastSeenAt: '2026-10-11T13:55:00.000Z', recovery: recovery(), ...over,
  };
}

const personVerdict = (generation?: number): IncidentVerdictView => ({ owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'generic rail words', ...(generation !== undefined ? { generation } : {}) });
const builddHold: IncidentVerdictView = { owner: 'buildd', by: 'rule', action: 'hold', reason: 'x', generation: 2 };
const opts = { now: NOW, timeZone: 'UTC', prHref: (n: number) => `https://github.com/o/r/pull/${n}` };

const FORBIDDEN = /Nothing is fixing|\bfixed\b|\bresolved\b/i;

describe('projectIncident: one state word, sentence and owner per assessment', () => {
  it('waiting: Buildd owns it, names the blocker and the next check, never asks', () => {
    const p = projectIncident(incident(), builddHold, opts);
    expect(p).toMatchObject({ owner: 'buildd', ownerLabel: 'Buildd', phase: 'waiting', stateWord: 'Waiting for PR #77', needsYou: false, options: [] });
    expect(p.sentence).toBe('Waiting for PR #77 to land. Buildd checks again at 2:20 PM.');
    expect(p.nextCheckAt).toBe('2026-10-11T14:20:00.000Z');
    expect(p.lastCheckedAt).toBe('2026-10-11T13:55:00.000Z');
    // Ages come from the episode, not the incident's first sighting (§9).
    expect(p.waitingSince).toBe('2026-10-11T12:00:00.000Z');
    expect(p.sentence).not.toMatch(FORBIDDEN);
  });

  it('no assessment yet: Checking current status, owner Buildd', () => {
    const p = projectIncident(incident({ recovery: null }), null, opts);
    expect(p).toMatchObject({ phase: 'checking', stateWord: 'Checking current status', owner: 'buildd', needsYou: false });
    expect(p.sentence).not.toMatch(FORBIDDEN);
  });

  it('repair running, and retrying n of 3 after the first attempt', () => {
    const attempt = (n: number) => ({ key: `recovery:i1:task:${TASK}:c:wake_subject:g2:a${n}`, action: 'wake_subject', subject: { kind: 'task' as const, id: TASK }, at: NOW, generation: 2 });
    const running = projectIncident(incident({ recovery: recovery({
      state: 'recovering', nextAction: { kind: 'wake_subject', label: 'PR #77 landed; Buildd restarted task 1a2b3c4d.', key: attempt(1).key },
      attempts: [attempt(1)], budget: { spent: 1, limit: 3, deadlineAt: NOW, spentKeys: [attempt(1).key] },
    }) }), builddHold, opts);
    expect(running).toMatchObject({ phase: 'repair_running', stateWord: 'Repair running', owner: 'buildd' });
    expect(running.sentence).toBe('PR #77 landed; Buildd restarted task 1a2b3c4d. Buildd checks the result at 2:20 PM.');

    const retry = projectIncident(incident({ recovery: recovery({
      state: 'recovering', nextAction: { kind: 'wake_subject', label: 'Restarted task 1a2b3c4d.', key: attempt(2).key },
      attempts: [attempt(1), attempt(2)], budget: { spent: 2, limit: 3, deadlineAt: NOW, spentKeys: [] },
    }) }), builddHold, opts);
    expect(retry).toMatchObject({ phase: 'retrying', stateWord: 'Retrying (2 of 3)' });
  });

  it('a fix task filed but not linked yet is Repair queued; a running fix task is Repair running', () => {
    const queued = projectIncident(incident({ recovery: recovery({ state: 'recovering', nextAction: { kind: 'file_fix_task', label: 'Buildd filed a fix for this.', key: 'k' } }) }), builddHold, opts);
    expect(queued).toMatchObject({ phase: 'repair_queued', stateWord: 'Repair queued' });
    const delegated = projectIncident(incident({ linkedFixTaskId: 'f1', recovery: recovery({ state: 'recovering', nextAction: { kind: 'fix_task_running', label: 'Buildd is fixing the overlap (task f1aaaaaa).', key: 'fix:f1' } }) }), builddHold, opts);
    expect(delegated).toMatchObject({ phase: 'repair_running', stateWord: 'Repair running' });
  });

  it('inconclusive: Couldn\'t confirm, never a green or fixed word', () => {
    const p = projectIncident(incident({ recovery: recovery({ state: 'inconclusive', nextAction: { kind: 'recheck', label: 'The facts could not be read in full.', key: 'k' } }) }), builddHold, opts);
    expect(p).toMatchObject({ phase: 'inconclusive', stateWord: 'Couldn\'t confirm', tone: 'q', needsYou: false });
    expect(p.sentence).toBe('Buildd couldn\'t confirm this is still happening. It checks again at 2:20 PM.');
    expect(`${p.stateWord} ${p.sentence}`).not.toMatch(FORBIDDEN);
  });

  it('a stale assessment (no look in 60 min) reads as inconclusive whatever it last said', () => {
    const p = projectIncident(incident({ recovery: recovery({ observation: { observedAt: '2026-10-11T12:30:00.000Z', source: 'sweep', evidenceRevision: 'r' }, nextCheckAt: '2026-10-11T12:40:00.000Z' }) }), builddHold, opts);
    expect(p.phase).toBe('inconclusive');
  });

  it('needs_operator: Automatic recovery unavailable, with the gap and the operator\'s action; not Needs You', () => {
    const p = projectIncident(incident({ recovery: recovery({
      state: 'needs_operator', owner: 'operator',
      cause: { reasonCode: 'infrastructure_failure.visual_qa.scrub', rule: 'path_overlap_stall', ownership: 'infrastructure' },
      capabilityGap: { capability: 'repair_infrastructure:visual_qa.scrub', reason: 'the QA database scrub fails on an immutable table' },
      nextAction: { kind: 'operator', label: 'An operator repairs the scrub step.', key: 'k' },
    }) }), builddHold, opts);
    expect(p).toMatchObject({ phase: 'unavailable', stateWord: 'Automatic recovery unavailable', owner: 'operator', ownerLabel: 'Operator', needsYou: false, options: [] });
    expect(p.sentence).toBe('Automatic recovery unavailable: the QA database scrub fails on an immutable table. An operator repairs the scrub step.');
  });

  it('needs_decision: the one question, typed options, recommended first, and it is the person\'s', () => {
    const decision = {
      question: 'Task 1a2b3c4d and PR #77\'s fix are waiting on each other. Choose one to stop.',
      options: [
        { capability: 'dismiss' as const, label: 'Leave both waiting', effect: 'Nothing changes.' },
        { capability: 'cancel_attempt' as const, label: 'Cancel the stale attempt', effect: 'Stops the attempt.' },
        { capability: 'open_blocker' as const, label: 'Open PR #77', effect: 'See why.' },
      ],
      recommended: 'cancel_attempt' as const,
    };
    const p = projectIncident(incident({ recovery: recovery({ state: 'needs_decision', owner: 'person', decision, nextCheckAt: null }) }), personVerdict(2), opts);
    expect(p).toMatchObject({ phase: 'decision', stateWord: 'Needs your decision', owner: 'person', ownerLabel: 'You', needsYou: true, sentence: decision.question });
    expect(p.options.map(o => o.capability)).toEqual(['cancel_attempt', 'dismiss', 'open_blocker']);
    expect(p.options[0]).toMatchObject({ recommended: true, mode: 'link', href: 'https://github.com/o/r/pull/77' });
    expect(p.options.find(o => o.capability === 'dismiss')).toMatchObject({ mode: 'post' });
    expect(p.options.find(o => o.capability === 'open_blocker')).toMatchObject({ mode: 'link', href: 'https://github.com/o/r/pull/77' });
    // Without a link to act through, an option is shown disabled with the reason, never as a dead button.
    const bare = projectIncident(incident({ recovery: recovery({ state: 'needs_decision', owner: 'person', decision, nextCheckAt: null }) }), personVerdict(2), { now: NOW, timeZone: 'UTC' });
    expect(bare.options.find(o => o.capability === 'open_blocker')).toMatchObject({ mode: 'unavailable' });
    // Never a generic merge or force start.
    expect(p.options.map(o => o.label).join(' ')).not.toMatch(/merge|force/i);
  });

  it('AC-5: a person verdict stamped for an older generation is absent', () => {
    const decided = incident({ recovery: recovery({ state: 'needs_decision', owner: 'person', decision: { question: 'q', options: [], recommended: 'dismiss' } }) });
    expect(projectIncident(decided, personVerdict(1), opts).needsYou).toBe(false);
    expect(projectIncident(decided, personVerdict(2), opts).needsYou).toBe(true);
    // A verdict stored before generations were stamped is read against the current assessment only.
    expect(projectIncident(decided, personVerdict(), opts).needsYou).toBe(true);
    // A person verdict the current assessment contradicts never lists it.
    expect(projectIncident(incident(), personVerdict(2), opts).needsYou).toBe(false);
  });

  it('recovered: the only state that says recovered, with what moved', () => {
    const p = projectIncident(incident({ status: 'resolved', resolvedAt: '2026-10-11T03:10:00.000Z', recovery: recovery({
      state: 'recovered', nextAction: null, nextCheckAt: null,
      verification: { predicate: 'subjects_moved', params: { summary: 'task 1a2b3c4d started once PR #77 landed.' } },
    }) }), builddHold, opts);
    expect(p).toMatchObject({ phase: 'recovered', stateWord: 'Recovered', needsYou: false, options: [], nextCheckAt: null });
    expect(p.sentence).toBe('Recovered at 3:10 AM: task 1a2b3c4d started once PR #77 landed.');
  });

  it('a dismissed incident is out of Needs You and says Buildd keeps checking', () => {
    const p = projectIncident(incident({ status: 'acknowledged' }), personVerdict(2), opts);
    expect(p.needsYou).toBe(false);
    expect(p.dismissed).toBe(true);
  });

  it('an unassessed high incident with no fix task: Automatic recovery unavailable, one specific action, never "Nothing is fixing it"', () => {
    const p = projectIncident(incident({ rule: 'retry_fork', recovery: null }), { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'old words' }, opts);
    expect(p).toMatchObject({ phase: 'unavailable', owner: 'person', needsYou: true });
    expect(p.sentence).toMatch(/^Automatic recovery unavailable: /);
    expect(p.options.map(o => o.capability)).toEqual(['dismiss']);
    expect(p.sentence).not.toMatch(FORBIDDEN);
  });

  it('an unassessed incident with a running fix task: Repair running, Buildd\'s', () => {
    const p = projectIncident(incident({ rule: 'retry_fork', recovery: null, linkedFixTaskId: 'abcdef12-0000' }), { owner: 'buildd', by: 'rule', action: 'wait_machine', reason: 'x' }, { ...opts, fixTask: { id: 'abcdef12-0000', status: 'in_progress' } });
    expect(p).toMatchObject({ phase: 'repair_running', owner: 'buildd', needsYou: false });
    expect(p.sentence).toBe('Buildd is fixing it in task abcdef12.');
  });

  it('a critical incident is the owner\'s once, whatever the recovery state, until dismissed', () => {
    const v: IncidentVerdictView = { owner: 'person', by: 'rule', rail: 'critical_incident', reason: 'r', generation: 2 };
    const p = projectIncident(incident({ severity: 'critical' }), v, opts);
    expect(p.needsYou).toBe(true);
    expect(p.options.map(o => o.capability)).toContain('dismiss');
    expect(projectIncident(incident({ severity: 'critical', status: 'acknowledged' }), v, opts).needsYou).toBe(false);
  });

  it('AC-11: no non-recovered phase says fixed, resolved or Nothing is fixing', () => {
    const states = ['observing', 'recovering', 'waiting', 'needs_decision', 'needs_operator', 'inconclusive'] as const;
    for (const state of states) {
      const p = projectIncident(incident({ recovery: recovery({ state, decision: state === 'needs_decision' ? { question: 'Choose one.', options: [], recommended: 'dismiss' } : undefined, capabilityGap: state === 'needs_operator' ? { capability: 'c', reason: 'r' } : undefined }) }), personVerdict(2), opts);
      expect(`${p.stateWord} ${p.sentence}`).not.toMatch(FORBIDDEN);
    }
  });
});
