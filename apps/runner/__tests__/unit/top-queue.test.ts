/**
 * `buildd top`'s Queue view in state and keys (spec c7410e76 R-26, AC-12): the
 * server's claim order per team in view, expected start in words, "Not for
 * this runner" with the reason, Tab between the views, `c` claims a queue row
 * through the same claim effect as the Missions view, and a queue event
 * (another runner claiming) asks for a reread.
 */
import { describe, expect, test } from 'bun:test';
import { handleKey } from '../../src/top/keys';
import { estimateWords, queueRowList, queueSections, selectedQueueRow } from '../../src/top/queue';
import { eventChangesQueue, reduce } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';
import { QUEUE, queueState } from './top-queue-fixture';

const key = (ch: string) => ({ name: 'char' as const, ch });

describe('queue sections (R-26)', () => {
  test('per team, in the server order, with position, workspace, mission, estimate and start', () => {
    const [one, two] = queueSections(queueState(), NOW);
    expect(one.teamName).toBe('Team One');
    expect(one.rows.map(r => [r.position, r.title, r.workspace, r.mission, r.est, r.starts])).toEqual([
      [1, 'fix(kernel): review composition', 'alpha', 'Workflow kernel', '40m', 'Thu 00:00'],
      [2, 'feat(intake): one intake door', 'alpha', 'Bug intake', '1h', 'after 1'],
      [3, 'chore(web): cache /fonts', 'alpha', '(no mission)', '15m', 'after 2'],
      [4, 'docs: kernel commands', 'alpha', 'Workflow kernel', '-', 'after 3'],
    ]);
    // A start time of its own is held, listed after the queue with its reason.
    expect(one.held.map(r => [r.position, r.title, r.mission, r.starts])).toEqual([
      [null, 'chore: rotate the logs', 'starts at its set time, 17:00', '17:00'],
    ]);
    // The organizer's planning run is not work (R-22).
    expect(one.rows.map(r => r.taskId)).not.toContain('q-plan');
    expect(two.teamName).toBe('Team Two');
    expect(two.rows.map(r => [r.position, r.est, r.starts])).toEqual([[1, null, 'next']]);
  });

  test('a retry floor far out is held with its reason and does not count toward "after N"', () => {
    const far = new Date(NOW + 6 * 24 * 3_600_000).toISOString();
    const t = QUEUE.teams[0];
    const queue = { ...QUEUE, teams: [{ ...t, queue: [
      { ...t.queue[0], holds: ['deferred' as const], holdUntil: far, holdCause: 'retry_after_failures' as const },
      t.queue[1], t.queue[2],
    ] }, QUEUE.teams[1]] };
    const s = reduce({ ...queueState(), claimOutcomes: { tasks: {}, broad: null } }, { type: 'queue', queue });
    const [one] = queueSections(s, NOW);
    expect(one.rows.map(r => [r.position, r.starts])).toEqual([[1, 'next'], [2, 'after 1']]);
    expect(one.held).toHaveLength(1);
    expect(one.held[0].reason).toMatch(/^retries after failures, /);
    expect(one.held[0].held).toBe(true);
  });

  test('"Not for this runner" names why: a local session, another runner, a role it lacks', () => {
    const [one] = queueSections(queueState(), NOW);
    expect(one.notFor.map(r => [r.position, r.title, r.reason])).toEqual([
      [null, 'Runner terminal: round 3 audit', 'local session'],
      [null, 'fix(supersession): close the old PR', 'another runner'],
      [null, 'design: the queue tab', 'needs Designer'],
    ]);
  });

  test('without a claim outcome holding it, position 1 is next', () => {
    let s = queueState();
    s = { ...s, claimOutcomes: { tasks: {}, broad: null } };
    expect(queueSections(s, NOW)[0].rows[0].starts).toBe('next');
  });

  test('t narrows to one team and w to one workspace (R-23)', () => {
    expect(queueSections(queueState({ selectedTeam: 'Team Two' }), NOW).map(s => s.teamName)).toEqual(['Team Two']);
    expect(queueSections(queueState({ selectedWorkspace: 'alpha' }), NOW).map(s => s.teamName)).toEqual(['Team One']);
  });

  test('the / filter narrows the queue by title', () => {
    const rows = queueRowList(queueState({ filter: 'kernel' }), NOW);
    expect(rows.map(r => r.taskId)).toEqual(['q-review', 'q-docs']);
  });

  test('no queue read yet: no sections', () => {
    expect(queueSections({ ...fixtureState(), view: 'queue' }, NOW)).toEqual([]);
  });

  test('estimate words', () => {
    expect([estimateWords(15), estimateWords(40), estimateWords(60), estimateWords(90), estimateWords(4000)]).toEqual(['15m', '40m', '1h', '1h30', '3d']);
  });
});

