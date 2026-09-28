/**
 * The visual review cell matrix (docs/design/visual-qa-human-review.md, "The
 * crux"). Illustrative fixtures only: made-up ids, routes and findings.
 */
import { describe, expect, it } from 'bun:test';
import type { HumanShotReview, VisualReviewPhase } from '@buildd/shared';
import { VISUAL_REVIEW_PHASES } from '@buildd/shared';
import {
  NO_BROWSER_RUNNER_AFTER_MS,
  auditAwaitingRunner,
  buildVisualReviewModel,
  describeVisualPhase,
  visualReviewCellKey,
  type BuildVisualReviewInput,
  type VisualReviewTaskInput,
} from './visual-review-model';
import {
  BOOT_FAILURE_QUESTION_PREFIX,
  VISUAL_AUDITOR_ROLE_SLUG,
  selectLatestRun,
  summarizeVisualRun,
  toVisualShots,
} from './mission-visual-review';
import { buildVisualReviewFixtureModel } from './visual-review-model.fixtures';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (min: number) => new Date(Date.parse('2026-03-10T10:00:00.000Z') + min * 60_000).toISOString();

let seq = 0;
const shot = (
  workerId: string,
  route: string,
  viewport: 'mobile' | 'desktop',
  verdict: 'ok' | 'issue' | 'unsure',
  min: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `s${++seq}-${route}-${viewport}`,
  type: 'screenshot',
  workerId,
  createdAt: at(min),
  title: null,
  metadata: { qa: { runKey: `run-${workerId}`, route, viewport, verdict, finding: `${route} ${viewport} ${verdict}`, ...extra } },
});

const audit = (id: string, round: number, status: string, workerId: string, extra: Partial<VisualReviewTaskInput> = {}): VisualReviewTaskInput => ({
  id,
  title: round > 1 ? `[surface audit] round ${round}: M` : '[surface audit] M',
  status,
  roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  createdAt: at(0),
  updatedAt: at(0),
  context: round > 1 ? { surfaceAuditRound: round } : {},
  workers: [{ id: workerId, status: status === 'completed' ? 'completed' : 'running', startedAt: at(1) }],
  ...extra,
});

const input = (over: Partial<BuildVisualReviewInput>): BuildVisualReviewInput => ({
  missionId: 'm1',
  shots: [],
  tasks: [],
  now: NOW,
  ...over,
});

const review = (artifactId: string, over: Partial<HumanShotReview> = {}): HumanShotReview => ({
  id: `rv-${artifactId}`,
  artifactId,
  auditTaskId: 't1',
  round: 1,
  cellKey: '',
  route: '/a',
  viewport: 'mobile',
  agentVerdict: 'unsure',
  decision: 'looks_right',
  relation: 'waive',
  note: null,
  fixTaskId: null,
  cancelledFixTaskId: null,
  reviewerUserId: null,
  reviewerLabel: 'someone',
  createdAt: at(30),
  supersededAt: null,
  ...over,
});

describe('visualReviewCellKey', () => {
  it('is route|viewport|variant, with an empty variant when there is none', () => {
    expect(visualReviewCellKey('/app/tasks/:id', 'mobile', null)).toBe('/app/tasks/:id|mobile|');
    expect(visualReviewCellKey('/invoices/:id', 'desktop', 'eur')).toBe('/invoices/:id|desktop|eur');
  });
});

