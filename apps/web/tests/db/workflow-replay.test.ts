/**
 * Replay recorded kernel inputs through the CURRENT kernel and diff its
 * decisions against the recorded ones (apps/web/src/lib/workflow/testing/).
 *
 *   KERNEL_REPLAY_CORPUS=<corpus.jsonl> bun run test:db apps/web/tests/db/workflow-replay.test.ts
 *
 * With KERNEL_REPLAY_CORPUS set it replays that corpus (exported by
 * scripts/forensics/export-kernel-corpus.ts, kept outside this repo) and
 * fails on any divergence; KERNEL_REPLAY_REPORT=<path> also writes the
 * per-delivery report as JSON. Unset, it says so loudly and replays the
 * checked-in synthetic corpus, which must replay identically. Either way an
 * empty corpus, or one where no step could be compared, is a failure, never
 * a pass.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@buildd/core/db';
import { readCorpus, type CorpusDelivery } from '../../src/lib/workflow/testing/corpus';
import { formatReport, replayCorpus, replayDelivery, type CorpusReport } from '../../src/lib/workflow/testing/replay';
import { assertDbConfigured } from './harness';

const FIXTURE = join(import.meta.dir, '../../src/lib/workflow/testing/fixtures/synthetic-corpus.jsonl');
const REAL = process.env.KERNEL_REPLAY_CORPUS?.trim() || null;
const exec = (q: Parameters<typeof db.execute>[0]) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;
const say = (s: string) => process.stderr.write(`${s}\n`);

let corpus: CorpusDelivery[];
let report: CorpusReport;

beforeAll(async () => {
  assertDbConfigured();
  if (!REAL) say(`[kernel-replay] KERNEL_REPLAY_CORPUS is unset: replaying the checked-in SYNTHETIC corpus (${FIXTURE}), not recorded production deliveries.`);
  corpus = readCorpus(REAL ?? FIXTURE);
  say(`[kernel-replay] ${corpus.length} deliveries from ${REAL ? 'KERNEL_REPLAY_CORPUS' : 'the synthetic fixture'}`);
  report = await replayCorpus(corpus, { exec });
  say(formatReport(report));
  if (process.env.KERNEL_REPLAY_REPORT) writeFileSync(process.env.KERNEL_REPLAY_REPORT, JSON.stringify(report, null, 2));
}, 600_000);

describe('replay', () => {
  test('the corpus is not empty and steps were actually compared', () => {
    expect(corpus.length).toBeGreaterThan(0);
    expect(report.deliveries).toBe(corpus.length);
    expect(report.stepsCompared).toBeGreaterThan(0);
  });

  test('no delivery diverges from its recorded decisions', () => {
    expect(report.reports.filter((r) => r.result === 'diverged')).toEqual([]);
  });

  test.if(!REAL)('the synthetic corpus replays completely and identically', () => {
    expect(report.identical).toBe(corpus.length);
    expect(report.stepsCompared).toBeGreaterThan(20);
    // It covers the families the harness has to rebuild commands for.
    const commands = new Set(corpus.flatMap((c) => c.transitions.map((t) => t.command)));
    for (const c of ['DeliveryOpened', 'PrBound', 'HeadObserved', 'AttemptEnded', 'ReviewVerdictRecorded', 'FixDispatched', 'FixClaimed',
      'CiFailedObserved', 'ConflictObserved', 'LandingRequested', 'MergeCallResult', 'PrMerged', 'PrClosedUnmerged', 'Abandon']) expect(commands).toContain(c);
  });
});

/** The diff can fail: a recording the current kernel would not make is reported at its step, with both decisions. */
describe('the replay detects a decision the kernel no longer makes', () => {
  const synthetic = () => readCorpus(FIXTURE);
  const pick = (cs: CorpusDelivery[], cmd: string) => {
    const c = cs.find((x) => x.transitions.some((t) => t.command === cmd))!;
    return { c, t: c.transitions.find((t) => t.command === cmd)! };
  };

  test('a different recorded state', async () => {
    const { c, t } = pick(synthetic(), 'ReviewVerdictRecorded');
    t.toState = 'ESCALATED';
    const r = await replayDelivery(c, { exec });
    expect(r).toMatchObject({ result: 'diverged', divergence: { field: 'transition.toState', recorded: 'ESCALATED' } });
    if (r.result !== 'diverged') throw new Error('unreachable');
    expect(r.step).toContain('ReviewVerdictRecorded');
    expect(r.replayed).toContain('ReviewVerdictRecorded');
  }, 60_000);

  test('a different recorded input: the fact brings another head', async () => {
    const cs = synthetic();
    const c = cs.find((x) => x.facts.some((f) => f.kind === 'head_observed' && f.appliedTransitionId))!;
    const f = c.facts.find((x) => x.kind === 'head_observed' && x.appliedTransitionId)!;
    (f.payload.live as Record<string, unknown>).headSha = 'f'.repeat(40);
    const r = await replayDelivery(c, { exec });
    expect(r.result).toBe('diverged');
  }, 60_000);

  test('a missing effect', async () => {
    const { c, t } = pick(synthetic(), 'ReviewVerdictRecorded');
    const e = c.effects.find((x) => x.transitionId === t.id && x.kind === 'post_review')!;
    c.effects = c.effects.filter((x) => x !== e);
    const r = await replayDelivery(c, { exec });
    expect(r).toMatchObject({ result: 'diverged', divergence: { recorded: null, replayed: 'post_review' } });
  }, 60_000);

  test('a step the record cannot rebuild stops the delivery as incomplete, not identical', async () => {
    const { c, t } = pick(synthetic(), 'MergeCallResult');
    t.evidence = { actor: t.actor };
    const r = await replayDelivery(c, { exec });
    expect(r).toMatchObject({ result: 'incomplete' });
    if (r.result !== 'incomplete') throw new Error('unreachable');
    expect(r.reason).toContain('MergeCallResult');
    expect(r.replayedIdentical).toBeGreaterThan(0);
  }, 60_000);
});

