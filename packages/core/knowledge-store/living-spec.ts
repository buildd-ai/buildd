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

/** One criterion of a revision: `<specId>@<revision>#<criterionId>`. */
export function livingSpecCriterionKey(specId: string, revision: number, criterionId: string): string {
  return `${livingSpecRevisionKey(specId, revision)}#${criterionId}`;
}

/**
 * Rules for edges derived from data buildd holds (living-specs.md §14, D-12):
 * labelled as derived, under the same prefix so each approval's rebuild drops
 * and rewrites them with the stored ones.
 */
export const LIVING_SPEC_DERIVED_RULE_PREFIX = `${LIVING_SPEC_RULE_PREFIX}derived:`;

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
  /**
   * Derived, exact (D-12, §14). All optional: an input without them builds
   * the stored graph only.
   */
  derived?: {
    /** The approved revision's criteria. */
    criteria?: ReadonlyArray<{ id: string; text: string }>;
    /** Tasks pinned to this revision and the criteria each answers for (its scope, else all). */
    tasks?: ReadonlyArray<{ taskId: string; title: string; criteria: readonly string[]; verified: ReadonlyArray<{ criterionId: string; headSha: string }> }>;
    /** The revision's design, when it names one. */
    design?: { kind: string; ref: string; version: string } | null;
    /** Files the spec's work changed, and where the list came from. */
    implementedIn?: { files: readonly string[]; source: 'pr_files' | 'path_manifest' };
    /** Neighbour specs, one edge each at the strongest kind's score. */
    neighbours?: ReadonlyArray<{ specId: string; title: string; score: number }>;
  };
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

  const d = input.derived;
  if (d) {
    const rule = (name: string) => `${LIVING_SPEC_DERIVED_RULE_PREFIX}${name}`;
    const criterionIds = new Set((d.criteria ?? []).map((c) => c.id));
    const verifiedBy = new Map<string, Array<{ taskId: string; headSha: string }>>();
    for (const t of d.tasks ?? []) for (const v of t.verified) {
      if (!criterionIds.has(v.criterionId)) continue;
      verifiedBy.set(v.criterionId, [...(verifiedBy.get(v.criterionId) ?? []), { taskId: t.taskId, headSha: v.headSha }]);
    }
    for (const c of d.criteria ?? []) {
      const key = livingSpecCriterionKey(specId, revision, c.id);
      entities.push({ workspaceId, kind: 'spec_criterion', key, canonicalName: `${c.id}: ${c.text}`.slice(0, 300),
        attributes: { specId, revision, criterionId: c.id, verified: verifiedBy.get(c.id) ?? [] } });
      edges.push({ workspaceId, fromEntityKind: 'spec_criterion', fromEntityKey: key, toEntityKind: 'spec_revision', toEntityKey: revKey,
        type: 'part_of', weight: 1.0, rule: rule('criterion') });
    }
    for (const t of d.tasks ?? []) {
      entities.push({ workspaceId, kind: 'task', key: t.taskId, canonicalName: t.title });
      for (const id of t.criteria) {
        if (!criterionIds.has(id)) continue;
        const key = livingSpecCriterionKey(specId, revision, id);
        edges.push({ workspaceId, fromEntityKind: 'spec_criterion', fromEntityKey: key, toEntityKind: 'task', toEntityKey: t.taskId,
          type: 'relates_to', weight: 0.8, rule: rule('answers_for') });
        if (t.verified.some((v) => v.criterionId === id)) {
          edges.push({ workspaceId, fromEntityKind: 'spec_criterion', fromEntityKey: key, toEntityKind: 'task', toEntityKey: t.taskId,
            type: 'outcome_of', weight: 1.0, rule: rule('verified') });
        }
      }
    }
    if (d.design?.kind === 'artifact') {
      entities.push({ workspaceId, kind: 'artifact', key: d.design.ref, canonicalName: `design (revision ${d.design.version})`,
        attributes: { designVersion: d.design.version } });
      edges.push({ workspaceId, fromEntityKind: 'spec_revision', fromEntityKey: revKey, toEntityKind: 'artifact', toEntityKey: d.design.ref,
        type: 'references', weight: 0.8, rule: rule('built_to') });
    }
    const implemented = new Set<string>();
    for (const path of d.implementedIn?.files ?? []) {
      if (implemented.has(path)) continue;
      implemented.add(path);
      entities.push({ workspaceId, kind: 'file', key: path, canonicalName: basename(path) });
      edges.push({ workspaceId, fromEntityKind: 'spec', fromEntityKey: specId, toEntityKind: 'file', toEntityKey: path,
        type: 'references', weight: d.implementedIn!.source === 'pr_files' ? 0.7 : 0.4, rule: rule(`implemented_in:${d.implementedIn!.source}`) });
    }
    for (const n of d.neighbours ?? []) {
      if (n.specId === specId) continue;
      entities.push({ workspaceId, kind: 'spec', key: n.specId, canonicalName: n.title });
      edges.push({ workspaceId, fromEntityKind: 'spec', fromEntityKey: specId, toEntityKind: 'spec', toEntityKey: n.specId,
        type: 'relates_to', weight: Math.max(0, Math.min(1, n.score)), rule: rule('neighbour') });
    }
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
