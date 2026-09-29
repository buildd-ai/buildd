import { describe, expect, it } from 'bun:test';
import { missionAskRows, missionInsight, objectSheetTitle, missionScopeLabel, missionSheetState, segments, type MissionSheetState } from './mission-sheet';

const state = (over: Partial<MissionSheetState> = {}): MissionSheetState => ({
  complete: false, planning: false, landed: { done: 1, total: 4 }, goal: { passed: 0, total: 3 }, needsYou: 0, live: 1, ...over,
});

describe('missionSheetState', () => {
  it('reads landed, goal, needs-you and live from the board', () => {
    const s = missionSheetState({
      status: 'active',
      board: {
        complete: false, planning: null, landed: { done: 2, total: 5 }, live: 2, needsYou: ['t1'],
        criteria: [{ state: 'pass' }, { state: 'pending' }, { state: 'fail' }],
      },
    });
    expect(s).toEqual({ complete: false, planning: false, landed: { done: 2, total: 5 }, goal: { passed: 1, total: 3 }, needsYou: 1, live: 2 });
  });

  it('a completed status counts as complete even before the board says so', () => {
    const s = missionSheetState({ status: 'completed', board: { complete: false, planning: null, landed: { done: 0, total: 0 }, live: 0, needsYou: [], criteria: [] } });
    expect(s.complete).toBe(true);
  });
});

describe('missionInsight', () => {
  it('complete but criteria unchecked: disagrees, and says how many', () => {
    const i = missionInsight(state({ complete: true, landed: { done: 4, total: 4 }, goal: { passed: 1, total: 3 }, live: 0 }));
    expect(i).toEqual({ text: 'Marked complete, but 2 of 3 goal criteria are unchecked.', disagrees: true });
  });

  it('everything landed but not complete: disagrees', () => {
    const i = missionInsight(state({ landed: { done: 4, total: 4 }, goal: { passed: 3, total: 3 }, live: 0 }));
    expect(i?.disagrees).toBe(true);
    expect(i?.text).toBe('Everything landed, but it is not marked complete yet.');
  });

  it('something waits on the viewer: disagrees (copper), counts it', () => {
    expect(missionInsight(state({ needsYou: 2 }))).toEqual({ text: '2 tasks are waiting on you.', disagrees: true });
    expect(missionInsight(state({ needsYou: 1 }))?.text).toBe('1 task is waiting on you.');
  });

  it('agreeing states: a plain line, no copper square', () => {
    expect(missionInsight(state())).toEqual({ text: '1 agent at work, 1 of 4 landed.', disagrees: false });
    expect(missionInsight(state({ planning: true, landed: { done: 0, total: 0 } }))).toEqual({ text: 'Still planning. No tasks yet.', disagrees: false });
    expect(missionInsight(state({ complete: true, landed: { done: 4, total: 4 }, goal: { passed: 3, total: 3 }, live: 0 })))
      .toEqual({ text: 'Done, and every goal criterion checks out.', disagrees: false });
    expect(missionInsight(state({ live: 0 }))).toEqual({ text: 'Nothing running right now. 1 of 4 landed.', disagrees: false });
  });

  it('never uses an em dash', () => {
    const all = [state(), state({ complete: true, goal: { passed: 0, total: 2 } }), state({ needsYou: 3 }), state({ planning: true })];
    for (const s of all) expect(missionInsight(s)?.text ?? '').not.toContain('—');
  });
});

