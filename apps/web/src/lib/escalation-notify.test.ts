import { describe, expect, it } from 'bun:test';
import { mayPageEscalation, verdictsAllowPage } from './escalation-notify';

const buildd = { owner: 'buildd' as const, by: 'rule' as const, action: 'ci_fix' as const, reason: 'fixing' };
const person = { owner: 'person' as const, by: 'rule' as const, rail: 'protected_path' as const, reason: 'protected' };

describe('escalation pushes follow the gate', () => {
  it('a PR Buildd owns does not page', () => {
    expect(verdictsAllowPage([buildd])).toBe(false);
  });

  it('a person-owned PR pages', () => {
    expect(verdictsAllowPage([person])).toBe(true);
    expect(verdictsAllowPage([buildd, person])).toBe(true);
  });

  it('no verdict pages exactly as before', () => {
    expect(verdictsAllowPage([])).toBe(true);
  });

  it('a failed read pages', async () => {
    expect(await mayPageEscalation({ workspaceId: 'ws', prNumber: 1 }, { loadVerdicts: async () => { throw new Error('down'); } })).toBe(true);
  });

  it('reads the verdicts for this PR', async () => {
    const seen: unknown[] = [];
    expect(await mayPageEscalation({ workspaceId: 'ws', prNumber: 4 }, { loadVerdicts: async (ws, n) => { seen.push([ws, n]); return [buildd]; } })).toBe(false);
    expect(seen).toEqual([['ws', 4]]);
  });
});
