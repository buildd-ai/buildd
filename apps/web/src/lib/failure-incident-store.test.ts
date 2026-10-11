import { describe, it, expect } from 'bun:test';
import {
  upsertIncident,
  recordIncidentCandidates,
  updateIncidentState,
  mergeIncident,
  type IncidentStorePort,
  type StoredIncident,
} from './failure-incident-store';
import {
  detectFailurePatterns,
  MAX_EVIDENCE_REFS,
  MAX_AFFECTED_REFS,
  FAILURE_PATTERN_DETECTOR_VERSION,
  type IncidentCandidate,
  type RetryChildFact,
} from './failure-pattern-sentinel';

const WS = '00000000-0000-4000-8000-0000000000aa';
const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/**
 * In-memory port with the same contract as the drizzle one: insert is
 * ON CONFLICT DO NOTHING on (signature, detectorVersion), update is a
 * compare-and-swap on `version`. `yieldEvery` forces interleaving so
 * concurrent upserts genuinely race between read and write.
 */
function memoryPort(opts: { yieldBetween?: boolean } = {}) {
  const rows = new Map<string, StoredIncident>();
  let seq = 0;
  let casFailures = 0;
  const tick = () => (opts.yieldBetween ? new Promise<void>(r => setTimeout(r, Math.random() * 3)) : Promise.resolve());
  const key = (s: string, v: string) => `${s}::${v}`;
  const port: IncidentStorePort = {
    async find(signature, detectorVersion) {
      await tick();
      const r = rows.get(key(signature, detectorVersion));
      return r ? structuredClone(r) : null;
    },
    async findById(id) {
      await tick();
      for (const r of rows.values()) if (r.id === id) return structuredClone(r);
      return null;
    },
    async insert(row) {
      await tick();
      const k = key(row.signature, row.detectorVersion);
      if (rows.has(k)) return null;
      const stored: StoredIncident = { ...structuredClone(row), id: `inc-${++seq}`, version: 0 };
      rows.set(k, stored);
      return structuredClone(stored);
    },
    async compareAndSwap(id, expectedVersion, next) {
      await tick();
      for (const [k, r] of rows) {
        if (r.id !== id) continue;
        if (r.version !== expectedVersion) { casFailures++; return null; }
        const stored = { ...structuredClone(next), id, version: expectedVersion + 1 };
        rows.set(k, stored);
        return structuredClone(stored);
      }
      return null;
    },
  };
  return { port, rows, casFailures: () => casFailures };
}

function child(taskId: string, createdAtMin: number, over: Partial<RetryChildFact> = {}): RetryChildFact {
  return {
    taskId,
    parentTaskId: 'parent-1',
    subjectPrNumber: 3412,
    kind: 'reviewer',
    stage: 'review',
    iteration: 2,
    createdAt: at(createdAtMin),
    ...over,
  };
}

function forkCandidate(children: RetryChildFact[], nowMin = 30): IncidentCandidate {
  const c = detectFailurePatterns({ workspaceId: WS, now: at(nowMin), retryChildren: children })
    .find(x => x.rule === 'retry_fork');
  if (!c) throw new Error('expected a retry_fork candidate');
  return c;
}

describe('upsertIncident — dedupe/upsert', () => {
  it('opens one incident, then updates the same row for later occurrences', async () => {
    const { port, rows } = memoryPort();
    const first = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    expect(first.outcome).toBe('opened');
    expect(first.incident.status).toBe('open');
    expect(first.incident.occurrenceCount).toBe(2);
    expect(first.incident.firstSeenAt).toBe(at(0));
    expect(first.incident.lastSeenAt).toBe(at(1));
    expect(first.incident.severity).toBe('high');
    expect(first.incident.detectorVersion).toBe(FAILURE_PATTERN_DETECTOR_VERSION);
    expect(first.incident.recurrenceCount).toBe(0);

    const second = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1), child('c3', 5)]));
    expect(second.outcome).toBe('updated');
    expect(second.incident.id).toBe(first.incident.id);
    expect(second.incident.occurrenceCount).toBe(3);
    expect(second.incident.firstSeenAt).toBe(at(0));
    expect(second.incident.lastSeenAt).toBe(at(5));
    expect(second.incident.severity).toBe('critical');
    expect(second.escalated).toBe(true);
    expect(second.previousSeverity).toBe('high');
    expect(second.incident.affectedRefs.taskIds.sort()).toEqual(['c1', 'c2', 'c3', 'parent-1']);
    expect(rows.size).toBe(1);
  });

  it('is idempotent: re-applying the same candidate changes nothing', async () => {
    const { port } = memoryPort();
    const cand = forkCandidate([child('c1', 0), child('c2', 1)]);
    const a = await upsertIncident(port, cand);
    const b = await upsertIncident(port, cand);
    const c = await upsertIncident(port, cand);
    expect(b.outcome).toBe('unchanged');
    expect(c.outcome).toBe('unchanged');
    expect(c.incident.occurrenceCount).toBe(a.incident.occurrenceCount);
    expect(c.incident.lastSeenAt).toBe(a.incident.lastSeenAt);
  });

  it('never lowers severity on update', async () => {
    const { port } = memoryPort();
    await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1), child('c3', 2)]));
    const later = forkCandidate([child('c4', 10), child('c5', 11)]);
    expect(later.severity).toBe('high');
    const r = await upsertIncident(port, later);
    expect(r.incident.severity).toBe('critical');
    expect(r.escalated).toBe(false);
  });

  it('a different detector version is a different incident', async () => {
    const { port, rows } = memoryPort();
    const cand = forkCandidate([child('c1', 0), child('c2', 1)]);
    await upsertIncident(port, cand);
    await upsertIncident(port, { ...cand, detectorVersion: 'fps-v999' });
    expect(rows.size).toBe(2);
  });
});

