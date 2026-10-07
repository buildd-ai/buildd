import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { classifyLocalSession, sortLocalSessions, countInteractiveSessions, shownInSessionList } = await import('./local-session-view');
type Row = import('./local-session-view').LocalSessionRow;

const NOW = new Date('2026-10-07T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Partial<Row> = {}): Row => ({
  id: 'p1', workspaceId: 'ws-1', clientKind: 'claude', clientVersion: null, repo: 'acme/app', interactive: true,
  startedAt: minsAgo(30), lastSeenAt: minsAgo(1), endedAt: null,
  boundWorkerId: null, workerStatus: null, workerUpdatedAt: null, taskId: null, taskTitle: null, taskStatus: null,
  ...over,
});

describe('classifyLocalSession', () => {
  it('presence only, recently seen: online, no task', () => {
    const v = classifyLocalSession(row(), NOW);
    expect(v.state).toBe('online');
    expect(v.clientLabel).toBe('Claude Code');
    expect(v.task).toBeNull();
  });

  it('bound to a live worker: working on that task', () => {
    const v = classifyLocalSession(row({ boundWorkerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(2), taskId: 't1', taskTitle: 'Fix login', taskStatus: 'in_progress' }), NOW);
    expect(v.state).toBe('bound');
    expect(v.task).toEqual({ id: 't1', title: 'Fix login', status: 'in_progress' });
    expect(v.workerLive).toBe(true);
  });

  it('MCP activity on the bound worker keeps a quiet presence online', () => {
    const v = classifyLocalSession(row({ lastSeenAt: minsAgo(40), boundWorkerId: 'w1', workerStatus: 'running', workerUpdatedAt: minsAgo(3), taskId: 't1' }), NOW);
    expect(v.state).toBe('bound');
  });

  it('no activity for ten minutes: offline', () => {
    expect(classifyLocalSession(row({ lastSeenAt: minsAgo(11) }), NOW).state).toBe('offline');
  });

  it('ended wins over everything, and a finished task is no longer live work', () => {
    const v = classifyLocalSession(row({ endedAt: minsAgo(1), boundWorkerId: 'w1', workerStatus: 'completed', taskId: 't1', taskTitle: 'Done', taskStatus: 'completed' }), NOW);
    expect(v.state).toBe('ended');
    expect(v.workerLive).toBe(false);
    expect(v.task?.status).toBe('completed');
  });

  it('a bound worker that ended reads as presence, not working', () => {
    expect(classifyLocalSession(row({ boundWorkerId: 'w1', workerStatus: 'completed', taskId: 't1' }), NOW).state).toBe('online');
  });
});

describe('ordering and count', () => {
  it('working first, then online, offline, ended', () => {
    const views = [
      classifyLocalSession(row({ id: 'ended', endedAt: minsAgo(1) }), NOW),
      classifyLocalSession(row({ id: 'off', lastSeenAt: minsAgo(20) }), NOW),
      classifyLocalSession(row({ id: 'on' }), NOW),
      classifyLocalSession(row({ id: 'bound', boundWorkerId: 'w', workerStatus: 'running', workerUpdatedAt: minsAgo(1), taskId: 't' }), NOW),
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
    row({ id: 'headless-working', interactive: false, boundWorkerId: 'w', workerStatus: 'running', workerUpdatedAt: minsAgo(1), taskId: 't' }), NOW);
  const person = classifyLocalSession(row({ id: 'person' }), NOW);

  it('a headless presence with no task is not listed and not counted', () => {
    expect([headless, person].filter(shownInSessionList).map(v => v.id)).toEqual(['person']);
    expect(countInteractiveSessions([headless, person])).toBe(1);
  });

  it('a headless session that claimed a task is still listed: it holds real work', () => {
    expect(shownInSessionList(headlessWorking)).toBe(true);
  });
});
