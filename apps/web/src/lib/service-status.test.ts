import { describe, expect, it } from 'bun:test';
import {
  applyCapabilityCheck,
  correlateSignals,
  projectServiceStatus,
  reconcileServiceStatus,
  statusAttentionItems,
  type RawFailureSignals,
  type ServiceStatusViewer,
} from './service-status';

const T0 = '2026-10-11T08:00:00.000Z';
const T1 = '2026-10-11T09:00:00.000Z';
const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const BANNED = /incident|sentinel|failure.?rate|baseline|account[ _-]?id|\[redacted\]|<redacted>|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

const work = (n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    taskId: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    workspaceId: 'ws-1',
    requesterUserId: i === 0 ? MEMBER : i === 1 ? OWNER : 'user-other',
    hasLiveRun: false,
    ...extra,
  }));

/** 5 tasks hit one expired runner sign-in, plus a rate alert and a failed sentinel task about the same runner. */
function scenario(overrides: Partial<RawFailureSignals> = {}): RawFailureSignals {
  return {
    teamId: 'team-a',
    expiredRunnerOauth: [
      { runnerId: 'runner-1', runnerName: 'Runner A', provider: 'Claude', ownerUserId: OWNER, reconnectHref: '/app/settings/runners/runner-1', work: work(5), seenAt: T0 },
    ],
    failureRateAlert: { runnerId: 'runner-1', rate: 0.62, baseline: 0.05, seenAt: T0 },
    sentinelTasks: [{ taskId: 'sentinel-1', title: 'Fix failing pattern abc', runnerId: 'runner-1', seenAt: T0 }],
    ...overrides,
  };
}

const viewer = (userId: string, o: Partial<ServiceStatusViewer> = {}): ServiceStatusViewer => ({ userId, teamId: 'team-a', isTeamAdmin: false, usableRunnerIds: [], ...o });

describe('correlation', () => {
  it('turns 5 expired-sign-in tasks + a rate alert + a sentinel task into one root cause', () => {
    const records = correlateSignals(scenario());
    expect(records).toHaveLength(1);
    expect(records[0].classification).toBe('credential_expired');
    expect(records[0].affectedWork).toHaveLength(5);
  });

  it('yields exactly one status per viewer scope', () => {
    const records = correlateSignals(scenario());
    for (const v of [viewer(OWNER), viewer(ADMIN, { isTeamAdmin: true }), viewer(MEMBER)]) {
      expect(projectServiceStatus(records, v)).toHaveLength(1);
    }
  });

  it('shows an uncorrelated alert as one generic status, never a guessed cause', () => {
    const records = correlateSignals(scenario({ expiredRunnerOauth: [], failureRateAlert: { rate: 0.5, baseline: 0.05, seenAt: T0 }, sentinelTasks: [] }));
    expect(records).toHaveLength(1);
    expect(records[0].classification).toBe('unknown');
    const [s] = projectServiceStatus(records, viewer(ADMIN, { isTeamAdmin: true }));
    expect(s.condition).toBe('Something is slowing work; we are looking at it');
    expect(s.action).toBeNull();
  });

  it('folds an alert and sentinel task with no cause of their own into one unknown status', () => {
    const records = correlateSignals(scenario({ expiredRunnerOauth: [], failureRateAlert: { rate: 0.5, baseline: 0.05, seenAt: T0 }, sentinelTasks: [{ taskId: 's', title: 't', seenAt: T0 }] }));
    expect(records).toHaveLength(1);
  });

  it('keeps two runners as two root causes', () => {
    const s = scenario();
    s.expiredRunnerOauth.push({ runnerId: 'runner-2', runnerName: 'Runner B', provider: 'Claude', ownerUserId: ADMIN, reconnectHref: '/r2', work: work(1), seenAt: T0 });
    expect(correlateSignals(s)).toHaveLength(2);
  });

  it('classifies a platform-managed failure without sign-in wording', () => {
    const records = correlateSignals(scenario({ expiredRunnerOauth: [], failureRateAlert: null, sentinelTasks: [], platformManaged: [{ key: 'hosted', label: 'Hosted runner', work: work(2), seenAt: T0 }] }));
    const [s] = projectServiceStatus(records, viewer(OWNER));
    expect(s.action).toBeNull();
    expect(s.attention).not.toBe('needs_you');
    expect(JSON.stringify(s)).not.toMatch(/sign.?in|reconnect/i);
  });
});