describe('recurrence after resolved', () => {
  it('stale evidence leaves a resolved incident resolved; new evidence reopens it once', async () => {
    const { port } = memoryPort();
    const opened = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    await updateIncidentState(port, opened.incident.id, { type: 'alerted', severity: 'high' }, { now: at(3) });
    await updateIncidentState(port, opened.incident.id, { type: 'resolve' }, { now: at(10) });

    const stale = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    expect(stale.outcome).toBe('unchanged');
    expect(stale.incident.status).toBe('resolved');

    const recur = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1), child('c9', 20)], 21));
    expect(recur.outcome).toBe('reopened');
    expect(recur.incident.status).toBe('open');
    expect(recur.incident.recurrenceCount).toBe(1);
    expect(recur.incident.resolvedAt).toBeNull();
    expect(recur.incident.firstSeenAt).toBe(at(0));
    expect(recur.incident.lastSeenAt).toBe(at(20));
    expect(recur.incident.occurrenceCount).toBe(3);
    // alert bookkeeping survives so the paging layer can decide on recurrence
    expect(recur.incident.lastAlertedAt).toBe(at(3));
    expect(recur.incident.lastAlertSeverity).toBe('high');

    const again = await upsertIncident(port, forkCandidate([child('c9', 20)].concat(child('c1', 0)), 22));
    expect(again.outcome).toBe('unchanged');
    expect(again.incident.recurrenceCount).toBe(1);
  });

  it('acknowledged incidents stay acknowledged while occurrences accrue', async () => {
    const { port } = memoryPort();
    const o = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    await updateIncidentState(port, o.incident.id, { type: 'acknowledge' }, { now: at(3) });
    const u = await upsertIncident(port, forkCandidate([child('c3', 4), child('c4', 5)]));
    expect(u.outcome).toBe('updated');
    expect(u.incident.status).toBe('acknowledged');
    expect(u.incident.occurrenceCount).toBe(4);
  });
});

describe('bounded evidence', () => {
  it('evidence and affected refs never exceed their caps however many occurrences arrive', async () => {
    const { port } = memoryPort();
    for (let wave = 0; wave < 10; wave++) {
      const kids = Array.from({ length: 12 }, (_, i) => child(`w${wave}-c${i}`, wave * 20 + i));
      await upsertIncident(port, forkCandidate(kids, wave * 20 + 15));
    }
    const final = (await port.find(forkCandidate([child('a', 0), child('b', 0)]).signature, FAILURE_PATTERN_DETECTOR_VERSION))!;
    expect(final.occurrenceCount).toBe(120);
    expect(final.evidenceRefs.length).toBe(MAX_EVIDENCE_REFS);
    expect(final.affectedRefs.taskIds.length).toBeLessThanOrEqual(MAX_AFFECTED_REFS);
    // newest retained
    expect(final.evidenceRefs[0].id).toBe('w9-c11');
  });
});

