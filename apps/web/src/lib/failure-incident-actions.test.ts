import { describe, it, expect } from 'bun:test';
import {
  actOnIncidentResults,
  formatIncidentAlert,
  impactScope,
  planIncidentAlert,
  shouldFileFixTask,
  triageIncident,
  IMPACT_SCOPE_THRESHOLDS,
  type FixTaskDraft,
  type FixTaskPort,
  type IncidentAlert,
  type IncidentDecider,
  type IncidentTriage,
} from './failure-incident-actions';
import {
  updateIncidentState,
  upsertIncident,
  type IncidentStorePort,
  type StoredIncident,
  type UpsertIncidentResult,
} from './failure-incident-store';
import { detectFailurePatterns, type IncidentCandidate, type WorkerFailureFact } from './failure-pattern-sentinel';

const WS = '00000000-0000-4000-8000-0000000000aa';
const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function memoryPort(opts: { yieldBetween?: boolean } = {}) {
  const rows = new Map<string, StoredIncident>();
  let seq = 0;
  const tick = () => (opts.yieldBetween ? new Promise<void>(r => setTimeout(r, Math.random() * 3)) : Promise.resolve());
  const key = (s: string, v: string) => `${s}::${v}`;
  const port: IncidentStorePort = {
    async find(s, v) { await tick(); const r = rows.get(key(s, v)); return r ? structuredClone(r) : null; },
    async findById(id) { await tick(); for (const r of rows.values()) if (r.id === id) return structuredClone(r); return null; },
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
        if (r.version !== expectedVersion) return null;
        const stored = { ...structuredClone(next), id, version: expectedVersion + 1 };
        rows.set(k, stored);
        return structuredClone(stored);
      }
      return null;
    },
  };
  return { port, rows };
}

/** A fix-task port whose claim is atomic like the system_cache slot. */
function memoryFixTasks() {
  const tasks = new Map<string, { draft: FixTaskDraft; context: Record<string, unknown> }>();
  const claims = new Set<string>();
  const touches: Array<{ taskId: string; update: Record<string, unknown> }> = [];
  let seq = 0;
  const port: FixTaskPort = {
    async findOpenByIncident(incidentId) {
      for (const [id, t] of tasks) if (t.context.failureIncidentId === incidentId) return id;
      return null;
    },
    async claim(incidentId) {
      await new Promise(r => setTimeout(r, Math.random() * 3));
      if (claims.has(incidentId)) return false;
      claims.add(incidentId);
      return true;
    },
    async create(draft) {
      const id = `task-${++seq}`;
      tasks.set(id, { draft, context: { ...draft.context } });
      return id;
    },
    async touch(taskId, update) {
      touches.push({ taskId, update: { ...update } });
      const t = tasks.get(taskId);
      if (t) Object.assign(t.context, update);
    },
  };
  return { port, tasks, touches };
}

function failures(n: number, signature: string, startMin = 0): WorkerFailureFact[] {
  return Array.from({ length: n }, (_, i) => ({
    workerId: `w-${signature.length}-${startMin + i}`,
    taskId: `t-${startMin + i}`,
    signature,
    exitCause: 'error',
    occurredAt: at(startMin + i),
  }));
}

function repeatedCandidate(n: number, signature = 'TypeError: cannot read properties of undefined', startMin = 0, nowMin = 30): IncidentCandidate {
  const c = detectFailurePatterns({ workspaceId: WS, now: at(nowMin), workerFailures: failures(n, signature, startMin) })
    .find(x => x.rule === 'repeated_failure');
  if (!c) throw new Error('expected repeated_failure');
  return c;
}

function forkCandidate(children: number): IncidentCandidate {
  const c = detectFailurePatterns({
    workspaceId: WS,
    now: at(30),
    retryChildren: Array.from({ length: children }, (_, i) => ({
      taskId: `child-${i}-aaaaaaaa`, parentTaskId: 'parent-1', subjectPrNumber: 3412, kind: 'ci' as const,
      stage: null, iteration: 1, createdAt: at(i),
    })),
  }).find(x => x.rule === 'retry_fork');
  if (!c) throw new Error('expected retry_fork');
  return c;
}

