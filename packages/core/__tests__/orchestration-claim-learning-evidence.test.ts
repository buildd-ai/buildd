import { describe, expect, it } from 'bun:test';
import { attributeClaimOutcome, claimAreaClass, claimReceipt } from '../orchestration-claim-learning-evidence';
const decision = { id: 'd', taskId: 'task', workspaceId: 'workspace', createdAt: new Date(0), prNumber: null, headSha: null, baseRef: null };
const label: any = { decisionId: 'd', risk: { status: 'observed', value: true }, collision: { status: 'observed', value: true }, conflictCreated: { status: 'observed', value: false }, mergeBaseRefusal: { status: 'observed', value: false }, touched: { status: 'observed', value: { landed: true } } };
const receipt = { paths: ['src/shared.ts'], blockerTaskIds: ['holder'], staleBlocker: false };
const event = (detail: any) => ({ taskId: 'task', workspaceId: 'workspace', occurredAt: new Date(1), gate: 'path_claim', outcome: 'deferred', detail });
describe('claim outcome attribution', () => {
  it('requires matching path or counterparty for edit collision', () => {
    expect(attributeClaimOutcome(decision, receipt, label, [event({ blockingTaskId: 'holder' })])).toBe(true);
    expect(attributeClaimOutcome(decision, receipt, label, [event({ blockingTaskId: 'stranger', path: 'src/other.ts' })])).toBe(false);
    expect(attributeClaimOutcome(decision, receipt, label, [event({})])).toBeNull();
  });
  it('never guesses missing conflict-file attribution or unlanded safety', () => {
    expect(attributeClaimOutcome(decision, receipt, { ...label, conflictCreated: { status: 'observed', value: true } }, [event({ blockingTaskId: 'stranger', path: 'src/other.ts' })])).toBeNull();
    const clean = { ...label, risk: { status: 'observed', value: false }, collision: { status: 'observed', value: false } };
    expect(attributeClaimOutcome(decision, receipt, clean, [])).toBe(false);
    expect(attributeClaimOutcome(decision, receipt, { ...clean, touched: { status: 'observed', value: { landed: false } } }, [])).toBeNull();
  });
  it('reads stale ownership from human receipts and classifies declared area', () => {
    expect(claimReceipt({ blockers: [{ blockers: [{ id: 'holder', stale: true }], overlap: { paths: ['packages/core/db/schema.ts'] } }] }).staleBlocker).toBe(true);
    expect(claimAreaClass(['packages/core/db/schema.ts'])).toBe('core/db');
    expect(claimAreaClass([])).toBe('unknown');
    expect(claimAreaClass(['**'])).toBe('unknown');
    expect(claimReceipt({ blockers: [{ type: 'task', id: 'holder', sharedPaths: ['src/shared.ts'], stale: true }] })).toEqual({ paths: ['src/shared.ts'], blockerTaskIds: ['holder'], staleBlocker: true });
    expect(claimReceipt({ paths: ['src/shared.ts'], holderTaskId: 'holder' }).blockerTaskIds).toEqual(['holder']);
  });
});
