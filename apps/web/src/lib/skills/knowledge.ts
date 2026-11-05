import { after } from 'next/server';
import type { KnowledgeStore } from '@buildd/core/knowledge-store';

/**
 * Skills in the knowledge store's `skill` corpus (`{workspaceId}:skill`,
 * packages/core/knowledge-store/skills.ts). One chunk per enabled
 * team/workspace skill; never a personal/private role. Mirrors
 * `indexApprovedSpec` (lib/specs/knowledge.ts): delete by source prefix, then
 * upsert, fail-open and off the response. A skill write has already happened
 * when this runs, so nothing here throws; a failure is logged and returned.
 */

type Store = Pick<KnowledgeStore, 'upsert' | 'query'> & Partial<Pick<KnowledgeStore, 'deleteBySource'>>;

export const skillKnowledgeDeps: {
  store: () => Promise<Store>;
  /** The embedded-text hash already stored for a skill, or null. */
  storedHash: (namespace: string, sourceId: string) => Promise<string | null>;
  afterResponse: (task: () => Promise<unknown>) => void;
} = {
  async store() {
    const { PgVectorStore, getVoyageEmbedder } = await import('@buildd/core/knowledge-store');
    return new PgVectorStore(getVoyageEmbedder());
  },
  async storedHash(namespace, sourceId) {
    const { db } = await import('@buildd/core/db');
    const { sql } = await import('drizzle-orm');
    const res = await db.execute(sql`
      SELECT metadata->>'skillHash' AS h FROM knowledge_chunks
      WHERE namespace = ${namespace} AND source_id = ${sourceId} AND is_current = true LIMIT 1`);
    return ((res as unknown as { rows?: Array<{ h: string | null }> }).rows?.[0]?.h) ?? null;
  },
  afterResponse: (task) => {
    const run = () => task().catch(() => {});
    try { after(run); } catch { void run(); }
  },
};

export interface SkillIndexRow {
  id: string;
  workspaceId: string | null;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  enabled: boolean;
  visibility?: string | null;
  ownerUserId?: string | null;
}

export interface SkillKnowledgeResult {
  indexed: boolean;
  hash?: string;
  skipped?: 'no_workspace' | 'not_indexable' | 'unchanged';
  errors: string[];
}

/**
 * Bring one skill's chunk to its current state. Disabled skills drop their
 * chunk; personal/private roles are never touched; an unchanged embedded text
 * (hash) is not re-embedded.
 */
export async function indexSkill(skill: SkillIndexRow): Promise<SkillKnowledgeResult> {
  const out: SkillKnowledgeResult = { indexed: false, errors: [] };
  if (!skill.workspaceId) return { ...out, skipped: 'no_workspace' };
  try {
    const ks = await import('@buildd/core/knowledge-store');
    if (skill.visibility === 'private' || skill.ownerUserId) return { ...out, skipped: 'not_indexable' };
    const namespace = ks.buildNamespace(skill.workspaceId, 'skill');
    const sourceId = ks.skillSourceId(skill.id);
    const chunk = ks.buildSkillChunk(skill);
    const store = await skillKnowledgeDeps.store();
    if (!chunk) {
      await store.deleteBySource?.(namespace, { sourceIdPrefix: sourceId });
      return out;
    }
    const hash = chunk.metadata!.skillHash as string;
    out.hash = hash;
    if ((await skillKnowledgeDeps.storedHash(namespace, sourceId)) === hash) return { ...out, skipped: 'unchanged' };
    await store.deleteBySource?.(namespace, { sourceIdPrefix: sourceId });
    await store.upsert(namespace, [chunk]);
    out.indexed = true;
  } catch (err) {
    out.errors.push((err as Error).message);
    console.error(`[skills] knowledge index for skill ${skill.id} failed: ${(err as Error).message}`);
  }
  return out;
}

/** Drop a deleted skill's chunk. Fail-open. */
export async function removeSkillChunk(workspaceId: string, skillId: string): Promise<{ errors: string[] }> {
  const out = { errors: [] as string[] };
  try {
    const ks = await import('@buildd/core/knowledge-store');
    const store = await skillKnowledgeDeps.store();
    await store.deleteBySource?.(ks.buildNamespace(workspaceId, 'skill'), { sourceIdPrefix: ks.skillSourceId(skillId) });
  } catch (err) {
    out.errors.push((err as Error).message);
    console.error(`[skills] knowledge removal for skill ${skillId} failed: ${(err as Error).message}`);
  }
  return out;
}

/** After a create/update/enable toggle: index once the response is out. */
export function scheduleSkillIndex(skill: SkillIndexRow): void {
  skillKnowledgeDeps.afterResponse(() => indexSkill(skill));
}

/** After a delete: drop the chunk once the response is out. */
export function scheduleSkillRemoval(workspaceId: string, skillId: string): void {
  skillKnowledgeDeps.afterResponse(() => removeSkillChunk(workspaceId, skillId));
}