const answer = (decision: string, confidence: number | null, reasonCode = 'cause_platform_defect', source: 'model' | 'fallback' | 'rule' = 'model'): IncidentDecider =>
  async () => ({ decision, confidence, reasonCode, source });

function sender() {
  const sent: IncidentAlert[] = [];
  return { sent, send: async (a: IncidentAlert) => { sent.push(a); return true; } };
}

async function open(port: IncidentStorePort, c: IncidentCandidate): Promise<UpsertIncidentResult> {
  return upsertIncident(port, c);
}

// ── triage ───────────────────────────────────────────────────────────────────

describe('triageIncident', () => {
  it('critical floor: page_now by rule, model never asked', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(10));
    expect(r.incident.severity).toBe('critical');
    let asked = 0;
    const t = await triageIncident(r.incident, { decide: async () => { asked++; return { decision: 'known_noise', confidence: 1, reasonCode: 'cause_unclear', source: 'model' }; } });
    expect(asked).toBe(0);
    expect(t).toMatchObject({ classification: 'page_now', severity: 'critical', source: 'rule' });
  });

  it('a confident model may raise severity', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(3));
    expect(r.incident.severity).toBe('medium');
    const t = await triageIncident(r.incident, { decide: answer('page_now', 0.9) });
    expect(t).toMatchObject({ classification: 'page_now', severity: 'critical', floorSeverity: 'medium', source: 'model', confidence: 0.9, reasonCode: 'cause_platform_defect' });
  });

  it('no model may lower the deterministic floor', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(5));
    expect(r.incident.severity).toBe('high');
    const t = await triageIncident(r.incident, { decide: answer('known_noise', 0.99, 'cause_transient_infra') });
    expect(t.classification).toBe('known_noise');
    expect(t.severity).toBe('high');
  });

  it('an unconfident raise does not raise', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(3));
    const t = await triageIncident(r.incident, { decide: answer('page_now', 0.4) });
    expect(t.severity).toBe('medium');
  });

  it('decision unavailable, malformed or timed out falls back deterministically to the floor', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(5));
    const cases: Array<[IncidentDecider | null, string]> = [
      [null, 'fallback_no_decider'],
      [async () => { throw new Error('provider down'); }, 'fallback_unavailable'],
      [() => new Promise(() => {}), 'fallback_timeout'],
      [answer('panic', 0.9), 'fallback_malformed'],
      [answer('page_now', 7), 'fallback_malformed'],
      [answer('page_now', 0.9, 'has spaces!'), 'fallback_malformed'],
      [async () => null as never, 'fallback_malformed'],
    ];
    for (const [decide, reasonCode] of cases) {
      const t = await triageIncident(r.incident, { decide, timeoutMs: 20 });
      expect(t).toMatchObject({ classification: 'systemic_bug', severity: 'high', source: 'fallback', reasonCode, confidence: null });
    }
  });

  it('a fallback answer from the decision policy keeps the floor', async () => {
    const { port } = memoryPort();
    const r = await open(port, repeatedCandidate(3));
    const t = await triageIncident(r.incident, { decide: answer('monitor', null, 'fallback_low_confidence', 'fallback') });
    expect(t).toMatchObject({ source: 'fallback', severity: 'medium', reasonCode: 'fallback_low_confidence' });
  });
});

// ── alert planning ───────────────────────────────────────────────────────────

function incidentWith(base: StoredIncident, over: Partial<StoredIncident>): StoredIncident {
  return { ...base, ...over, impact: { ...base.impact, ...(over.impact ?? {}) } };
}

