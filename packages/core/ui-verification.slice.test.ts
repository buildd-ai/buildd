import { describe, expect, it } from 'bun:test';
import { surface } from './ui-verification.fixtures';
import { parseSurfaceEvidence, runUiActionStateCheck, uiVerificationFingerprint, type SurfaceEvidence } from './ui-verification';

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

