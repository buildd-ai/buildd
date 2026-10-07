import { describe, it, expect, mock } from 'bun:test';

let verdict: any = { ok: true, missing: [] };
const mockLoad = mock(async (_o: unknown) => verdict);
mock.module('@/lib/visual-audit-evidence', () => ({
  loadVisualAuditEvidence: mockLoad,
  formatVisualEvidenceRejection: (v: any) => `missing: ${v.missing.join(', ')}`,
}));

const { visualAuditEvidencePolicy } = await import('./visual-audit-evidence-policy');
const input = { workerId: 'w-1', taskId: 't-1', missionId: 'm-1', workspaceId: 'ws-1', roleSlug: 'visual-auditor', workerStartedAt: null };

describe('visual audit evidence policy', () => {
  it('has nothing to judge for any other role, and loads nothing', async () => {
    expect(await visualAuditEvidencePolicy({ ...input, roleSlug: 'builder' })).toBeNull();
    expect(await visualAuditEvidencePolicy({ ...input, roleSlug: null })).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('passes an audit with full evidence', async () => {
    verdict = { ok: true, missing: [] };
    expect(await visualAuditEvidencePolicy(input)).toEqual({ kind: 'pass' });
    expect(mockLoad).toHaveBeenCalledWith({ workerId: 'w-1', taskId: 't-1', missionId: 'm-1', workspaceId: 'ws-1', workerStartedAt: null });
  });

  it('fails an audit missing evidence, naming what is missing', async () => {
    verdict = { ok: false, missing: ['/app @ mobile'] };
    expect(await visualAuditEvidencePolicy(input)).toEqual({ kind: 'fail', reason: 'missing: /app @ mobile', hint: 'visual_evidence' });
  });
});
