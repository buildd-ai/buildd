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
      'CiFailedObserved', 'LandingRequested', 'MergeCallResult', 'PrMerged', 'PrClosedUnmerged', 'Abandon']) expect(commands).toContain(c);
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
