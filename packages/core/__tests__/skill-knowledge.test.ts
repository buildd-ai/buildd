import { describe, it, expect } from 'bun:test';
import {
  buildSkillChunk, isIndexableSkill, skillChunkHash, skillChunkText, findSimilarSkills, quoteSkillText,
  SKILL_EXCERPT_CHARS,
} from '../knowledge-store/skills';
import { ALL_CORPORA } from '../knowledge-store/health';
import { getVoyageEmbedderForCorpus } from '../knowledge-store/voyage-embedder';
import { CORPORA } from '../mcp-tools';

const skill = { id: 'sk1', slug: 's', name: 'Ship it', description: 'How to ship', content: 'body', enabled: true };

describe('skill chunk', () => {
  it('is one bounded chunk with name, description, excerpt', () => {
    const c = buildSkillChunk({ ...skill, content: 'x'.repeat(SKILL_EXCERPT_CHARS * 3) })!;
    expect(c.id).toBe('skill:sk1');
    expect(c.content.startsWith('Ship it\n\nHow to ship\n\n')).toBe(true);
    expect(c.content.length).toBeLessThan(SKILL_EXCERPT_CHARS + 100);
  });
  it('is null for disabled, private, and owned skills', () => {
    expect(buildSkillChunk({ ...skill, enabled: false })).toBeNull();
    expect(isIndexableSkill({ enabled: true, visibility: 'private' })).toBe(false);
    expect(isIndexableSkill({ enabled: true, ownerUserId: 'u' })).toBe(false);
  });
  it('hash changes with the embedded text only', () => {
    expect(skillChunkHash(skill)).toBe(skillChunkHash({ ...skill }));
    expect(skillChunkHash(skill)).not.toBe(skillChunkHash({ ...skill, description: 'other' }));
    expect(skillChunkText(skill)).toContain('body');
  });
  it('quotes text', () => expect(quoteSkillText('a\nb')).toBe('> a\n> b'));
});

describe('corpus wiring', () => {
  it('skill is a health corpus and opt-in for recall', () => {
    expect(ALL_CORPORA).toContain('skill');
    expect((CORPORA as readonly string[]).includes('skill')).toBe(true);
  });
  it('skill shares the spec embedder model', () => {
    process.env.VOYAGE_API_KEY = 'k';
    const a = getVoyageEmbedderForCorpus('skill') as any;
    const b = getVoyageEmbedderForCorpus('spec') as any;
    expect(a.model ?? a['model']).toBe(b.model ?? b['model']);
  });
});

describe('findSimilarSkills', () => {
  it('returns raw scores and matched names, with no verdict or floor', async () => {
    const store = { nearDupeCheck: async () => [
      { id: 'skill:a', similarity: 0.31, content: 'Alpha\n\ndesc', sourceUrl: null },
      { id: 'skill:b', similarity: 0.95, content: 'Beta\n\ndesc', sourceUrl: null },
    ] };
    const r = await findSimilarSkills('ws', 'text', { store });
    expect(r).toEqual([
      { skillId: 'a', name: 'Alpha', score: 0.31, sourceUrl: null },
      { skillId: 'b', name: 'Beta', score: 0.95, sourceUrl: null },
    ]);
  });
});
