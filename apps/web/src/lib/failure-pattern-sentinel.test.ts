import { describe, it, expect } from 'bun:test';
import {
  detectFailurePatterns,
  retryForkSignature,
  boundEvidenceRefs,
  maxSeverity,
  FAILURE_PATTERN_DETECTOR_VERSION,
  MAX_EVIDENCE_REFS,
  MAX_AFFECTED_REFS,
  DEFAULT_SENTINEL_THRESHOLDS,
  type SentinelFacts,
  type RetryChildFact,
  type WorkerFailureFact,
} from './failure-pattern-sentinel';

const WS = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2026-10-04T12:00:00.000Z';

function minutesAgo(m: number): string {
  return new Date(Date.parse(NOW) - m * 60_000).toISOString();
}

function facts(over: Partial<SentinelFacts>): SentinelFacts {
  return { workspaceId: WS, now: NOW, ...over };
}

function child(over: Partial<RetryChildFact> & { taskId: string }): RetryChildFact {
  return {
    parentTaskId: 'parent-1',
    subjectPrNumber: 3412,
    kind: 'reviewer',
    stage: 'review',
    iteration: 2,
    createdAt: minutesAgo(5),
    ...over,
  };
}

function failure(over: Partial<WorkerFailureFact> & { workerId: string }): WorkerFailureFact {
  return {
    taskId: `task-${over.workerId}`,
    rootTaskId: null,
    signature: 'bun install failed: <n> packages',
    exitCause: 'infra_failure',
    occurredAt: minutesAgo(10),
    ...over,
  };
}

describe('retry fork (duplicate retry children)', () => {
  it('opens one candidate for two children of the same PR + kind + stage + iteration', () => {
    const out = detectFailurePatterns(facts({
      retryChildren: [child({ taskId: 'c1' }), child({ taskId: 'c2', createdAt: minutesAgo(4) })],
    }));
    const forks = out.filter(c => c.rule === 'retry_fork');
    expect(forks).toHaveLength(1);
    expect(forks[0].reasonCode).toBe('retry_fork.duplicate_children');
    expect(forks[0].severity).toBe('high');
    expect(forks[0].detectorVersion).toBe(FAILURE_PATTERN_DETECTOR_VERSION);
    // the children and the parent they forked from
    expect(forks[0].affected.taskIds.sort()).toEqual(['c1', 'c2', 'parent-1']);
    expect(forks[0].affected.prNumbers).toEqual([3412]);
    expect(forks[0].impact.children).toBe(2);
  });

  it('signature is exactly workspace + PR + kind + stage + iteration — child ids, order and timing never enter it', () => {
    const a = detectFailurePatterns(facts({
      retryChildren: [child({ taskId: 'c1' }), child({ taskId: 'c2' })],
    })).find(c => c.rule === 'retry_fork')!;
    const b = detectFailurePatterns(facts({
      retryChildren: [
        child({ taskId: 'zz', createdAt: minutesAgo(1) }),
        child({ taskId: 'yy', createdAt: minutesAgo(30) }),
        child({ taskId: 'xx', createdAt: minutesAgo(2) }),
      ],
    })).find(c => c.rule === 'retry_fork')!;
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toBe(retryForkSignature(WS, { subjectPrNumber: 3412, kind: 'reviewer', stage: 'review', iteration: 2 }));
    expect(a.signature).toBe(`retry_fork|ws=${WS}|pr=3412|kind=reviewer|stage=review|iter=2`);
  });

  it('different iteration, kind, stage, PR or workspace is a different signature', () => {
    const base = { subjectPrNumber: 3412, kind: 'reviewer' as const, stage: 'review', iteration: 2 };
    const s = retryForkSignature(WS, base);
    expect(retryForkSignature(WS, { ...base, iteration: 3 })).not.toBe(s);
    expect(retryForkSignature(WS, { ...base, kind: 'ci' })).not.toBe(s);
    expect(retryForkSignature(WS, { ...base, stage: 'ci' })).not.toBe(s);
    expect(retryForkSignature(WS, { ...base, subjectPrNumber: 3413 })).not.toBe(s);
    expect(retryForkSignature('00000000-0000-4000-8000-0000000000bb', base)).not.toBe(s);
    expect(retryForkSignature(null, base)).toBe('retry_fork|ws=none|pr=3412|kind=reviewer|stage=review|iter=2');
    expect(retryForkSignature(WS, { ...base, stage: null, iteration: null })).toBe(`retry_fork|ws=${WS}|pr=3412|kind=reviewer|stage=-|iter=-`);
  });

  it('one child per (PR, kind, stage, iteration) is normal retry flow — no candidate', () => {
    const out = detectFailurePatterns(facts({
      retryChildren: [
        child({ taskId: 'c1', iteration: 1 }),
        child({ taskId: 'c2', iteration: 2 }),
        child({ taskId: 'c3', kind: 'ci', stage: 'ci', iteration: 1 }),
      ],
    }));
    expect(out.filter(c => c.rule === 'retry_fork')).toHaveLength(0);
  });

  it('the same child id listed twice is not a fork', () => {
    const out = detectFailurePatterns(facts({ retryChildren: [child({ taskId: 'c1' }), child({ taskId: 'c1' })] }));
    expect(out.filter(c => c.rule === 'retry_fork')).toHaveLength(0);
  });

  it('three or more children, or children that each opened their own PR, is critical', () => {
    const three = detectFailurePatterns(facts({
      retryChildren: [child({ taskId: 'c1' }), child({ taskId: 'c2' }), child({ taskId: 'c3' })],
    })).find(c => c.rule === 'retry_fork')!;
    expect(three.severity).toBe('critical');

    const prFork = detectFailurePatterns(facts({
      retryChildren: [child({ taskId: 'c1', openedPrNumber: 3500 }), child({ taskId: 'c2', openedPrNumber: 3501 })],
    })).find(c => c.rule === 'retry_fork')!;
    expect(prFork.severity).toBe('critical');
    expect(prFork.affected.prNumbers.sort()).toEqual([3412, 3500, 3501]);
  });
});

