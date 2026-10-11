import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { classifyLocalSession, sortLocalSessions, countInteractiveSessions, shownInSessionList, groupSessionsForDisplay, sessionTaskPreview, SESSION_TASK_PREVIEW } = await import('./local-session-view');
type Row = import('./local-session-view').LocalSessionRow;
type Held = Row['held'][number];

const NOW = new Date('2026-10-07T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Partial<Row> = {}): Row => ({
  id: 'p1', workspaceId: 'ws-1', clientKind: 'claude', clientVersion: null, repo: 'acme/app', interactive: true,
  startedAt: minsAgo(30), lastSeenAt: minsAgo(1), endedAt: null,
  held: [],
  ...over,
});
/** One worker the session holds, as claim_task left it. */
const held = (over: Partial<Held> = {}): Held => ({
  workerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(2), taskId: 't1', taskTitle: 'Fix login', taskStatus: 'in_progress', ...over,
});

describe('classifyLocalSession', () => {
  it('presence only, recently seen: online, no task', () => {
    const v = classifyLocalSession(row(), NOW);
    expect(v.state).toBe('online');
    expect(v.clientLabel).toBe('Claude Code');
    expect(v.task).toBeNull();
  });

  it('bound to a live worker: working on that task', () => {
    const v = classifyLocalSession(row({ held: [held({ workerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(2), taskId: 't1', taskTitle: 'Fix login', taskStatus: 'in_progress' })] }), NOW);
    expect(v.state).toBe('bound');
    expect(v.task).toEqual({ id: 't1', title: 'Fix login', status: 'in_progress' });
    expect(v.workerLive).toBe(true);
  });

  it('MCP activity on the bound worker keeps a quiet presence online', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(40), held: [held({ workerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(3), taskId: 't1', taskTitle: null, taskStatus: null })] }), NOW);
    expect(v.state).toBe('bound');
  });

  it('no activity for ten minutes: offline', () => {
    expect(classifyLocalSession(row({ lastSeenAt: minsAgo(11) }), NOW).state).toBe('offline');
  });

  it('ended wins over everything, and a finished task is no longer live work', () => {
    const v = classifyLocalSession(row({ endedAt: minsAgo(1), held: [held({ workerId: 'w1', workerStatus: 'completed', taskId: 't1', taskTitle: 'Done', taskStatus: 'completed', workerUpdatedAt: null })] }), NOW);
    expect(v.state).toBe('ended');
    expect(v.workerLive).toBe(false);
    expect(v.task?.status).toBe('completed');
  });

  it('a bound worker that ended reads as presence, not working', () => {
    expect(classifyLocalSession(row({ held: [held({ workerId: 'w1', workerStatus: 'completed', taskId: 't1', workerUpdatedAt: null, taskTitle: null, taskStatus: null })] }), NOW).state).toBe('online');
  });
});

describe('ordering and count', () => {
  it('working first, then online, offline, ended', () => {
    const views = [
      classifyLocalSession(row({ id: 'ended', endedAt: minsAgo(1) }), NOW),
      classifyLocalSession(row({ id: 'off', lastSeenAt: minsAgo(20) }), NOW),
      classifyLocalSession(row({ id: 'on' }), NOW),
      classifyLocalSession(row({ id: 'bound', held: [held({ workerId: 'w', workerStatus: 'running', workerUpdatedAt: minsAgo(1), taskId: 't', taskTitle: null, taskStatus: null })] }), NOW),
    ];
    expect(sortLocalSessions(views).map(v => v.id)).toEqual(['bound', 'on', 'off', 'ended']);
    // "Interactive sessions" counts only online ones, and never feeds agent capacity.
    expect(countInteractiveSessions(views)).toBe(2);
  });
});

