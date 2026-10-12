/**
 * Activity's Now must read a local session's work the way the session card
 * does. A session whose client went quiet (or ended) while a server write
 * bumped its held worker is not an agent live: not "agent live", not counted
 * in agents working, and not promoted to Latest by that write.
 *
 * The seed replays the adversarial shapes: a ghost (client last heard 3h ago,
 * never ended, worker updated_at bumped just now), an ended session whose
 * worker still reads running, and a live session with a running worker. Each
 * goes through classifyLocalSession → localHoldsByWorker → the worker shape
 * loadActivity builds → buildActivityNow / latestTask.
 */
import { describe, expect, it, mock } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { classifyLocalSession } = await import('./local-session-view');
const { localHoldsByWorker } = await import('./local-session-display');
const { buildActivityNow, latestTask } = await import('./activity-delivery');
type Row = import('./local-session-view').LocalSessionRow;
type ActivityTaskInput = import('./activity-delivery').ActivityTaskInput;

const NOW = new Date('2026-10-09T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function session(id: string, workerId: string, taskId: string, over: Partial<Row>): Row {
  return {
    id, workspaceId: 'ws', clientKind: 'claude', clientVersion: null, repo: 'acme/app', interactive: true,
    startedAt: minsAgo(300), lastSeenAt: minsAgo(0), endedAt: null,
    held: [{ workerId, workerStatus: 'running', workerUpdatedAt: minsAgo(0), taskId, taskTitle: taskId, taskStatus: 'in_progress' }],
    ...over,
  };
}

const sessions = [
  session('ghost', 'w-ghost', 't-ghost', { lastSeenAt: minsAgo(180) }),
  session('ended', 'w-ended', 't-ended', { lastSeenAt: minsAgo(30), endedAt: minsAgo(30) }),
  session('live', 'w-live', 't-live', { lastSeenAt: minsAgo(0) }),
].map(r => classifyLocalSession(r, NOW));
const holds = localHoldsByWorker(sessions);

/** A task as loadActivity maps it: the worker's name and hold come from the session holding it. */
function localTask(id: string, workerId: string, workerUpdatedMinsAgo: number, over: Partial<ActivityTaskInput> = {}): ActivityTaskInput {
  const hold = holds.get(workerId) ?? null;
  return {
    id, title: id, status: 'in_progress', taskClass: 'work', missionId: null,
    createdAt: minsAgo(240).toISOString(), updatedAt: minsAgo(200).toISOString(),
    workers: [{ status: 'running', name: hold?.client ?? 'runner', startedAt: minsAgo(200).toISOString(), updatedAt: minsAgo(workerUpdatedMinsAgo).toISOString(), local: hold }],
    ...over,
  };
}

// The ghost's worker was bumped by a server write just now; the live one moved a minute ago.
const ghost = localTask('t-ghost', 'w-ghost', 0);
const ended = localTask('t-ended', 'w-ended', 0);
const live = localTask('t-live', 'w-live', 1);
const build = (tasks: ActivityTaskInput[]) => buildActivityNow({ tasks, missions: [], rules, now: NOW.getTime() });
const rowOf = (tasks: ActivityTaskInput[], id: string) => build(tasks).groups.flatMap(g => g.rows).find(r => r.id === id)!;

describe('Activity Now reads a local session by its own client, as the session card does', () => {
  it('the seed classifies as the card reads it: offline, ended, working', () => {
    expect(sessions.map(s => [s.id, s.state])).toEqual(expect.arrayContaining([['ghost', 'offline'], ['ended', 'ended'], ['live', 'bound']]));
  });

  it('a quiet session\'s task is not agent live and says the session went quiet and holds the slot', () => {
    const r = rowOf([ghost, ended, live], 't-ghost');
    expect(r.live).toBe(false);
    expect(r.quietHold).toEqual({ client: 'Claude Code · local', state: 'offline', at: minsAgo(180).getTime() });
    expect(r.line).toBe("A Claude Code · local session went quiet 3h ago and still holds this task's slot. Release it from the task page.");
    expect(r.line).not.toContain('An agent is building it');
    // Its age is the client's last event, not the server's bump.
    expect(r.updatedAt).toBe(minsAgo(180).getTime());
  });

  it('an ended session\'s task says the session ended', () => {
    const r = rowOf([ghost, ended, live], 't-ended');
    expect(r.live).toBe(false);
    expect(r.quietHold?.state).toBe('ended');
    expect(r.line).toBe("A Claude Code · local session ended 30m ago and still holds this task's slot. Release it from the task page.");
  });

  it('a live session\'s row is unchanged', () => {
    const r = rowOf([ghost, ended, live], 't-live');
    expect(r.live).toBe(true);
    expect(r.quietHold).toBeNull();
    expect(r.line).toBe('An agent is building it on Claude Code · local.');
  });

  it('only the live session counts as an agent working; the held slots are still deliveries in motion', () => {
    const n = build([ghost, ended, live]);
    expect(n.liveAgents).toBe(1);
    expect(n.inMotion).toBe(3);
  });

  it('Latest is not promoted by a server write to a quiet session\'s worker', () => {
    expect(latestTask([ghost, ended, live], rules)?.id).toBe('t-live');
  });

  it('a cancelled root with a live worker is not counted', () => {
    const cancelled = localTask('t-cancelled', 'w-runner', 0, { status: 'cancelled' });
    expect(build([cancelled]).liveAgents).toBe(0);
    expect(build([cancelled, live]).liveAgents).toBe(1);
  });

  it('a worker no local session holds reads as before', () => {
    const r = rowOf([localTask('t-runner', 'w-runner', 1)], 't-runner');
    expect(r.live).toBe(true);
    expect(r.quietHold).toBeNull();
    expect(r.line).toBe('An agent is building it on runner.');
  });
});