describe('>1 PR in one retry lineage', () => {
  it('two PRs in a lineage is medium; two open at once is high', () => {
    const two = detectFailurePatterns(facts({
      lineages: [{ rootTaskId: 'root-1', taskIds: ['root-1', 'a1'], prs: [
        { number: 10, state: 'closed', at: minutesAgo(50) },
        { number: 11, state: 'open', at: minutesAgo(5) },
      ] }],
    })).filter(c => c.rule === 'lineage_multi_pr');
    expect(two).toHaveLength(1);
    expect(two[0].severity).toBe('medium');
    expect(two[0].signature).toBe(`lineage_multi_pr|ws=${WS}|root=root-1`);

    const parallel = detectFailurePatterns(facts({
      lineages: [{ rootTaskId: 'root-1', taskIds: ['root-1'], prs: [
        { number: 10, state: 'open', at: minutesAgo(50) },
        { number: 11, state: 'open', at: minutesAgo(5) },
      ] }],
    })).find(c => c.rule === 'lineage_multi_pr')!;
    expect(parallel.severity).toBe('high');
    expect(parallel.reasonCode).toBe('lineage.multiple_prs');
  });

  it('a single PR (listed twice) is not a candidate', () => {
    const out = detectFailurePatterns(facts({
      lineages: [{ rootTaskId: 'r', taskIds: ['r'], prs: [{ number: 10, state: 'open', at: NOW }, { number: 10, state: 'open', at: NOW }] }],
    }));
    expect(out.filter(c => c.rule === 'lineage_multi_pr')).toHaveLength(0);
  });
});