describe('buildVisualReviewModel: cells across rounds', () => {
  // The regression: round 2 re-shoots only the fixed route, and selectLatestRun
  // used to drop every other route from the Board.
  const round1 = [
    shot('w1', '/a', 'mobile', 'issue', 1),
    shot('w1', '/a', 'desktop', 'issue', 2),
    shot('w1', '/b', 'mobile', 'ok', 3),
    shot('w1', '/b', 'desktop', 'ok', 4),
  ];
  const round2 = [shot('w2', '/a', 'mobile', 'ok', 60), shot('w2', '/a', 'desktop', 'ok', 61)];
  const tasks = [audit('t1', 1, 'completed', 'w1'), audit('t2', 2, 'completed', 'w2')];
  const model = buildVisualReviewModel(input({ shots: [...round2, ...round1], tasks }));

  it('keeps a round-1 cell that round 2 did not re-shoot as current', () => {
    const b = model.cells.find(c => c.key === '/b|mobile|')!;
    expect(b.current.round).toBe(1);
    expect(b.history).toHaveLength(1);
    expect(model.cells).toHaveLength(4);
  });

  it("gives a re-shot cell two history entries in round order, and the newer round is current", () => {
    const a = model.cells.find(c => c.key === '/a|mobile|')!;
    expect(a.history.map(h => h.round)).toEqual([1, 2]);
    expect(a.history.map(h => h.agentVerdict)).toEqual(['issue', 'ok']);
    expect(a.current.round).toBe(2);
    expect(a.current.shot.auditTaskId).toBe('t2');
    expect(a.effectiveVerdict).toBe('ok');
  });

  it('counts current cells in the summary, not every shot', () => {
    expect(model.summary).toMatchObject({ shots: 4, ok: 4, issues: 0, unsure: 0, rounds: 2 });
  });

  it('reads the round from a row taskId when the worker is not on a loaded task', () => {
    const rows = [{ ...shot('w9', '/c', 'mobile', 'ok', 5), taskId: 't2' }];
    const m = buildVisualReviewModel(input({ shots: rows, tasks }));
    expect(m.cells[0].current.round).toBe(2);
    expect(m.cells[0].current.shot.auditTaskId).toBe('t2');
  });

  it('keeps both shots when one run shoots a cell twice, so neither hides the other', () => {
    const rows = [shot('w1', '/a', 'mobile', 'issue', 1), shot('w1', '/a', 'mobile', 'ok', 9)];
    const m = buildVisualReviewModel(input({ shots: rows, tasks: [audit('t1', 1, 'completed', 'w1')] }));
    expect(m.cells.map(c => c.key)).toEqual(['/a|mobile|', '/a|mobile|shot 2']);
    expect(m.summary).toMatchObject({ shots: 2, ok: 1, issues: 1 });
  });

  it('lets the newest run of a round own a cell (a retry replaces the run it retries)', () => {
    const t = audit('t1', 1, 'completed', 'w1', { workers: [{ id: 'w1', startedAt: at(1) }, { id: 'w1b', startedAt: at(20) }] });
    const rows = [shot('w1', '/a', 'mobile', 'issue', 1), shot('w1', '/b', 'mobile', 'ok', 2), shot('w1b', '/a', 'mobile', 'ok', 21)];
    const m = buildVisualReviewModel(input({ shots: rows, tasks: [t] }));
    expect(m.cells.map(c => [c.key, c.current.agentVerdict])).toEqual([['/a|mobile|', 'ok'], ['/b|mobile|', 'ok']]);
    expect(m.cells[0].history).toHaveLength(1);
  });

  it('separates variants into their own cells', () => {
    const rows = [
      shot('w1', '/inv', 'desktop', 'ok', 1, { variant: 'eur' }),
      shot('w1', '/inv', 'desktop', 'ok', 2, { variant: 'jpy' }),
    ];
    const m = buildVisualReviewModel(input({ shots: rows, tasks: [audit('t1', 1, 'completed', 'w1')] }));
    expect(m.cells.map(c => c.key).sort()).toEqual(['/inv|desktop|eur', '/inv|desktop|jpy']);
  });

  it('drops a shot without a valid metadata.qa', () => {
    const bad = { ...shot('w1', '/a', 'mobile', 'ok', 1), metadata: { qa: { route: '/a' } } };
    expect(buildVisualReviewModel(input({ shots: [bad], tasks: [audit('t1', 1, 'completed', 'w1')] })).cells).toEqual([]);
  });
});

