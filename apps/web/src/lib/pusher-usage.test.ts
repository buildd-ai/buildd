import { describe, it, expect, mock, beforeEach } from 'bun:test';

const hashes = new Map<string, Map<string, number>>();
const ttls = new Map<string, number>();
let redisUp = true;

mock.module('@/lib/redis', () => ({
  hincrWithTtl: async (key: string, field: string, ttlSec: number) => {
    if (!redisUp) return false;
    const h = hashes.get(key) ?? new Map<string, number>();
    h.set(field, (h.get(field) ?? 0) + 1);
    hashes.set(key, h);
    ttls.set(key, ttlSec);
    return true;
  },
  hgetAllKey: async (key: string) => {
    if (!redisUp) return undefined;
    const h = hashes.get(key);
    return h ? Object.fromEntries(h) : null;
  },
}));

const { recordPusherPublish, readPusherUsage, pusherUsageKey, PUSHER_USAGE_TTL_SEC } = await import('./pusher-usage');

const DAY1 = new Date('2026-10-29T12:00:00Z');
const DAY2 = new Date('2026-10-30T08:00:00Z');

beforeEach(() => {
  hashes.clear();
  ttls.clear();
  redisUp = true;
});

describe('recordPusherPublish', () => {
  it('counts per event and channel kind, per UTC day, never per channel id', async () => {
    await recordPusherPublish('workspace-ws1-activity', 'worker:progress', DAY1);
    await recordPusherPublish('workspace-ws2-activity', 'worker:progress', DAY1);
    await recordPusherPublish('workspace-ws1', 'task:created', DAY1);
    await recordPusherPublish('worker-w1', 'worker:completed', DAY2);

    expect(Object.fromEntries(hashes.get(pusherUsageKey('2026-10-29'))!)).toEqual({
      'worker:progress|workspace-activity': 2,
      'task:created|workspace': 1,
    });
    expect(Object.fromEntries(hashes.get(pusherUsageKey('2026-10-30'))!)).toEqual({ 'worker:completed|worker': 1 });
    expect(ttls.get(pusherUsageKey('2026-10-29'))).toBe(PUSHER_USAGE_TTL_SEC);
    expect(JSON.stringify([...hashes.entries()].map(([k, v]) => [k, [...v.keys()]]))).not.toContain('ws1');
  });

  it('never throws when Redis is down', async () => {
    redisUp = false;
    await expect(recordPusherPublish('workspace-ws1', 'task:created', DAY1)).resolves.toBeUndefined();
  });
});

describe('readPusherUsage', () => {
  it('reads newest day first, rows by volume, with the share that runners receive', async () => {
    for (let i = 0; i < 3; i++) await recordPusherPublish('workspace-ws1-activity', 'worker:progress', DAY2);
    await recordPusherPublish('worker-w1-activity', 'worker:progress', DAY2);
    await recordPusherPublish('workspace-ws1', 'task:created', DAY2);
    await recordPusherPublish('task-t1', 'worker:progress', DAY2);
    await recordPusherPublish('workspace-ws1', 'worker:progress', DAY1);

    const days = await readPusherUsage(2, DAY2);
    expect(days!.map(d => d.day)).toEqual(['2026-10-30', '2026-10-29']);

    const today = days![0];
    expect(today.total).toBe(6);
    expect(today.rows[0]).toEqual({ event: 'worker:progress', channelKind: 'workspace-activity', publishes: 3 });
    // Runners subscribe to workspace and worker channels, never to the activity twins or task channels.
    expect(today.onRunnerChannels).toBe(1);
    expect(today.byChannelKind).toEqual({ 'workspace-activity': 3, 'worker-activity': 1, workspace: 1, task: 1 });

    expect(days![1]).toMatchObject({ total: 1, onRunnerChannels: 1 });
  });

  it('reports an empty day as zero, and null when Redis could not be asked', async () => {
    const days = await readPusherUsage(1, DAY2);
    expect(days).toEqual([{ day: '2026-10-30', total: 0, onRunnerChannels: 0, byChannelKind: {}, rows: [] }]);
    redisUp = false;
    expect(await readPusherUsage(1, DAY2)).toBeNull();
  });
});