describe('repeated normalized failure across unrelated tasks', () => {
  it('needs the threshold of distinct lineages inside the window', () => {
    const n = DEFAULT_SENTINEL_THRESHOLDS.repeatedFailureMinTasks;
    const below = Array.from({ length: n - 1 }, (_, i) => failure({ workerId: `w${i}` }));
    expect(detectFailurePatterns(facts({ workerFailures: below })).filter(c => c.rule === 'repeated_failure')).toHaveLength(0);

    const at = Array.from({ length: n }, (_, i) => failure({ workerId: `w${i}` }));
    const out = detectFailurePatterns(facts({ workerFailures: at })).filter(c => c.rule === 'repeated_failure');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('medium');
    expect(out[0].reasonCode).toBe('failure.repeated_across_tasks');
    expect(out[0].impact.distinctTasks).toBe(n);
  });

  it('retries of ONE task are not unrelated tasks', () => {
    const same = Array.from({ length: 6 }, (_, i) => failure({ workerId: `w${i}`, taskId: `t${i}`, rootTaskId: 'root-x' }));
    expect(detectFailurePatterns(facts({ workerFailures: same })).filter(c => c.rule === 'repeated_failure')).toHaveLength(0);
  });

  it('failures outside the window do not count', () => {
    const old = Array.from({ length: 6 }, (_, i) => failure({
      workerId: `w${i}`,
      occurredAt: minutesAgo(DEFAULT_SENTINEL_THRESHOLDS.repeatedFailureWindowMinutes + 5),
    }));
    expect(detectFailurePatterns(facts({ workerFailures: old })).filter(c => c.rule === 'repeated_failure')).toHaveLength(0);
  });

  it('bookkeeping exits and output_unmet (its own rule) are excluded', () => {
    const rows = Array.from({ length: 6 }, (_, i) => failure({ workerId: `w${i}`, exitCause: i % 2 ? 'needs_input' : 'output_unmet' }));
    expect(detectFailurePatterns(facts({ workerFailures: rows })).filter(c => c.rule === 'repeated_failure')).toHaveLength(0);
  });

  it('signature is stable across occurrences and keyed on the normalized signature', () => {
    const a = detectFailurePatterns(facts({ workerFailures: Array.from({ length: 3 }, (_, i) => failure({ workerId: `a${i}` })) }))
      .find(c => c.rule === 'repeated_failure')!;
    const b = detectFailurePatterns(facts({ workerFailures: Array.from({ length: 7 }, (_, i) => failure({ workerId: `b${i}` })) }))
      .find(c => c.rule === 'repeated_failure')!;
    expect(a.signature).toBe(b.signature);
    expect(a.signature.startsWith(`repeated_failure|ws=${WS}|`)).toBe(true);
    expect(b.severity).toBe('high');
  });
});

describe('repeated stranded gate reason', () => {
  it('groups stranded rows by gate + normalized reason across distinct tasks', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `g${i}`, gate: 'claim_loop_deferral', outcome: 'stranded', reason: 'pending past <n>m: path_overlap',
      taskId: `t${i}`, occurredAt: minutesAgo(i),
    }));
    const noise = [{ id: 'gx', gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'x', taskId: 'tx', occurredAt: NOW }];
    const out = detectFailurePatterns(facts({ gateEvents: [...rows, ...noise] })).filter(c => c.rule === 'stranded_gate');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('medium');
    expect(out[0].evidence.map(e => e.kind)).toEqual(['gate_event', 'gate_event', 'gate_event']);
    expect(out[0].signature.startsWith(`stranded_gate|ws=${WS}|gate=claim_loop_deferral|`)).toBe(true);
  });

  it('the same task stranded repeatedly is one task', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `g${i}`, gate: 'pr_landing', outcome: 'stranded', reason: 'r', taskId: 't1', occurredAt: minutesAgo(i),
    }));
    expect(detectFailurePatterns(facts({ gateEvents: rows })).filter(c => c.rule === 'stranded_gate')).toHaveLength(0);
  });
});