/**
 * What is not a decision is left out by provenance, and only that: a row written
 * by the transition's own statement (same `tUs`) is always compared.
 */
describe('out-of-band rows are not the step’s decision', () => {
  const synthetic = () => readCorpus(FIXTURE);

  /**
   * A fix that ends unproven with commits but no local head reported, its push already
   * observed mid-fix: FIXING → AWAITING_PUSH(local_head_unknown) owes
   * `push_recovery:<d>:none:1` (an unreported commit may be missing from that push,
   * so it is not proof). The drain later hangs try 2 on the same transition, and the
   * floor a chain for the attempt's reported head: neither is reducer output.
   */
  function awaitingPush(o: { outcome: 'success' | 'unproven'; commitCount: number } = { outcome: 'unproven', commitCount: 1 }) {
    const c = synthetic().find((x) => x.transitions.some((t) => t.command === 'AttemptEnded' && t.fromState === 'FIXING'))!;
    const t = c.transitions.find((x) => x.command === 'AttemptEnded' && x.fromState === 'FIXING')!;
    const live = t.evidence.live as Record<string, unknown>;
    t.toState = 'AWAITING_PUSH';
    t.evidence = { actor: t.actor, live, outcome: o.outcome, commitCount: o.commitCount, localHeadSha: null, proof: { holds: false, reason: 'local_head_unknown' } };
    c.transitions = c.transitions.filter((x) => x.toVersion <= t.toVersion);
    const kept = new Set(c.transitions.map((x) => x.id));
    c.facts = c.facts.filter((f) => f.tUs < t.tUs && (!f.appliedTransitionId || kept.has(f.appliedTransitionId)));
    c.rounds = c.rounds.filter((r) => r.tUs < t.tUs);
    c.attempts = c.attempts.filter((a) => a.tUs < t.tUs);
    const did = c.delivery.id;
    const fx = (dedupeKey: string, payload: Record<string, unknown>, tUs: number, outcome: string) =>
      ({ id: crypto.randomUUID(), transitionId: t.id, kind: 'push_recovery', dedupeKey, payload, status: 'done', outcome, tUs });
    c.effects = [
      ...c.effects.filter((e) => kept.has(e.transitionId) && (e.transitionId !== t.id || e.kind === 'render_activity')),
      fx(`push_recovery:${did}:none:1`, { localHeadSha: null, try: 1, maxTries: 3 }, t.tUs, 'ok:retry_2'),
    ];
    return { c, t, did, live, fx };
  }

  test('the decision alone replays identically', async () => {
    const { c } = awaitingPush();
    expect(await replayDelivery(c, { exec })).toMatchObject({ result: 'identical', outOfBand: { facts: 0, effects: 0 } });
  }, 60_000);

  test('drain and floor follow-ups, a diverted note and its render are left out and re-applied', async () => {
    const { c, t, did, live, fx } = awaitingPush();
    c.effects.push(
      fx(`push_recovery:${did}:none:2`, { localHeadSha: null, try: 2, maxTries: 3 }, t.tUs + 5_000_000, 'ok:retry_3'),
      fx(`push_recovery:${did}:${String(live.headSha)}:1`, { localHeadSha: live.headSha, try: 1, maxTries: 3 }, t.tUs + 6_000_000, 'ok:retry_2'),
    );
    const prev = c.transitions.find((x) => x.toVersion === t.toVersion - 1)!;
    const note = `activity:${did}:fix_ended:0123456789abcdef`;
    c.facts.push({ id: crypto.randomUUID(), kind: 'activity_note', factKey: note, source: 'legacy:appendPrActivity', repoFullName: c.delivery.repoFullName, prNumber: c.delivery.prNumber, payload: { kind: 'fix_ended' }, appliedTransitionId: null, tUs: t.tUs - 10 });
    c.effects.push({ id: crypto.randomUUID(), transitionId: prev.id, kind: 'render_activity', dedupeKey: `render:${did}:note:${note}`, payload: { note }, status: 'done', outcome: 'ok:unchanged', tUs: t.tUs - 10 });
    const r = await replayDelivery(c, { exec });
    expect(r).toMatchObject({ result: 'identical', outOfBand: { facts: 1, effects: 3 } });
    expect(r.inferred).toContain('effect (out-of-band row, re-applied at its recorded position)');
  }, 60_000);

  test('a row claiming the transition’s own statement is still compared', async () => {
    const { c, t, did, fx } = awaitingPush();
    c.effects.push(fx(`push_recovery:${did}:none:2`, { localHeadSha: null, try: 2, maxTries: 3 }, t.tUs, 'ok:retry_3'));
    expect(await replayDelivery(c, { exec })).toMatchObject({
      result: 'diverged', divergence: { field: `effects[push_recovery:${did}:none:2]`, recorded: 'push_recovery', replayed: null },
    });
  }, 60_000);

  test('abe42d1b: a recording of the old decision (a successful fix, nothing local, its own push live) is reported as diverged, never tolerated', async () => {
    // Before abe42d1b the kernel parked this end in AWAITING_PUSH; the attempt's attributed push is
    // its delivery (§9, §6.9), so the current kernel starts the next round. A different to-state is
    // a different decision, which no known evolution may rewrite.
    const { c } = awaitingPush({ outcome: 'success', commitCount: 0 });
    expect(await replayDelivery(c, { exec })).toMatchObject({
      result: 'diverged', divergence: { field: 'transition.toState', recorded: 'AWAITING_PUSH', replayed: 'AWAITING_REVIEW' }, tolerated: [],
    });
  }, 60_000);

  test('the try-1 key is the reducer’s: a different local head in it is a divergence', async () => {
    const { c, did, live } = awaitingPush();
    const e = c.effects.find((x) => x.kind === 'push_recovery')!;
    e.dedupeKey = `push_recovery:${did}:${String(live.headSha)}:1`;
    expect(await replayDelivery(c, { exec })).toMatchObject({ result: 'diverged' });
  }, 60_000);
});

