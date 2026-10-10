import { describe, it, expect } from 'bun:test';
import {
  incidentEscalationRule,
  incidentFingerprint,
  createGatedIncidentSender,
  incidentNeedsYouItems,
  type IncidentSubject,
  type IncidentGateDeps,
} from './failure-incident-escalation';
import type { IncidentAlert } from './failure-incident-actions';
import type { StoredIncident } from './failure-incident-store';

const subject = (over: Partial<IncidentSubject> = {}): IncidentSubject => ({
  key: 'incident:i1', incidentId: 'i1', teamId: 't1', workspaceId: 'w1',
  severity: 'high', status: 'open', fixTask: null, recurrenceCount: 0, scope: 3, ...over,
});

describe('incidentEscalationRule', () => {
  it('asks the owner for a critical platform incident', () => {
    expect(incidentEscalationRule(subject({ severity: 'critical' }))).toMatchObject({ owner: 'person', by: 'rule', rail: 'critical_incident' });
  });
  it('asks the owner for a critical incident even while a fix task runs', () => {
    expect(incidentEscalationRule(subject({ severity: 'critical', fixTask: { id: 'f1', running: true } }))).toMatchObject({ owner: 'person' });
  });
  it('Buildd owns a high incident whose fix task is running', () => {
    expect(incidentEscalationRule(subject({ fixTask: { id: 'abcdef123', running: true } }))).toMatchObject({ owner: 'buildd', by: 'rule', action: 'wait_machine' });
  });
  it('a finished fix task is not ownership', () => {
    expect(incidentEscalationRule(subject({ fixTask: { id: 'f1', running: false } }))).toMatchObject({ owner: 'person' });
  });
  it('a high incident with no fix task has no next step: the owner', () => {
    expect(incidentEscalationRule(subject())).toMatchObject({ owner: 'person', rail: 'no_next_step' });
  });
  it('medium, low and resolved incidents never reach a person', () => {
    for (const s of [subject({ severity: 'medium' }), subject({ severity: 'low' }), subject({ status: 'resolved', severity: 'critical' })]) {
      expect(incidentEscalationRule(s)).toMatchObject({ owner: 'buildd', action: 'hold' });
    }
  });
});

describe('incidentFingerprint', () => {
  it('is stable across occurrences and changes on a transition', () => {
    expect(incidentFingerprint(subject({ scope: 3 }))).toBe(incidentFingerprint(subject({ scope: 4 })));
    const base = incidentFingerprint(subject());
    expect(incidentFingerprint(subject({ severity: 'critical' }))).not.toBe(base);
    expect(incidentFingerprint(subject({ recurrenceCount: 1 }))).not.toBe(base);
    expect(incidentFingerprint(subject({ fixTask: { id: 'f', running: true } }))).not.toBe(base);
    expect(incidentFingerprint(subject({ scope: 12 }))).not.toBe(base);
  });
});

function harness(over: Partial<IncidentGateDeps> = {}) {
  const notified: Array<{ teamId: string; title: string; url?: string; priority?: number }> = [];
  const records: Array<Record<string, unknown>> = [];
  const stored = new Map<string, { fingerprint: string; appliedAnswer: string | null }>();
  const deps: IncidentGateDeps = {
    loadTeamId: async () => 't1',
    loadFixTask: async () => null,
    loadStored: async (_t, key) => stored.get(key) ?? null,
    record: async r => { records.push(r as unknown as Record<string, unknown>); stored.set(r.subjectId!, { fingerprint: r.fingerprint, appliedAnswer: r.appliedAnswer ?? null }); return 'rec1'; },
    notify: async (teamId, p) => { notified.push({ teamId, ...p }); },
    ...over,
  };
  return { deps, notified, records };
}

const incident = (over: Partial<StoredIncident> = {}) => ({
  id: 'i1', workspaceId: 'w1', severity: 'high', status: 'open', rule: 'retry_fork', recurrenceCount: 0,
  linkedFixTaskId: null, affectedRefs: { taskIds: ['a', 'b'], prNumbers: [] }, impact: {}, ...over,
}) as unknown as StoredIncident;
const alert = (over: Partial<IncidentAlert> = {}, inc = incident()): IncidentAlert => ({
  incidentId: 'i1', severity: inc.severity, priority: inc.severity === 'critical' ? 1 : 0, reason: 'opened',
  title: 'HIGH incident opened: x', message: 'm', dedupeKey: 'k', incident: inc, ...over,
});