describe('concurrency', () => {
  it('parallel upserts of overlapping candidates converge on one row with exact counts', async () => {
    const { port, rows, casFailures } = memoryPort({ yieldBetween: true });
    const waves = Array.from({ length: 12 }, (_, i) =>
      forkCandidate([child('c0', 0), child('c1', 1), child(`n${i}`, 2 + i)], 30));
    // Liveness bound: a CAS only fails because another writer's succeeded, so
    // every round lands at least one writer and N racing writers finish within
    // N rounds. The default budget is for the realistic case (one sweep at a
    // time per workspace); this test races twelve at once.
    const results = await Promise.all(waves.map(c => upsertIncident(port, c, { maxAttempts: waves.length })));
    expect(rows.size).toBe(1);
    const final = [...rows.values()][0];
    // c0, c1 and twelve distinct n* — every occurrence counted exactly once,
    // whatever order the racing waves landed in.
    expect(final.occurrenceCount).toBe(14);
    expect(results.filter(r => r.outcome === 'opened')).toHaveLength(1);
    // every non-noop write bumped the version exactly once
    expect(final.version).toBe(results.filter(r => r.outcome === 'updated').length);
    expect(final.affectedRefs.taskIds).toHaveLength(15);
    // the race was real: at least one writer lost a CAS or an insert and retried
    expect(casFailures() + results.filter(r => r.attempts > 1).length).toBeGreaterThan(0);
  });

  it('parallel upserts of the SAME candidate open once and count once', async () => {
    const { port, rows } = memoryPort({ yieldBetween: true });
    const cand = forkCandidate([child('c1', 0), child('c2', 1)]);
    const results = await Promise.all(Array.from({ length: 20 }, () => upsertIncident(port, cand)));
    expect(rows.size).toBe(1);
    expect(results.filter(r => r.outcome === 'opened')).toHaveLength(1);
    expect(results.filter(r => r.outcome === 'unchanged')).toHaveLength(19);
    expect([...rows.values()][0].occurrenceCount).toBe(2);
  });

  it('gives up after bounded retries rather than spinning', async () => {
    const { port } = memoryPort();
    const cand = forkCandidate([child('c1', 0), child('c2', 1)]);
    await upsertIncident(port, cand);
    const alwaysLoses: IncidentStorePort = { ...port, compareAndSwap: async () => null };
    await expect(upsertIncident(alwaysLoses, forkCandidate([child('c3', 5), child('c4', 6)])))
      .rejects.toThrow(/contention/);
  });
});

describe('recordIncidentCandidates — never blocks the caller', () => {
  it('swallows a failing store and returns what landed', async () => {
    const broken: IncidentStorePort = {
      find: async () => { throw new Error('db down'); },
      findById: async () => { throw new Error('db down'); },
      insert: async () => { throw new Error('db down'); },
      compareAndSwap: async () => { throw new Error('db down'); },
    };
    const errors: unknown[] = [];
    const out = await recordIncidentCandidates([forkCandidate([child('c1', 0), child('c2', 1)])], {
      port: broken,
      onError: e => errors.push(e),
    });
    expect(out).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('one failing candidate does not stop the others', async () => {
    const { port, rows } = memoryPort();
    const good = forkCandidate([child('c1', 0), child('c2', 1)]);
    const bad = { ...good, signature: 'boom' } as IncidentCandidate;
    const flaky: IncidentStorePort = {
      ...port,
      find: async (s, v) => { if (s === 'boom') throw new Error('x'); return port.find(s, v); },
    };
    const out = await recordIncidentCandidates([bad, good], { port: flaky, onError: () => {} });
    expect(out).toHaveLength(1);
    expect(rows.size).toBe(1);
  });
});

describe('updateIncidentState', () => {
  it('records alerts, links a fix task, and resolve/acknowledge timestamps', async () => {
    const { port } = memoryPort();
    const o = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    const linked = await updateIncidentState(port, o.incident.id, { type: 'link_fix_task', taskId: 'fix-1' }, { now: at(3) });
    expect(linked?.linkedFixTaskId).toBe('fix-1');
    const alerted = await updateIncidentState(port, o.incident.id, { type: 'alerted', severity: 'critical' }, { now: at(4) });
    expect(alerted?.lastAlertedAt).toBe(at(4));
    expect(alerted?.lastAlertSeverity).toBe('critical');
    const ack = await updateIncidentState(port, o.incident.id, { type: 'acknowledge' }, { now: at(5) });
    expect(ack?.status).toBe('acknowledged');
    expect(ack?.acknowledgedAt).toBe(at(5));
    const res = await updateIncidentState(port, o.incident.id, { type: 'resolve' }, { now: at(6) });
    expect(res?.status).toBe('resolved');
    expect(res?.resolvedAt).toBe(at(6));
    expect(await updateIncidentState(port, 'missing', { type: 'resolve' }, { now: at(7) })).toBeNull();
  });

  it('links only the first fix task: a racing second link keeps the first', async () => {
    const { port } = memoryPort();
    const o = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    await updateIncidentState(port, o.incident.id, { type: 'link_fix_task', taskId: 'fix-1' });
    const second = await updateIncidentState(port, o.incident.id, { type: 'link_fix_task', taskId: 'fix-2' });
    expect(second?.linkedFixTaskId).toBe('fix-1');
  });

  it('an alert raises stored severity (never lowers it) and its scope survives later detections', async () => {
    const { port } = memoryPort();
    const o = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1)]));
    expect(o.incident.severity).toBe('high');
    const alerted = await updateIncidentState(port, o.incident.id, { type: 'alerted', severity: 'critical', scope: 2, recurrence: 0 });
    expect(alerted?.severity).toBe('critical');
    expect(alerted?.impact).toMatchObject({ alertedScope: 2, alertedRecurrence: 0 });
    const lower = await updateIncidentState(port, o.incident.id, { type: 'alerted', severity: 'high' });
    expect(lower?.severity).toBe('critical');

    const u = await upsertIncident(port, forkCandidate([child('c1', 0), child('c2', 1), child('c3', 4)]));
    expect(u.outcome).toBe('updated');
    expect(u.incident.impact.alertedScope).toBe(2);
    expect(u.incident.impact.alertedRecurrence).toBe(0);
    expect(u.incident.impact.children).toBe(3);
  });
});

