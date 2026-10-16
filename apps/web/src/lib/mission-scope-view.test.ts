import { describe, expect, it } from 'bun:test';
import { describeScopeUpdates } from './mission-scope-view';

const titles: Record<string, string> = { a: 'Add Apple Pay', b: 'Drop the slow test gate', c: 'Fix rounding' };
const row = (sourceTaskId: string, status: string, scopeVersionAfter: number | null, createdAt: string) =>
  ({ sourceTaskId, decision: status === 'held' ? 'ask' : status === 'applied' ? 'amend_scope' : 'in_scope', status, scopeVersionAfter, createdAt });

describe('describeScopeUpdates (scenario 8: a compact, auditable "scope updated" event)', () => {
  it('names amendments and holds in words, newest first; in-scope decisions say nothing', () => {
    const lines = describeScopeUpdates([
      row('c', 'recorded', null, '2026-10-14T09:00:00Z'),
      row('a', 'applied', 2, '2026-10-14T10:00:00Z'),
      row('b', 'held', null, '2026-10-14T11:00:00Z'),
    ], (id) => titles[id] ?? null);
    expect(lines.map((l) => l.text)).toEqual([
      '"Drop the slow test gate" is on hold until you decide whether it changes what this mission delivers.',
      'Scope updated to version 2 when "Add Apple Pay" was added.',
    ]);
    expect(lines.map((l) => l.needsDecision)).toEqual([true, false]);
    for (const l of lines) expect(l.text).not.toMatch(/needs you|NEEDS|AMEND|IN_SCOPE/i);
  });

  it('shows at most three', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row('a', 'applied', n + 1, `2026-10-14T1${n}:00:00Z`));
    expect(describeScopeUpdates(rows, () => 'T')).toHaveLength(3);
  });
});
