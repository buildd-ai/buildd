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
    const h = harness(); const out = await executeUiVerification('ui.actions_match_state', surface(), { teamId: 'team-test' }, h.deps);
    expect(out.result.verdict).toBe('pass'); expect(out.method).toBe('deterministic');
    expect(h.calls).toHaveLength(0); expect(out.receipts).toEqual([]); expect(out.decisionRecordIds).toEqual([]);
    expect(out.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses broker scope, actual persisted decision IDs and actual provider receipts', async () => {
    const h = harness(); const forwarded: DecisionReceipt[] = [];
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test', workspaceId: 'workspace-test', onUsage: r => { forwarded.push(r); } }, h.deps);
    expect(out.result.verdict).toBe('pass'); expect(out.method).toBe('model'); expect(out.decisionKind).toBe('buildd.ui_copy');
    expect(out.decisionRecordIds).toEqual(['decision-test']); expect(out.receipts).toEqual([receipt]); expect(forwarded).toEqual([receipt]);
    expect(h.rows[0]).toMatchObject({ teamId: 'team-test', workspaceId: 'workspace-test', subjectType: 'ui_surface' });
    expect(out.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('records a model failure finding and keeps low confidence or missing access inconclusive', async () => {
    const fail = harness(['clear', 'revise', 'clear']);
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, fail.deps)).result.verdict).toBe('fail');
    const low = harness(['clear', 'clear', 'clear'], 0.1);
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, low.deps)).result.verdict).toBe('inconclusive');
    const absent = harness(); absent.deps.resolveAccess = async () => ({ ok: false, error: { kind: 'missing_key' } });
    const out = await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, absent.deps);
    expect(out.result.verdict).toBe('inconclusive'); expect(out.receipts).toEqual([]); expect(absent.calls).toHaveLength(0);
  });
  it('does not spend for partial, self-reported, malformed, or sensitive evidence', async () => {
    for (const change of [
      (e: ReturnType<typeof surface>) => { e.coverage.renderedText = 'partial'; },
      (e: ReturnType<typeof surface>) => { e.provenance.collector = 'agent'; },
      (e: ReturnType<typeof surface>) => { e.visible.blocks[0].text = 'Bearer private-value'; },
      (e: ReturnType<typeof surface>) => { e.facts = {}; },
      (e: ReturnType<typeof surface>) => { e.visible = { blocks: [], actions: [] }; },
    ]) { const e = surface(); change(e); const h = harness();
      expect((await executeUiVerification('ui.card_clarity', e, { teamId: 'team-test' }, h.deps)).result.verdict).toBe('inconclusive');
      expect(h.calls).toHaveLength(0);
    }
    const h = harness(); expect((await executeUiVerification('ui.card_clarity', {}, { teamId: 'team-test' }, h.deps)).inputFingerprint).toBeNull();
  });
  it('cannot report an authoritative model pass when ledger persistence fails', async () => {
    const h = harness(); h.deps.record = async () => { throw new Error('offline'); };
    expect((await executeUiVerification('ui.card_clarity', surface(), { teamId: 'team-test' }, h.deps)).result.verdict).toBe('inconclusive');
  });
});

