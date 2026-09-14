import { describe, it, expect } from 'bun:test';
import {
  computeReadout,
  deriveContaminationBoundary,
  formatReadoutText,
  requiredNPerArm,
  DESIGN_MDE,
  CONTAMINATION_MARKER,
  type CompositionRow,
  type SessionRow,
} from '../memory-digest-readout';

/**
 * The readout is the only thing standing between this experiment and the
 * contaminated analysis that preceded it, so the tests here are about the
 * analysis rules, not about arithmetic plumbing:
 *
 *  - the contamination boundary is DERIVED from the rows, never passed in;
 *  - the two eras are reported separately and never pooled;
 *  - `called_recall` is reported per era and carries no pooled figure;
 *  - "not yet conclusive" is a first-class verdict, not an error;
 *  - a terminal verdict is reachable both by power and by stalled accrual.
 */

const V = 'memory-digest-v4';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A UUID-shaped id, so nothing accidentally depends on short ids. */
function tid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function comp(over: Partial<CompositionRow> & { taskId: string; ts: Date; arm: 'full' | 'task_scoped' }): CompositionRow {
  return {
    workerId: `w-${over.taskId}-${over.buildIndex ?? 0}`,
    buildIndex: 0,
    policyVersion: V,
    backend: 'claude',
    taskMatchDerivedBy: 'no_match',
    promptBytes: 10_000,
    memoryBlockBytes: 2_000,
    digestBytes: 2_000,
    digestBytesAvailable: 2_000,
    memoryShare: 0.2,
    ...over,
  };
}

function session(over: Partial<SessionRow> & { taskId: string }): SessionRow {
  return {
    workerId: `w-${over.taskId}-0`,
    status: 'completed',
    turns: 10,
    durationMs: 60_000,
    readCalls: 5,
    shellCalls: 5,
    calledRecall: false,
    ...over,
  };
}

/**
 * A cohort with `perArm` tasks in each arm on each side of the boundary.
 * Treatment rows get `shift` added to every continuous metric so an effect is
 * present and its sign is known.
 */
function cohort(opts: {
  perArm: number;
  boundary: Date;
  shift?: number;
  postOnly?: boolean;
  latestPostTs?: Date;
  /** Decides calledRecall per session, so the metric can be driven per era. */
  recall?: (arm: 'full' | 'task_scoped', era: 'pre' | 'post') => boolean | null;
}): { composition: CompositionRow[]; sessions: SessionRow[] } {
  const { perArm, boundary, shift = 0, postOnly = false } = opts;
  const composition: CompositionRow[] = [];
  const sessions: SessionRow[] = [];
  let n = 0;

  const eras: Array<{ base: Date; marker: boolean }> = postOnly
    ? [{ base: opts.latestPostTs ?? boundary, marker: true }]
    : [
        { base: new Date(boundary.getTime() - 10 * HOUR), marker: false },
        { base: opts.latestPostTs ?? boundary, marker: true },
      ];

  for (const era of eras) {
    for (const arm of ['full', 'task_scoped'] as const) {
      for (let i = 0; i < perArm; i++) {
        const taskId = tid(++n);
        const bump = arm === 'task_scoped' ? shift : 0;
        // Deterministic spread so sd > 0 without a random source.
        const jitter = (i % 5) - 2;
        composition.push(
          comp({
            taskId,
            ts: new Date(era.base.getTime() + i * 1000),
            arm,
            // Only post-boundary rows can carry the marker; that is the whole
            // point of the boundary.
            taskMatchDerivedBy: era.marker && i % 2 === 0 ? CONTAMINATION_MARKER : 'no_match',
            promptBytes: 10_000 + bump * 1000 + jitter * 100,
            memoryShare: 0.2 + bump * 0.05,
          }),
        );
        sessions.push(
          session({
            taskId,
            turns: 10 + bump + jitter,
            durationMs: 60_000 + bump * 1000 + jitter * 500,
            readCalls: 5 + bump + jitter,
            shellCalls: 5 + bump,
            calledRecall: opts.recall ? opts.recall(arm, era.marker ? 'post' : 'pre') : false,
          }),
        );
      }
    }
  }
  return { composition, sessions };
}

const BOUNDARY = new Date('2026-01-15T09:00:00.000Z');