describe('planIncidentAlert — transitions, never occurrences', () => {
  it('maps severity to channel on open', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(3))).incident;
    expect(planIncidentAlert(incidentWith(inc, {}), 'critical')).toMatchObject({ page: true, priority: 1, reason: 'opened', channel: 'pushover_priority' });
    expect(planIncidentAlert(inc, 'high')).toMatchObject({ page: true, priority: 0, reason: 'opened', channel: 'pushover' });
    expect(planIncidentAlert(inc, 'medium')).toMatchObject({ page: false, channel: 'digest', reason: null });
    expect(planIncidentAlert(inc, 'low')).toMatchObject({ page: false, channel: 'ledger', reason: null });
  });

  it('does not re-alert at the same severity; does on increase', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(5))).incident;
    const alerted = incidentWith(inc, { lastAlertedAt: at(1), lastAlertSeverity: 'high', impact: { alertedScope: 5, alertedRecurrence: 0 } });
    expect(planIncidentAlert(alerted, 'high').page).toBe(false);
    expect(planIncidentAlert(alerted, 'critical')).toMatchObject({ page: true, priority: 1, reason: 'severity_increase' });
  });

  it('re-alerts once the affected scope crosses the next impact threshold', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(5))).incident;
    const alerted = incidentWith(inc, { lastAlertedAt: at(1), lastAlertSeverity: 'high', impact: { alertedScope: 5, alertedRecurrence: 0 } });
    const below = incidentWith(alerted, { impact: { distinctTasks: IMPACT_SCOPE_THRESHOLDS[0] - 1 } });
    expect(planIncidentAlert(below, 'high').page).toBe(false);
    const crossed = incidentWith(alerted, { impact: { distinctTasks: IMPACT_SCOPE_THRESHOLDS[0] } });
    expect(impactScope(crossed)).toBe(IMPACT_SCOPE_THRESHOLDS[0]);
    expect(planIncidentAlert(crossed, 'high')).toMatchObject({ page: true, reason: 'impact_threshold' });
    // already paged at that tier
    const paged = incidentWith(crossed, { impact: { alertedScope: IMPACT_SCOPE_THRESHOLDS[0] + 3 } });
    expect(planIncidentAlert(paged, 'high').page).toBe(false);
  });

  it('re-alerts when a resolved incident recurs, once', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(5))).incident;
    const recurred = incidentWith(inc, { lastAlertedAt: at(1), lastAlertSeverity: 'high', recurrenceCount: 1, impact: { alertedScope: 5, alertedRecurrence: 0 } });
    expect(planIncidentAlert(recurred, 'high')).toMatchObject({ page: true, reason: 'recurrence' });
    expect(planIncidentAlert(incidentWith(recurred, { impact: { alertedRecurrence: 1 } }), 'high').page).toBe(false);
  });

  it('an acknowledged incident only re-pages on a severity increase', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(5))).incident;
    const ack = incidentWith(inc, { status: 'acknowledged', lastAlertSeverity: 'high', lastAlertedAt: at(1), impact: { alertedScope: 1, distinctTasks: 60 } });
    expect(planIncidentAlert(ack, 'high').page).toBe(false);
    expect(planIncidentAlert(ack, 'critical').page).toBe(true);
  });
});

describe('formatIncidentAlert — compact, no raw text', () => {
  it('names the pattern, impact, first/last seen, one example and a deep link; never the error text', async () => {
    const { port } = memoryPort();
    const secretish = 'Error: auth failed for token sk-live-SECRET123 body={"password":"hunter2"}';
    const inc = (await open(port, repeatedCandidate(10, secretish))).incident;
    const { title, message } = formatIncidentAlert(inc, planIncidentAlert(inc, 'critical'), { baseUrl: 'https://example.test' });
    const text = `${title}\n${message}`;
    expect(text).not.toContain('SECRET123');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(inc.title);
    expect(text).toMatch(/same failure across tasks/i);
    expect(text).toContain('10 tasks');
    expect(text).toContain('first 2026-10-04 12:00Z');
    expect(text).toContain('last 2026-10-04 12:09Z');
    expect(text).toMatch(/task t-9\b/);
    expect(text).toContain(`https://example.test/app/incidents/${inc.id}`);
    expect(message.split('\n').length).toBeLessThanOrEqual(5);
    expect(message.length).toBeLessThan(400);
  });

  it('includes a representative PR when the pattern has one', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, forkCandidate(3))).incident;
    const { message } = formatIncidentAlert(inc, planIncidentAlert(inc, 'critical'), { baseUrl: 'https://example.test' });
    expect(message).toContain('PR #3412');
  });
});