describe('path_overlap deferral with no progress', () => {
  const T = DEFAULT_SENTINEL_THRESHOLDS.pathOverlapStallMinutes;

  it('flags a task deferred past the threshold with no progress since, grouped by blocking PR', () => {
    const out = detectFailurePatterns(facts({
      pathOverlapDeferrals: [
        { taskId: 't1', blockingPrNumber: 77, firstDeferredAt: minutesAgo(T + 30), lastDeferredAt: minutesAgo(1), lastProgressAt: null },
        { taskId: 't2', blockingPrNumber: 77, firstDeferredAt: minutesAgo(T + 10), lastDeferredAt: minutesAgo(1), lastProgressAt: minutesAgo(T + 20) },
      ],
    })).filter(c => c.rule === 'path_overlap_stall');
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe(`path_overlap_stall|ws=${WS}|blocker=pr:77`);
    expect(out[0].affected.taskIds.sort()).toEqual(['t1', 't2']);
    expect(out[0].affected.prNumbers).toEqual([77]);
    expect(out[0].severity).toBe('medium');
  });

  it('progress after the deferral began, or a short deferral, is not a stall', () => {
    const out = detectFailurePatterns(facts({
      pathOverlapDeferrals: [
        { taskId: 't1', blockingPrNumber: 77, firstDeferredAt: minutesAgo(T + 30), lastDeferredAt: minutesAgo(1), lastProgressAt: minutesAgo(3) },
        { taskId: 't2', blockingPrNumber: 77, firstDeferredAt: minutesAgo(T - 5), lastDeferredAt: minutesAgo(1), lastProgressAt: null },
      ],
    }));
    expect(out.filter(c => c.rule === 'path_overlap_stall')).toHaveLength(0);
  });
});

describe('provider/backend attribution mismatch', () => {
  it('flags failures charged to a provider the worker never ran on', () => {
    const rows = [
      { workerId: 'w1', taskId: 't1', executedProvider: 'openai-codex', attributedProvider: 'anthropic', occurredAt: minutesAgo(3) },
      { workerId: 'w2', taskId: 't2', executedProvider: 'openai-codex', attributedProvider: 'anthropic', occurredAt: minutesAgo(2) },
      { workerId: 'w3', taskId: 't3', executedProvider: 'anthropic', attributedProvider: 'anthropic', occurredAt: minutesAgo(1) },
    ];
    const out = detectFailurePatterns(facts({ providerAttributions: rows })).filter(c => c.rule === 'provider_attribution_mismatch');
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe(`provider_attribution_mismatch|ws=${WS}|ran=openai-codex|charged=anthropic`);
    expect(out[0].affected.workerIds.sort()).toEqual(['w1', 'w2']);
    expect(out[0].severity).toBe('medium');
  });

  it('a single mismatch is below threshold', () => {
    const out = detectFailurePatterns(facts({
      providerAttributions: [{ workerId: 'w1', taskId: 't1', executedProvider: 'a', attributedProvider: 'b', occurredAt: NOW }],
    }));
    expect(out.filter(c => c.rule === 'provider_attribution_mismatch')).toHaveLength(0);
  });
});

describe('failure-rate spike', () => {
  it('flags a sharp rise over the baseline with enough sample', () => {
    const out = detectFailurePatterns(facts({
      failureRate: {
        recent: { failed: 8, total: 20 },
        baseline: { failed: 10, total: 200 },
        recentFailures: [{ workerId: 'w1', at: minutesAgo(2) }],
      },
    })).filter(c => c.rule === 'failure_rate_spike');
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe(`failure_rate_spike|ws=${WS}`);
    expect(out[0].severity).toBe('high');
    expect(out[0].impact.recentRatePct).toBe(40);
    expect(out[0].impact.baselineRatePct).toBe(5);
  });

  it('half of a large recent sample failing is critical', () => {
    const c = detectFailurePatterns(facts({
      failureRate: { recent: { failed: 12, total: 20 }, baseline: { failed: 10, total: 200 } },
    })).find(x => x.rule === 'failure_rate_spike')!;
    expect(c.severity).toBe('critical');
  });

  it('a small sample, or an elevated-but-steady rate, is not a spike', () => {
    expect(detectFailurePatterns(facts({
      failureRate: { recent: { failed: 4, total: 5 }, baseline: { failed: 1, total: 100 } },
    })).filter(c => c.rule === 'failure_rate_spike')).toHaveLength(0);
    expect(detectFailurePatterns(facts({
      failureRate: { recent: { failed: 6, total: 20 }, baseline: { failed: 50, total: 200 } },
    })).filter(c => c.rule === 'failure_rate_spike')).toHaveLength(0);
  });
});