describe('deriveContaminationBoundary', () => {
  it('derives the boundary from the first marker row in the data, not from a constant', () => {
    const first = new Date('2026-03-04T05:06:07.000Z');
    const rows = [
      comp({ taskId: tid(1), ts: new Date(first.getTime() + DAY), arm: 'full', taskMatchDerivedBy: CONTAMINATION_MARKER }),
      comp({ taskId: tid(2), ts: first, arm: 'task_scoped', taskMatchDerivedBy: CONTAMINATION_MARKER }),
      comp({ taskId: tid(3), ts: new Date(first.getTime() - DAY), arm: 'full', taskMatchDerivedBy: 'title_phrase' }),
    ];
    // Nothing about this date is hardcoded anywhere: move the rows, the
    // boundary moves with them.
    expect(deriveContaminationBoundary(rows)?.toISOString()).toBe(first.toISOString());
  });

  it('returns null when no row carries the marker, so the caller cannot invent a split', () => {
    const rows = [comp({ taskId: tid(1), ts: BOUNDARY, arm: 'full', taskMatchDerivedBy: 'no_match' })];
    expect(deriveContaminationBoundary(rows)).toBeNull();
  });

  it('ignores the marker on rows whose derivedBy is unknown (NULL), rather than imputing it', () => {
    const rows = [comp({ taskId: tid(1), ts: BOUNDARY, arm: 'full', taskMatchDerivedBy: null })];
    expect(deriveContaminationBoundary(rows)).toBeNull();
  });
});

describe('computeReadout — era split', () => {
  it('reports pre- and post-boundary cohorts separately and marks post as valid', () => {
    const { composition, sessions } = cohort({ perArm: 6, boundary: BOUNDARY, shift: 1 });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });

    expect(r.boundary?.at).toBe(BOUNDARY.toISOString());
    expect(r.eras.pre.n.full).toBe(6);
    expect(r.eras.pre.n.task_scoped).toBe(6);
    expect(r.eras.post.n.full).toBe(6);
    expect(r.eras.post.n.task_scoped).toBe(6);
    expect(r.eras.post.valid).toBe(true);
    expect(r.eras.pre.valid).toBe(false);
  });

  it('excludes a task whose prompt builds straddle the boundary from both eras', () => {
    const taskId = tid(99);
    const composition = [
      comp({ taskId, ts: new Date(BOUNDARY.getTime() - HOUR), arm: 'full', buildIndex: 0 }),
      comp({
        taskId,
        ts: new Date(BOUNDARY.getTime() + HOUR),
        arm: 'full',
        buildIndex: 1,
        taskMatchDerivedBy: CONTAMINATION_MARKER,
      }),
    ];
    const r = computeReadout({
      composition,
      sessions: [session({ taskId })],
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    expect(r.excluded.straddling).toBe(1);
    expect(r.eras.pre.n.full + r.eras.post.n.full).toBe(0);
  });

  it('excludes rows with no task id and tasks seen in both arms', () => {
    const mixed = tid(1);
    const composition = [
      comp({ taskId: mixed, ts: BOUNDARY, arm: 'full', buildIndex: 0, taskMatchDerivedBy: CONTAMINATION_MARKER }),
      comp({ taskId: mixed, ts: BOUNDARY, arm: 'task_scoped', buildIndex: 1 }),
      { ...comp({ taskId: tid(2), ts: BOUNDARY, arm: 'full' }), taskId: null } as CompositionRow,
    ];
    const r = computeReadout({
      composition,
      sessions: [],
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + HOUR),
    });
    expect(r.excluded.mixedArm).toBe(1);
    expect(r.excluded.noTaskId).toBe(1);
  });

  it('refuses to pool a foreign policy version into the cohort', () => {
    const composition = [
      comp({ taskId: tid(1), ts: BOUNDARY, arm: 'full', taskMatchDerivedBy: CONTAMINATION_MARKER }),
      comp({ taskId: tid(2), ts: BOUNDARY, arm: 'task_scoped', policyVersion: 'memory-digest-v3' }),
    ];
    const r = computeReadout({
      composition,
      sessions: [],
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + HOUR),
    });
    expect(r.excluded.foreignPolicyVersion).toBe(1);
    expect(r.eras.post.n.task_scoped).toBe(0);
  });
});

