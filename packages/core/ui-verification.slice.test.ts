import { describe, expect, it } from 'bun:test';
import { surface } from './ui-verification.fixtures';
import { checkUiActionState, evaluateUiSurface, parseSurfaceEvidence, parseUiEvidence, runUiActionStateCheck, runUiSurfaceCheck, surfaceFromUiEvidence, uiVerificationFingerprint, type SurfaceEvidence, type UiEvidence } from './ui-verification';

describe('surface evidence contract', () => {
  it('accepts bounded composed cards and rejects unknown, truncated, or sensitive payloads', () => {
    expect(parseSurfaceEvidence(surface()).ok).toBe(true);
    expect(parseSurfaceEvidence({ ...surface(), extra: 'unknown' }).ok).toBe(false);
    const large = surface(); large.visible.blocks[0].text = 'x'.repeat(1001);
    expect(parseSurfaceEvidence(large).ok).toBe(false);
    const secret = surface(); secret.visible.blocks[0].text = 'Bearer test-token-not-for-sharing';
    expect(parseSurfaceEvidence(secret).ok).toBe(false);
    const hidden = surface(); hidden.visible.actions[0].label = 'private-test-key';
    expect(parseSurfaceEvidence(hidden, { secrets: ['private-test-key'] }).ok).toBe(false);
    hidden.visible.actions[0].label = 'private-"quoted-key';
    expect(parseSurfaceEvidence(hidden, { secrets: ['private-"quoted-key'] }).ok).toBe(false);
    secret.visible.blocks[0].text = 'Bearer\ttest-token-not-for-sharing';
    expect(parseSurfaceEvidence(secret).ok).toBe(false);
    const duplicate = surface(); duplicate.visible.actions.push({ ...duplicate.visible.actions[0] });
    expect(parseSurfaceEvidence(duplicate).ok).toBe(false);
  });

  it('keys context, runtime facts, ordered composition, exact capture, profile and prompt', () => {
    const a = surface(); const original = uiVerificationFingerprint(a, 'ui.card_clarity', 'prompt-a');
    for (const change of [
      (e: SurfaceEvidence) => { e.subject.viewport = 'desktop'; },
      (e: SurfaceEvidence) => { e.facts.prState = 'open'; },
      (e: SurfaceEvidence) => { e.capture.captureId = 'other-capture'; },
      (e: SurfaceEvidence) => { e.visible.blocks[0].order = 1; },
    ]) { const b = surface(); change(b); expect(uiVerificationFingerprint(b, 'ui.card_clarity', 'prompt-a')).not.toBe(original); }
    expect(uiVerificationFingerprint(a, 'ui.card_clarity', 'prompt-b')).not.toBe(original);
    expect(uiVerificationFingerprint(a, 'ui.actions_match_state')).not.toBe(original);
    expect(uiVerificationFingerprint(JSON.parse(JSON.stringify(a)), 'ui.card_clarity', 'prompt-a')).toBe(original);
  });
});

describe('AC-3 semantic actions match captured state', () => {
  it.each(['closed', 'merged'] as const)('fails an enabled merge operation on a %s PR regardless of label', prState => {
    const e = surface(); e.facts.prState = prState;
    e.visible.actions[0] = { ...e.visible.actions[0], operation: 'merge_pr', label: 'Continue' };
    expect(runUiActionStateCheck(e)).toMatchObject({ verdict: 'fail', observed: 'terminal_pr_offers_merge' });
  });
  it('allows replacement confirmation without confusing it with merging', () => {
    expect(runUiActionStateCheck(surface())).toMatchObject({ verdict: 'pass', checkId: 'ui.actions_match_state', checkVersion: 1 });
  });
  it('fails unresolved closure actions after a verified replacement', () => {
    const e = surface(); e.facts.replacementState = 'verified'; e.visible.actions[0].operation = 'resolve_pr_closure';
    expect(runUiActionStateCheck(e).verdict).toBe('fail');
  });
  it('fails a verified-pass status while recapture is pending', () => {
    const e = surface(); e.facts.verificationState = 'pending_recapture'; e.facts.shownVerificationState = 'verified_pass';
    expect(runUiActionStateCheck(e).verdict).toBe('fail');
  });
  it('requires independent, complete runtime evidence; unknown never passes', () => {
    const partial = surface(); partial.coverage.runtimeState = 'partial';
    expect(runUiActionStateCheck(partial)).toMatchObject({ verdict: 'inconclusive', evidenceShortfall: [{ key: 'runtimeState', have: 'partial' }] });
    const agent = surface(); agent.provenance.collector = 'agent';
    expect(runUiActionStateCheck(agent).verdict).toBe('inconclusive');
    const unknown = surface(); unknown.facts = {};
    expect(runUiActionStateCheck(unknown).verdict).toBe('inconclusive');
  });
  it('reports unmapped semantic operations as unsupported instead of approving their labels', () => {
    const e = surface(); e.visible.actions[0].operation = 'other';
    expect(runUiActionStateCheck(e)).toMatchObject({ verdict: 'unsupported', observed: 'unmapped_action_operation' });
  });
  it('declared non-mutating operations are mapped, and dismissing a replacement still needs its state', () => {
    for (const operation of ['view_detail', 'answer_question', 'cancel', 'turn_off_visual_review', 'dismiss_replacement'] as const) {
      const e = surface(); e.visible.actions[0].operation = operation;
      expect(runUiActionStateCheck(e).verdict).toBe('pass');
    }
    const e = surface(); e.visible.actions[0].operation = 'dismiss_replacement'; e.facts = { prState: 'closed' };
    expect(runUiActionStateCheck(e)).toMatchObject({ verdict: 'inconclusive', observed: 'runtime_state_unknown' });
  });
});

