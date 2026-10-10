import { describe, expect, it } from 'bun:test';
import {
  attentionCount,
  classifyTracesByRule,
  isExplorationNoise,
  isReadOnlyCommand,
  priorAttemptFactsOf,
  resolveTraceConsequences,
  type ConsequenceTrace,
} from './trace-consequence';

const bash = (id: string, command: string, exit: number, ts: number, output = 'output', workerId = 'w1'): ConsequenceTrace => ({
  id, workerId, pattern: 'bash_nonzero_exit', excerpt: `$ ${command} [exit ${exit}]\n${output}`, ts: new Date(ts),
});
const recovered = (id: string, command: string, ts: number, workerId = 'w1'): ConsequenceTrace => ({
  id, workerId, pattern: 'bash_verify_recovered', excerpt: `$ ${command} [exit 0]`, ts: new Date(ts),
});
const RUNNING = { succeeded: false, failed: false, gatingCheckRed: false };

describe('isReadOnlyCommand', () => {
  it.each([
    'grep -rn "foo" apps/web 2>/dev/null',
    'ls apps/web/src/lib | grep evidence',
    'cd /repo && grep -n x file.ts',
    'find . -name "*.ts" | head -5',
    'cat a.ts 2>/dev/null || echo none',
    'git grep -n foo',
    'git log --oneline -5',
    'sed -n 1,40p file.ts',
    'FOO=1 rg pattern',
    'wc -l a b c',
  ])('reads only: %s', cmd => expect(isReadOnlyCommand(cmd)).toBe(true));

  it.each([
    'bun test apps/web/foo.test.ts',
    'bun run test',
    'sed -i s/a/b/ file.ts',
    'find . -name x -delete',
    'grep foo a > out.txt',
    'git push origin HEAD',
    'grep x a && rm -rf b',
    'bunx tsc --noEmit',
    'cd /repo ⏎ rm -rf build',
  ])('does something else: %s', cmd => expect(isReadOnlyCommand(cmd)).toBe(false));
});

describe('isExplorationNoise', () => {
  it('a grep exiting 2 with stderr suppressed is noise by rule', () => {
    expect(isExplorationNoise(bash('a', 'grep -rn "x" missing/ 2>/dev/null', 2, 1))).toBe(true);
  });
  it('a grep exiting 1 (no match) is noise', () => {
    expect(isExplorationNoise(bash('a', 'grep -n nothing file.ts', 1, 1))).toBe(true);
  });
  it('a failing test run is never noise', () => {
    expect(isExplorationNoise(bash('a', 'bun test apps/web/foo.test.ts', 1, 1))).toBe(false);
  });
  it('a read-only command exiting with another code (crash, signal) is not noise', () => {
    expect(isExplorationNoise(bash('a', 'cat big.log', 137, 1))).toBe(false);
  });
  it('a pattern-matched trace that is not a Bash exit is not noise by this rule', () => {
    expect(isExplorationNoise({ pattern: 'git_fatal', excerpt: 'fatal: not a git repository' })).toBe(false);
  });
});

describe('classifyTracesByRule', () => {
  it('grep noise stays noise even on a failed task and never counts', () => {
    const c = classifyTracesByRule([bash('g', 'grep -rn x . 2>/dev/null', 2, 1)], { succeeded: false, failed: true, gatingCheckRed: true });
    expect(c.get('g')!.presentation).toBe('noise');
    expect(attentionCount(c)).toBe(0);
  });

  it('a failing test followed by a pass of the same family is recovered', () => {
    const c = classifyTracesByRule([
      bash('t', 'bun test a.test.ts', 1, 1),
      recovered('r', 'bun test a.test.ts', 2),
    ], RUNNING);
    expect(c.get('t')!.presentation).toBe('recovered');
    expect(c.get('r')!.presentation).toBe('recovered');
  });

  it('a failing test on a task whose gating check is red needs attention', () => {
    const c = classifyTracesByRule([bash('t', 'bun test a.test.ts', 1, 1)], { succeeded: false, failed: false, gatingCheckRed: true });
    expect(c.get('t')!.presentation).toBe('needs_attention');
    expect(attentionCount(c)).toBe(1);
  });

  it('words a success by what it was: a merge landed, a finished task or a ready PR did not', () => {
    const t = [{ id: 'x', pattern: 'git_fatal', excerpt: 'fatal: bad', ts: new Date(2) }];
    const reason = (settledAs: 'shipped' | 'done' | 'ready_to_merge' | null) =>
      classifyTracesByRule(t, { succeeded: true, failed: false, gatingCheckRed: false, settledAs }).get('x')!.reason;
    expect(reason('shipped')).toBe('The work merged; this did not stop it.');
    expect(reason('done')).toBe('The task finished; this did not stop it.');
    expect(reason('ready_to_merge')).toBe('The PR is ready to merge; this did not block it.');
    for (const s of ['done', 'ready_to_merge'] as const) expect(reason(s)).not.toMatch(/landed|merged/);
  });

  it('once the work landed, unrecovered history is recovered, not current', () => {
    const c = classifyTracesByRule([
      bash('t', 'bun test a.test.ts', 1, 1),
      { id: 'x', pattern: 'git_fatal', excerpt: 'fatal: bad', ts: new Date(2) },
    ], { succeeded: true, failed: false, gatingCheckRed: false });
    expect(c.get('t')!.presentation).toBe('recovered');
    expect(c.get('x')!.presentation).toBe('recovered');
    expect(attentionCount(c)).toBe(0);
  });

  it('a failed task: the last non-noise failure needs attention, earlier non-verify ones are unclear', () => {
    const c = classifyTracesByRule([
      bash('a', 'node scripts/build.js', 1, 1),
      bash('b', 'node scripts/deploy.js', 1, 2),
      bash('n', 'grep -n x y', 1, 3),
    ], { succeeded: false, failed: true, gatingCheckRed: false });
    expect(c.get('a')!.presentation).toBe('unclear');
    expect(c.get('b')!.presentation).toBe('needs_attention');
    expect(c.get('n')!.presentation).toBe('noise');
  });

  it('a recovery by another worker does not recover this worker\'s failure', () => {
    const c = classifyTracesByRule([
      bash('t', 'bun test a.test.ts', 1, 1, 'out', 'w1'),
      recovered('r', 'bun test a.test.ts', 2, 'w2'),
    ], { succeeded: false, failed: true, gatingCheckRed: false });
    expect(c.get('t')!.presentation).toBe('needs_attention');
  });
});