describe('computeReadout — per-arm aggregation', () => {
  const { composition, sessions } = cohort({ perArm: 10, boundary: BOUNDARY, shift: 2 });
  const r = computeReadout({
    composition,
    sessions,
    policyVersion: V,
    now: new Date(BOUNDARY.getTime() + 2 * HOUR),
  });

  it('reports the continuous process metrics as primary outcomes', () => {
    expect(r.eras.post.metrics.map(m => m.key).sort()).toEqual(
      ['durationMs', 'memoryShare', 'promptBytes', 'readCalls', 'shellCalls', 'turns'].sort(),
    );
  });

  it('keeps failure rate out of the primary metrics and labels it a guardrail', () => {
    expect(r.eras.post.metrics.some(m => m.key === 'failureRate')).toBe(false);
    expect(r.eras.post.guardrail.key).toBe('failureRate');
    expect(r.eras.post.guardrail.role).toBe('guardrail');
  });

  it('computes per-arm mean and sd and a signed difference with a confidence interval', () => {
    const prompt = r.eras.post.metrics.find(m => m.key === 'promptBytes')!;
    expect(prompt.arms.full.n).toBe(10);
    expect(prompt.arms.task_scoped.n).toBe(10);
    expect(prompt.arms.full.mean).toBeCloseTo(10_000, 0);
    // shift=2 → +2000 bytes on the treatment arm.
    expect(prompt.diff.value).toBeCloseTo(2_000, 0);
    expect(prompt.diff.ciLow).toBeLessThan(prompt.diff.value);
    expect(prompt.diff.ciHigh).toBeGreaterThan(prompt.diff.value);
    // A real effect this large against this spread must exclude zero.
    expect(prompt.diff.ciLow).toBeGreaterThan(0);
  });

  it('reports a standardised effect size with an interval, not just means', () => {
    const prompt = r.eras.post.metrics.find(m => m.key === 'promptBytes')!;
    expect(prompt.effect.value).toBeGreaterThan(0);
    expect(prompt.effect.ciLow).toBeLessThan(prompt.effect.value!);
    expect(prompt.effect.ciHigh).toBeGreaterThan(prompt.effect.value!);
  });

  it('reports per-metric coverage so a metric nobody reports cannot read as zero', () => {
    const withUnknowns = sessions.map((s, i) => (i % 2 === 0 ? { ...s, readCalls: null } : s));
    const r2 = computeReadout({
      composition,
      sessions: withUnknowns,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    const read = r2.eras.post.metrics.find(m => m.key === 'readCalls')!;
    expect(read.arms.full.n + read.arms.task_scoped.n).toBeLessThan(20);
    expect(read.coverage).toBeLessThan(1);
    const turns = r2.eras.post.metrics.find(m => m.key === 'turns')!;
    expect(turns.coverage).toBe(1);
  });

  it('reports no effect size for a metric with no within-arm spread', () => {
    // memoryShare is constant within each arm in this fixture. A `sd > 0` guard
    // is not enough: floating-point dust in the pooled sd divides into an effect
    // size of ~1e15, which renders as a real number and reads as the biggest
    // result on the page.
    const share = r.eras.post.metrics.find(m => m.key === 'memoryShare')!;
    expect(share.arms.full.sd).toBeCloseTo(0, 10);
    expect(share.effect.value).toBeNull();
    // The absolute difference is still real and still reported.
    expect(share.diff.value).toBeCloseTo(0.1, 6);
    expect(formatReadoutText(r)).not.toMatch(/g \d{4,}/);
  });

  it('carries a covariate-balance check on an arm-independent field', () => {
    const balance = r.eras.post.balance;
    expect(balance.field).toBe('taskMatchDerivedBy');
    expect(balance.categories.length).toBeGreaterThan(0);
    for (const c of balance.categories) {
      expect(c.diff.ciLow).toBeLessThanOrEqual(c.diff.value);
      expect(c.diff.ciHigh).toBeGreaterThanOrEqual(c.diff.value);
    }
    // Assignment is a hash of the task id, so this field cannot correlate with
    // the arm by construction — an imbalance here means the cohort is broken.
    expect(typeof balance.imbalanced).toBe('boolean');
  });
});

describe('computeReadout — called_recall is never pooled', () => {
  it('reports called_recall per era and exposes no pooled figure at all', () => {
    // The effect lives entirely pre-boundary: every pre-boundary treatment task
    // called recall, no post-boundary task did. Pooled, that reads as a real
    // treatment effect; split, it is visibly an artifact of the boundary.
    const { composition, sessions } = cohort({
      perArm: 5,
      boundary: BOUNDARY,
      recall: (arm, era) => arm === 'task_scoped' && era === 'pre',
    });

    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });

    const pre = r.eras.pre.secondary.find(s => s.key === 'calledRecall')!;
    const post = r.eras.post.secondary.find(s => s.key === 'calledRecall')!;
    expect(pre.arms.task_scoped.rate).toBe(1);
    expect(post.arms.task_scoped.rate).toBe(0);
    expect(pre.role).toBe('secondary-per-era');

    // There must be no pooled container anywhere in the structured output.
    const flat = JSON.stringify(r);
    expect(flat).not.toContain('"pooled"');
    expect((r as any).pooled).toBeUndefined();
    expect(pre.pooledWarning).toContain('per era');
  });

  it('renders called_recall in text only with its era stated', () => {
    const { composition, sessions } = cohort({ perArm: 5, boundary: BOUNDARY });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    const text = formatReadoutText(r);
    for (const line of text.split('\n')) {
      if (line.includes('called_recall')) {
        expect(/pre-boundary|post-boundary/.test(line)).toBe(true);
      }
    }
  });
});

