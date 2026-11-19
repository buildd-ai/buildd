import { createHash } from 'crypto';
import type { KnowledgeStore, UpsertChunk } from './types';

/**
 * Skills in the knowledge store (corpus `skill`, namespace `{workspaceId}:skill`).
 *
 * One chunk per enabled team/workspace skill: name + description + a bounded
 * excerpt of the body, never the whole instruction text (skill text is what
 * workers are told to obey, so it is kept small and always rendered as quoted
 * data). Personal roles (`visibility: private` or an `ownerUserId` that is not
 * shared) are never indexed. The corpus is opt-in for recall: it is not in the
 * default scope list.
 */

export const SKILL_SOURCE_TYPE = 'skill';
/** Bound on the body excerpt in a skill chunk. */
export const SKILL_EXCERPT_CHARS = 1200;

export function skillSourceId(skillId: string): string {
  return `skill:${skillId}`;
}

export interface SkillIndexInput {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  enabled: boolean;
  visibility?: string | null;
  ownerUserId?: string | null;
}

/** A skill belongs in a shared namespace only when it is enabled and not personal/private. */
export function isIndexableSkill(s: Pick<SkillIndexInput, 'enabled' | 'visibility' | 'ownerUserId'>): boolean {
  if (!s.enabled) return false;
  if (s.visibility === 'private') return false;
  if (s.ownerUserId) return false;
  return true;
}

/** The text that is embedded: name, description, and a bounded excerpt. */
export function skillChunkText(s: Pick<SkillIndexInput, 'name' | 'description' | 'content'>): string {
  const parts = [s.name.trim()];
  if (s.description?.trim()) parts.push(s.description.trim());
  const excerpt = s.content.trim().slice(0, SKILL_EXCERPT_CHARS);
  if (excerpt) parts.push(excerpt);
  return parts.join('\n\n');
}

/** Hash of exactly what is embedded; the gate that skips an unchanged skill. */
export function skillChunkHash(s: Pick<SkillIndexInput, 'name' | 'description' | 'content'>): string {
  return createHash('sha256').update(skillChunkText(s)).digest('hex');
}

/** The chunk for a skill, or null when it must not be indexed. */
export function buildSkillChunk(s: SkillIndexInput): UpsertChunk | null {
  if (!isIndexableSkill(s)) return null;
  return {
    id: skillSourceId(s.id),
    content: skillChunkText(s),
    sourceType: SKILL_SOURCE_TYPE,
    metadata: { skillId: s.id, slug: s.slug, name: s.name, skillHash: skillChunkHash(s) },
  };
}

/** Render a matched skill's text as quoted data for any prompt that compares skills. */
export function quoteSkillText(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

export interface SimilarSkill {
  skillId: string;
  name: string;
  /** Raw cosine similarity. No threshold is applied: callers decide, and must calibrate. */
  score: number;
  sourceUrl: string | null;
}

type DupeStore = Pick<KnowledgeStore, 'nearDupeCheck'>;

/**
 * Enabled skills most like `text`, with raw cosine scores and the matched
 * name. Makes no decision: no floor, no verdict. The memory dedupe floor does
 * not apply to skill paraphrases.
 */
export async function findSimilarSkills(
  workspaceId: string,
  text: string,
  opts: { topK?: number; store?: DupeStore } = {},
): Promise<SimilarSkill[]> {
  const store: DupeStore = opts.store ?? new (await import('./pg-vector-store')).PgVectorStore((await import('./voyage-embedder')).getVoyageEmbedder());
  if (!store.nearDupeCheck) return [];
  const { buildNamespace } = await import('./pg-vector-store');
  const hits = await store.nearDupeCheck(buildNamespace(workspaceId, 'skill'), text, opts.topK ?? 5);
  return hits.map((h) => {
    const first = h.content.split('\n', 1)[0] ?? '';
    return { skillId: h.id.replace(/^skill:/, ''), name: first, score: h.similarity, sourceUrl: h.sourceUrl };
  });
}
