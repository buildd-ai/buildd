import { describe, it, expect } from 'bun:test';
import {
  rankSkillSpecSuggestions, proposeLinkRetirements, assertPersonCaller, SkillSpecLinkRefusedError,
} from '../skill-spec-links';

const now = new Date('2026-11-06T00:00:00Z');

describe('rankSkillSpecSuggestions', () => {
  it('ranks observed path overlap above any embedding score and keeps score and matched text', () => {
    const out = rankSkillSpecSuggestions({
      similar: [{ specId: 'a', score: 0.99, matchedText: 'AC-1 reads alike' }],
      pathOverlap: [{ specId: 'b', sharedPaths: ['apps/web/x.ts'], taskCount: 2 }],
    });
    expect(out.map(s => s.specId)).toEqual(['b', 'a']);
    expect(out[0]).toMatchObject({ basis: 'observed_path_overlap', matchedText: 'apps/web/x.ts' });
    expect(out[1]).toMatchObject({ basis: 'similarity', score: 0.99, matchedText: 'AC-1 reads alike' });
  });
  it('merges a spec found both ways under the observed basis', () => {
    const out = rankSkillSpecSuggestions({
      similar: [{ specId: 'a', score: 0.6, matchedText: 't' }],
      pathOverlap: [{ specId: 'a', sharedPaths: ['p'], taskCount: 1 }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.basis).toBe('observed_path_overlap');
  });
});

describe('proposeLinkRetirements', () => {
  const skill = { id: 's1', teamId: 't1', enabled: true, contentHash: 'h' };
  it('unconfirmed suggestion produces no proposal (no links, nothing proposed)', () => {
    expect(proposeLinkRetirements({ links: [], specs: [{ id: 'sp', status: 'retired' }], skills: [skill], now })).toEqual([]);
  });
  it('confirmed link to a retired or superseded spec yields a proposal event only', () => {
    for (const status of ['retired', 'superseded'] as const) {
      const out = proposeLinkRetirements({
        links: [{ skillId: 's1', specId: 'sp' }], specs: [{ id: 'sp', status }], skills: [skill], now,
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ skillId: 's1', action: 'retirement_proposed', mode: 'recording', previousEnabled: true });
    }
  });
  it('ignores live specs and already-disabled skills', () => {
    expect(proposeLinkRetirements({
      links: [{ skillId: 's1', specId: 'sp' }], specs: [{ id: 'sp', status: 'approved' }], skills: [skill], now,
    })).toEqual([]);
    expect(proposeLinkRetirements({
      links: [{ skillId: 's1', specId: 'sp' }], specs: [{ id: 'sp', status: 'retired' }], skills: [{ ...skill, enabled: false }], now,
    })).toEqual([]);
  });
});

describe('assertPersonCaller', () => {
  it('lets a session user through and refuses agents', () => {
    expect(() => assertPersonCaller('session')).not.toThrow();
    for (const t of ['api', 'worker', 'dev-agent'] as const) {
      expect(() => assertPersonCaller(t as any)).toThrow(SkillSpecLinkRefusedError);
    }
  });
});