describe('an unmeasurable binary outcome cannot read as a measured zero', () => {
  it('drops unknown tasks from the denominator instead of counting them as non-events', () => {
    const { composition, sessions } = cohort({
      perArm: 6,
      boundary: BOUNDARY,
      // Half the sessions report no tool histogram at all.
      recall: (arm) => (arm === 'task_scoped' ? true : null),
    });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    const post = r.eras.post.secondary.find(s => s.key === 'calledRecall')!;
    expect(post.arms.full.n).toBe(0);
    expect(post.arms.full.rate).toBeNull();
    expect(post.arms.task_scoped.rate).toBe(1);
    expect(post.coverage).toBeCloseTo(0.5, 6);
  });

  it('flags a zero-coverage outcome loudly rather than printing 0% vs 0%', () => {
    // This is the failure that nearly shipped: recall was queried from a table
    // it is never written to, so the metric read 0% in both arms for every
    // task, which looks exactly like a clean null result.
    const { composition, sessions } = cohort({
      perArm: 5,
      boundary: BOUNDARY,
      recall: () => null,
    });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    const post = r.eras.post.secondary.find(s => s.key === 'calledRecall')!;
    expect(post.coverage).toBe(0);
    expect(post.arms.full.rate).toBeNull();
    expect(post.arms.task_scoped.rate).toBeNull();
    expect(post.diff.value).toBeNull();
    expect(post.coverageWarning).toContain('NOT MEASURED');
    expect(formatReadoutText(r)).toContain('NOT MEASURED');
  });
});

describe('power position', () => {
  it('sizes the cohort against a declared design MDE, not one re-derived from the data', () => {
    // A post-hoc power calculation on the observed effect is circular; the MDE
    // is a design parameter fixed up front.
    expect(DESIGN_MDE).toBeGreaterThan(0);
    expect(requiredNPerArm(DESIGN_MDE)).toBe(325);
    // Smaller effects need more exposure — monotone, and nothing is hardcoded.
    expect(requiredNPerArm(0.1)).toBeGreaterThan(requiredNPerArm(0.5));
  });
});