describe('buildVisualReviewModel: human reviews', () => {
  const s = shot('w1', '/a', 'mobile', 'unsure', 1);
  const tasks = [audit('t1', 1, 'completed', 'w1')];

  it('prefers the active human review for effectiveVerdict', () => {
    const fine = buildVisualReviewModel(input({ shots: [s], tasks, reviews: [review(s.id, { decision: 'looks_right', relation: 'waive' })] }));
    expect(fine.cells[0].effectiveVerdict).toBe('ok');
    expect(fine.cells[0].marker).toBe('waived');
    expect(fine.cells[0].needsHuman).toBe(false);

    const bad = buildVisualReviewModel(input({ shots: [s], tasks, reviews: [review(s.id, { decision: 'needs_fix', relation: 'dispute' })] }));
    expect(bad.cells[0].effectiveVerdict).toBe('issue');
    expect(bad.cells[0].marker).toBe('disputed');
  });

  it('ignores a superseded review', () => {
    const m = buildVisualReviewModel(input({ shots: [s], tasks, reviews: [review(s.id, { supersededAt: at(40) })] }));
    expect(m.cells[0].current.review).toBeNull();
    expect(m.cells[0].effectiveVerdict).toBe('unsure');
    expect(m.cells[0].marker).toBe('awaiting');
    expect(m.cells[0].needsHuman).toBe(true);
    expect(m.summary.awaitingHuman).toBe(1);
  });

  it('a review of the round-1 shot does not carry to the round-2 shot of the same cell', () => {
    const r2 = shot('w2', '/a', 'mobile', 'unsure', 60);
    const m = buildVisualReviewModel(input({
      shots: [s, r2],
      tasks: [...tasks, audit('t2', 2, 'completed', 'w2')],
      reviews: [review(s.id)],
    }));
    expect(m.cells[0].history[0].review?.id).toBe(`rv-${s.id}`);
    expect(m.cells[0].current.review).toBeNull();
    expect(m.cells[0].needsHuman).toBe(true);
  });

  it('counts confirmed, disputed and waived', () => {
    const a = shot('w1', '/a', 'desktop', 'ok', 1);
    const b = shot('w1', '/b', 'mobile', 'ok', 2);
    const c = shot('w1', '/c', 'mobile', 'issue', 3);
    const m = buildVisualReviewModel(input({
      shots: [s, a, b, c],
      tasks,
      reviews: [
        review(s.id, { relation: 'waive' }),
        review(a.id, { relation: 'agree', agentVerdict: 'ok' }),
        review(c.id, { relation: 'dispute', agentVerdict: 'issue' }),
      ],
    }));
    expect(m.summary).toMatchObject({ reviewed: 3, unreviewed: 1, confirmed: 1, disputed: 1, waived: 1, awaitingHuman: 0 });
  });
});

describe('buildVisualReviewModel: fix tasks', () => {
  it('joins the auditor fix (qa.fixTaskId) and a human-filed fix (review row) with status, PR and merge', () => {
    const a = shot('w1', '/a', 'mobile', 'issue', 1, { fixTaskId: 'fx1' });
    const b = shot('w1', '/b', 'mobile', 'ok', 2);
    const tasks: VisualReviewTaskInput[] = [
      audit('t1', 1, 'completed', 'w1'),
      { id: 'fx1', title: '[surface fix] /a: header overflows', status: 'completed', workers: [{ id: 'wf', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: at(90) }] },
      { id: 'fx2', title: '[surface fix] /b: button clipped', status: 'pending', workers: [] },
    ];
    const m = buildVisualReviewModel(input({
      shots: [a, b],
      tasks,
      reviews: [review(b.id, { decision: 'needs_fix', relation: 'dispute', agentVerdict: 'ok', fixTaskId: 'fx2' })],
    }));
    const ca = m.cells.find(c => c.route === '/a')!;
    const cb = m.cells.find(c => c.route === '/b')!;
    expect(ca.current.fixTask).toMatchObject({ id: 'fx1', status: 'completed', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: at(90), origin: 'auditor' });
    expect(cb.current.fixTask).toMatchObject({ id: 'fx2', status: 'pending', prUrl: null, origin: 'human' });
    expect(m.summary.openFixes).toBe(1);
    expect(m.fixTasks.map(f => f.id).sort()).toEqual(['fx1', 'fx2']);
  });
});