describe('mergeIncident (pure)', () => {
  it('counts an unseen occurrence even at the watermark instant', () => {
    const cand = forkCandidate([child('c1', 0), child('c2', 1)]);
    const opened = mergeIncident(null, cand);
    expect(opened.outcome).toBe('opened');
    const existing = { ...opened.next, id: 'x', version: 0 } as StoredIncident;
    const r = mergeIncident(existing, forkCandidate([child('c1', 0), child('c2', 1), child('c3', 1)]));
    // c3 shares the watermark minute with c2 and is new by identity
    expect(r.newOccurrences).toBe(1);
  });
});

describe('live retry-fork regression', () => {
  it('duplicate retry-stage signals → parallel children → their own PRs: one incident, escalated, never a second row', async () => {
    const { port, rows } = memoryPort();
    // sweep 1: the duplicate dispatch has just produced two children for the same review stage
    const s1 = await upsertIncident(port, forkCandidate([child('fix-a', 0), child('fix-b', 0)], 1));
    expect(s1.outcome).toBe('opened');
    expect(s1.incident.severity).toBe('high');

    // sweep 2: each child could not reuse the branch and opened a PR of its own
    const s2 = await upsertIncident(port, forkCandidate([
      child('fix-a', 0, { openedPrNumber: 3501 }),
      child('fix-b', 0, { openedPrNumber: 3502 }),
    ], 15));
    expect(s2.incident.id).toBe(s1.incident.id);
    expect(s2.outcome).toBe('updated');
    expect(s2.incident.severity).toBe('critical');
    expect(s2.escalated).toBe(true);
    expect(s2.incident.occurrenceCount).toBe(2);
    expect(s2.incident.affectedRefs.prNumbers.sort()).toEqual([3412, 3501, 3502]);

    // sweep 3: nothing new — no write, no re-escalation
    const s3 = await upsertIncident(port, forkCandidate([
      child('fix-a', 0, { openedPrNumber: 3501 }),
      child('fix-b', 0, { openedPrNumber: 3502 }),
    ], 30));
    expect(s3.outcome).toBe('unchanged');
    expect(rows.size).toBe(1);
  });
});

describe('watermark once evidence is full', () => {
  it('an unseen occurrence older than the retained window is treated as already counted', () => {
    const kids = Array.from({ length: MAX_EVIDENCE_REFS + 5 }, (_, i) => child(`k${i}`, 100 + i));
    const opened = mergeIncident(null, forkCandidate(kids, 200));
    expect(opened.next.evidenceRefs).toHaveLength(MAX_EVIDENCE_REFS);
    expect(opened.next.occurrenceCount).toBe(MAX_EVIDENCE_REFS + 5);
    const existing = { ...opened.next, id: 'x', version: 0 } as StoredIncident;
    // k0..k4 were counted but dropped from evidence; re-seeing them is not new
    const again = mergeIncident(existing, forkCandidate(kids, 201));
    expect(again.outcome).toBe('unchanged');
    // a genuinely newer one is
    const newer = mergeIncident(existing, forkCandidate([...kids, child('k-new', 150)], 201));
    expect(newer.newOccurrences).toBe(1);
  });
});
