/**
 * `buildd top`'s Queue view in state and keys (spec c7410e76 R-26, AC-12): the
 * server's claim order per team in view, expected start in words, "Not for
 * this runner" with the reason, Tab between the views, `c` claims a queue row
 * through the same claim effect as the Missions view, and a queue event
 * (another runner claiming) asks for a reread.
 */
import { describe, expect, test } from 'bun:test';
import { LOCAL_CLAIM_WORDS, handleKey } from '../../src/top/keys';
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
      // One of 3 slots is free (2 agents run): the first row nothing holds starts now.
      [2, 'feat(intake): one intake door', 'alpha', 'Bug intake', '1h', 'now'],
      [3, 'chore(web): cache /fonts', 'alpha', '-', '15m', 'when a slot frees'],
      [4, 'docs: kernel commands', 'alpha', 'Workflow kernel', '-', 'after its dependency'],
    ]);
    // A start time of its own is held, listed after the queue: its mission, then the time and why.
    expect(one.held.map(r => [r.position, r.title, r.mission, r.starts, r.reason])).toEqual([
      [null, 'chore: rotate the logs', 'Workflow kernel', '17:00 · scheduled', 'scheduled, 17:00'],
    ]);
    // The organizer's planning run is not work (R-22).
    expect(one.rows.map(r => r.taskId)).not.toContain('q-plan');
    expect(two.teamName).toBe('Team Two');
    // The free slot went to Team One's row ahead of it in the claim order.
    expect(two.rows.map(r => [r.position, r.est, r.starts])).toEqual([[1, null, 'when a slot frees']]);
  });

  test('a row sharing only mergeable files with other work says it starts alongside it (I-38)', () => {
    const t = QUEUE.teams[0];
    const queue = { ...QUEUE, teams: [{ ...t, queue: t.queue.map(q =>
      q.id === 'q-intake' ? { ...q, alongside: { prNumber: 41, holderTaskId: 'pr-task' } }
        : q.id === 'q-fonts' ? { ...q, alongside: { prNumber: null, holderTaskId: 'q-review' } }
          : q.id === 'q-docs' ? { ...q, alongside: { prNumber: 42, holderTaskId: null } }
            : q) }, QUEUE.teams[1]] };
    const s = reduce(queueState(), { type: 'queue', queue });
    const [one] = queueSections(s, NOW);
    const by = new Map(one.rows.map(r => [r.taskId, r]));
    expect(by.get('q-intake')).toMatchObject({ starts: 'now', alongside: 'starts alongside #41 (same files, merges at the end)' });
    // No PR: the holder by title.
    expect(by.get('q-fonts')?.alongside).toBe('starts alongside "fix(kernel): review com…" (same files, merges at the end)');
    // A row something holds says what it waits for, not alongside.
    expect(by.get('q-docs')?.starts).toBe('after its dependency');
    expect(by.get('q-docs')?.alongside).toBeUndefined();
    expect(by.get('q-review')?.alongside).toBeUndefined();
  });

  test('a retry floor far out is held with its reason and takes no free slot', () => {
    const far = new Date(NOW + 6 * 24 * 3_600_000).toISOString();
    const t = QUEUE.teams[0];
    const queue = { ...QUEUE, teams: [{ ...t, queue: [
      { ...t.queue[0], holds: ['deferred' as const], holdUntil: far, holdCause: 'retry_after_failures' as const },
      t.queue[1], t.queue[2],
    ] }, QUEUE.teams[1]] };
    const s = reduce({ ...queueState(), claimOutcomes: { tasks: {}, broad: null } }, { type: 'queue', queue });
    const [one] = queueSections(s, NOW);
    expect(one.rows.map(r => [r.position, r.starts])).toEqual([[1, 'now'], [2, 'when a slot frees']]);
    expect(one.held).toHaveLength(1);
    expect(one.held[0].reason).toMatch(/^retries after failures, /);
    // The time first, so a narrow column keeps it, then why.
    expect(one.held[0].starts).toMatch(/^.+ · retries after failures$/);
    expect(one.held[0].held).toBe(true);
  });

  test('"Not for this runner" names why: a local session, another runner, a role it lacks', () => {
    const [one] = queueSections(queueState(), NOW);
    // The why goes in the starts column; the mission column always names the mission.
    expect(one.notFor.map(r => [r.position, r.title, r.starts, r.exclusion])).toEqual([
      [null, 'Runner terminal: round 3 audit', 'runs in a local session', 'local_session'],
      [null, 'fix(supersession): close the old PR', 'another runner takes it', 'another_runner'],
      [null, 'design: the queue tab', 'needs Designer', 'role_missing'],
    ]);
    expect(one.notFor.every(r => r.mission === r.mission.trim() && !/local session|another runner/.test(r.mission))).toBe(true);
  });

  test('without a claim outcome holding it, position 1 starts now on the free slot', () => {
    let s = queueState();
    s = { ...s, claimOutcomes: { tasks: {}, broad: null } };
    expect(queueSections(s, NOW)[0].rows[0].starts).toBe('now');
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
    expect(one.rows[0]).toMatchObject({ position: 1, title: 'feat(intake): one intake door', starts: 'now' });
    expect(one.notFor[0]).toMatchObject({ title: 'fix(kernel): review composition', reason: 'another runner takes it' });
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
    expect(r.state.status).toEqual({ text: 'Not for this runner: another runner takes it.', tone: 'error' });
  });

  test('c on a local session\'s row says where that changes, and claims nothing', () => {
    let s = queueState();
    while (selectedQueueRow(s, NOW)?.exclusion !== 'local_session') s = handleKey(s, { name: 'down' }, NOW).state;
    const r = handleKey(s, key('c'), NOW);
    expect(r.effects).toEqual([]);
    expect(r.state.status).toEqual({ text: LOCAL_CLAIM_WORDS, tone: 'error' });
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
