import type { EdgeUpsert, EntityUpsert, QueryResult, UpsertChunk } from './types';
import { outlineOf } from '../artifact-read';
import { specCriteria } from '@buildd/spec-contract/requirements';

/**
 * Living Specs in the knowledge store (corpus `spec`, per workspace).
 *
 * A spec lives in the database, not the repo, so the repo ingest never sees it.
 * When a person approves a revision, its body is chunked here and written under
 * one id prefix per spec, replacing whatever an earlier approval wrote: there is
 * only ever one approved text of a spec in recall.
 *
 * Each revision is indexed as its whole text, one chunk per section and one per
 * criterion (R-102), each id `<prefix>@<revision>#<key>`, so `similar` and the
 * duplicate check can say which criterion matched which. A draft head (R-106)
 * is indexed too, under its own prefix and source type, and every query leaves
 * it out unless it asks for drafts (`includeDrafts`): recall never shows one.
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
/** A draft revision's chunks: found only by a query that asks for drafts. */
export const LIVING_SPEC_DRAFT_SOURCE_TYPE = 'living_spec_draft';
/** Every edge written here carries a rule under this prefix, so a rebuild can find its own. */
export const LIVING_SPEC_RULE_PREFIX = 'living_spec:';

/** All of a spec's approved chunk ids start with this. */
export function livingSpecChunkPrefix(specId: string): string {
  return `living-spec:${specId}`;
}

