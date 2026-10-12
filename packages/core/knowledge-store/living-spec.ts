import type { EdgeUpsert, EntityUpsert, UpsertChunk } from './types';
import { fileToChunks } from './ingest';

/**
 * Approved Living Specs in the knowledge store (corpus `spec`, per workspace).
 *
 * A spec lives in the database, not the repo, so the repo ingest never sees it.
 * When a person approves a revision, its body is chunked here and written under
 * one id prefix per spec, replacing whatever an earlier approval wrote: there is
 * only ever one approved text of a spec in recall. Drafts are never indexed.
 *
 * Chunks carry no source path on purpose. A full repo ingest prunes every path
 * in the `spec` namespace it did not see on disk, and these are not repo files.
 *
 * The graph is derived only from what the spec states explicitly: its parent,
 * the repo specs a revision cites at a commit, and the approval it replaces.
 * Nothing is inferred and no agent-supplied relation is accepted. It is rebuilt
 * from scratch on each approval, so it can always be regenerated.
 */

export const LIVING_SPEC_SOURCE_TYPE = 'living_spec';
/** Every edge written here carries a rule under this prefix, so a rebuild can find its own. */
export const LIVING_SPEC_RULE_PREFIX = 'living_spec:';

/** All of a spec's chunk ids start with this. */
export function livingSpecChunkPrefix(specId: string): string {
  return `living-spec:${specId}`;
}

export function livingSpecRevisionKey(specId: string, revision: number): string {
  return `${specId}@${revision}`;
}

export interface LivingSpecChunkInput {
  specId: string;
  workspaceId: string;
  title: string;
  /** The approved revision's body, exactly. */
  body: string;
  revision: number;
  contentHash: string;
  parentSpecId: string | null;
  scope: string;
  approvedAt: Date;
  sourceUrl: string;
}

/** The approved body as chunks, split at headings with the docs chunker. */
export async function buildLivingSpecChunks(input: LivingSpecChunkInput): Promise<UpsertChunk[]> {
  if (!input.body.trim()) return [];
  const prefix = livingSpecChunkPrefix(input.specId);
  // The path only selects the markdown chunker; it never reaches a stored row.
  const pieces = await fileToChunks({ path: `${prefix}.md`, content: input.body }, 'spec');
  return pieces.map((p) => {
    const meta = p.metadata ?? {};
    const headingPath = Array.isArray(meta.headingPath) ? (meta.headingPath as string[]) : [];
    return {
      id: `${prefix}#${meta.startLine as number}`,
      content: p.content,
      lexicalText: `${input.title}${headingPath.length ? `\n${headingPath.join(' > ')}` : ''}\n\n${p.content}`,
      sourceType: LIVING_SPEC_SOURCE_TYPE,
      sourcePath: null,
      sourceUrl: input.sourceUrl,
      sourceTs: input.approvedAt,
      metadata: {
        ...meta,
        title: input.title,
        specId: input.specId,
        revision: input.revision,
        contentHash: input.contentHash,
        parentSpecId: input.parentSpecId,
        scope: input.scope,
        workspaceId: input.workspaceId,
        approvedAt: input.approvedAt.toISOString(),
      },
    } satisfies UpsertChunk;
  });
}

export interface LivingSpecGraphInput {
  workspaceId: string;
  specId: string;
  title: string;
  revision: number;
  parent: { specId: string; title: string } | null;
  repoRefs: ReadonlyArray<{ path: string; commitSha: string }>;
  /** The revision this approval replaces, if one was approved before. */
  previousApprovedRevision: number | null;
}

export interface LivingSpecGraph {
  entities: EntityUpsert[];
  edges: EdgeUpsert[];
  /** The entities this spec's chunks are linked to (the spec defines, the revision is referenced). */
  chunkLinks: Array<{ kind: 'spec' | 'spec_revision'; key: string; role: 'defines' | 'references' }>;
}

const basename = (p: string) => p.split('/').pop() ?? p;

/** The spec's explicit references as entities and edges. Pure. */
export function buildLivingSpecGraph(input: LivingSpecGraphInput): LivingSpecGraph {
  const { workspaceId, specId, revision } = input;
  const revKey = livingSpecRevisionKey(specId, revision);
  const entities: EntityUpsert[] = [
    { workspaceId, kind: 'spec', key: specId, canonicalName: input.title },
    {
      workspaceId, kind: 'spec_revision', key: revKey, canonicalName: `${input.title} (revision ${revision})`,
      attributes: { specId, revision, repoRefs: input.repoRefs.map(r => ({ path: r.path, commitSha: r.commitSha })) },
    },
  ];
  const edges: EdgeUpsert[] = [];

  if (input.parent) {
    entities.push({ workspaceId, kind: 'spec', key: input.parent.specId, canonicalName: input.parent.title });
    edges.push({
      workspaceId, fromEntityKind: 'spec', fromEntityKey: specId, toEntityKind: 'spec', toEntityKey: input.parent.specId,
      type: 'part_of', weight: 0.9, rule: `${LIVING_SPEC_RULE_PREFIX}parent`,
    });
  }

  const seen = new Set<string>();
  for (const ref of input.repoRefs) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    // Same entity the repo ingest makes for that file: kind file, key = repo path.
    entities.push({ workspaceId, kind: 'file', key: ref.path, canonicalName: basename(ref.path) });
    edges.push({
      workspaceId, fromEntityKind: 'spec_revision', fromEntityKey: revKey, toEntityKind: 'file', toEntityKey: ref.path,
      type: 'references_doc', weight: 0.6, rule: `${LIVING_SPEC_RULE_PREFIX}repo_ref`,
    });
  }

  if (input.previousApprovedRevision !== null && input.previousApprovedRevision !== revision) {
    const prevKey = livingSpecRevisionKey(specId, input.previousApprovedRevision);
    entities.push({
      workspaceId, kind: 'spec_revision', key: prevKey,
      canonicalName: `${input.title} (revision ${input.previousApprovedRevision})`,
      attributes: { specId, revision: input.previousApprovedRevision },
    });
    edges.push({
      workspaceId, fromEntityKind: 'spec_revision', fromEntityKey: revKey, toEntityKind: 'spec_revision', toEntityKey: prevKey,
      type: 'supersedes', weight: 1.0, rule: `${LIVING_SPEC_RULE_PREFIX}supersedes`,
    });
  }

  return {
    entities,
    edges,
    chunkLinks: [
      { kind: 'spec', key: specId, role: 'defines' },
      { kind: 'spec_revision', key: revKey, role: 'references' },
    ],
  };
}