describe('resolveTraceConsequences', () => {
  it('a model answer refines only an unclear trace', () => {
    const traces = [
      bash('u', 'node scripts/x.js', 1, 1),
      bash('g', 'grep x y', 1, 2),
    ];
    const c = resolveTraceConsequences(traces, RUNNING, { u: 'noise', g: 'real' });
    expect(c.get('u')).toMatchObject({ presentation: 'noise', decidedBy: 'model' });
    // The rule said noise; the model cannot overrule it.
    expect(c.get('g')).toMatchObject({ presentation: 'noise', decidedBy: 'rule' });
  });
});

describe('resume branch fallback', () => {
  const BRANCH = 'buildd/6f9a5b05-recon-specs';
  const fallback = (workerId = 'w2', reason: 'missing' | 'diverged' = 'missing'): ConsequenceTrace => ({
    id: 'f', workerId, pattern: 'resume_branch_fallback', source: 'git-operations', ts: new Date(10_000),
    excerpt: `Branch "${BRANCH}" was ${reason} on remote — starting fresh from "dev".`,
  });
  const worker = (over: Record<string, unknown> = {}) => ({
    id: 'w1', branch: BRANCH, createdAt: new Date(1_000), startedAt: null, exitCause: 'never_started',
    commitCount: 0, mergedAt: null, ...over,
  });
  const second = { id: 'w2', branch: BRANCH, createdAt: new Date(9_000), startedAt: new Date(9_500), exitCause: null, commitCount: 0, mergedAt: null };
  const DONE = { succeeded: true, failed: false, gatingCheckRed: false, settledAs: 'done' as const };

  it('after a session that never began, is routine setup: diagnostic, not a recovered incident', () => {
    const c = classifyTracesByRule([fallback()], { ...DONE, priorAttempts: priorAttemptFactsOf([second, worker()]) }).get('f')!;
    expect(c.presentation).toBe('noise');
    expect(c.headline).toBe('Started fresh after the previous session never began');
    expect(c.reason).toBe('It made no commits, so nothing was lost.');
    expect(`${c.headline} ${c.reason}`).not.toMatch(/\bPR\b|landed/);
  });

  it('is routine on a still-running task too: the outcome is not what decides it', () => {
    const c = classifyTracesByRule([fallback()], { succeeded: false, failed: false, gatingCheckRed: false, priorAttempts: priorAttemptFactsOf([second, worker()]) });
    expect(c.get('f')!.presentation).toBe('noise');
    expect(attentionCount(c)).toBe(0);
  });

  it('after a session that ran but pushed nothing, is routine too', () => {
    const c = classifyTracesByRule([fallback()], { ...DONE, priorAttempts: priorAttemptFactsOf([second, worker({ startedAt: new Date(1_500), exitCause: 'code_failure' })]) }).get('f')!;
    expect(c.presentation).toBe('noise');
    expect(c.headline).toBe('Started fresh; the previous attempt had pushed nothing');
  });

  it('when the prior attempt made commits that never merged, needs attention, even once the task succeeded', () => {
    const c = classifyTracesByRule([fallback()], { ...DONE, priorAttempts: priorAttemptFactsOf([second, worker({ startedAt: new Date(1_500), exitCause: 'code_failure', commitCount: 3 })]) });
    expect(c.get('f')).toMatchObject({ presentation: 'needs_attention', headline: "A previous attempt's commits were not on the remote" });
    expect(attentionCount(c)).toBe(1);
  });

  it('when the prior attempt\'s PR merged, the gone branch lost nothing', () => {
    const c = classifyTracesByRule([fallback()], { ...DONE, priorAttempts: priorAttemptFactsOf([second, worker({ startedAt: new Date(1_500), commitCount: 3, mergedAt: new Date(2_000) })]) });
    expect(c.get('f')!.presentation).toBe('noise');
  });

  it('abstains with no prior attempt on record, or for a diverged branch', () => {
    const none = classifyTracesByRule([fallback()], { ...DONE, priorAttempts: priorAttemptFactsOf([second]) }).get('f')!;
    expect(none.headline).toBeUndefined();
    expect(none.presentation).toBe('recovered');
    const diverged = classifyTracesByRule([fallback('w2', 'diverged')], { ...DONE, priorAttempts: priorAttemptFactsOf([second, worker()]) }).get('f')!;
    expect(diverged.headline).toBeUndefined();
  });

  it('a model answer cannot overrule it', () => {
    const c = resolveTraceConsequences([fallback()], { ...RUNNING, priorAttempts: priorAttemptFactsOf([second, worker()]) }, { f: 'real' });
    expect(c.get('f')).toMatchObject({ presentation: 'noise', decidedBy: 'rule' });
  });
});
