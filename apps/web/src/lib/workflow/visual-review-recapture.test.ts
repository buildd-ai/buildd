/**
 * Spec 072de598 I-15, AC-14, I-7, I-12 / AC-10: a merged fix waiting for a
 * screenshot, read end to end through the production chain (model, state,
 * presentation, mission check row, schedule, ready-to-merge). Illustrative
 * fixtures only (`recaptureFixtureInput`), the same ones the dev fixture page shows.
 */
import { describe, expect, it } from 'bun:test';
import { buildVisualReviewModel, screensToReview } from '../visual-review-model';
import { recaptureFixtureInput } from '../visual-review-model.fixtures';
import { visualCheck } from '../mission-checks';
import { decideReadyToMerge, readyToMergeReason } from '../ready-to-merge';
import { formatVisualReview } from '@buildd/core/visual-review-text';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { deriveMissionVisualReview, reviewInputFromModel, type VisualReviewStateInput } from './visual-review-state';
import { presentVisualReview } from './visual-review-presentation';
import { planVisualReviewSchedule, type ScheduleAudit } from './visual-review-schedule';

const HEAD = 'abc1234def5678';
const openPr = { number: 9, state: 'open' as const, ready: true, blocked: false };

function chain(scenario: Parameters<typeof recaptureFixtureInput>[0], over: Partial<VisualReviewStateInput> = {}) {
  const model = buildVisualReviewModel(recaptureFixtureInput(scenario));
  const state = deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    audit: model.audit ? { id: model.audit.id, createdAt: model.audit.createdAt, errorType: model.audit.errorType, status: model.audit.status } : null,
    review: reviewInputFromModel(model),
    waiver: null,
    auditedSha: HEAD,
    branch: { headSha: HEAD, base: 'mission/x', integrationPr: openPr, workLanded: true },
    ...over,
  });
  const p = presentVisualReview(state, { ownerMergesIntegration: true });
  const row = visualCheck(state, { mergeTier: 'human' });
  const merge = decideReadyToMerge({ kind: 'mission_integration_pr', workHolder: null, visual: state });
  const audits: ScheduleAudit[] = (model.audits ?? []).slice().reverse()
    .map(a => ({ id: a.id, status: a.status, round: a.round, headSha: HEAD, updatedAt: 0 }));
  const plan = planVisualReviewSchedule({ state, impact: null, audits, browserRunnerOnline: true, executorLocal: false, now: 0 });
  const text = formatVisualReview(model, 'Example', { audience: 'mcp' });
  return { model, state, p, row, merge, plan, text };
}

const DIALOG = '/app/dev/fixtures · abandon-reason · phone';
const NO_ACTION = /no action needed/i;

describe('a merged fix waiting for a screenshot, the audit finished without it (AC-14)', () => {
  const c = chain('recapture');

  it('one recapture of each exact screen is filed, never a terminal "no action"', () => {
    expect(c.state).toMatchObject({ status: 'needed', nextActor: 'system', blocksMerge: true });
    expect(c.state.recapture?.screens).toEqual([DIALOG, DIALOG, '/app/dev/fixtures · visual review boot failed · dark · phone']);
    expect(c.plan).toMatchObject({ action: 'enqueue', reason: 'recapture', round: 3 });
  });

  it('every surface names what it waits for and none says no action is needed', () => {
    expect(c.p.label).toBe(`Waiting for a new screenshot of ${DIALOG} and 1 more screen`);
    expect(c.row).toMatchObject({ status: 'queued', state: 'waiting for a new screenshot', chip: 'blocks merge' });
    expect(c.row.detail).toContain(DIALOG);
    expect(c.text).toContain('a capture of each is filed next');
    for (const s of [c.p.label, c.p.detail ?? '', c.row.detail ?? '', c.text, readyToMergeReason(c.merge)]) expect(s).not.toMatch(NO_ACTION);
  });

  it('the merge is refused naming the screens, never "a decision is pending"', () => {
    expect(c.merge.ready).toBe(false);
    expect(readyToMergeReason(c.merge)).toContain(DIALOG);
    expect(readyToMergeReason(c.merge)).not.toContain('a decision is pending');
    expect(c.merge.scheduleVisualReview).toBe(true);
  });

  it('AC-10: an approved, green mission PR does not read ready to merge while it blocks', () => {
    expect(c.p.stage).not.toBe('ready');
    expect(c.p.label).not.toMatch(/ready to merge/i);
  });
});