describe('repeated output-unmet at one lifecycle boundary', () => {
  it('groups output_unmet exits by boundary across distinct tasks', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => failure({ workerId: `w${i}`, exitCause: 'output_unmet', lifecycleBoundary: 'complete_task' })),
      failure({ workerId: 'wx', exitCause: 'output_unmet', lifecycleBoundary: 'session_end' }),
    ];
    const out = detectFailurePatterns(facts({ workerFailures: rows })).filter(c => c.rule === 'output_unmet_boundary');
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe(`output_unmet_boundary|ws=${WS}|boundary=complete_task`);
    expect(out[0].reasonCode).toBe('output_unmet.repeated_boundary');
    expect(out[0].severity).toBe('medium');
  });
});

describe('bounded evidence and determinism', () => {
  it('caps evidence and affected refs, keeping the newest', () => {
    const many = Array.from({ length: 60 }, (_, i) => failure({ workerId: `w${String(i).padStart(2, '0')}`, occurredAt: minutesAgo(60 - i) }));
    const c = detectFailurePatterns(facts({ workerFailures: many })).find(x => x.rule === 'repeated_failure')!;
    expect(c.evidence).toHaveLength(MAX_EVIDENCE_REFS);
    expect(c.affected.taskIds.length).toBeLessThanOrEqual(MAX_AFFECTED_REFS);
    expect(c.affected.workerIds.length).toBeLessThanOrEqual(MAX_AFFECTED_REFS);
    // newest first: w59 is the most recent occurrence
    expect(c.evidence[0].id).toBe('w59');
    expect(c.impact.failures).toBe(60);
  });

  it('boundEvidenceRefs dedupes by kind+id and orders newest first with a stable tiebreak', () => {
    const refs = boundEvidenceRefs([
      { kind: 'task', id: 'b', at: NOW },
      { kind: 'task', id: 'a', at: NOW },
      { kind: 'task', id: 'a', at: minutesAgo(5) },
      { kind: 'worker', id: 'a', at: minutesAgo(1) },
    ], 3);
    expect(refs).toEqual([
      { kind: 'task', id: 'a', at: NOW },
      { kind: 'task', id: 'b', at: NOW },
      { kind: 'worker', id: 'a', at: minutesAgo(1) },
    ]);
  });

  it('same facts in any order produce identical output', () => {
    const rows = Array.from({ length: 4 }, (_, i) => failure({ workerId: `w${i}` }));
    const kids = [child({ taskId: 'c1' }), child({ taskId: 'c2' })];
    const a = detectFailurePatterns(facts({ workerFailures: rows, retryChildren: kids }));
    const b = detectFailurePatterns(facts({ workerFailures: [...rows].reverse(), retryChildren: [...kids].reverse() }));
    expect(b).toEqual(a);
  });

  it('empty facts produce no candidates', () => {
    expect(detectFailurePatterns(facts({}))).toEqual([]);
  });
});

describe('maxSeverity', () => {
  it('orders low < medium < high < critical', () => {
    expect(maxSeverity('low', 'critical')).toBe('critical');
    expect(maxSeverity('high', 'medium')).toBe('high');
    expect(maxSeverity('medium', 'medium')).toBe('medium');
  });
});
