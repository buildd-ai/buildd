/**
 * The mission-branch visual-review workflow, end to end
 * (docs/specs/mission-task-lifecycle.md, "Visual review").
 *
 * Each test is one mission's life, driven through `tick` (the in-memory mission
 * in `visual-review-flow.fake-db.ts`) which runs the production pure chain:
 * impact -> state -> schedule -> ready-to-merge -> presentation. The unit tests
 * next to each module pin their own rules; this file pins that the pieces agree
 * when they run together, which is where the earlier "each surface reads it
 * differently" bugs lived. Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import { isMissionPrTask, MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';
import { decideReadyToMerge } from '../ready-to-merge';
import { visualReviewNeedsYou } from './visual-review-presentation';
import { RETRY_BACKOFF_BASE_MS, MAX_AUTO_ATTEMPTS_PER_HEAD, retryBackoffMs } from './visual-review-schedule';
import {
  AMBIGUOUS_EDIT, CSS_EDIT, DOC_EDIT, MIN, REVIEW, RISKY_FLOW_EDIT, SCREEN_EDIT, TEST_EDIT, TOKEN_EDIT,
  advance, finishAudit, jevSays, moveHead, newMission, tick,
} from './visual-review-flow.fake-db';

const codes = (t: Awaited<ReturnType<typeof tick>>) => t.merge.blockers.map(b => b.code);

describe('impact: what owes a review', () => {
  it('a diff that cannot render (tests, docs) is an automatic skip: nothing filed, nothing blocked, Jev not asked', async () => {
    const m = newMission({ files: [TEST_EDIT, DOC_EDIT] });
    const t = await tick(m);
    expect(t.assessment).toMatchObject({ verdict: 'not_applicable', basis: 'rule', recordKind: 'applicability' });
    expect(t.state).toMatchObject({ status: 'not_applicable', blocksMerge: false, blocksCompletion: false });
    expect(t.plan).toMatchObject({ action: 'none', why: 'not_applicable' });
    expect(t.merge.ready).toBe(true);
    expect(t.view.record?.kind).toBe('auto_no_impact');
    expect(t.view.needsYou).toBe(false);
    expect(m.filed).toEqual([]);
    expect(m.jevAsked).toBe(0);
  });

  it('a stylesheet or a shared token always owes a review, by rule, without asking Jev', async () => {
    for (const edit of [CSS_EDIT, TOKEN_EDIT]) {
      const m = newMission({ files: [edit] });
      const t = await tick(m);
      expect(t.assessment).toMatchObject({ verdict: 'review_required', basis: 'rule' });
      expect(t.plan).toMatchObject({ action: 'enqueue', reason: 'first', headSha: 'aaaa1111' });
      expect(m.jevAsked).toBe(0);
    }
  });

  it('a relevant UI change is reviewed BEFORE the integration PR may merge, then merges', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });

    let t = await tick(m);
    expect(t.plan.action).toBe('enqueue');
    expect(t.state).toMatchObject({ status: 'needed', blocksMerge: true, nextActor: 'system' });
    expect(t.after).toMatchObject({ status: 'queued', blocksMerge: true, nextActor: 'system' });
    expect(codes(t)).toEqual(['visual_review_owed']);
    expect(t.view.needsYou).toBe(false);

    finishAudit(m, { status: 'in_progress', review: REVIEW.capturing });
    t = await tick(m);
    expect(t.state.status).toBe('running');
    expect(t.plan).toMatchObject({ action: 'none', why: 'audit_live' });
    expect(t.merge.ready).toBe(false);

    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    m.pr = { number: 9, deliveryState: 'APPROVED' };
    t = await tick(m);
    expect(t.state).toMatchObject({ status: 'passed', blocksMerge: false, staleEvidence: false });
    expect(t.merge.ready).toBe(true);
    expect(t.view.stage).toBe('ready');
    expect(m.filed).toHaveLength(1);
  });

  it('an ambiguous change goes to Jev; a confident "no visual impact" skips and records the basis', async () => {
    const m = newMission({ files: [AMBIGUOUS_EDIT], jev: [jevSays('no_visual_impact')] });
    const t = await tick(m);
    expect(m.jevAsked).toBe(1);
    expect(t.assessment).toMatchObject({ verdict: 'not_applicable', basis: 'model' });
    expect(t.plan).toMatchObject({ action: 'none', why: 'not_applicable' });
    expect(t.merge.ready).toBe(true);
    expect(t.view.needsYou).toBe(false);
  });

  it('every way Jev cannot prove "no visual impact" fails safe into a review, never a human prompt', async () => {
    for (const jev of [[jevSays('review_required')], [jevSays('insufficient_evidence')], [jevSays('no_visual_impact', 0.4)], []]) {
      const m = newMission({ files: [AMBIGUOUS_EDIT], jev });
      const t = await tick(m);
      expect(t.assessment?.verdict).toBe('review_required');
      expect(t.plan.action).toBe('enqueue');
      expect(t.view.needsYou).toBe(false);
    }
  });

  it('an unreadable diff fails safe into a review', async () => {
    const t = await tick(newMission({ files: null }));
    expect(t.assessment).toMatchObject({ verdict: 'review_required', basis: 'fail_safe' });
    expect(t.plan.action).toBe('enqueue');
  });
});

describe('findings', () => {
  it('a visual finding is repaired and re-reviewed on the fixed commit before merge', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.fixing });

    let t = await tick(m);
    expect(t.state).toMatchObject({ status: 'findings', blocksMerge: true, nextActor: 'system' });
    expect(t.plan).toMatchObject({ action: 'none', why: 'findings_open' });
    expect(codes(t)).toEqual(['visual_review_findings']);
    expect(t.view).toMatchObject({ stage: 'fixing', problem: 'product', needsYou: false, report: null });

    // The fix PR lands: the head moves and the old audit's issues are resolved.
    moveHead(m, 'bbbb2222');
    m.audits[0].review = REVIEW.reviewed;
    t = await tick(m);
    expect(t.state).toMatchObject({ status: 'needed', staleEvidence: true, blocksMerge: true });
    expect(codes(t)).toEqual(['visual_review_stale']);
    expect(t.plan).toMatchObject({ action: 'enqueue', headSha: 'bbbb2222', round: 2, reason: 'new_head' });

    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    t = await tick(m);
    expect(t.state.status).toBe('passed');
    expect(t.merge.ready).toBe(true);
  });

  it('an ambiguous screen is Jev\'s, not the owner\'s; only spent fix rounds reach a person', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.unsure });
    let t = await tick(m);
    expect(t.state).toMatchObject({ status: 'findings', nextActor: 'jev' });
    expect(t.view.needsYou).toBe(false);

    m.audits[0].review = REVIEW.exhausted;
    t = await tick(m);
    expect(t.state).toMatchObject({ status: 'findings', nextActor: 'owner' });
    expect(t.view).toMatchObject({ needsYou: true, problem: 'product' });
    expect(t.view.owner?.kind).toBe('judge');
    expect(t.merge.ready).toBe(false);
  });
});

describe('evidence is for a commit', () => {
  it('a pass on an older commit is not a pass for the head, and an audit with no recorded commit proves nothing', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    expect((await tick(m)).state.status).toBe('passed');

    moveHead(m, 'cccc3333');
    let t = await tick(m);
    expect(t.state.staleEvidence).toBe(true);
    expect(t.merge.ready).toBe(false);
    expect(t.merge.scheduleVisualReview).toBe(true);

    // Same again with an audit that never recorded the commit it looked at.
    const n = newMission({ files: [SCREEN_EDIT] });
    await tick(n);
    finishAudit(n, { status: 'completed', review: REVIEW.reviewed });
    n.audits[0].headSha = null;
    t = await tick(n);
    expect(t.state.staleEvidence).toBe(true);
    expect(codes(t)).toEqual(['visual_review_stale']);
  });

  it('a queued audit stamped for an older head is re-stamped, not duplicated', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    moveHead(m, 'dddd4444');
    const t = await tick(m);
    expect(t.plan).toMatchObject({ action: 'restamp', headSha: 'dddd4444' });
    expect(m.audits).toHaveLength(1);
    expect(m.audits[0].headSha).toBe('dddd4444');
  });

  it('a new head that removes the UI change drops the requirement', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    m.headSha = 'eeee5555';
    m.files = [TEST_EDIT];
    const t = await tick(m);
    expect(t.state.staleEvidence).toBe(false);
    expect(t.merge.ready).toBe(true);
  });
});

describe('the check itself cannot run', () => {
  it('a failing audit retries with backoff, three attempts per head, then names the owner; it never passes by default', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS_PER_HEAD; attempt++) {
      finishAudit(m, { status: 'failed', review: REVIEW.failed });
      let t = await tick(m);
      if (attempt < MAX_AUTO_ATTEMPTS_PER_HEAD) {
        expect(t.state).toMatchObject({ status: 'blocked', nextActor: 'system' });
        expect(t.view).toMatchObject({ problem: 'system', needsYou: false });
        expect(t.plan).toMatchObject({ action: 'wait', attempt: attempt + 1 });
        expect(codes(t)).toEqual(['visual_review_blocked']);
        advance(m, retryBackoffMs(attempt));
        t = await tick(m);
        expect(t.plan.action).toBe('enqueue');
        expect(m.filed.at(-1)).toMatchObject({ reason: 'retry', attempt: attempt + 1, headSha: 'aaaa1111' });
      } else {
        expect(t.plan).toMatchObject({ action: 'blocked', cause: 'retries_exhausted', nextActor: 'owner' });
        expect(t.state).toMatchObject({ status: 'blocked', nextActor: 'owner' });
        expect(t.view).toMatchObject({ needsYou: true, problem: 'system' });
        expect(t.view.owner?.kind).toBe('report');
        expect(t.merge.ready).toBe(false);
      }
    }
    expect(RETRY_BACKOFF_BASE_MS).toBe(5 * MIN);
  });

  it('a new commit is a new question: the attempt budget resets', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    for (let i = 0; i < MAX_AUTO_ATTEMPTS_PER_HEAD; i++) {
      finishAudit(m, { status: 'failed', review: REVIEW.failed });
      advance(m, 3 * 60 * MIN);
      await tick(m);
    }
    expect((await tick(m)).plan).toMatchObject({ action: 'blocked', cause: 'retries_exhausted' });
    moveHead(m, 'ffff6666');
    expect((await tick(m)).plan).toMatchObject({ action: 'enqueue', headSha: 'ffff6666', attempt: 1 });
  });

  it('a setup problem the workspace owns goes to the owner at once and is never retried', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'failed', review: REVIEW.failed, result: 'capture failed: protection_bypass_missing' });
    const t = await tick(m);
    expect(t.plan).toMatchObject({ action: 'blocked', cause: 'capture_config', nextActor: 'owner' });
    expect(t.state.blocked).toMatchObject({ cause: 'capture_auth', causeOwner: 'workspace' });
    expect(t.view.owner?.kind).toBe('fix_setup');
    expect(m.filed).toHaveLength(1);
  });

  it('no browser runner online: the review is still filed, flagged, and the merge stays held', async () => {
    const m = newMission({ files: [SCREEN_EDIT], browserRunnerOnline: false });
    const t = await tick(m);
    expect(t.plan).toMatchObject({ action: 'enqueue', runnerNote: 'no_browser_runner' });
    expect(t.merge.ready).toBe(false);

    finishAudit(m, { status: 'pending', review: REVIEW.noBrowser });
    const waiting = await tick(m);
    expect(waiting.state).toMatchObject({ status: 'blocked' });
    expect(waiting.state.blocked?.cause).toBe('no_browser_runner');
    expect(waiting.merge.ready).toBe(false);
    // Nothing failed and nothing retries: it reads as waiting for a browser, not as a failure to report.
    expect(waiting.view).toMatchObject({ stage: 'blocked', label: 'Waiting for a browser', problem: 'system', needsYou: false, report: null });
  });

  it('a local executor is named to the owner rather than waiting unseen', async () => {
    const t = await tick(newMission({ files: [SCREEN_EDIT], executorLocal: true }));
    expect(t.plan).toMatchObject({ action: 'blocked', cause: 'executor_local', nextActor: 'owner' });
  });
});

describe('policy inheritance', () => {
  it('ask: nothing is filed for the owner; Run is the one owner prompt, and the merge waits for it', async () => {
    const m = newMission({ workspace: 'ask', files: [SCREEN_EDIT] });
    const t = await tick(m);
    expect(t.plan).toMatchObject({ action: 'none', why: 'ask_policy' });
    expect(t.state).toMatchObject({ status: 'needed', nextActor: 'owner' });
    expect(t.view.owner?.kind).toBe('run_review');
    expect(t.merge.ready).toBe(false);
    expect(m.filed).toEqual([]);
  });

  it('off: nothing is required, filed or shown to the owner, even for a stylesheet', async () => {
    const m = newMission({ workspace: 'off', files: [CSS_EDIT] });
    const t = await tick(m);
    expect(t.assessment).toMatchObject({ verdict: 'not_applicable', basis: 'policy' });
    expect(t.merge.ready).toBe(true);
    expect(t.view.needsYou).toBe(false);
    expect(m.filed).toEqual([]);
  });

  it('strict: never skips on Jev\'s say-so, ignores a mission exception, and a waiver does not clear it', async () => {
    const m = newMission({
      workspace: 'strict',
      autoSurfaceAudit: false,
      files: [AMBIGUOUS_EDIT],
      waiver: { reason: 'copy-only change, checked by hand', actorLabel: 'someone', at: new Date(Date.parse('2026-10-12T11:00:00Z')).toISOString() },
    });
    const t = await tick(m);
    expect(m.jevAsked).toBe(0);
    expect(t.assessment).toMatchObject({ verdict: 'review_required', basis: 'policy' });
    expect(t.state.policy).toMatchObject({ mode: 'strict', locked: true, waiverAllowed: false });
    expect(t.state.status).not.toBe('waived');
    expect(t.merge.ready).toBe(false);
    expect(t.plan.action).toBe('enqueue');
  });

  it('team default applies when the workspace inherits; the workspace beats it; a mission exception beats both', async () => {
    expect((await tick(newMission({ team: 'ask', files: [SCREEN_EDIT] }))).state.policy).toMatchObject({ mode: 'ask', origin: 'team' });
    expect((await tick(newMission({ team: 'ask', workspace: 'automatic', files: [SCREEN_EDIT] }))).state.policy).toMatchObject({ mode: 'automatic', origin: 'workspace' });
    expect((await tick(newMission({ workspace: 'ask', autoSurfaceAudit: false, files: [SCREEN_EDIT] }))).state.policy).toMatchObject({ mode: 'off', origin: 'mission' });
  });

  it('legacy autoSurfaceAudit: true and null inherit, false is an off exception', async () => {
    for (const autoSurfaceAudit of [true, null]) {
      const m = newMission({ autoSurfaceAudit, files: [SCREEN_EDIT] });
      const t = await tick(m);
      expect(t.state.policy).toMatchObject({ mode: 'automatic', origin: 'default' });
      expect(t.plan.action).toBe('enqueue');
    }
    const t = await tick(newMission({ autoSurfaceAudit: false, files: [SCREEN_EDIT] }));
    expect(t.state.policy).toMatchObject({ mode: 'off', origin: 'mission' });
    expect(t.plan).toMatchObject({ action: 'none', why: 'policy_off' });
    expect(t.merge.ready).toBe(true);
  });
});

describe('protected paths are never a model\'s call', () => {
  it('a risky flow screen, a stylesheet and a route screen each require a review even when Jev would say no', async () => {
    for (const edit of [RISKY_FLOW_EDIT, CSS_EDIT, SCREEN_EDIT]) {
      const m = newMission({ files: [edit], jev: [jevSays('no_visual_impact', 0.99)] });
      const t = await tick(m);
      expect(t.assessment).toMatchObject({ verdict: 'review_required', basis: 'rule' });
      expect(m.jevAsked).toBe(0);
      expect(t.plan.action).toBe('enqueue');
    }
  });

  it('a protected file alongside an ambiguous one is decided by the rule, not by asking', async () => {
    const m = newMission({ files: [AMBIGUOUS_EDIT, CSS_EDIT], jev: [jevSays('no_visual_impact')] });
    const t = await tick(m);
    expect(t.assessment?.verdict).toBe('review_required');
    expect(m.jevAsked).toBe(0);
  });
});

describe('the merge and the record', () => {
  it('a merged mission after a pass keeps a completion record that says the check passed before the merge', async () => {
    const m = newMission({ files: [SCREEN_EDIT] });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    m.pr = { number: 9, deliveryState: 'MERGED' };
    const t = await tick(m);
    expect(t.state).toMatchObject({ status: 'passed', blocksCompletion: false });
    expect(t.state.branch).toMatchObject({ postMergeRecovery: false, integrationPr: { stage: 'merged' } });
    expect(t.view).toMatchObject({ stage: 'merged', needsYou: false });
    expect(t.view.record?.kind).toBe('passed');
    expect(t.merge.ready).toBe(true);
  });

  it('a person\'s waiver is a recorded decision kept apart from an automatic "no visual changes"', async () => {
    const waived = newMission({
      files: [SCREEN_EDIT],
      waiver: { reason: 'copy-only change, checked by hand', actorLabel: 'someone', at: new Date(Date.parse('2026-10-12T11:00:00Z')).toISOString() },
    });
    const w = await tick(waived);
    expect(w.state.status).toBe('waived');
    expect(w.view.record).toMatchObject({ kind: 'waiver', reason: 'copy-only change, checked by hand', actor: 'someone', policy: 'automatic' });
    expect(w.merge.ready).toBe(true);
    expect(waived.filed).toEqual([]);

    const auto = await tick(newMission({ files: [DOC_EDIT] }));
    expect(auto.view.record?.kind).toBe('auto_no_impact');
  });

  it('a mission PR that merged without the review is recovered after the fact and never reported as pre-merge assurance', async () => {
    const m = newMission({ files: [CSS_EDIT], pr: { number: 9, deliveryState: 'MERGED' } });
    let t = await tick(m);
    expect(t.state).toMatchObject({ pendingVerification: true, blocksCompletion: true, blocksMerge: false });
    expect(t.state.branch.postMergeRecovery).toBe(true);
    expect(t.merge.ready).toBe(true);
    expect(t.plan).toMatchObject({ action: 'enqueue', reason: 'post_merge_recovery' });

    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    t = await tick(m);
    expect(t.state).toMatchObject({ status: 'passed', blocksCompletion: false });
    expect(t.state.branch.postMergeRecovery).toBe(false);
  });
});

describe('the owner is not a routine reviewer', () => {
  it('under automatic and strict, no stage of an ordinary review raises Needs You', async () => {
    for (const workspace of ['automatic', 'strict'] as const) {
      const m = newMission({ workspace, files: [SCREEN_EDIT] });
      const seen: boolean[] = [];
      seen.push((await tick(m)).view.needsYou); // queued
      finishAudit(m, { status: 'in_progress', review: REVIEW.capturing });
      seen.push((await tick(m)).view.needsYou); // running
      finishAudit(m, { status: 'completed', review: REVIEW.fixing });
      seen.push((await tick(m)).view.needsYou); // fixing
      m.audits[0].review = REVIEW.unsure;
      const unsure = await tick(m);
      seen.push(unsure.view.needsYou); // a screen awaiting Jev
      moveHead(m, 'bbbb2222');
      m.audits[0].review = REVIEW.reviewed;
      const stale = await tick(m);
      seen.push(stale.view.needsYou); // re-review filed
      finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
      const passed = await tick(m);
      seen.push(passed.view.needsYou); // passed; merge policy is not visual review's concern
      expect(seen).toEqual([false, false, false, false, false, false]);
      expect(visualReviewNeedsYou(unsure.state)).toBe(false);
    }
  });

  it('Merge now appears only where the merge policy asks a person', async () => {
    const m = newMission({ files: [SCREEN_EDIT], pr: { number: 9, deliveryState: 'APPROVED' } });
    await tick(m);
    finishAudit(m, { status: 'completed', review: REVIEW.reviewed });
    expect((await tick(m)).view.needsYou).toBe(false);
    const human = await tick(m, { ownerMergesIntegration: true });
    expect(human.view.owner?.kind).toBe('merge_now');
  });
});

describe('what the gate covers', () => {
  it('a task PR into the integration branch is never asked, so approved task PRs keep landing', () => {
    expect(decideReadyToMerge({ kind: 'not_mission_pr' })).toMatchObject({ ready: true, blockers: [] });
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}Banner`, taskClass: 'bookkeeping' })).toBe(true);
    expect(isMissionPrTask({ title: 'Add the banner', taskClass: 'work' })).toBe(false);
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}Banner`, taskClass: 'work' })).toBe(false);
  });

  it('the mission PR is held while its own work is unfinished, whatever the review says', async () => {
    const m = newMission({ files: [DOC_EDIT], workHolder: 'one task PR still open' });
    const t = await tick(m);
    expect(t.state.status).toBe('not_applicable');
    expect(codes(t)).toEqual(['work_unfinished']);
  });

  it('a feature mission (integration PR) gates its merge; a direct-to-trunk mission has no merge to gate and is held only at completion', async () => {
    const feature = await tick(newMission({ files: [SCREEN_EDIT] }));
    expect(feature.state.blocksMerge).toBe(true);

    const direct = newMission({ files: [SCREEN_EDIT], pr: null, headSha: null });
    const t = await tick(direct);
    // Honest limit: with no integration branch there is no head to assess, so the canonical state stays
    // `optional` and nothing is filed or blocked here. Direct-to-trunk completion is held by the older
    // surface-audit gate (see the spec's "Not yet wired").
    expect(t.state).toMatchObject({ status: 'optional', blocksMerge: false, blocksCompletion: false });
    expect(t.plan).toMatchObject({ action: 'none', why: 'no_integration_head' });
    expect(direct.filed).toEqual([]);
  });
});