describe('missionAskRows', () => {
  it('2 to 3 rows, always', () => {
    const cases = [state(), state({ planning: true, landed: { done: 0, total: 0 } }), state({ complete: true, goal: { passed: 3, total: 3 }, landed: { done: 4, total: 4 } }), state({ needsYou: 1 }), state({ complete: true, goal: { passed: 0, total: 3 } })];
    for (const s of cases) {
      const rows = missionAskRows(s);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.length).toBeLessThanOrEqual(3);
    }
  });

  it('row 1 is copper and addresses the disagreement: complete but unchecked', () => {
    const rows = missionAskRows(state({ complete: true, landed: { done: 4, total: 4 }, goal: { passed: 1, total: 3 }, live: 0 }));
    expect(rows[0].tone).toBe('needs');
    expect(rows[0].label).toBe('Why are 2 criteria unchecked?');
    expect(rows[0].send).toBe(true);
    expect(rows.slice(1).every(r => r.tone === undefined)).toBe(true);
  });

  it('before the mission loads: the plain three, none copper', () => {
    const rows = missionAskRows(null);
    expect(rows.map(r => r.label)).toEqual(['How is it going?', "What's holding it up?", "What's left?"]);
    expect(rows.some(r => r.tone)).toBe(false);
  });

  it('row 1 copper when something waits on the viewer', () => {
    const rows = missionAskRows(state({ needsYou: 1 }));
    expect(rows[0]).toMatchObject({ label: 'What does it need from me?', tone: 'needs' });
  });

  it('nothing disagrees: no copper row', () => {
    for (const s of [state(), state({ planning: true, landed: { done: 0, total: 0 } }), state({ complete: true, goal: { passed: 3, total: 3 }, landed: { done: 4, total: 4 } })]) {
      expect(missionAskRows(s).some(r => r.tone === 'needs')).toBe(false);
    }
  });

  it('rows follow the state: planning asks about the plan, complete asks what shipped', () => {
    expect(missionAskRows(state({ planning: true, landed: { done: 0, total: 0 } }))[0].label).toBe("What's the plan so far?");
    expect(missionAskRows(state({ complete: true, goal: { passed: 3, total: 3 }, landed: { done: 4, total: 4 } }))[0].label).toBe('What shipped?');
    expect(missionAskRows(state())[0].label).toBe('How is it going?');
  });
});

describe('missionScopeLabel', () => {
  it('locks the scope to the mission and its workspace', () => {
    expect(missionScopeLabel('billing-web')).toBe('mission · billing-web');
    expect(missionScopeLabel(null)).toBe('mission');
  });
});

describe('objectSheetTitle', () => {
  it('a mission sheet is titled by its kind: the pane shows the title once', () => {
    expect(objectSheetTitle({ kind: 'mission', fallbackText: 'Mission: Multi-currency invoices' })).toBe('Mission');
  });
  it('anything else keeps its own words', () => {
    expect(objectSheetTitle({ kind: 'question', fallbackText: 'The builder asks: which one?' })).toBe('The builder asks: which one?');
  });
  // Regression (demo capture): the sheet kept saying a question was waiting
  // after the person had answered it.
  it('an open question keeps its words', () => {
    expect(objectSheetTitle({ kind: 'question', fallbackText: 'A question is waiting on you' }, { kind: 'question', open: true })).toBe('A question is waiting on you');
  });
  it('an answered question the agent has not picked up says the answer went', () => {
    expect(objectSheetTitle({ kind: 'question', fallbackText: 'A question is waiting on you' }, { kind: 'question', open: false, awaitingAgent: true }))
      .toBe('Answer sent, waiting for the agent');
  });
  it('an answered question the agent has picked up says so', () => {
    expect(objectSheetTitle({ kind: 'question', fallbackText: 'A question is waiting on you' }, { kind: 'question', open: false })).toBe('Question answered');
  });
});

describe('segments', () => {
  it('one per item up to the cap', () => {
    expect(segments(2, 4)).toEqual([true, true, false, false]);
    expect(segments(0, 0)).toEqual([]);
  });
  it('scales past the cap, never shows full until done', () => {
    const s = segments(19, 20, 10);
    expect(s).toHaveLength(10);
    expect(s.filter(Boolean)).toHaveLength(9);
    expect(segments(20, 20, 10).every(Boolean)).toBe(true);
    expect(segments(1, 40, 10).filter(Boolean)).toHaveLength(1);
  });
});