describe('buildVisualReviewModel: triage queue', () => {
  it('orders unsure, then issue, then ok, then already reviewed; by route, variant, then phone first', () => {
    const rows = [
      shot('w1', '/b', 'desktop', 'ok', 1),
      shot('w1', '/b', 'mobile', 'ok', 2),
      shot('w1', '/a', 'desktop', 'issue', 3),
      shot('w1', '/z', 'mobile', 'unsure', 4),
      shot('w1', '/c', 'mobile', 'unsure', 5),
    ];
    const reviewed = rows[4];
    const m = buildVisualReviewModel(input({
      shots: rows,
      tasks: [audit('t1', 1, 'completed', 'w1')],
      reviews: [review(reviewed.id)],
    }));
    expect(m.queue).toEqual(['/z|mobile|', '/a|desktop|', '/b|mobile|', '/b|desktop|', '/c|mobile|']);
  });
});

describe('buildVisualReviewModel: phase', () => {
  const dep = (id: string, status: string, updatedAt = at(0)): VisualReviewTaskInput => ({ id, title: 'Build it', status, updatedAt, createdAt: at(0) });
  const pendingAudit = (extra: Partial<VisualReviewTaskInput> = {}) =>
    audit('t1', 1, 'pending', 'w1', { workers: [], dependsOn: ['b1'], createdAt: at(0), ...extra });
  const phaseOf = (over: Partial<BuildVisualReviewInput>) => buildVisualReviewModel(input(over)).phase;

  it('off: no auditor task and no shots, or a finished audit that shot nothing', () => {
    expect(phaseOf({})).toBe('off');
    expect(phaseOf({ tasks: [audit('t1', 1, 'completed', 'w1')] })).toBe('off');
    expect(phaseOf({ tasks: [{ id: 'x', title: '[surface audit] M', status: 'pending', roleSlug: 'builder' }] })).toBe('off');
  });

  it('waiting_deps: pending audit whose dependencies are not done', () => {
    expect(phaseOf({ tasks: [pendingAudit(), dep('b1', 'in_progress')] })).toBe('waiting_deps');
  });

  it('queued: pending, deps done, younger than the runner window or a browser runner is online', () => {
    const recent = new Date(NOW - 2 * 60_000).toISOString();
    expect(phaseOf({ tasks: [pendingAudit({ createdAt: recent }), dep('b1', 'completed', recent)], browserRunnerOnline: false })).toBe('queued');
    expect(phaseOf({ tasks: [pendingAudit(), dep('b1', 'completed')], browserRunnerOnline: true })).toBe('queued');
    // Unknown availability never claims "no runner".
    expect(phaseOf({ tasks: [pendingAudit(), dep('b1', 'completed')], browserRunnerOnline: null })).toBe('queued');
  });

  it('no_browser_runner: pending, deps done, older than 10 minutes, no fresh browser heartbeat', () => {
    expect(phaseOf({ tasks: [pendingAudit(), dep('b1', 'completed')], browserRunnerOnline: false })).toBe('no_browser_runner');
    // Measured from when the audit became claimable (its last dependency), not its insert.
    const justDone = new Date(NOW - NO_BROWSER_RUNNER_AFTER_MS + 60_000).toISOString();
    expect(phaseOf({ tasks: [pendingAudit(), dep('b1', 'completed', justDone)], browserRunnerOnline: false })).toBe('queued');
  });

  it('auditAwaitingRunner says when the loader must read heartbeats', () => {
    expect(auditAwaitingRunner([pendingAudit(), dep('b1', 'completed')], NOW)).toBe(true);
    expect(auditAwaitingRunner([pendingAudit(), dep('b1', 'in_progress')], NOW)).toBe(false);
    expect(auditAwaitingRunner([audit('t1', 1, 'in_progress', 'w1')], NOW)).toBe(false);
  });

  it('capturing: x of y for the running round', () => {
    const m = buildVisualReviewModel(input({
      shots: [shot('w1', '/a', 'mobile', 'ok', 1)],
      tasks: [audit('t1', 1, 'in_progress', 'w1')],
      requiredRoutesOf: () => ['/a', '/b'],
    }));
    expect(m.phase).toBe('capturing');
    expect(m.progress).toEqual({ captured: 1, expected: 4 });
    expect(describeVisualPhase(m).label).toBe('Capturing 1 of 4');
  });

  it('capturing counts only the running round, and has no denominator when code named no route', () => {
    const m = buildVisualReviewModel(input({
      shots: [shot('w1', '/a', 'mobile', 'ok', 1), shot('w1', '/b', 'mobile', 'ok', 2), shot('w2', '/a', 'mobile', 'ok', 60)],
      tasks: [audit('t1', 1, 'completed', 'w1'), audit('t2', 2, 'in_progress', 'w2')],
    }));
    expect(m.phase).toBe('capturing');
    expect(m.progress).toEqual({ captured: 1, expected: null });
  });

  it('boot_failed: the newest auditor worker parked on the boot-failure question', () => {
    const t = audit('t1', 1, 'waiting_input', 'w1', {
      workers: [{ id: 'w1', status: 'waiting_input', startedAt: at(1), waitingFor: { type: 'question', prompt: `${BOOT_FAILURE_QUESTION_PREFIX}: port busy` } }],
    });
    const m = buildVisualReviewModel(input({ tasks: [t] }));
    expect(m.phase).toBe('boot_failed');
    expect(m.bootFailure).toEqual({ taskId: 't1', workerId: 'w1', prompt: `${BOOT_FAILURE_QUESTION_PREFIX}: port busy` });
    expect(m.summary.bootFailed).toBe(true);
  });

  it('stalled: the latest audit failed infra_stalled', () => {
    expect(phaseOf({ tasks: [audit('t1', 1, 'failed', 'w1', { result: { errorType: 'infra_stalled' } })] })).toBe('stalled');
    expect(phaseOf({ tasks: [audit('t1', 1, 'failed', 'w1', { errorType: 'infra_stalled' })] })).toBe('stalled');
    // A newer open audit (the retry) is what counts.
    expect(phaseOf({
      tasks: [
        audit('t1', 1, 'failed', 'w1', { result: { errorType: 'infra_stalled' }, createdAt: at(0) }),
        audit('t1b', 1, 'pending', 'w1b', { workers: [], createdAt: at(5) }),
      ],
      browserRunnerOnline: true,
    })).toBe('queued');
  });

  it('needs_you: an unsure cell nobody decided, or the round-cap question is open', () => {
    const tasks = [audit('t1', 1, 'completed', 'w1')];
    expect(phaseOf({ shots: [shot('w1', '/a', 'mobile', 'unsure', 1)], tasks })).toBe('needs_you');
    expect(phaseOf({ shots: [shot('w1', '/a', 'mobile', 'ok', 1)], tasks, roundCapOpen: true })).toBe('needs_you');
  });

  it('needs_you: an in-progress audit whose worker waits on a question (not a boot failure)', () => {
    const t = audit('t1', 1, 'in_progress', 'w1', {
      workers: [{ id: 'w1', status: 'waiting_input', startedAt: at(1), waitingFor: { type: 'question', prompt: 'Which login should I use?' } }],
    });
    const m = buildVisualReviewModel(input({ shots: [shot('w1', '/a', 'mobile', 'ok', 1)], tasks: [t] }));
    expect(m.phase).toBe('needs_you');
    expect(m.needsYou).toEqual({ reason: 'question', prompt: 'Which login should I use?', taskId: 't1', workerId: 'w1' });
    const copy = describeVisualPhase(m);
    expect(copy.detail).toContain('The visual audit has a question for you');
    expect(copy.detail).toContain('Which login should I use?');
    expect(copy.detail).not.toMatch(/issues remain/i);
  });

  it('needs_you: an older worker question is cleared by a newer running worker', () => {
    const t = audit('t1', 1, 'in_progress', 'w2', {
      workers: [
        { id: 'w1', status: 'waiting_input', startedAt: at(1), waitingFor: { type: 'question', prompt: 'Which login?' } },
        { id: 'w2', status: 'running', startedAt: at(5) },
      ],
    });
    expect(phaseOf({ tasks: [t] })).toBe('capturing');
  });

  it('needs_you copy follows the reason: unsure cells, round cap', () => {
    const tasks = [audit('t1', 1, 'completed', 'w1')];
    const unsure = buildVisualReviewModel(input({ shots: [shot('w1', '/a', 'mobile', 'unsure', 1)], tasks }));
    expect(unsure.needsYou?.reason).toBe('unsure');
    expect(describeVisualPhase(unsure).label).toBe('1 to review');
    const cap = buildVisualReviewModel(input({
      shots: [shot('w2', '/a', 'mobile', 'issue', 60)],
      tasks: [audit('t1', 1, 'completed', 'w1'), audit('t2', 2, 'completed', 'w2')],
      roundCapOpen: true,
    }));
    expect(cap.needsYou?.reason).toBe('round_cap');
    expect(describeVisualPhase(cap).detail).toContain('Issues remain after 2 rounds');
    // Not needs_you: no reason.
    expect(buildVisualReviewModel(input({ shots: [shot('w1', '/a', 'mobile', 'ok', 1)], tasks })).needsYou).toBeNull();
  });

  it('failed: the latest audit failed for a reason other than a stall', () => {
    const failed = audit('t1', 1, 'failed', 'w1', { result: { errorType: 'max_turns' } });
    const m = buildVisualReviewModel(input({ tasks: [failed] }));
    expect(m.phase).toBe('failed');
    expect(describeVisualPhase(m).detail).not.toMatch(/No visual audit/);
    // Earlier rounds' cells do not hide a failed re-check behind "reviewed".
    expect(phaseOf({
      shots: [shot('w1', '/a', 'mobile', 'ok', 1)],
      tasks: [audit('t1', 1, 'completed', 'w1'), audit('t2', 2, 'failed', 'w2', { errorType: 'crash' })],
    })).toBe('failed');
    // Failed with no errorType at all is still failed, not off.
    expect(phaseOf({ tasks: [audit('t1', 1, 'failed', 'w1')] })).toBe('failed');
  });

  it('fixing: a [surface fix] is still open', () => {
    const s = shot('w1', '/a', 'mobile', 'issue', 1, { fixTaskId: 'fx1' });
    expect(phaseOf({
      shots: [s],
      tasks: [audit('t1', 1, 'completed', 'w1'), { id: 'fx1', title: '[surface fix] /a: overflow', status: 'in_progress' }],
    })).toBe('fixing');
    // Round 2 waiting on the fix is still "fixing", not "waiting".
    expect(phaseOf({
      shots: [s],
      tasks: [
        audit('t1', 1, 'completed', 'w1'),
        audit('t2', 2, 'pending', 'w2', { workers: [], dependsOn: ['fx1'] }),
        { id: 'fx1', title: '[surface fix] /a: overflow', status: 'pending' },
      ],
    })).toBe('fixing');
  });

  it('reviewed: shots in, nothing open, nothing needs a human', () => {
    expect(phaseOf({ shots: [shot('w1', '/a', 'mobile', 'ok', 1)], tasks: [audit('t1', 1, 'completed', 'w1')] })).toBe('reviewed');
    const s = shot('w1', '/a', 'mobile', 'unsure', 1);
    expect(phaseOf({ shots: [s], tasks: [audit('t1', 1, 'completed', 'w1')], reviews: [review(s.id)] })).toBe('reviewed');
  });

  it('reviewed copy counts human decisions, not only agent verdicts', () => {
    const s = shot('w1', '/a', 'mobile', 'issue', 1);
    const m = buildVisualReviewModel(input({
      shots: [s],
      tasks: [audit('t1', 1, 'completed', 'w1')],
      reviews: [review(s.id, { agentVerdict: 'issue', decision: 'looks_right', relation: 'dispute' })],
    }));
    expect(m.phase).toBe('reviewed');
    // Agent counts stay (parity); effective counts follow the human.
    expect(m.summary.ok).toBe(0);
    expect(m.summary.issues).toBe(1);
    expect(m.summary.effectiveOk).toBe(1);
    expect(m.summary.effectiveIssues).toBe(0);
    const copy = describeVisualPhase(m);
    expect(copy.label).toBe('1 of 1 ok');
    expect(copy.detail).not.toMatch(/issue/);
    expect(copy.detail).toContain('1 decided by you');
  });

  it('every phase has copy with no dash placeholders', () => {
    for (const phase of VISUAL_REVIEW_PHASES) {
      const fixture = buildVisualReviewFixtureModel(phase);
      expect(fixture.phase).toBe(phase);
      const copy = describeVisualPhase(fixture);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(`${copy.label} ${copy.detail}`).not.toMatch(/[–—]/);
    }
  });
});