const SHA = 'c'.repeat(40);
const portable = (over: Partial<UiEvidence> = {}): UiEvidence => ({
  route: '/app/tasks/[id]', scenario: 'completed-task-with-pr', codeSha: SHA,
  text: [{ text: 'Ready to merge', prominence: 'primary' }, { text: 'Merging closes the task.', prominence: 'secondary' }, { text: 'More', prominence: 'menu' }],
  actions: [{ label: 'Merge', operation: 'merge', enabled: true, prominence: 'primary' }, { label: 'Details', operation: 'open_details', enabled: false, prominence: 'menu' }],
  claims: [{ kind: 'verification', value: 'verified' }],
  state: { pr: 'open', verification: 'verified', replacementPending: false },
  coverage: { text: 'complete', actions: 'complete', state: 'partial' },
  pixels: { screenshotArtifactId: 'shot-1' },
  ...over,
});
const parsedPortable = (e: unknown) => { const r = parseUiEvidence(e); if (!r.ok) throw new Error(r.reason); return r.evidence; };

describe('portable evidence as the canonical capture', () => {
  it('keeps order, roles, ids, operations, enabled state, prominence, facts, the shown claim, coverage and the screenshot', () => {
    const r = surfaceFromUiEvidence(parsedPortable(portable()), { independent: true });
    if (!r.ok) throw new Error(r.reason);
    const e = r.evidence;
    expect(parseSurfaceEvidence(e).ok).toBe(true);
    expect(e.visible.blocks).toEqual([
      { id: 's1', role: 'status', text: 'Ready to merge', order: 0, disclosure: 'visible' },
      { id: 's2', role: 'body', text: 'Merging closes the task.', order: 1, disclosure: 'visible' },
      { id: 's3', role: 'hint', text: 'More', order: 2, disclosure: 'visible' },
    ]);
    expect(e.visible.actions).toEqual([
      { id: 'a1', label: 'Merge', operation: 'merge_pr', enabled: true, prominence: 'primary', disclosure: 'visible' },
      { id: 'a2', label: 'Details', operation: 'view_detail', enabled: false, prominence: 'menu', disclosure: 'visible' },
    ]);
    expect(e.facts).toEqual({ prState: 'open', verificationState: 'passed', replacementState: 'none', shownVerificationState: 'verified_pass' });
    expect(e.coverage).toEqual({ renderedText: 'complete', actions: 'complete', runtimeState: 'partial', screenshot: 'complete' });
    expect(e.capture.screenshotRef).toBe('shot-1');
    expect(e.subject).toMatchObject({ route: '/app/tasks/[id]', scenarioId: 'completed-task-with-pr', commitSha: SHA });
    expect(e.provenance.collector).toBe('runner');
    expect(surfaceFromUiEvidence(parsedPortable(portable()), { independent: false })).toMatchObject({ ok: true, evidence: { provenance: { collector: 'agent' } } });
  });
  it('refuses what the canonical capture cannot hold instead of dropping it', () => {
    for (const claims of [[{ kind: 'verification', value: 'unverified' }], [{ kind: 'verification', value: 'verified' }, { kind: 'verification', value: 'failed' }]] as const) {
      expect(surfaceFromUiEvidence(parsedPortable(portable({ claims: [...claims] })), { independent: true })).toEqual({ ok: false, reason: 'claims_not_representable' });
    }
  });
  it('one engine: the portable checker and the stored-capture check agree, with the stronger rules on both', () => {
    const cases: Array<[Partial<UiEvidence>, string]> = [
      [{ state: { pr: 'closed', verification: 'verified', replacementPending: false } }, 'fail'],
      [{ actions: [{ label: 'Confirm', operation: 'confirm_replacement', enabled: true, prominence: 'primary' }] }, 'fail'],
      [{ claims: [{ kind: 'verification', value: 'failed' }] }, 'fail'],
      [{ actions: [{ label: 'Do it', operation: 'other', enabled: true, prominence: 'primary' }] }, 'unsupported'],
      [{ state: { verification: 'verified' } }, 'inconclusive'],
      [{}, 'pass'],
    ];
    for (const [over, verdict] of cases) {
      const card = parsedPortable(portable({ ...over, coverage: { text: 'complete', actions: 'complete', state: 'complete' } }));
      expect(checkUiActionState(card).verdict).toBe(verdict);
      const r = surfaceFromUiEvidence(card, { independent: true });
      if (!r.ok) throw new Error(r.reason);
      expect(runUiActionStateCheck(r.evidence).verdict).toBe(verdict);
    }
  });
  it('links deterministic findings to the capture\'s own action ids', async () => {
    const e = surface(); e.facts.prState = 'merged';
    e.visible.actions = [{ id: 'merge-button', label: 'Merge', operation: 'merge_pr', enabled: true, prominence: 'primary', disclosure: 'visible' }];
    const out = await evaluateUiSurface('ui.actions_match_state', e);
    expect(out).toMatchObject({ verdict: 'fail', method: 'deterministic', coverage: 'complete' });
    expect(out.findings).toEqual([expect.objectContaining({ kind: 'action_state_contradiction', code: 'terminal_pr_offers_merge', fact: 'prState', actionIds: ['merge-button'] })]);
    // A capture showing a status its facts contradict fails, beyond the pending-recapture case.
    const shown = surface(); shown.facts.shownVerificationState = 'verified_pass';
    expect(runUiActionStateCheck(shown)).toMatchObject({ verdict: 'fail', observed: 'shown_verification_contradicts_state' });
  });
  it('copy is judged on words and actions: unknown runtime facts are not a precondition, partial text is', () => {
    const e = surface(); e.facts = {}; e.coverage.runtimeState = 'absent';
    expect(runUiSurfaceCheck('ui.card_clarity', e, { verdict: 'inconclusive', observed: 'model_judgment_required' })).toMatchObject({ observed: 'model_judgment_required', evidenceShortfall: [] });
    expect(runUiActionStateCheck(e).verdict).toBe('inconclusive');
    const partial = surface(); partial.coverage.renderedText = 'partial';
    expect(runUiSurfaceCheck('ui.card_clarity', partial, { verdict: 'inconclusive', observed: 'model_judgment_required' }).evidenceShortfall).toEqual([expect.objectContaining({ key: 'renderedText' })]);
  });
  it('the copy evaluator makes exactly one model call and only a model answer is a model result', async () => {
    let calls = 0;
    const out = await evaluateUiSurface('ui.card_clarity', surface(), { criterion: { id: 'AC-2', text: 'Says each thing once.' } }, async (features) => {
      calls++;
      expect(features.criterion).toEqual({ id: 'AC-2', text: 'Says each thing once.' });
      expect(features.state?.facts).toMatchObject({ prState: 'closed' });
      return { ok: true, decision: 'concise', raw: null, evaluator: { model: 'm', promptFingerprint: 'p', policyVersion: 'v', decisionId: 'd' } };
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ verdict: 'pass', method: 'model', inspected: ['text', 'actions', 'state'] });
    const failed = await evaluateUiSurface('ui.card_clarity', surface(), {}, async () => ({ ok: false, error: 'decision_record_missing' }));
    expect(failed).toMatchObject({ verdict: 'inconclusive', method: 'fallback', inspected: [] });
    expect(JSON.stringify(failed.findings)).toContain('decision_record_missing');
  });
});
