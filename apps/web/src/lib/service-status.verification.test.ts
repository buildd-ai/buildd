import { describe, expect, it } from 'bun:test';
import { correlateSignals, projectServiceStatus, statusAttentionItems } from './service-status';
import { ADMIN, MEMBER, OPERATOR_ADMIN, OWNER, expiredSignInScenario, platformOutageScenario, viewerFor } from './service-status-scenario';

const BANNED = /incident|sentinel|failure.?rate|baseline|account[ _-]?id|redact|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\b0\.62\b|62\s?%/i;
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

const recordsA = correlateSignals(expiredSignInScenario('team-a'));
const recordsB = correlateSignals(expiredSignInScenario('team-b'));
const outageA = correlateSignals(platformOutageScenario('team-a'));
const admin = viewerFor(ADMIN, { isTeamAdmin: true });

describe('expired sign-in: five waiting tasks, alert and sentinel task are one status', () => {
  it('member, admin, owner and operator-who-is-also-admin each get exactly one status in their own words', () => {
    const [m] = projectServiceStatus(recordsA, viewerFor(MEMBER));
    const [a] = projectServiceStatus(recordsA, admin);
    const [o] = projectServiceStatus(recordsA, viewerFor(OWNER));
    const [op] = projectServiceStatus(recordsA, viewerFor(OPERATOR_ADMIN, { isTeamAdmin: true }));
    expect(m.title).toBe('Waiting for runner sign-in');
    expect(m.work).toHaveLength(1);
    expect(m.action).toBeNull();
    expect(m.ownerRef).toBeUndefined();
    expect(a.title).toBe('Runner A is waiting for its owner to sign in');
    expect(a.work).toHaveLength(5);
    expect(a.action?.kind).toBe('route_work');
    expect(a.ownerRef?.userId).toBe(OWNER);
    expect(o.title).toBe('Runner needs sign-in');
    expect(o.action?.kind).toBe('reconnect');
    expect(o.work).toHaveLength(5);
    // Being the platform operator adds nothing: identical to any other team admin.
    expect({ ...op, key: '' }).toEqual({ ...a, key: '' });
  });

  it('no team-facing string carries incident vocabulary, rates or ids, for any viewer', () => {
    for (const v of [viewerFor(MEMBER), admin, viewerFor(OWNER)]) {
      const text = strings([...projectServiceStatus(recordsA, v), ...statusAttentionItems(projectServiceStatus(recordsA, v))]).join('\n');
      expect(text).not.toMatch(BANNED);
    }
  });

  it('only the credential owner reaches Needs You; a routing-capable admin and a member never do', () => {
    expect(statusAttentionItems(projectServiceStatus(recordsA, viewerFor(MEMBER)))).toHaveLength(0);
    expect(statusAttentionItems(projectServiceStatus(recordsA, viewerFor(OWNER)))).toHaveLength(1);
    expect(statusAttentionItems(projectServiceStatus(recordsA, admin))).toHaveLength(0);
    const noAlt = correlateSignals({ ...expiredSignInScenario(), alternateRunnerAvailable: false });
    expect(statusAttentionItems(projectServiceStatus(noAlt, admin))).toHaveLength(0);
  });
});

describe('true platform outage', () => {
  it('is service impact only: no sign-in wording, no action, a banner and zero Needs You for everyone', () => {
    for (const v of [viewerFor(MEMBER), admin, viewerFor(OWNER)]) {
      const statuses = projectServiceStatus(outageA, v);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].action).toBeNull();
      expect(statuses[0].attention).toBe('banner');
      expect(strings(statuses).join(' ')).not.toMatch(/sign.?in|reconnect|runner needs/i);
      expect(statusAttentionItems(statuses)).toHaveLength(0);
    }
  });
});

describe('team isolation', () => {
  it('team B sees nothing of team A, even as an admin, through any viewer shape', () => {
    const all = [...recordsA, ...outageA];
    for (const v of [viewerFor(MEMBER, {}, 'team-b'), viewerFor(ADMIN, { isTeamAdmin: true, usableRunnerIds: ['team-a-runner-1'] }, 'team-b'), viewerFor(OWNER, {}, 'team-b')]) {
      expect(projectServiceStatus(all, v)).toEqual([]);
    }
  });

  it('with both teams in one input, each team admin sees only their own runner and work', () => {
    const both = [...recordsA, ...recordsB];
    const b = projectServiceStatus(both, viewerFor(ADMIN, { isTeamAdmin: true }, 'team-b'));
    expect(b).toHaveLength(1);
    expect(strings(b).join(' ')).not.toContain('team-a');
    expect(b.every(s => s.key.startsWith('team-b:'))).toBe(true);
  });
});