describe('the recapture is queued (I-15)', () => {
  const c = chain('recapture-queued');
  it('reads queued and names the screen; the scheduler files nothing more', () => {
    expect(c.state.status).toBe('queued');
    expect(c.state.recapture?.next).toBe('queued');
    expect(c.p.label).toContain(DIALOG);
    expect(c.p.detail).toBe('The capture is queued.');
    expect(c.row).toMatchObject({ status: 'queued', state: 'waiting for a new screenshot' });
    expect(c.plan).toMatchObject({ action: 'none', why: 'audit_live' });
  });
});

describe('no capture is coming: a person decides (I-15, AC-14)', () => {
  const c = chain('recapture-decide');

  it('reads owner decision, Fixed or Still broken, and the merge refusal says so', () => {
    expect(c.state).toMatchObject({ status: 'findings', nextActor: 'owner' });
    expect(c.p).toMatchObject({ needsYou: true, owner: { kind: 'judge', label: 'Check 3 fixed screens' } });
    expect(c.p.detail).toContain('Fixed or Still broken');
    expect(c.row).toMatchObject({ status: 'owner', state: 'Check 3 fixed screens', waivable: true });
    expect(readyToMergeReason(c.merge)).toContain('decide Fixed or Still broken, or skip the review');
    expect(c.plan).toMatchObject({ action: 'none', why: 'findings_open' });
  });

  it('every count of open findings agrees: deck, row, owner button, text', () => {
    const open = screensToReview(c.model);
    expect(open).toBe(3);
    expect(c.model.queue).toHaveLength(open);
    expect(c.state.recapture?.screens).toHaveLength(open);
    expect(c.p.owner?.label).toBe(`Check ${open} fixed screens`);
    expect(c.text).toContain(`Decision needed: ${open} fixed screens with no new screenshot`);
  });
});

describe('Skip and the gate (second reproduction; I-7, I-12)', () => {
  const waiver = { reason: 'Checked these screens by hand on the branch', actorLabel: 'Sam', at: '2026-03-10T14:00:00.000Z' };

  it('an active Skip over open findings reads waived, never passed, and lets the merge through', () => {
    const c = chain('recapture-decide', { waiver });
    expect(c.state).toMatchObject({ status: 'waived', blocksMerge: false });
    expect(c.p.stage).toBe('waived');
    expect(c.row).toMatchObject({ status: 'waived', state: 'waived' });
    expect(c.row.detail).toContain('Sam');
    expect(c.merge).toMatchObject({ ready: true, blockers: [] });
  });

  it('policy off with old findings does not block', () => {
    const c = chain('recapture-decide', { policy: resolveVisualReviewPolicy({ workspace: 'off' }) });
    expect(c.state.blocksMerge).toBe(false);
    expect(c.merge.ready).toBe(true);
  });

  it('a Skip a later review replaced still names the person on the row, and the gate holds', () => {
    const early = { ...waiver, at: '2026-03-10T09:00:00.000Z' };
    const c = chain('recapture-decide', { waiver: early });
    expect(c.state.status).toBe('findings');
    expect(c.state.waiver).toMatchObject({ actorLabel: 'Sam', supersededBy: c.model.audit!.id });
    expect(c.row.detail).toContain('Sam skipped an earlier review; a later one replaced it.');
    expect(c.row.waivable).toBe(true);
    expect(c.merge.ready).toBe(false);
  });
});