describe('roles', () => {
  const records = correlateSignals(scenario());

  it('credential owner: Runner needs sign-in with reconnect, runner, provider and waiting work', () => {
    const [s] = projectServiceStatus(records, viewer(OWNER));
    expect(s.title).toBe('Runner needs sign-in');
    expect(s.condition).toContain('Runner A');
    expect(s.condition).toContain('Claude');
    expect(s.action).toEqual({ kind: 'reconnect', label: 'Sign in on Runner A', href: '/app/settings/runners/runner-1' });
    expect(s.attention).toBe('needs_you');
    expect(s.work.length).toBe(5);
  });

  it('team admin who is not the owner: coordination only, no reconnect, sees the owner', () => {
    const [s] = projectServiceStatus(records, viewer(ADMIN, { isTeamAdmin: true }));
    expect(s.title).toBe('Runner A is waiting for its owner to sign in');
    expect(s.action?.kind).not.toBe('reconnect');
    expect(s.ownerRef).toBeDefined();
    expect(s.work.length).toBe(5);
  });

  it('team admin gets a Needs You decision only when another runner can take the work', () => {
    const withAlt = correlateSignals(scenario({ alternateRunnerAvailable: true }));
    const [a] = projectServiceStatus(withAlt, viewer(ADMIN, { isTeamAdmin: true }));
    expect(a.action).toMatchObject({ kind: 'route_work' });
    expect(a.attention).toBe('needs_you');
    const [b] = projectServiceStatus(records, viewer(ADMIN, { isTeamAdmin: true }));
    expect(b.attention).toBe('quiet');
  });

  it('member: Waiting for runner sign-in on their own work only, no action, no owner identity', () => {
    const [s] = projectServiceStatus(records, viewer(MEMBER));
    expect(s.title).toBe('Waiting for runner sign-in');
    expect(s.action).toBeNull();
    expect(s.attention).toBe('quiet');
    expect(s.work.map(w => w.taskId)).toEqual(['task-1']);
    expect(s.ownerRef).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(OWNER);
  });

  it('member with no affected work and no usable runner sees nothing', () => {
    expect(projectServiceStatus(records, viewer('user-uninvolved'))).toEqual([]);
  });

  it('member who can use the affected runner sees the condition even with no own work', () => {
    const [s] = projectServiceStatus(records, viewer('user-uninvolved', { usableRunnerIds: ['runner-1'] }));
    expect(s.work).toEqual([]);
    expect(s.effect).toBe('No work affected');
  });

  it('a platform operator who is a plain member gets the same projection as any member', () => {
    const plain = projectServiceStatus(records, viewer(MEMBER));
    const op = projectServiceStatus(records, { ...viewer(MEMBER), isPlatformOperator: true } as ServiceStatusViewer);
    expect(op).toEqual(plain);
  });

  it('the same person as owner and operator sees the owner projection only', () => {
    const owner = projectServiceStatus(records, viewer(OWNER));
    const both = projectServiceStatus(records, { ...viewer(OWNER), isPlatformOperator: true } as ServiceStatusViewer);
    expect(both).toEqual(owner);
  });

  it('never carries banned terms or operator fields', () => {
    for (const v of [viewer(OWNER), viewer(ADMIN, { isTeamAdmin: true }), viewer(MEMBER)]) {
      const json = JSON.stringify(projectServiceStatus(records, v));
      expect(json).not.toMatch(BANNED);
      expect(json).not.toContain('0.62');
      expect(json).not.toContain('sentinel-1');
    }
  });

  it('shows a next update only when data backs it', () => {
    const [none] = projectServiceStatus(records, viewer(MEMBER));
    expect(none.nextUpdateAt).toBeUndefined();
    const timed = correlateSignals(scenario({ nextUpdateAt: T1 }));
    expect(projectServiceStatus(timed, viewer(MEMBER))[0].nextUpdateAt).toBe(T1);
  });

  it('a severe widespread cause raises a banner for non-actors, never needs_you', () => {
    const wide = correlateSignals(scenario({ widespread: true }));
    expect(projectServiceStatus(wide, viewer(MEMBER))[0].attention).toBe('banner');
    expect(projectServiceStatus(wide, viewer(ADMIN, { isTeamAdmin: true }))[0].attention).toBe('banner');
    expect(projectServiceStatus(wide, viewer(OWNER))[0].attention).toBe('needs_you');
  });

  it('owner without a real reconnect path gets the condition but no action and no Needs You', () => {
    const noPath = correlateSignals(scenario({ expiredRunnerOauth: [{ ...scenario().expiredRunnerOauth[0], reconnectHref: null }] }));
    const [s] = projectServiceStatus(noPath, viewer(OWNER));
    expect(s.action).toBeNull();
    expect(s.attention).not.toBe('needs_you');
  });
});

describe('team scoping', () => {
  it('a viewer of team B gets nothing from team A', () => {
    const records = correlateSignals(scenario());
    expect(projectServiceStatus(records, viewer(OWNER, { teamId: 'team-b' }))).toEqual([]);
    expect(projectServiceStatus(records, viewer(ADMIN, { teamId: 'team-b', isTeamAdmin: true }))).toEqual([]);
  });
});

