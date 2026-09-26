/**
 * The initiative card model. Fixtures are illustrative.
 *
 * Several cases here are regressions for the derived-verdict list this model
 * replaced. That list could badge an initiative "losing" at 4/4 missions,
 * "stuck" at 100% on a mission that had already finished, and draw an empty bar
 * beside "100%". An initiative now carries a status a person set, and progress
 * is missions done over missions.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildInitiativeCard,
  groupInitiativeCards,
  initiativesHeadline,
  targetDateLabel,
  INITIATIVE_STATUS_LABEL,
  type InitiativeMissionInput,
  type InitiativeInput,
} from './initiative-view';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function mission(id: string, over: Partial<InitiativeMissionInput> = {}): InitiativeMissionInput {
  return {
    id,
    title: `Mission ${id}`,
    status: 'active',
    href: `/app/missions/${id}`,
    kind: 'active',
    statusLabel: 'Running',
    tone: 'accent',
    done: 1,
    total: 4,
    failed: 0,
    question: null,
    ask: null,
    ...over,
  };
}
const doneMission = (id: string, over: Partial<InitiativeMissionInput> = {}) =>
  mission(id, { status: 'completed', kind: 'done', statusLabel: 'Done', tone: 'success', done: 4, total: 4, ...over });

function initiative(over: Partial<InitiativeInput> = {}): InitiativeInput {
  return {
    id: 'i1',
    title: 'An initiative',
    description: null,
    status: 'active',
    targetDate: null,
    owner: null,
    missions: [],
    ...over,
  };
}

const VERDICT_WORDS = /\b(losing|stuck|dormant|unverified|winning|grinding|ready to close|arcs?)\b/i;

function allText(card: ReturnType<typeof buildInitiativeCard>): string {
  return [
    card.statusLabel,
    card.target?.label,
    ...card.facts.map((f) => f.text),
    card.action?.label,
    ...card.missions.map((m) => `${m.statusLabel} ${m.ask?.label ?? ''}`),
  ].join(' ');
}

describe('progress: one definition, and the bar agrees with it', () => {
  it('counts missions done over missions, and draws one segment per mission', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [doneMission('a'), doneMission('b'), mission('c', { done: 2, total: 4 })] }),
      { now: NOW },
    );
    expect(card.progress).toEqual({ done: 2, total: 3, tasksDone: 10, tasksTotal: 12 });
    expect(card.segments).toHaveLength(3);
    // Filled segments are exactly the done missions: the bar cannot read 100%
    // while the count reads 2/3.
    expect(card.segments.filter((s) => s.state === 'done')).toHaveLength(card.progress.done);
    expect(card.segments.find((s) => s.missionId === 'c')!.fill).toBe(0.5);
  });

  it('never renders an empty bar for a finished initiative (regression: dashed line beside 100%)', () => {
    const card = buildInitiativeCard(initiative({ missions: [doneMission('a'), doneMission('b')] }), { now: NOW });
    expect(card.segments.every((s) => s.state === 'done' && s.fill === 1)).toBe(true);
  });

  it('leaves archived missions out of both the count and the bar', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [doneMission('a'), mission('x', { status: 'archived' })] }),
      { now: NOW },
    );
    expect(card.progress.total).toBe(1);
    expect(card.segments.map((s) => s.missionId)).toEqual(['a']);
  });

  it('a mission done with a failed task counts as done and says the task failed', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [doneMission('a', { done: 3, total: 4, failed: 1 })] }),
      { now: NOW },
    );
    expect(card.progress.done).toBe(1);
    expect(card.missions[0].note).toBe('1 failed');
  });

  it('a done mission with tasks left says how many, so 3/4 is never unexplained', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [doneMission('a', { done: 3, total: 4, failed: 0 })] }),
      { now: NOW },
    );
    expect(card.missions[0].note).toBe('1 unfinished');
  });

  it('one finished mission reads as done, not "All 1 missions"', () => {
    const card = buildInitiativeCard(initiative({ missions: [doneMission('a')] }), { now: NOW });
    expect(card.facts.map((f) => f.text)).toEqual(['Its mission is done']);
  });
});

describe('status is the one a person set', () => {
  it('labels every status in Linear style', () => {
    expect(INITIATIVE_STATUS_LABEL).toEqual({
      planned: 'Planned', active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived',
    });
  });

  it('all missions done does not change the status: it offers Mark completed (regression: "losing" at 4/4)', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [doneMission('a'), doneMission('b'), doneMission('c'), doneMission('d')] }),
      { now: NOW },
    );
    expect(card.statusLabel).toBe('Active');
    expect(card.facts.map((f) => f.text)).toEqual(['All 4 missions done']);
    expect(card.action).toEqual({ kind: 'mark_completed', label: 'Mark completed', href: null, missionId: null });
    expect(card.section).toBe('needs_you');
  });

  it('never uses the old verdict vocabulary', () => {
    const shapes: InitiativeInput[] = [
      initiative({ missions: [doneMission('a')] }),
      initiative({ status: 'paused', missions: [doneMission('a')] }),
      initiative({ status: 'planned', targetDate: '2026-11-01', missions: [mission('a', { kind: 'scheduled', statusLabel: 'Waiting', tone: 'muted', done: 0 })] }),
      initiative({ status: 'completed', missions: [doneMission('a')] }),
      initiative({ missions: [] }),
      initiative({ missions: [mission('a', { kind: 'held', statusLabel: 'Held', tone: 'warning' })] }),
    ];
    for (const shape of shapes) expect(allText(buildInitiativeCard(shape, { now: NOW }))).not.toMatch(VERDICT_WORDS);
  });
});

describe('what needs you comes from the missions', () => {
  it('a parked question is a fact with a link and the card action is Answer', () => {
    const card = buildInitiativeCard(
      initiative({
        missions: [
          doneMission('a'),
          mission('b', {
            statusLabel: 'Needs you', tone: 'warning',
            question: { label: 'versions', href: '/app/missions/b?task=t4', prompt: 'Keep v1 at /v1?' },
          }),
        ],
      }),
      { now: NOW },
    );
    expect(card.facts[0]).toMatchObject({ key: 'needs_you', text: '1 mission needs you', href: '/app/missions/b?task=t4' });
    expect(card.action).toMatchObject({ kind: 'answer', label: 'Answer', href: '/app/missions/b?task=t4' });
    expect(card.section).toBe('needs_you');
    // The mission that needs you lists first.
    expect(card.missions[0].id).toBe('b');
  });

  it('a merge ask keeps its own verb', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [mission('b', { statusLabel: 'Needs you', tone: 'warning', ask: { label: 'Merge: feat(x): thing', href: '/h' } })] }),
      { now: NOW },
    );
    expect(card.action).toMatchObject({ kind: 'answer', label: 'Merge', href: '/h' });
  });

  it('a held open mission is a fact, and Arm is the action when nothing else is asked', () => {
    const card = buildInitiativeCard(
      initiative({ missions: [mission('a'), mission('h', { kind: 'held', statusLabel: 'Held', tone: 'warning', done: 0, total: 3 })] }),
      { now: NOW },
    );
    expect(card.facts.map((f) => f.text)).toEqual(['1 mission held']);
    expect(card.action).toEqual({ kind: 'arm', label: 'Arm', href: '/app/missions/h', missionId: 'h' });
    expect(card.segments.find((s) => s.missionId === 'h')!.state).toBe('held');
    expect(card.missions.find((m) => m.id === 'h')!.held).toBe(true);
  });

  it('a finished mission cannot be held (regression: "stuck · 1 held" at 100%)', () => {
    // A completed mission that still carries isHeld reads as done: the list
    // model only says `held` for open missions, and the card trusts `kind`.
    const card = buildInitiativeCard(
      initiative({ status: 'paused', missions: [doneMission('a'), doneMission('b')] }),
      { now: NOW },
    );
    expect(card.facts.some((f) => f.key === 'held')).toBe(false);
    expect(card.section).toBe('paused');
  });

  it('counts several missions that need you', () => {
    const ask = { label: 'Retry: x', href: '/r' };
    const card = buildInitiativeCard(
      initiative({ missions: [mission('a', { statusLabel: 'Needs you', ask }), mission('b', { statusLabel: 'Needs you', ask })] }),
      { now: NOW },
    );
    expect(card.facts[0].text).toBe('2 missions need you');
  });

  it('an initiative with no missions offers Add mission', () => {
    const card = buildInitiativeCard(initiative({ id: 'i9' }), { now: NOW });
    expect(card.facts.map((f) => f.text)).toEqual(['No missions yet']);
    expect(card.action).toMatchObject({ kind: 'add_mission', label: 'Add mission', href: '/app/missions/new?initiative=i9' });
    expect(card.section).toBe('active');
  });

  it('a completed initiative asks nothing', () => {
    const card = buildInitiativeCard(initiative({ status: 'completed', missions: [doneMission('a')] }), { now: NOW });
    expect(card.facts).toEqual([]);
    expect(card.action).toBeNull();
    expect(card.section).toBe('completed');
  });

  it('a running initiative with nothing to ask offers Open', () => {
    const card = buildInitiativeCard(initiative({ id: 'i2', missions: [mission('a')] }), { now: NOW });
    expect(card.action).toEqual({ kind: 'open', label: 'Open', href: '/app/initiatives/i2', missionId: null });
    expect(card.section).toBe('active');
  });
});

describe('target date', () => {
  it('reads as a countdown near the date, a date further out, and overdue after', () => {
    expect(targetDateLabel('2026-09-26', 'active', NOW)).toEqual({ label: 'Due today', overdue: false });
    expect(targetDateLabel('2026-09-30', 'active', NOW)).toEqual({ label: 'Due in 4d', overdue: false });
    expect(targetDateLabel('2026-11-10', 'active', NOW)).toEqual({ label: 'Due Nov 10', overdue: false });
    expect(targetDateLabel('2026-09-20', 'active', NOW)).toEqual({ label: '6d overdue', overdue: true });
  });
  it('a completed initiative is never overdue', () => {
    expect(targetDateLabel('2026-09-20', 'completed', NOW)).toEqual({ label: 'Target Sep 20', overdue: false });
  });
  it('no date, no label', () => {
    expect(targetDateLabel(null, 'active', NOW)).toBeNull();
  });
});

describe('grouping and headline', () => {
  it('puts what needs you first and completed last', () => {
    const cards = [
      buildInitiativeCard(initiative({ id: 'done', status: 'completed', missions: [doneMission('a')] }), { now: NOW }),
      buildInitiativeCard(initiative({ id: 'plan', status: 'planned', missions: [mission('p', { done: 0 })] }), { now: NOW }),
      buildInitiativeCard(initiative({ id: 'run', missions: [mission('r')] }), { now: NOW }),
      buildInitiativeCard(initiative({ id: 'ask', missions: [mission('q', { statusLabel: 'Needs you', ask: { label: 'Merge: y', href: '/y' } })] }), { now: NOW }),
      buildInitiativeCard(initiative({ id: 'pause', status: 'paused', missions: [mission('z')] }), { now: NOW }),
    ];
    const groups = groupInitiativeCards(cards);
    expect(groups.map((g) => [g.section, g.cards.map((c) => c.id)])).toEqual([
      ['needs_you', ['ask']],
      ['active', ['run']],
      ['planned', ['plan']],
      ['paused', ['pause']],
      ['completed', ['done']],
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Needs you', 'Active', 'Planned', 'Paused', 'Completed']);
  });

  it('drops empty groups', () => {
    const groups = groupInitiativeCards([buildInitiativeCard(initiative({ missions: [mission('r')] }), { now: NOW })]);
    expect(groups.map((g) => g.section)).toEqual(['active']);
  });

  it('headline leads with what needs you', () => {
    expect(initiativesHeadline({ needsYou: 2, active: 3 })).toBe('2 need you');
    expect(initiativesHeadline({ needsYou: 1, active: 3 })).toBe('1 needs you');
    expect(initiativesHeadline({ needsYou: 0, active: 3 })).toBe('3 active');
    expect(initiativesHeadline({ needsYou: 0, active: 0 })).toBe('Nothing active');
  });
});