/** All of a spec's draft chunk ids start with this (never under the approved prefix). */
export function livingSpecDraftChunkPrefix(specId: string): string {
  return `living-spec-draft:${specId}`;
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

/** The whole text is cut here: one embedding input, well under the model's limit. */
export const LIVING_SPEC_TEXT_MAX_CHARS = 32_000;
const SECTION_MAX_CHARS = 8_000;

export type LivingSpecPieceKind = 'text' | 'section' | 'criterion';

/** One indexed piece of a spec body, before it is a stored chunk. */
export interface LivingSpecPiece {
  /** `text`, a section's outline id (`s3`) or a criterion id (`AC-4`). */
  key: string;
  kind: LivingSpecPieceKind;
  content: string;
  criterionId?: string;
  /** The section the piece sits in (a section: itself). */
  section?: { id: string; title: string } | null;
  headingPath: string[];
}

/**
 * A body as the pieces the spec corpus holds: the whole text, each section's
 * own text (to the next heading of any level, so a parent does not repeat its
 * children), and each criterion (R-n, AC-n) on its own. A section that is only
 * its heading, or that is the whole text, is left out. Pure.
 */
export function livingSpecPieces(body: string): LivingSpecPiece[] {
  if (!body.trim()) return [];
  const whole = body.trim();
  const out: LivingSpecPiece[] = [{ key: 'text', kind: 'text', content: whole.slice(0, LIVING_SPEC_TEXT_MAX_CHARS), section: null, headingPath: [] }];
  const outline = outlineOf(body);
  const paths: string[][] = [];
  const stack: Array<{ level: number; title: string }> = [];
  outline.forEach((s, i) => {
    while (stack.length && stack[stack.length - 1]!.level >= s.level) stack.pop();
    stack.push({ level: s.level, title: s.title });
    paths.push(stack.map((h) => h.title));
    const ownEnd = outline[i + 1]?.start ?? body.length;
    const own = body.slice(s.start, ownEnd).trim();
    const afterHeading = own.split('\n').slice(1).join('\n').trim();
    if (!afterHeading || own === whole) return;
    out.push({ key: s.id, kind: 'section', content: own.slice(0, SECTION_MAX_CHARS), section: { id: s.id, title: s.title }, headingPath: paths[i]! });
  });
  const lineStarts = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStarts.push(i + 1);
  for (const c of specCriteria(body)) {
    const offset = lineStarts[c.line - 1] ?? 0;
    let at = -1;
    for (let i = 0; i < outline.length && outline[i]!.start <= offset; i++) at = i;
    const s = at >= 0 ? outline[at]! : null;
    out.push({
      key: c.id, kind: 'criterion', content: `${c.id}: ${c.text}`.slice(0, SECTION_MAX_CHARS), criterionId: c.id,
      section: s ? { id: s.id, title: s.title } : null, headingPath: at >= 0 ? paths[at]! : [],
    });
  }
  return out;
}

export interface LivingSpecChunkInput {
  specId: string;
  workspaceId: string;
  title: string;
  /** The revision's body, exactly. */
  body: string;
  revision: number;
  contentHash: string;
  parentSpecId: string | null;
  scope: string;
  /** When the revision was approved; null for a draft. */
  approvedAt: Date | null;
  /** A draft's time: when the revision was written. */
  writtenAt?: Date | null;
  /** A draft head (R-106): its own prefix and source type, so default queries leave it out. */
  draft?: boolean;
  sourceUrl: string;
}

/** A revision's body as chunks: whole text, sections and criteria, each under `<prefix>@<revision>#<key>`. */
export async function buildLivingSpecChunks(input: LivingSpecChunkInput): Promise<UpsertChunk[]> {
  const draft = input.draft === true;
  const prefix = `${draft ? livingSpecDraftChunkPrefix(input.specId) : livingSpecChunkPrefix(input.specId)}@${input.revision}#`;
  return livingSpecPieces(input.body).map((p) => ({
    id: `${prefix}${p.key}`,
    content: p.content,
    lexicalText: `${input.title}${p.headingPath.length ? `\n${p.headingPath.join(' > ')}` : ''}\n\n${p.content}`,
    sourceType: draft ? LIVING_SPEC_DRAFT_SOURCE_TYPE : LIVING_SPEC_SOURCE_TYPE,
    sourcePath: null,
    sourceUrl: input.sourceUrl,
    sourceTs: input.approvedAt ?? input.writtenAt ?? null,
    metadata: {
      title: input.title,
      specId: input.specId,
      revision: input.revision,
      contentHash: input.contentHash,
      parentSpecId: input.parentSpecId,
      scope: input.scope,
      workspaceId: input.workspaceId,
      approvedAt: input.approvedAt ? input.approvedAt.toISOString() : null,
      draft,
      chunkKind: p.kind,
      headingPath: p.headingPath,
      ...(p.criterionId ? { criterionId: p.criterionId } : {}),
      ...(p.section ? { section: p.section } : {}),
    },
  } satisfies UpsertChunk));
}

// ── Matching specs from corpus hits (R-101, R-102, R-104) ─────────────────────

/**
 * Where a corpus hit counts as similar, per retrieval mode, set here beside
 * the store: a vector hit by its cosine; a lexical rank is not a cosine, so a
 * lexical match has no floor.
 */
export const LIVING_SPEC_SIMILAR_FLOOR = { vector: 0.55, lexical: 0 } as const;

/** One probe (a piece of the asking spec) and what the spec corpus returned for it. */
export interface SpecProbeHits {
  probe: { key: string; criterionId?: string | null };
  results: readonly QueryResult[];
}

export interface SpecMatch {
  specId: string;
  /** The best hit's score: a cosine in vector mode, a capped rank in lexical mode. */
  score: number;
  mode: 'vector' | 'lexical';
  /** The matched spec's revision that was hit, and whether it is a draft. */
  revision: number | null;
  draft: boolean;
  /** Criterion pairs, best first: `here` the asking spec's, `there` the matched spec's. */
  pairs: Array<{ here: string; there: string; score: number }>;
  /** The chunks of the matched spec that were hit. */
  chunkIds: string[];
}

/** What one hit says, in the units the floor reads. Null when it is not a spec chunk or falls under the floor. */
function readHit(r: QueryResult): { specId: string; score: number; mode: 'vector' | 'lexical'; criterionId: string | null; revision: number | null; draft: boolean } | null {
  const m = r.metadata ?? {};
  if (typeof m.specId !== 'string') return null;
  const dense = r.scoreBreakdown?.dense;
  const hit = typeof dense === 'number'
    ? { score: dense, mode: 'vector' as const }
    : { score: Math.min(1, r.score), mode: 'lexical' as const };
  if (hit.score < LIVING_SPEC_SIMILAR_FLOOR[hit.mode]) return null;
  return {
    specId: m.specId, ...hit,
    criterionId: typeof m.criterionId === 'string' ? m.criterionId : null,
    revision: typeof m.revision === 'number' ? m.revision : null,
    draft: m.draft === true || r.sourceType === LIVING_SPEC_DRAFT_SOURCE_TYPE,
  };
}

const MAX_PAIRS = 5;

/**
 * Specs from the hits of every probe: one row per spec at its best score,
 * strongest first, at most `limit`. A hit where a criterion probe met a
 * criterion chunk is a pair, so the reason can name both ("AC-3 here reads
 * like R-7 there"). Pure.
 */
export function aggregateSpecMatches(probes: readonly SpecProbeHits[], opts: { limit: number; excludeSpecId?: string }): SpecMatch[] {
  const by = new Map<string, SpecMatch & { pairKeys: Map<string, number> }>();
  for (const { probe, results } of probes) {
    for (const r of results) {
      const h = readHit(r);
      if (!h || h.specId === opts.excludeSpecId) continue;
      let m = by.get(h.specId);
      if (!m) {
        m = { specId: h.specId, score: h.score, mode: h.mode, revision: h.revision, draft: h.draft, pairs: [], chunkIds: [], pairKeys: new Map() };
        by.set(h.specId, m);
      } else if (h.score > m.score) {
        Object.assign(m, { score: h.score, mode: h.mode, revision: h.revision, draft: h.draft });
      }
      if (!m.chunkIds.includes(r.id)) m.chunkIds.push(r.id);
      if (probe.criterionId && h.criterionId) {
        // One pair per criterion of the asking spec: its best match there.
        const best = m.pairKeys.get(probe.criterionId);
        if (best === undefined || h.score > m.pairs[best]!.score) {
          const pair = { here: probe.criterionId, there: h.criterionId, score: h.score };
          if (best === undefined) { m.pairKeys.set(probe.criterionId, m.pairs.length); m.pairs.push(pair); }
          else m.pairs[best] = pair;
        }
      }
    }
  }
  return [...by.values()]
    .map(({ pairKeys: _k, ...m }) => ({ ...m, pairs: [...m.pairs].sort((a, b) => b.score - a.score).slice(0, MAX_PAIRS) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
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
