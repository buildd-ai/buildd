import { describe, expect, it } from 'bun:test';
import { evaluatePrScope, scopeRefusalMessage, type ScopeCommit } from './pr-scope';

const CLAIMED = new Date('2026-10-20T12:00:00Z');
const c = (sha: string, authoredAt: string, o: Partial<ScopeCommit> = {}): ScopeCommit => ({ sha, message: `msg ${sha}`, authoredAt, parents: 1, ...o });

describe('evaluatePrScope', () => {
  it('flags non-merge commits authored before the task was claimed', () => {
    const v = evaluatePrScope([c('aaa1111', '2026-10-01T00:00:00Z'), c('bbb2222', '2026-10-20T13:00:00Z')], CLAIMED);
    expect(v.foreign.map(x => x.sha)).toEqual(['aaa1111']);
    expect(v.ok).toBe(false);
  });
  it('lets the task\'s own commits and merges of the base through', () => {
    const v = evaluatePrScope([c('own', '2026-10-20T12:30:00Z'), c('mrg', '2026-10-01T00:00:00Z', { parents: 2 })], CLAIMED);
    expect(v.ok).toBe(true);
  });
  it('fails open without a claim time or commit date', () => {
    expect(evaluatePrScope([c('a', '2026-01-01T00:00:00Z')], null).ok).toBe(true);
    expect(evaluatePrScope([c('a', 'not a date')], CLAIMED).ok).toBe(true);
  });
});

describe('scopeRefusalMessage', () => {
  it('names the commits and both fixes, capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`sha${String(i).padStart(4, '0')}xyz`, '2026-10-01T00:00:00Z'));
    const m = scopeRefusalMessage(many, 'mission/x', 'codex/personal');
    expect(m).toContain('sha0000');
    expect(m).toContain('and 4 more');
    expect(m).toContain('fresh branch');
    expect(m).toContain('scopeOverride');
  });
});