describe('headless sessions', () => {
  // `claude -p`, SDK runs and Cursor background agents report interactive: false.
  const headless = classifyLocalSession(row({ id: 'headless', interactive: false }), NOW);
  const headlessWorking = classifyLocalSession(
    row({ id: 'headless-working', interactive: false, held: [held({ workerId: 'w', workerStatus: 'running', workerUpdatedAt: minsAgo(1), taskId: 't', taskTitle: null, taskStatus: null })] }), NOW);
  const person = classifyLocalSession(row({ id: 'person' }), NOW);

  it('a headless presence with no task is not listed and not counted', () => {
    expect([headless, person].filter(shownInSessionList).map(v => v.id)).toEqual(['person']);
    expect(countInteractiveSessions([headless, person])).toBe(1);
  });

  it('a headless session that claimed a task is still listed: it holds real work', () => {
    expect(shownInSessionList(headlessWorking)).toBe(true);
  });
});

describe('a session holding several tasks', () => {
  it('lists every task, works while any is live, and keeps the newest live one as the primary', () => {
    const v = classifyLocalSession(row({ held: [
      held({ workerId: 'w1', taskId: 't1', taskTitle: 'Fix login', workerStatus: 'completed', taskStatus: 'completed' }),
      held({ workerId: 'w2', taskId: 't2', taskTitle: 'Add export', workerUpdatedAt: minsAgo(1) }),
      held({ workerId: 'w3', taskId: 't3', taskTitle: 'Rename flag', workerUpdatedAt: minsAgo(4) }),
    ] }), NOW);
    expect(v.state).toBe('bound');
    expect(v.workerLive).toBe(true);
    expect(v.tasks.map(t => [t.id, t.live])).toEqual([['t1', false], ['t2', true], ['t3', true]]);
    expect(v.task?.id).toBe('t3');
    expect(v.workerId).toBe('w3');
  });

  it('any live held worker keeps a quiet presence online', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(40), held: [
      held({ workerId: 'w1', workerStatus: 'completed', workerUpdatedAt: minsAgo(1) }),
      held({ workerId: 'w2', workerUpdatedAt: minsAgo(3) }),
    ] }), NOW);
    expect(v.state).toBe('bound');
  });

  it('all held tasks finished: presence only, tasks still listed', () => {
    const v = classifyLocalSession(row({ held: [
      held({ workerId: 'w1', workerStatus: 'completed', taskStatus: 'completed' }),
      held({ workerId: 'w2', workerStatus: 'failed', taskId: 't2', taskStatus: 'pending' }),
    ] }), NOW);
    expect(v.state).toBe('online');
    expect(v.workerLive).toBe(false);
    expect(v.tasks).toHaveLength(2);
    expect(v.task?.id).toBe('t2');
  });
});

describe('Activity collapse', () => {
  const v = (id: string, over: Partial<Row> = {}) => classifyLocalSession(row({ id, ...over }), NOW);

  it('working sessions lead; online ones without a task and earlier ones are counted apart', () => {
    const views = sortLocalSessions([
      v('ended', { endedAt: minsAgo(5) }),
      v('off', { lastSeenAt: minsAgo(30) }),
      v('idle-a'),
      v('working', { held: [held()] }),
      v('idle-b', { lastSeenAt: minsAgo(2) }),
    ]);
    const g = groupSessionsForDisplay(views);
    expect(g.working.map(s => s.id)).toEqual(['working']);
    expect(g.idleOnline.map(s => s.id)).toEqual(['idle-a', 'idle-b']);
    expect(g.earlier.map(s => s.id)).toEqual(['off', 'ended']);
  });

  it('a session shows at most three tasks: live ones first, newest first; the rest are counted', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => held({
      workerId: `w${i}`, taskId: `t${i}`, taskTitle: `task ${i}`, workerStatus: i === 1 || i === 4 ? 'running' : 'completed',
    }));
    const p = sessionTaskPreview(v('many', { held: tasks }));
    expect(SESSION_TASK_PREVIEW).toBe(3);
    expect(p.shown.map(t => t.id)).toEqual(['t4', 't1', 't5']);
    expect(p.hidden.map(t => t.id)).toEqual(['t3', 't2', 't0']);
  });

  it('three or fewer tasks: all shown, nothing hidden', () => {
    const p = sessionTaskPreview(v('few', { held: [held({ taskId: 'a' }), held({ workerId: 'w2', taskId: 'b', workerStatus: 'completed' })] }));
    expect(p.shown.map(t => t.id)).toEqual(['a', 'b']);
    expect(p.hidden).toEqual([]);
  });
});