// ── fix-task eligibility ─────────────────────────────────────────────────────

const triage = (over: Partial<IncidentTriage>): IncidentTriage => ({
  classification: 'systemic_bug', floorSeverity: 'high', severity: 'high', confidence: 0.9, reasonCode: 'cause_platform_defect', source: 'model', ...over,
});

describe('shouldFileFixTask', () => {
  it('only high-confidence systemic_bug / page_now', async () => {
    const { port } = memoryPort();
    const inc = (await open(port, repeatedCandidate(5))).incident;
    expect(shouldFileFixTask(inc, triage({})).file).toBe(true);
    expect(shouldFileFixTask(inc, triage({ classification: 'page_now' })).file).toBe(true);
    expect(shouldFileFixTask(inc, triage({ classification: 'monitor' }))).toMatchObject({ file: false, reason: 'not_systemic' });
    expect(shouldFileFixTask(inc, triage({ confidence: 0.6 }))).toMatchObject({ file: false, reason: 'low_confidence' });
    expect(shouldFileFixTask(inc, triage({ source: 'fallback', confidence: null }))).toMatchObject({ file: false, reason: 'decision_unavailable' });
    expect(shouldFileFixTask(inc, triage({ source: 'rule', confidence: null, classification: 'page_now' })).file).toBe(true);
  });

  it('never for budget exhaustion or transient infrastructure unless it is a platform defect', async () => {
    const { port } = memoryPort();
    const budget = (await open(port, repeatedCandidate(10, 'Claude usage limit reached for this billing period'))).incident;
    expect(shouldFileFixTask(budget, triage({ source: 'rule', classification: 'page_now', confidence: null, reasonCode: 'critical_floor_repeated_failure' }))).toMatchObject({ file: false, reason: 'transient_or_budget' });
    expect(shouldFileFixTask(budget, triage({ reasonCode: 'cause_budget_or_quota' })).file).toBe(false);
    expect(shouldFileFixTask(budget, triage({ reasonCode: 'cause_platform_defect' })).file).toBe(true);
    const net = (await open(port, repeatedCandidate(5, 'fetch failed: ECONNRESET socket hang up'))).incident;
    expect(shouldFileFixTask(net, triage({})).file).toBe(true); // model says platform defect
    expect(shouldFileFixTask(net, triage({ reasonCode: 'cause_transient_infra' })).file).toBe(false);
    // a model that blames transient infra on an ordinary pattern still files nothing
    const plain = (await open(port, repeatedCandidate(5, 'plain failure'))).incident;
    expect(shouldFileFixTask(plain, triage({ reasonCode: 'cause_transient_infra' })).file).toBe(false);
  });
});

// ── the orchestrator ─────────────────────────────────────────────────────────