describe('gated incident sender', () => {
  it('pages the owner once for a critical incident, with the deep link, and stores the verdict', async () => {
    const h = harness();
    const send = createGatedIncidentSender(h.deps);
    const inc = incident({ severity: 'critical' });
    expect(await send(alert({}, inc))).toBe(true);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ teamId: 't1', priority: 1 });
    expect(h.notified[0].url).toContain('/app/incidents/i1');
    expect(h.records[0]).toMatchObject({ capability: 'escalation_gate', subjectType: 'incident', subjectId: 'incident:i1', appliedAnswer: 'person:rule:critical_incident' });
  });

  it('does not page while the fix task runs, and still stores the verdict', async () => {
    const h = harness({ loadFixTask: async () => ({ id: 'f1', status: 'in_progress' }) });
    const send = createGatedIncidentSender(h.deps);
    expect(await send(alert({}, incident({ linkedFixTaskId: 'f1' })))).toBe(false);
    expect(h.notified).toHaveLength(0);
    expect(h.records[0]).toMatchObject({ appliedAnswer: expect.stringMatching(/^buildd:rule:wait_machine/) });
  });

  it('a pending fix task counts as running', async () => {
    const h = harness({ loadFixTask: async () => ({ id: 'f1', status: 'pending' }) });
    expect(await createGatedIncidentSender(h.deps)(alert({}, incident({ linkedFixTaskId: 'f1' })))).toBe(false);
  });

  it('pages for a high incident with no fix task, once per transition', async () => {
    const h = harness();
    const send = createGatedIncidentSender(h.deps);
    expect(await send(alert())).toBe(true);
    expect(await send(alert())).toBe(false); // same state replayed
    expect(h.notified).toHaveLength(1);
    expect(h.records).toHaveLength(1);
    expect(await send(alert({ severity: 'critical' }, incident({ severity: 'critical' })))).toBe(true); // new transition
    expect(h.notified).toHaveLength(2);
  });

  it('pages when the fix task has finished and the incident recurs', async () => {
    const h = harness({ loadFixTask: async () => ({ id: 'f1', status: 'completed' }) });
    const send = createGatedIncidentSender(h.deps);
    expect(await send(alert({ reason: 'recurrence' }, incident({ linkedFixTaskId: 'f1', recurrenceCount: 1 })))).toBe(true);
  });

  it('records only when the owning team cannot be resolved', async () => {
    const h = harness({ loadTeamId: async () => null });
    expect(await createGatedIncidentSender(h.deps)(alert())).toBe(false);
    expect(h.notified).toHaveLength(0);
  });

  it('a failed state read still pages (the gate never silences)', async () => {
    const h = harness({ loadFixTask: async () => { throw new Error('db'); } });
    expect(await createGatedIncidentSender(h.deps)(alert({}, incident({ linkedFixTaskId: 'f1' })))).toBe(true);
  });

  it('asks the judge only for a concern and lets it hand the incident to Buildd', async () => {
    let asked = 0;
    const h = harness({ judge: async () => { asked++; return { owner: 'buildd', by: 'jev', action: 'hold', reason: 'noise' }; } });
    const send = createGatedIncidentSender(h.deps);
    expect(await send(alert())).toBe(false);
    expect(asked).toBe(1);
    await send(alert({ severity: 'critical' }, incident({ severity: 'critical' })));
    expect(asked).toBe(1); // critical is a rule
  });
});

describe('gated incident sender: a failed page is not remembered', () => {
  it('does not store the verdict when the page fails, so the next replay pages again', async () => {
    let fail = true;
    const h = harness({ notify: async () => { if (fail) throw new Error('push down'); } });
    const send = createGatedIncidentSender(h.deps);
    await expect(send(alert())).rejects.toThrow('push down');
    expect(h.records).toHaveLength(0);
    fail = false;
    expect(await send(alert())).toBe(true);
    expect(h.records).toHaveLength(1);
  });

  it('stores the verdict only after the page went out', async () => {
    const order: string[] = [];
    const h = harness({
      notify: async () => { order.push('notify'); },
      record: async () => { order.push('record'); return 'r'; },
    });
    await createGatedIncidentSender(h.deps)(alert({}, incident({ severity: 'critical' })));
    expect(order).toEqual(['notify', 'record']);
  });
});

describe('incidentNeedsYouItems: Home and the badge read the stored verdict', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'i1', workspaceId: 'w1', title: 'Retry forks across 3 tasks', severity: 'high' as const, status: 'open' as const,
    lastSeenAt: new Date('2026-10-09T20:00:00Z'), ...over,
  });
  const person = { owner: 'person' as const, by: 'rule' as const, rail: 'critical_incident' as const, reason: 'A critical platform incident: the owner is told once, whatever else is running.' };
  const buildd = { owner: 'buildd' as const, by: 'rule' as const, action: 'wait_machine' as const, reason: 'Buildd is fixing it (task abcdef12).' };

  it('lists an open incident whose stored verdict is the owner, with the incident link', () => {
    const items = incidentNeedsYouItems([row()], new Map([['i1', person]]), 'https://x.test');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'incident', incidentId: 'i1', incidentTitle: 'Retry forks across 3 tasks', fixHref: 'https://x.test/app/incidents/i1', fixLabel: 'Open incident' });
    expect(items[0].failureMessage).toBe(person.reason);
  });

  it('leaves out an incident Buildd owns, one with no stored verdict, and a resolved one', () => {
    const items = incidentNeedsYouItems(
      [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', status: 'resolved' })],
      new Map([['a', buildd], ['c', person]]),
      'https://x.test',
    );
    expect(items).toEqual([]);
  });
});

