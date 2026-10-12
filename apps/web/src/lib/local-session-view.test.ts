import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { recentLocalSessionWhere, classifyLocalSession, sortLocalSessions, countInteractiveSessions, shownInSessionList, groupSessionsForDisplay, sessionTaskPreview, SESSION_TASK_PREVIEW } = await import('./local-session-view');
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

  it('a write to the bound worker does not keep a silent presence online', () => {
    // workers.updated_at is bumped by the reaper, webhooks, usage and any MCP
    // call of the account's other sessions: none of them is this client.
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(40), held: [held({ workerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(3), taskId: 't1', taskTitle: null, taskStatus: null })] }), NOW);
    expect(v.state).toBe('offline');
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

  it('live held workers do not keep a quiet presence online: the seats stay listed, the session reads offline', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(40), held: [
      held({ workerId: 'w1', workerStatus: 'completed', workerUpdatedAt: minsAgo(1) }),
      held({ workerId: 'w2', workerUpdatedAt: minsAgo(3) }),
    ] }), NOW);
    expect(v.state).toBe('offline');
    // Still holding a seat: repairable from the task page ("Release slot").
    expect(v.workerLive).toBe(true);
  });

  it('a client heartbeat with several live claims (subagents) works on all of them', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(2), held: [
      held({ workerId: 'w1', taskId: 't1', workerUpdatedAt: minsAgo(30) }),
      held({ workerId: 'w2', taskId: 't2', workerUpdatedAt: minsAgo(25) }),
      held({ workerId: 'w3', taskId: 't3', workerUpdatedAt: minsAgo(20) }),
    ] }), NOW);
    expect(v.state).toBe('bound');
    expect(v.tasks.filter(t => t.live).map(t => t.id)).toEqual(['t1', 't2', 't3']);
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

// The ghost: Activity read "Claude Code · Working · 3m" holding a long list of
// tasks while no client was running. Its presence had stopped hearing from
// the client long before; a held worker that nothing had released was still
// being written server-side, and that write was read as the session's own.
describe('a session whose client is gone', () => {
  const ghostHeld = [
    ...Array.from({ length: 24 }, (_, i) => held({ workerId: `done-${i}`, taskId: `done-${i}`, workerStatus: i % 2 ? 'completed' : 'failed', taskStatus: 'completed', workerUpdatedAt: minsAgo(600 + i) })),
    held({ workerId: 'stuck-1', taskId: 'stuck-1', workerStatus: 'running', workerUpdatedAt: minsAgo(3) }),
    held({ workerId: 'stuck-2', taskId: 'stuck-2', workerStatus: 'idle', workerUpdatedAt: minsAgo(1) }),
    held({ workerId: 'stuck-3', taskId: 'stuck-3', workerStatus: 'waiting_input', workerUpdatedAt: minsAgo(8) }),
  ];

  it('no client heartbeat since it went quiet: not Working, not online, not counted', () => {
    const v = classifyLocalSession(row({ startedAt: minsAgo(900), lastSeenAt: minsAgo(180), held: ghostHeld }), NOW);
    expect(v.state).toBe('offline');
    expect(v.state).not.toBe('bound');
    expect(countInteractiveSessions([v])).toBe(0);
    expect(groupSessionsForDisplay([v]).working).toHaveLength(0);
    expect(groupSessionsForDisplay([v]).earlier.map(s => s.id)).toEqual(['p1']);
  });

  it('its clock is the client\'s last heartbeat, not the last server write to a held worker', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(180), held: ghostHeld }), NOW);
    expect(v.lastSeenAt).toBe(minsAgo(180).toISOString());
  });

  it('a held worker updated after the client vanished does not revive it', () => {
    const vanished = row({ lastSeenAt: minsAgo(11), held: [held({ workerUpdatedAt: minsAgo(0) })] });
    expect(classifyLocalSession(vanished, NOW).state).toBe('offline');
  });

  it('pre-reboot: the client process may still exist but is silent: offline until it speaks, never Working', () => {
    // A long local command fires no hook until it returns. Buildd has no
    // current signal from the client, so it does not claim one.
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(25), held: [held({ workerUpdatedAt: minsAgo(4) })] }), NOW);
    expect(v.state).toBe('offline');
    // The next hook (the command returning) brings it straight back.
    const back = classifyLocalSession(row({ lastSeenAt: NOW, held: [held({ workerUpdatedAt: minsAgo(4) })] }), NOW);
    expect(back.state).toBe('bound');
  });

  it('detached tasks: every held worker released, the session holds no live work', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(180), held: [
      held({ workerId: 'w1', workerStatus: 'failed', taskStatus: 'pending', workerUpdatedAt: minsAgo(2) }),
      held({ workerId: 'w2', workerStatus: 'completed', taskStatus: 'completed', workerUpdatedAt: minsAgo(2) }),
    ] }), NOW);
    expect(v.state).toBe('offline');
    expect(v.workerLive).toBe(false);
  });

  it('explicitly ended but a held worker is still live (/clear, or not yet released): ended, never Working', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(1), endedAt: minsAgo(1), held: [held({ workerUpdatedAt: minsAgo(0) })] }), NOW);
    expect(v.state).toBe('ended');
    expect(countInteractiveSessions([v])).toBe(0);
  });

  it('online is decided by the age of the client heartbeat alone', () => {
    const at = (m: number) => classifyLocalSession(row({ lastSeenAt: minsAgo(m), held: [held({ workerUpdatedAt: minsAgo(0) })] }), NOW).state;
    expect(at(9.9)).toBe('bound');
    expect(at(10)).toBe('offline');
  });
});

describe('which sessions are listed', () => {
  it('only those whose own client was heard from recently; a held worker\'s writes never relist one', () => {
    const q = new PgDialect().sqlToQuery(recentLocalSessionWhere(minsAgo(60 * 24)));
    expect(q.sql).toContain('"local_sessions"."last_seen_at" >');
    expect(q.sql).not.toContain('workers');
    expect(q.sql).not.toContain('updated_at');
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

describe('a task claimed twice by one session', () => {
  it('lists the task once, under its live worker, not the released one', () => {
    const v = classifyLocalSession(row({ held: [
      held({ workerId: 'w-released', taskId: 't1', workerStatus: 'completed', workerUpdatedAt: minsAgo(120) }),
      held({ workerId: 'w-live', taskId: 't1', workerStatus: 'running' }),
    ] }), NOW);
    expect(v.tasks.map(t => [t.id, t.workerId, t.live])).toEqual([['t1', 'w-live', true]]);
  });

  it('with no live worker, lists the newest claim once', () => {
    const v = classifyLocalSession(row({ held: [
      held({ workerId: 'w1', taskId: 't1', workerStatus: 'completed' }),
      held({ workerId: 'w2', taskId: 't1', workerStatus: 'failed' }),
    ] }), NOW);
    expect(v.tasks.map(t => t.workerId)).toEqual(['w2']);
  });
});
