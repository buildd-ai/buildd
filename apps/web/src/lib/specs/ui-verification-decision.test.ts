import { describe, expect, it } from 'bun:test';
import { surface } from '../../../../../packages/core/ui-verification.fixtures';
import { executeUiVerification, type UiVerificationDeps } from './ui-verification-decision';
import type { DecisionReceipt } from '@buildd/ai-kit/decide';

const receipt: DecisionReceipt = { kind: 'decision', decisionId: 'buildd.ui_copy', provider: 'openrouter', model: 'typesafe/jev-3', usage: { inputTokens: 60, outputTokens: 3, costUsd: 0.0001 }, latencyMs: 9, outcome: 'ok', attempts: 1 };
function harness(choices = ['clear', 'clear', 'clear'], confidence = 0.97) {
  const calls: unknown[] = []; const rows: unknown[] = [];
  const deps: UiVerificationDeps = {
    measurements: async () => [],
    resolveAccess: async () => ({ ok: true, apiKey: 'fake-key', model: 'typesafe/jev-3' }),
    call: async params => {
      calls.push(params); await params.onUsage?.(receipt);
      return { ok: true, answers: Object.fromEntries(['repetition', 'action_clarity', 'workflow_narration'].map((name, i) => [name, { type: 'choice', choice: choices[i], confidence, probabilities: { [choices[i]]: confidence } }])), model: receipt.model, usage: receipt.usage, latencyMs: 9, attempts: 1 } as never;
    },
    record: async row => { rows.push(row); return 'decision-test'; },
  };
  return { deps, calls, rows };
}

describe('registered UI verification executor', () => {
  it('runs deterministic semantics without provider access or invented receipts', async () => {
    const h = harness(); const out = await executeUiVerification('ui.actions_match_state', surface(), { teamId: 'team-test' }, {}, h.deps);
    expect(out.result.verdict).toBe('pass'); expect(out.method).toBe('deterministic');
    expect(h.calls).toHaveLength(0); expect(out.receipts).toEqual([]); expect(out.decisionRecordIds).toEqual([]);
    expect(out.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses broker scope, actual persisted decision IDs and actual provider receipts', async () => {
    const h = harness(); const forwarded: DecisionReceipt[] = [];
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test', workspaceId: 'workspace-test', onUsage: r => { forwarded.push(r); } }, {}, h.deps);
    expect(out.result.verdict).toBe('pass'); expect(out.method).toBe('model'); expect(out.decisionKind).toBe('buildd.ui_copy');
    expect(out.decisionRecordIds).toEqual(['decision-test']); expect(out.receipts).toEqual([receipt]); expect(forwarded).toEqual([receipt]);
    expect(h.rows[0]).toMatchObject({ teamId: 'team-test', workspaceId: 'workspace-test', subjectType: 'ui_surface' });
    expect(out.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('records a model failure finding and keeps low confidence or missing access inconclusive', async () => {
    const fail = harness(['clear', 'revise', 'clear']);
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, {}, fail.deps)).result.verdict).toBe('fail');
    const low = harness(['clear', 'clear', 'clear'], 0.1);
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, {}, low.deps)).result.verdict).toBe('inconclusive');
    const absent = harness(); absent.deps.resolveAccess = async () => ({ ok: false, error: { kind: 'missing_key' } });
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, {}, absent.deps);
    expect(out.result.verdict).toBe('inconclusive'); expect(out.receipts).toEqual([]); expect(absent.calls).toHaveLength(0);
  });
  it('does not spend for partial, self-reported, malformed, or sensitive evidence', async () => {
    for (const change of [
      (e: ReturnType<typeof surface>) => { e.coverage.renderedText = 'partial'; },
      (e: ReturnType<typeof surface>) => { e.provenance.collector = 'agent'; },
      (e: ReturnType<typeof surface>) => { e.visible.blocks[0].text = 'Bearer private-value'; },
      (e: ReturnType<typeof surface>) => { e.visible = { blocks: [], actions: [] }; },
    ]) { const e = surface(); change(e); const h = harness();
      expect((await executeUiVerification('ui.card_clarity', e, { teamId: 'team-test' }, {}, h.deps)).result.verdict).toBe('inconclusive');
      expect(h.calls).toHaveLength(0);
    }
    const h = harness(); expect((await executeUiVerification('ui.card_clarity', {}, { teamId: 'team-test' }, {}, h.deps)).inputFingerprint).toBeNull();
  });
  it('judges copy on its words and actions alone: a capture without runtime facts is still asked, once', async () => {
    const e = surface(); e.facts = {}; e.provenance.factVersion = 'none'; e.coverage.runtimeState = 'absent';
    const h = harness();
    const out = await executeUiVerification('ui.card_clarity', e, { teamId: 'team-test' }, {}, h.deps);
    expect(out.result.verdict).toBe('pass'); expect(out.method).toBe('model');
    expect(h.calls).toHaveLength(1);
    expect(out.inspected).toEqual(['text', 'actions']);
  });
  it('sends the capture\'s runtime facts, element ids and the criterion to the model, in one broker call', async () => {
    const h = harness(['revise', 'clear', 'clear']);
    const criterion = { id: 'AC-2', text: 'The card says each thing once.' };
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, { profile: { id: 'buildd-ui', version: 1 }, criterion }, h.deps);
    expect(h.calls).toHaveLength(1);
    const sent = JSON.stringify(h.calls[0]);
    for (const part of ['The card says each thing once.', 'prState', 'candidate', '"status"', '"confirm"']) expect(sent).toContain(part);
    expect(out).toMatchObject({ method: 'model', inspected: ['text', 'actions', 'state'], evaluator: { decisionId: 'decision-test', policyVersion: 'ui-copy-v4' } });
    // A failed axis is a card-level finding on the capture's own element ids.
    expect(out.findings).toEqual([{ kind: 'repetition', axis: 'repetition', scope: 'card', segmentIds: ['status'] }]);
    // The criterion is part of the input identity: a different one is a different run.
    const other = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, { criterion: { ...criterion, text: 'Other words.' } }, harness().deps);
    expect(other.inputFingerprint).not.toBe(out.inputFingerprint);
  });
  it('a fallback answer is never a model result, even with a ledger row', async () => {
    const h = harness(); h.deps.resolveAccess = async () => ({ ok: false, error: { kind: 'missing_key' } });
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, {}, h.deps);
    expect(out.method).toBe('fallback'); expect(out.result.verdict).toBe('inconclusive'); expect(out.inspected).toEqual([]);
  });
  it('cannot report an authoritative model pass when ledger persistence fails', async () => {
    const h = harness(); h.deps.record = async () => { throw new Error('offline'); };
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, {}, h.deps)).result.verdict).toBe('inconclusive');
  });
});

