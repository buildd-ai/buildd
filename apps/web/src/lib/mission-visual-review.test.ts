/**
 * The mission page's Visual review model (docs/design/visual-qa-auditor.md,
 * "Where the screenshots show"). Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import {
  VISUAL_AUDITOR_ROLE_SLUG,
  missionVisualReview,
  parseQaMeta,
  qaRouteSatisfies,
  requiredCoverage,
  auditBootFailed,
  BOOT_FAILURE_QUESTION_PREFIX,
  selectLatestRun,
  summarizeVisualRun,
  thumbSrc,
  toVisualShots,
  type VisualShot,
} from './mission-visual-review';

const qa = (over: Record<string, unknown> = {}) => ({
  runKey: 'run-a',
  route: '/app/tasks',
  viewport: 'mobile',
  finding: 'Header fits on one line.',
  verdict: 'ok',
  ...over,
});

const row = (id: string, createdAt: string, metadata: unknown, type = 'screenshot') => ({ id, type, createdAt, metadata });

describe('parseQaMeta', () => {
  it('reads the five required fields', () => {
    expect(parseQaMeta({ qa: qa() })).toEqual({
      runKey: 'run-a',
      route: '/app/tasks',
      viewport: 'mobile',
      finding: 'Header fits on one line.',
      verdict: 'ok',
    });
  });

  it('keeps the optional theme and fixTaskId only when they are non-empty strings', () => {
    expect(parseQaMeta({ qa: qa({ theme: 'dark', fixTaskId: 'task-1' }) })).toMatchObject({ theme: 'dark', fixTaskId: 'task-1' });
    const loose = parseQaMeta({ qa: qa({ theme: 3, fixTaskId: '' }) })!;
    expect('theme' in loose).toBe(false);
    expect('fixTaskId' in loose).toBe(false);
  });

  it('drops a shot with a missing field, an empty string or an unknown verdict', () => {
    for (const bad of [
      qa({ route: '' }),
      qa({ viewport: 7 }),
      qa({ finding: '   ' }),
      qa({ verdict: 'pass' }),
    ]) {
      expect(parseQaMeta({ qa: bad })).toBeNull();
    }
  });

  // The evidence check (visual-audit-evidence.ts) is the contract: a shot it
  // counts must show here, and one it can never count must not.
  it('drops what the evidence check can never count: a route without a leading slash, a viewport outside mobile/desktop', () => {
    expect(parseQaMeta({ qa: qa({ route: 'app/tasks' }) })).toBeNull();
    expect(parseQaMeta({ qa: qa({ viewport: 'tablet' }) })).toBeNull();
    expect(parseQaMeta({ qa: qa({ viewport: 'desktop' }) })).toMatchObject({ viewport: 'desktop' });
  });

  it('keeps a shot with no runKey, as the evidence check counts it: it groups as that worker\'s un-keyed run', () => {
    expect(parseQaMeta({ qa: qa({ runKey: undefined }) })).toMatchObject({ runKey: '', route: '/app/tasks' });
    expect(parseQaMeta({ qa: qa({ runKey: '  ' }) })).toMatchObject({ runKey: '' });
  });

  it('is null for metadata that is not an object or has no qa object', () => {
    for (const bad of [null, undefined, 'qa', [], {}, { qa: 'yes' }, { qa: [] }, { qa: null }]) {
      expect(parseQaMeta(bad)).toBeNull();
    }
  });
});

describe('toVisualShots', () => {
  it('keeps only screenshots with a valid metadata.qa, oldest first, with a download-route src', () => {
    const shots = toVisualShots([
      row('b', '2026-03-10T10:02:00.000Z', { qa: qa({ viewport: 'desktop' }) }),
      row('a', '2026-03-10T10:01:00.000Z', { qa: qa() }),
      row('c', '2026-03-10T10:03:00.000Z', { qa: qa() }, 'report'),
      row('d', '2026-03-10T10:04:00.000Z', { qa: qa({ verdict: 'maybe' }) }),
      row('e', '2026-03-10T10:05:00.000Z', {}),
    ]);
    expect(shots.map(s => s.id)).toEqual(['a', 'b']);
    expect(shots[0].src).toBe('/api/artifacts/a/download');
  });

  it('accepts Date createdAt values', () => {
    const [shot] = toVisualShots([{ id: 'a', type: 'screenshot', createdAt: new Date('2026-03-10T10:00:00.000Z'), metadata: { qa: qa() } }]);
    expect(shot.createdAt).toBe('2026-03-10T10:00:00.000Z');
  });
});

describe('thumbSrc', () => {
  it('goes through the access-checked download route and never adds a token', () => {
    expect(thumbSrc('abc')).toBe('/api/artifacts/abc/download');
    expect(thumbSrc('a/b')).toBe('/api/artifacts/a%2Fb/download');
  });
});

describe('selectLatestRun', () => {
  it('returns the shots of the run whose newest shot is newest', () => {
    const shots = toVisualShots([
      row('r1a', '2026-03-10T10:00:00.000Z', { qa: qa({ runKey: 'run-1' }) }),
      row('r2a', '2026-03-11T10:00:00.000Z', { qa: qa({ runKey: 'run-2' }) }),
      row('r1b', '2026-03-10T10:01:00.000Z', { qa: qa({ runKey: 'run-1', viewport: 'desktop' }) }),
      row('r2b', '2026-03-11T10:01:00.000Z', { qa: qa({ runKey: 'run-2', viewport: 'desktop' }) }),
    ]);
    expect(selectLatestRun(shots).map(s => s.id)).toEqual(['r2a', 'r2b']);
  });

  it('is empty for no shots', () => {
    expect(selectLatestRun([])).toEqual([]);
  });

  // A run is (worker, runKey): another worker reusing the auditor's runKey
  // must not merge into, or displace, the auditor's run.
  it('groups a run by worker as well as runKey', () => {
    const shots = toVisualShots([
      { ...row('w1a', '2026-03-10T10:00:00.000Z', { qa: qa({ runKey: 'run-1', verdict: 'issue' }) }), workerId: 'w1' },
      { ...row('w1b', '2026-03-10T10:01:00.000Z', { qa: qa({ runKey: 'run-1', viewport: 'desktop' }) }), workerId: 'w1' },
      { ...row('w2a', '2026-03-10T10:00:30.000Z', { qa: qa({ runKey: 'run-1' }) }), workerId: 'w2' },
    ]);
    expect(selectLatestRun(shots).map(s => s.id)).toEqual(['w1a', 'w1b']);
  });
});

describe('missionVisualReview', () => {
  const auditor = (status: string) => ({ title: '[surface audit] Mission', status, roleSlug: VISUAL_AUDITOR_ROLE_SLUG });
  const shotRow = (id: string, verdict = 'ok') =>
    ({ ...row(id, '2026-03-10T10:00:00.000Z', { qa: qa({ verdict }) }), workerId: 'w1' });

  it('shows todo (no shots) while an auditor task is still open', () => {
    for (const status of ['pending', 'assigned', 'in_progress', 'waiting_input']) {
      const r = missionVisualReview([], [auditor(status)]);
      expect(r).not.toBeNull();
      expect(r!.run).toEqual([]);
      expect(r!.summary).toEqual({ shots: 0, ok: 0, issues: 0, unsure: 0 });
    }
  });

  it('is hidden for a finished, failed or cancelled auditor task with no shots', () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      expect(missionVisualReview([], [auditor(status)])).toBeNull();
    }
  });

  it('is hidden when there are no shots and no auditor task', () => {
    expect(missionVisualReview([], [])).toBeNull();
  });

  // Pre-auditor `[surface audit]` tasks run as builders and never write
  // accepted shots, so they must not hold the step open waiting forever.
  it('ignores an open [surface audit] that is not a visual-auditor task', () => {
    expect(missionVisualReview([], [{ title: '[surface audit] Mission', status: 'pending', roleSlug: 'builder' }])).toBeNull();
  });

  it('shows the latest run once there are shots, whatever the task state', () => {
    const r = missionVisualReview([shotRow('a'), shotRow('b', 'issue')], []);
    expect(r!.run.map(s => s.id)).toEqual(['a', 'b']);
    expect(r!.summary).toEqual({ shots: 2, ok: 1, issues: 1, unsure: 0 });
  });
});

describe('summarizeVisualRun', () => {
  const shot = (id: string, verdict: string): VisualShot =>
    toVisualShots([row(id, '2026-03-10T10:00:00.000Z', { qa: qa({ verdict }) })])[0];

  it('counts verdicts across the run', () => {
    expect(summarizeVisualRun([shot('a', 'ok'), shot('b', 'issue'), shot('c', 'issue'), shot('d', 'unsure')])).toEqual({
      shots: 4, ok: 1, issues: 2, unsure: 1,
    });
  });

  it('carries the required-shot count and the boot failure when given', () => {
    expect(summarizeVisualRun([], { required: 8, bootFailed: true })).toEqual({
      shots: 0, ok: 0, issues: 0, unsure: 0, required: 8, bootFailed: true,
    });
  });
});

describe('qaRouteSatisfies', () => {
  it('matches exactly, or a concrete URL against a pattern', () => {
    expect(qaRouteSatisfies('/app/tasks', '/app/tasks')).toBe(true);
    expect(qaRouteSatisfies('/app/tasks/:id', '/app/tasks/:id')).toBe(true);
    expect(qaRouteSatisfies('/app/tasks/:id', '/app/tasks/abc')).toBe(true);
    expect(qaRouteSatisfies('/app/tasks/:id', '/app/tasks/abc/logs')).toBe(false);
    expect(qaRouteSatisfies('/docs/:slug*', '/docs/a/b')).toBe(true);
    expect(qaRouteSatisfies('/app/tasks', '/app/missions')).toBe(false);
  });
});

describe('requiredCoverage', () => {
  const shots = (...cells: Array<[string, string]>) =>
    toVisualShots(cells.map(([route, viewport], i) => row(`s${i}`, `2026-03-10T10:0${i}:00.000Z`, { qa: qa({ route, viewport }) })));

  it('counts required route x viewport cells a shot covers, not shots', () => {
    const run = shots(['/app/tasks', 'mobile'], ['/app/tasks', 'mobile'], ['/app/tasks', 'desktop'], ['/app/extra', 'mobile']);
    expect(requiredCoverage(run, ['/app/tasks', '/app/missions/:id'])).toEqual({ required: 4, covered: 2 });
  });

  it('is null when code named no route (the auditor picks, so there is no denominator)', () => {
    expect(requiredCoverage(shots(['/app/tasks', 'mobile']), [])).toBeNull();
  });
});

describe('missionVisualReview required coverage', () => {
  const auditTask = { id: 't-audit', status: 'in_progress', roleSlug: VISUAL_AUDITOR_ROLE_SLUG, workers: [{ id: 'w1' }] };
  const shotRow = (id: string, viewport: string) =>
    ({ ...row(id, '2026-03-10T10:00:00.000Z', { qa: qa({ viewport }) }), workerId: 'w1' });

  it("reads the required routes of the task whose worker wrote the latest run", () => {
    const seen: string[] = [];
    const r = missionVisualReview([shotRow('a', 'mobile')], [auditTask], {
      requiredRoutesOf: (t) => { seen.push(t.id!); return ['/app/tasks', '/app/missions']; },
    });
    expect(seen).toEqual(['t-audit']);
    expect(r!.summary).toMatchObject({ shots: 1, required: 4, covered: 1 });
  });

  it('leaves coverage unknown when the run\'s worker is not on a loaded task, or no resolver is given', () => {
    const other = { ...auditTask, workers: [{ id: 'w9' }] };
    const r = missionVisualReview([shotRow('a', 'mobile')], [other], { requiredRoutesOf: () => ['/app/tasks'] });
    expect('required' in r!.summary).toBe(false);
    expect('required' in missionVisualReview([shotRow('a', 'mobile')], [auditTask])!.summary).toBe(false);
  });
});

// PR1's role prompt parks a boot failure with AskUserQuestion "App did not
// boot: <reason>"; the runner stores that as the worker's waitingFor.prompt,
// on a waiting_input worker (or a failed one, in inputAsRetry mode).
describe('auditBootFailed', () => {
  const w = (over: Record<string, unknown> = {}) => ({
    id: 'w1', status: 'waiting_input', startedAt: '2026-03-10T10:00:00.000Z',
    waitingFor: { type: 'question', prompt: `${BOOT_FAILURE_QUESTION_PREFIX}: next dev exited 1` }, ...over,
  });
  const task = (workers: unknown[], over: Record<string, unknown> = {}) =>
    ({ id: 't1', status: 'in_progress', roleSlug: VISUAL_AUDITOR_ROLE_SLUG, workers, ...over }) as any;

  it("is true when the newest auditor worker is parked on the boot-failure question", () => {
    expect(auditBootFailed([task([w()])])).toBe(true);
    expect(auditBootFailed([task([w({ status: 'failed' })], { status: 'failed' })])).toBe(true);
    expect(auditBootFailed([task([w({ waitingFor: { type: 'question', prompt: 'app did not boot - port busy' } })])])).toBe(true);
  });

  it('is false for another question, a permission prompt, a running worker, or another role', () => {
    expect(auditBootFailed([task([w({ waitingFor: { type: 'question', prompt: 'Is the empty state intended?' } })])])).toBe(false);
    expect(auditBootFailed([task([w({ waitingFor: { type: 'permission', prompt: 'App did not boot' } })])])).toBe(false);
    expect(auditBootFailed([task([w({ status: 'running' })])])).toBe(false);
    expect(auditBootFailed([task([w()], { roleSlug: 'builder' })])).toBe(false);
    expect(auditBootFailed([])).toBe(false);
  });

  it('clears once a newer auditor worker starts (the retry), or the audit was completed or cancelled', () => {
    const retry = { id: 't2', status: 'in_progress', roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
      workers: [w({ id: 'w2', status: 'running', startedAt: '2026-03-10T11:00:00.000Z', waitingFor: null })] } as any;
    expect(auditBootFailed([task([w({ status: 'failed' })], { status: 'failed' }), retry])).toBe(false);
    expect(auditBootFailed([task([w()], { status: 'completed' })])).toBe(false);
    expect(auditBootFailed([task([w()], { status: 'cancelled' })])).toBe(false);
  });

  it('makes missionVisualReview show a blocked step even with no shots and a failed audit task', () => {
    const r = missionVisualReview([], [task([w({ status: 'failed' })], { status: 'failed' })]);
    expect(r!.summary).toMatchObject({ shots: 0, bootFailed: true });
  });
});