describe('parity with summarizeVisualRun for a single-round mission', () => {
  const rows = [
    shot('w1', '/a', 'mobile', 'ok', 1),
    shot('w1', '/a', 'desktop', 'issue', 2),
    shot('w1', '/b', 'mobile', 'unsure', 3),
    shot('w1', '/b', 'desktop', 'ok', 4),
    shot('w1', '/c', 'mobile', 'ok', 5),
  ];
  const tasks = [audit('t1', 1, 'completed', 'w1')];

  it('counts equal the latest run summary, coverage included', () => {
    const required = () => ['/a', '/b', '/d'];
    const m = buildVisualReviewModel(input({ shots: rows, tasks, requiredRoutesOf: required }));
    const legacy = summarizeVisualRun(selectLatestRun(toVisualShots(rows)), { required: 6, covered: 4 });
    expect({ shots: m.summary.shots, ok: m.summary.ok, issues: m.summary.issues, unsure: m.summary.unsure, required: m.summary.required, covered: m.summary.covered })
      .toEqual({ shots: legacy.shots, ok: legacy.ok, issues: legacy.issues, unsure: legacy.unsure, required: legacy.required, covered: legacy.covered });
  });

  it('holds for fixture-built runs of every mix of verdicts', () => {
    const verdicts = ['ok', 'issue', 'unsure'] as const;
    for (let n = 1; n <= 6; n++) {
      const run = Array.from({ length: n }, (_, i) =>
        shot('w1', `/r${i}`, i % 2 ? 'desktop' : 'mobile', verdicts[(i * 7 + n) % 3], i + 1));
      const m = buildVisualReviewModel(input({ shots: run, tasks }));
      const legacy = summarizeVisualRun(selectLatestRun(toVisualShots(run)));
      expect({ shots: m.summary.shots, ok: m.summary.ok, issues: m.summary.issues, unsure: m.summary.unsure }).toEqual(legacy);
    }
  });
});

describe('buildVisualReviewFixtureModel', () => {
  it('builds a model for every phase with placeholder images only', () => {
    for (const phase of VISUAL_REVIEW_PHASES as readonly VisualReviewPhase[]) {
      const m = buildVisualReviewFixtureModel(phase);
      for (const cell of m.cells) {
        for (const h of cell.history) expect(h.shot.src.startsWith('data:image/svg+xml,')).toBe(true);
      }
    }
    expect(buildVisualReviewFixtureModel('needs_you').summary.awaitingHuman).toBeGreaterThan(0);
    for (const reason of ['unsure', 'question', 'round_cap'] as const) {
      const m = buildVisualReviewFixtureModel('needs_you', { needsYou: reason });
      expect(m.phase).toBe('needs_you');
      expect(m.needsYou?.reason).toBe(reason);
    }
    expect(buildVisualReviewFixtureModel('fixing').cells.some(c => c.history.length > 1)).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildVisualReviewFixtureModel('reviewed'))).toBe(JSON.stringify(buildVisualReviewFixtureModel('reviewed')));
  });
});