describe('the queue follows the server (AC-12)', () => {
  test('another runner taking position 1: the reread moves position 2 to the top', () => {
    const s = queueState({ claimOutcomes: { tasks: {}, broad: null } });
    const after = {
      ...QUEUE,
      teams: QUEUE.teams.map((t, i) => i === 0 ? { ...t, queue: t.queue.slice(1), notForRunner: [{ ...t.queue[0], reason: 'another_runner' as const }, ...t.notForRunner] } : t),
    };
    const next = reduce(s, { type: 'queue', queue: after });
    const [one] = queueSections(next, NOW);
    expect(one.rows[0]).toMatchObject({ position: 1, title: 'feat(intake): one intake door', starts: 'next' });
    expect(one.notFor[0]).toMatchObject({ title: 'fix(kernel): review composition', reason: 'another runner' });
  });

  test('a task claimed in one of its workspaces is a queue change', () => {
    expect(eventChangesQueue(queueState(), { type: 'task_claimed', taskId: 'q-review' })).toBe(true);
  });

  test('a malformed queue frame is ignored', () => {
    const s = queueState();
    expect(reduce(s, { type: 'queue', queue: { nope: true } as any }).queue).toBe(s.queue);
  });
});

describe('Queue view keys', () => {
  test('Tab opens the Queue view and asks for a fresh read; Tab again goes back to Missions', () => {
    const s = { ...fixtureState() };
    const r = handleKey(s, { name: 'tab' }, NOW);
    expect(r.state.view).toBe('queue');
    expect(r.effects).toEqual([{ type: 'refreshQueue' }]);
    const back = handleKey(r.state, { name: 'tab' }, NOW);
    expect(back.state.view).toBe('missions');
  });

  test('↑↓ move over every queue row, "Not for this runner" included, and stop at the ends', () => {
    let s = queueState();
    expect(selectedQueueRow(s, NOW)?.taskId).toBe('q-review');
    s = handleKey(s, { name: 'up' }, NOW).state;
    expect(s.queueCursor).toBe(0);
    for (let i = 0; i < 20; i++) s = handleKey(s, { name: 'down' }, NOW).state;
    expect(selectedQueueRow(s, NOW)?.taskId).toBe('q-billing');
    s = handleKey(s, key('k'), NOW).state;
    expect(selectedQueueRow(s, NOW)?.taskId).toBe('q-design');
  });

  test('c on a queue row claims it through the same claim effect as the Missions view', () => {
    let s = queueState();
    s = handleKey(s, { name: 'down' }, NOW).state;
    const r = handleKey(s, key('c'), NOW);
    expect(r.effects).toEqual([{ type: 'claim', taskId: 'q-intake', title: 'feat(intake): one intake door' }]);
    expect(r.state.status?.text).toBe('Claiming "feat(intake): one intake door" onto this runner…');
  });

  test('c on a "Not for this runner" row is refused with the reason, and claims nothing', () => {
    let s = queueState();
    for (let i = 0; i < 6; i++) s = handleKey(s, { name: 'down' }, NOW).state;
    expect(selectedQueueRow(s, NOW)?.taskId).toBe('q-other');
    const r = handleKey(s, key('c'), NOW);
    expect(r.effects).toEqual([]);
    expect(r.state.status).toEqual({ text: '"fix(supersession): close the old PR" is not for this runner: another runner.', tone: 'error' });
  });

  test('o opens the selected queue row on buildd', () => {
    expect(handleKey(queueState(), key('o'), NOW).effects).toEqual([{ type: 'open', taskId: 'q-review' }]);
  });

  test('the worker keys point back to Missions instead of acting on a hidden row', () => {
    for (const ch of ['a', 'm', 'p', 'x']) {
      const r = handleKey(queueState(), key(ch), NOW);
      expect(r.effects).toEqual([]);
      expect(r.state.status?.text).toBe('Tab back to Missions to act on running work.');
    }
  });

  test('t and w still change the filter in the Queue view, and the cursor goes back to the top', () => {
    let s = queueState();
    s = handleKey(s, { name: 'down' }, NOW).state;
    s = handleKey(s, key('t'), NOW).state;
    expect(s.view).toBe('queue');
    expect(s.queueCursor).toBe(0);
    expect(queueSections(s, NOW).map(x => x.teamName)).toEqual(['Team One']);
  });

  test('q quits from the Queue view', () => {
    expect(handleKey(queueState(), key('q'), NOW).effects).toEqual([{ type: 'quit' }]);
  });
});