/**
 * bc92e43f: a conflict repair escalating to an agent a second time. The first agent's
 * worker ended after its push had already taken the delivery back to review: that end
 * writes the attempt row and no transition. Unless the replay writes it too, the second
 * refusal (`effect:refresh_branch`, REPAIRING -> REPAIRING) meets a still-open agent
 * attempt and is rejected `fix_in_flight`.
 */
describe('an attempt end no transition wrote', () => {
  const escalation = () => {
    const c = readCorpus(FIXTURE).find((x) => x.transitions.filter((t) => t.command === 'ConflictObserved' && t.actor === 'effect:refresh_branch').length === 2)!;
    const late = c.attempts.find((a) => a.family === 'conflict' && a.mode === 'agent' && a.attemptNo === 1)!;
    return { c, late };
  };

  test('the synthetic corpus records the shape: an ended agent attempt whose end time is no transition\'s', () => {
    const { c, late } = escalation();
    expect(late.status).toBe('ended');
    expect(typeof late.endedUs).toBe('number');
    expect(c.transitions.some((t) => t.tUs === late.endedUs)).toBe(false);
    const last = [...c.transitions].sort((a, b) => a.toVersion - b.toVersion).at(-1)!;
    expect(last).toMatchObject({ command: 'ConflictObserved', actor: 'effect:refresh_branch', fromState: 'REPAIRING', toState: 'REPAIRING', evidence: { mode: 'agent' } });
  });

  test('is written at its recorded time, and the escalation replays identically', async () => {
    const r = await replayDelivery(escalation().c, { exec });
    expect(r).toMatchObject({ result: 'identical' });
    expect(r.inferred).toContain('attempt end (out-of-band row, re-applied at its recorded time)');
  }, 60_000);

  test('a corpus exported before end times were recorded infers it from the attempt no longer being bound', async () => {
    const { c } = escalation();
    for (const a of c.attempts) delete a.endedUs;
    const r = await replayDelivery(c, { exec });
    expect(r).toMatchObject({ result: 'identical' });
    expect(r.inferred).toContain('attempt end (out-of-band, unbound worker end; time not recorded)');
  }, 60_000);

  test('without it, the escalation is rejected and reported as diverged', async () => {
    const { c, late } = escalation();
    c.attempts = c.attempts.map((a) => (a.id === late.id ? { ...a, status: 'running', outcome: 'delivered', endedUs: null } : a));
    expect(await replayDelivery(c, { exec })).toMatchObject({
      result: 'diverged', step: 'command ConflictObserved (effect:refresh_branch)', replayed: 'no transition (rejected: fix_in_flight)',
    });
  }, 60_000);
});