describe('home attention', () => {
  const records = correlateSignals(scenario());
  const items = (v: ServiceStatusViewer) => statusAttentionItems(projectServiceStatus(records, v));

  it('owner gets one card naming runner, provider and waiting work, linking to the reconnect path', () => {
    const [i] = items(viewer(OWNER));
    expect(i.actionType).toBe('reconnect');
    expect(i.title).toBe('Runner needs sign-in');
    expect(i.sentence).toContain('Runner A');
    expect(i.sentence).toContain('Claude');
    expect(i.sentence).toContain('5');
    expect(i.primary?.href).toBe('/app/settings/runners/runner-1');
    expect(`${i.title} ${i.sentence} ${i.meta}`).not.toMatch(BANNED);
  });

  it('members and admins without a decision add no Needs You items', () => {
    expect(items(viewer(MEMBER))).toEqual([]);
    expect(items(viewer(ADMIN, { isTeamAdmin: true }))).toEqual([]);
  });

  it('a banner status adds no Needs You item', () => {
    const wide = correlateSignals(scenario({ widespread: true }));
    expect(statusAttentionItems(projectServiceStatus(wide, viewer(MEMBER)))).toEqual([]);
  });
});

describe('recovery and dedupe', () => {
  it('notifies once, then not on repeated observations', () => {
    const r = correlateSignals(scenario());
    const first = reconcileServiceStatus({ ledger: [], records: r, now: T0 });
    expect(first.notify).toHaveLength(1);
    const second = reconcileServiceStatus({ ledger: first.ledger, records: r, now: T1 });
    expect(second.notify).toEqual([]);
    expect(second.ledger).toHaveLength(1);
  });

  it('stays active when the owner reconnects but the capability check fails', () => {
    const r = correlateSignals(scenario());
    const checked = r.map(x => applyCapabilityCheck(x, { ok: false, checkedAt: T1 }));
    expect(checked[0].verifiedRestoredAt).toBeNull();
    const led = reconcileServiceStatus({ ledger: [], records: r, now: T0 }).ledger;
    const out = reconcileServiceStatus({ ledger: led, records: checked, now: T1 });
    expect(out.cleared).toEqual([]);
    expect(out.resume).toEqual([]);
    expect(projectServiceStatus(checked, viewer(OWNER))).toHaveLength(1);
  });

  it('clears on a passing check and drops the status and action', () => {
    const r = correlateSignals(scenario());
    const led = reconcileServiceStatus({ ledger: [], records: r, now: T0 }).ledger;
    const ok = r.map(x => applyCapabilityCheck(x, { ok: true, checkedAt: T1 }));
    expect(projectServiceStatus(ok, viewer(OWNER))).toEqual([]);
    expect(statusAttentionItems(projectServiceStatus(ok, viewer(OWNER)))).toEqual([]);
    const out = reconcileServiceStatus({ ledger: led, records: ok, now: T1 });
    expect(out.cleared).toHaveLength(1);
  });

  it('asks the existing workflow authority to resume only waiting work, pinned to the same runner', () => {
    const s = scenario();
    s.expiredRunnerOauth[0].work = [...work(3), { taskId: 'live-1', title: 'Live', workspaceId: 'ws-1', requesterUserId: OWNER, hasLiveRun: true }];
    const r = correlateSignals(s);
    const led = reconcileServiceStatus({ ledger: [], records: r, now: T0 }).ledger;
    const ok = r.map(x => applyCapabilityCheck(x, { ok: true, checkedAt: T1 }));
    const out = reconcileServiceStatus({ ledger: led, records: ok, now: T1 });
    expect(out.resume.map(x => x.taskId).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    expect(out.resume.every(x => x.runnerId === 'runner-1' && x.providerFallback === 'none')).toBe(true);
  });

  it('does not resume twice when cleared is observed again', () => {
    const r = correlateSignals(scenario());
    const led = reconcileServiceStatus({ ledger: [], records: r, now: T0 }).ledger;
    const ok = r.map(x => applyCapabilityCheck(x, { ok: true, checkedAt: T1 }));
    const once = reconcileServiceStatus({ ledger: led, records: ok, now: T1 });
    const again = reconcileServiceStatus({ ledger: once.ledger, records: ok, now: T1 });
    expect(again.resume).toEqual([]);
    expect(again.cleared).toEqual([]);
  });

  it('reopens a cleared cause without a new notification', () => {
    const r = correlateSignals(scenario());
    const a = reconcileServiceStatus({ ledger: [], records: r, now: T0 });
    const ok = r.map(x => applyCapabilityCheck(x, { ok: true, checkedAt: T1 }));
    const b = reconcileServiceStatus({ ledger: a.ledger, records: ok, now: T1 });
    const c = reconcileServiceStatus({ ledger: b.ledger, records: correlateSignals(scenario()), now: '2026-10-11T10:00:00.000Z' });
    expect(c.notify).toEqual([]);
    expect(c.ledger[0].state).toBe('active');
    expect(c.ledger).toHaveLength(1);
  });
});