describe('actOnIncidentResults', () => {
  it('pages a critical incident once, with priority 1; a retried sweep does not page again', async () => {
    const { port } = memoryPort();
    const { sent, send } = sender();
    const r = await open(port, forkCandidate(3));
    const deps = { port, send, decide: null, fixTasks: null, now: () => at(40) };
    const first = await actOnIncidentResults([r], deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ incidentId: r.incident.id, priority: 1, severity: 'critical', reason: 'opened' });
    expect(first[0].alert).toMatchObject({ reason: 'opened', sent: true });
    // the same results replayed (a retry of the whole sweep)
    await actOnIncidentResults([r], deps);
    expect(sent).toHaveLength(1);
    const stored = (await port.findById(r.incident.id))!;
    expect(stored.lastAlertSeverity).toBe('critical');
    expect(stored.lastAlertedAt).toBe(at(40));
  });

  it('two concurrent sweeps over the same incident page once', async () => {
    const { port } = memoryPort({ yieldBetween: true });
    const { sent, send } = sender();
    const r = await open(port, forkCandidate(3));
    const deps = { port, send, decide: null, fixTasks: null, now: () => at(40) };
    await Promise.all(Array.from({ length: 8 }, () => actOnIncidentResults([r], deps)));
    expect(sent).toHaveLength(1);
  });

  it('high pages once at normal priority; medium and unchanged never page', async () => {
    const { port } = memoryPort();
    const { sent, send } = sender();
    const high = await open(port, repeatedCandidate(5, 'high pattern'));
    const medium = await open(port, repeatedCandidate(3, 'medium pattern'));
    const same = await upsertIncident(port, repeatedCandidate(3, 'medium pattern'));
    expect(same.outcome).toBe('unchanged');
    let asked = 0;
    const decide: IncidentDecider = async () => { asked++; return { decision: 'monitor', confidence: 0.9, reasonCode: 'cause_unclear', source: 'model' }; };
    const out = await actOnIncidentResults([high, medium, same], { port, send, decide, fixTasks: null, now: () => at(40) });
    expect(sent.map(s => s.priority)).toEqual([0]);
    expect(out).toHaveLength(2); // unchanged is not a transition
    expect(asked).toBe(2);
    expect(out.find(o => o.incidentId === medium.incident.id)?.alert).toBeNull();
  });

  it('an occurrence that changes nothing alert-worthy does not page again', async () => {
    const { port } = memoryPort();
    const { sent, send } = sender();
    const deps = { port, send, decide: null, fixTasks: null, now: () => at(40) };
    await actOnIncidentResults([await open(port, repeatedCandidate(5, 'p'))], deps);
    const more = await upsertIncident(port, repeatedCandidate(6, 'p'));
    expect(more.outcome).toBe('updated');
    await actOnIncidentResults([more], deps);
    expect(sent).toHaveLength(1);
  });

  it('a model raise is persisted with the page', async () => {
    const { port } = memoryPort();
    const { sent, send } = sender();
    const r = await open(port, repeatedCandidate(3));
    await actOnIncidentResults([r], { port, send, decide: answer('page_now', 0.95), fixTasks: null, now: () => at(40) });
    expect(sent[0]).toMatchObject({ severity: 'critical', priority: 1 });
    expect((await port.findById(r.incident.id))!.severity).toBe('critical');
  });

  it('a failing sender never throws and never re-pages (at most once)', async () => {
    const { port } = memoryPort();
    let calls = 0;
    const send = async () => { calls++; throw new Error('pushover down'); };
    const r = await open(port, forkCandidate(3));
    const errors: unknown[] = [];
    const out = await actOnIncidentResults([r], { port, send, decide: null, fixTasks: null, now: () => at(40), onError: e => errors.push(e) });
    expect(out[0].alert).toMatchObject({ sent: false });
    await actOnIncidentResults([r], { port, send, decide: null, fixTasks: null, now: () => at(41), onError: () => {} });
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('a recurrence after resolve pages again, once', async () => {
    const { port } = memoryPort();
    const { sent, send } = sender();
    const deps = { port, send, decide: null, fixTasks: null, now: () => at(40) };
    const r = await open(port, forkCandidate(3));
    await actOnIncidentResults([r], deps);
    await updateIncidentState(port, r.incident.id, { type: 'resolve' }, { now: at(45) });
    const recur = await upsertIncident(port, { ...forkCandidate(3), occurrences: [{ kind: 'task', id: 'new-child', at: at(50) }], evidence: [{ kind: 'task', id: 'new-child', at: at(50) }] });
    expect(recur.outcome).toBe('reopened');
    await actOnIncidentResults([recur], deps);
    await actOnIncidentResults([recur], deps);
    expect(sent.map(s => s.reason)).toEqual(['opened', 'recurrence']);
  });

  describe('fix tasks', () => {
    it('creates exactly one linked bug for a high-confidence systemic incident; later occurrences update it', async () => {
      const { port } = memoryPort();
      const fix = memoryFixTasks();
      const { send } = sender();
      const deps = { port, send, decide: answer('systemic_bug', 0.92), fixTasks: fix.port, now: () => at(40) };
      const r = await open(port, repeatedCandidate(5, 'q'));
      const out = await actOnIncidentResults([r], deps);
      expect(out[0].fixTask).toMatchObject({ action: 'created' });
      expect(fix.tasks.size).toBe(1);
      const [taskId, task] = [...fix.tasks][0];
      expect((await port.findById(r.incident.id))!.linkedFixTaskId).toBe(taskId);
      expect(task.draft.workspaceId).toBe(WS);
      expect(task.draft.category).toBe('bug');
      expect(task.draft.context.failureIncidentId).toBe(r.incident.id);
      expect(task.draft.description).toContain(`/app/incidents/${r.incident.id}`);

      const more = await upsertIncident(port, repeatedCandidate(7, 'q'));
      const out2 = await actOnIncidentResults([more], deps);
      expect(out2[0].fixTask).toMatchObject({ action: 'updated', taskId });
      expect(fix.tasks.size).toBe(1);
      expect(fix.touches.at(-1)?.update).toMatchObject({ failureIncidentOccurrenceCount: 7 });
    });

    it('concurrent sweeps file one task', async () => {
      const { port } = memoryPort({ yieldBetween: true });
      const fix = memoryFixTasks();
      const { send } = sender();
      const r = await open(port, forkCandidate(3));
      await Promise.all(Array.from({ length: 6 }, () =>
        actOnIncidentResults([r], { port, send, decide: null, fixTasks: fix.port, now: () => at(40) })));
      expect(fix.tasks.size).toBe(1);
    });

    it('relinks a task filed by a sweep that died before linking, instead of filing a second', async () => {
      const { port } = memoryPort();
      const fix = memoryFixTasks();
      const r = await open(port, forkCandidate(3));
      await fix.port.create({ workspaceId: WS, title: 'x', description: 'x', priority: 1, category: 'bug', context: { failureIncidentId: r.incident.id } });
      const out = await actOnIncidentResults([r], { port, send: sender().send, decide: null, fixTasks: fix.port, now: () => at(40) });
      expect(out[0].fixTask).toMatchObject({ action: 'linked_existing', taskId: 'task-1' });
      expect(fix.tasks.size).toBe(1);
    });

    it('files nothing for low confidence, a fallback, or budget exhaustion', async () => {
      const { port } = memoryPort();
      const fix = memoryFixTasks();
      const { send } = sender();
      const low = await open(port, repeatedCandidate(5, 'a'));
      const fb = await open(port, repeatedCandidate(5, 'b'));
      const budget = await open(port, repeatedCandidate(10, 'rate limit exceeded: quota'));
      await actOnIncidentResults([low], { port, send, decide: answer('systemic_bug', 0.5), fixTasks: fix.port, now: () => at(40) });
      await actOnIncidentResults([fb], { port, send, decide: async () => { throw new Error('x'); }, fixTasks: fix.port, now: () => at(40) });
      const out = await actOnIncidentResults([budget], { port, send, decide: null, fixTasks: fix.port, now: () => at(40) });
      expect(out[0].fixTask).toMatchObject({ action: 'skipped', reason: 'transient_or_budget' });
      expect(fix.tasks.size).toBe(0);
    });
  });

  it('never throws, even when the store is down', async () => {
    const { port } = memoryPort();
    const r = await open(port, forkCandidate(3));
    const broken: IncidentStorePort = { ...port, findById: async () => { throw new Error('db down'); }, compareAndSwap: async () => { throw new Error('db down'); } };
    const errors: unknown[] = [];
    const out = await actOnIncidentResults([r], { port: broken, send: sender().send, decide: null, fixTasks: null, onError: e => errors.push(e) });
    expect(out).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