describe('verdict — not yet conclusive', () => {
  const { composition, sessions } = cohort({ perArm: 4, boundary: BOUNDARY, shift: 1 });
  const r = computeReadout({
    composition,
    sessions,
    policyVersion: V,
    now: new Date(BOUNDARY.getTime() + 2 * HOUR),
  });

  it('concludes "accruing" — a valid output, not a failure', () => {
    expect(r.verdict.status).toBe('accruing');
    expect(r.verdict.terminal).toBe(false);
    expect(r.verdict.indeterminate).toBe(false);
    expect(r.verdict.headline).toContain('not yet conclusive');
  });

  it('states the power position explicitly: n per arm against what is required', () => {
    expect(r.verdict.nPerArm).toBe(4);
    expect(r.verdict.requiredNPerArm).toBe(325);
    expect(r.verdict.fractionOfRequired).toBeCloseTo(4 / 325, 5);
    expect(formatReadoutText(r)).toContain('n per arm');
  });

  it('is indeterminate — not quietly healthy — when the boundary cannot be derived', () => {
    const noMarker = composition.map(c => ({ ...c, taskMatchDerivedBy: 'no_match' }));
    const r2 = computeReadout({
      composition: noMarker,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    expect(r2.boundary).toBeNull();
    expect(r2.verdict.indeterminate).toBe(true);
    expect(r2.verdict.terminal).toBe(false);
  });

  it('is indeterminate on an empty cohort rather than reporting a clean bill of health', () => {
    const r2 = computeReadout({
      composition: [],
      sessions: [],
      policyVersion: V,
      now: new Date(),
    });
    expect(r2.verdict.indeterminate).toBe(true);
    expect(r2.verdict.status).toBe('indeterminate');
  });
});

describe('verdict — terminal', () => {
  it('is terminal when the post-boundary cohort crosses the power threshold', () => {
    const { composition, sessions } = cohort({
      perArm: requiredNPerArm(DESIGN_MDE),
      boundary: BOUNDARY,
      shift: 1,
      postOnly: true,
    });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    });
    expect(r.verdict.status).toBe('powered');
    expect(r.verdict.terminal).toBe(true);
    expect(r.verdict.nPerArm).toBeGreaterThanOrEqual(325);
    expect(r.verdict.headline).not.toContain('not yet conclusive');
  });

  it('is terminal when accrual has stalled short of power', () => {
    const latestPostTs = new Date(BOUNDARY.getTime() + HOUR);
    const { composition, sessions } = cohort({ perArm: 5, boundary: BOUNDARY, latestPostTs });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      // Well past the stall threshold with no new rows.
      now: new Date(latestPostTs.getTime() + 5 * DAY),
    });
    expect(r.verdict.status).toBe('stalled');
    expect(r.verdict.terminal).toBe(true);
    expect(r.verdict.reason).toContain('stalled');
  });

  it('stays non-terminal while rows are still arriving below the threshold', () => {
    const latestPostTs = new Date(BOUNDARY.getTime() + HOUR);
    const { composition, sessions } = cohort({ perArm: 5, boundary: BOUNDARY, latestPostTs });
    const r = computeReadout({
      composition,
      sessions,
      policyVersion: V,
      now: new Date(latestPostTs.getTime() + 6 * HOUR),
    });
    expect(r.verdict.terminal).toBe(false);
  });

  it('gives every verdict a stable notification key so one verdict pages once', () => {
    const mk = (perArm: number) =>
      computeReadout({
        ...cohort({ perArm, boundary: BOUNDARY, shift: 1, postOnly: true }),
        policyVersion: V,
        now: new Date(BOUNDARY.getTime() + 2 * HOUR),
      }).verdict;
    const a = mk(requiredNPerArm(DESIGN_MDE));
    const b = mk(requiredNPerArm(DESIGN_MDE) + 3);
    expect(a.notificationKey).toBe(b.notificationKey);
    expect(a.notificationKey).toContain(V);
    expect(a.notificationKey).toContain('powered');
  });
});

describe('formatReadoutText', () => {
  it('is deterministic — same rows in, same text out', () => {
    const { composition, sessions } = cohort({ perArm: 7, boundary: BOUNDARY, shift: 1 });
    const args = {
      composition,
      sessions,
      policyVersion: V,
      now: new Date(BOUNDARY.getTime() + 2 * HOUR),
    };
    expect(formatReadoutText(computeReadout(args))).toBe(formatReadoutText(computeReadout(args)));
  });

  it('names both eras, the derived boundary and the power position', () => {
    const { composition, sessions } = cohort({ perArm: 7, boundary: BOUNDARY, shift: 1 });
    const text = formatReadoutText(
      computeReadout({
        composition,
        sessions,
        policyVersion: V,
        now: new Date(BOUNDARY.getTime() + 2 * HOUR),
      }),
    );
    expect(text).toContain('pre-boundary');
    expect(text).toContain('post-boundary');
    expect(text).toContain(BOUNDARY.toISOString());
    expect(text).toContain('guardrail');
  });
});
