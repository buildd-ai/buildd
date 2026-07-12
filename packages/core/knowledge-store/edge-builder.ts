import type {
  Corpus,
  EntityKind,
  EntityUpsert,
  EdgeUpsert,
  PendingRef,
  RelationRef,
} from './types';
import { extractEntities, type SymbolInfo } from './entity-extractor';

// ── Edge weight defaults per type ─────────────────────────────────────────────

const EDGE_WEIGHTS: Record<string, number> = {
  imports:       0.8,
  defines:       1.0,
  references:    0.5,
  produced:      1.0,
  implements:    0.9,
  supersedes:    1.0,
  references_doc: 0.6,
  relates_to:    0.7,
  outcome_of:    0.8,
  part_of:       0.9,
};

// ── Input / Output types ──────────────────────────────────────────────────────

export interface EdgeBuilderInput {
  chunk: {
    id: string;
    content: string;
    sourceType: string;
    sourcePath?: string | null;
    metadata?: Record<string, unknown>;
  };
  corpus: Corpus;
  workspaceId: string;
  /** Changed files list from a PR diff — produces `produced` edges. */
  prDiff?: string[];
  /** Agent-supplied relations from MCP params. */
  agentRelations?: RelationRef[];
  /** Candidate spec/docs paths sharing a basename with the chunk — produces `implements` edges. */
  speculativeMatchPaths?: string[];
  /**
   * Pre-extracted top-level symbols (ast-grep symbol layer). Falls back to
   * `chunk.metadata.symbols` (attached by fileToChunks) when omitted.
   * Produces `(file) -defines-> (symbol)` edges.
   */
  symbols?: SymbolInfo[];
  /**
   * Pre-extracted import statements (ast-grep). Falls back to
   * `chunk.metadata.imports`. Resolved relative imports produce
   * `(file) -imports-> (file)` edges.
   */
  imports?: ImportInfo[];
}

/** Structural subset of ExtractedImport — keeps this module dependency-free. */
export interface ImportInfo {
  specifier: string;
  resolvedPath: string | null;
}

function importsFromInput(input: EdgeBuilderInput): ImportInfo[] {
  const raw = input.imports ?? (input.chunk.metadata as { imports?: unknown } | undefined)?.imports;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is ImportInfo => !!i && typeof i === 'object' && typeof (i as ImportInfo).specifier === 'string',
  );
}

export interface EdgeBuilderOutput {
  entities: EntityUpsert[];
  edges: EdgeUpsert[];
  pendingRefs: PendingRef[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function stemName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase();
}

function dedup(edges: EdgeUpsert[]): EdgeUpsert[] {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.fromEntityKind}:${e.fromEntityKey}→${e.type}→${e.toEntityKind}:${e.toEntityKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupEntities(entities: EntityUpsert[]): EntityUpsert[] {
  const seen = new Set<string>();
  return entities.filter(e => {
    const key = `${e.kind}:${e.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const PR_REF_RE = /#(\d+)/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Deterministic, pure edge builder.
 * Consumes chunk structure + optional SCIP/diff/agent metadata and emits
 * entity upserts, edge upserts, and pending refs — no I/O.
 */
export function buildEdges(input: EdgeBuilderInput): EdgeBuilderOutput {
  const { chunk, corpus, workspaceId, prDiff, agentRelations, speculativeMatchPaths, symbols } = input;
  const chunkId = chunk.id;
  const entities: EntityUpsert[] = [];
  const edges: EdgeUpsert[] = [];
  const pendingRefs: PendingRef[] = [];

  // ── Step 1: extract base entities from the chunk ──────────────────────────
  const extracted = extractEntities({
    content: chunk.content,
    corpus,
    workspaceId,
    sourcePath: chunk.sourcePath,
    metadata: chunk.metadata,
    symbols,
  });
  entities.push(...extracted);

  // ── Step 1b: symbol defines / import edges (ast-grep symbol layer) ────────
  if (chunk.sourcePath) {
    // (file) -defines-> (symbol) for every symbol defined in this chunk.
    // extractEntities already filtered symbols to the chunk's line range.
    for (const sym of extracted.filter(e => e.kind === 'symbol')) {
      edges.push({
        workspaceId,
        fromEntityKey: chunk.sourcePath,
        fromEntityKind: 'file',
        toEntityKey: sym.key,
        toEntityKind: 'symbol',
        type: 'defines',
        weight: EDGE_WEIGHTS.defines,
        sourceChunkId: chunkId,
        rule: 'astgrep:definition',
      });
    }

    // (file) -imports-> (file) for resolved relative imports. Best-effort:
    // resolvedPath is a textually-normalized, extensionless candidate path.
    for (const imp of importsFromInput(input)) {
      if (!imp.resolvedPath || imp.resolvedPath === chunk.sourcePath) continue;
      entities.push({
        workspaceId,
        kind: 'file',
        key: imp.resolvedPath,
        canonicalName: basename(imp.resolvedPath),
      });
      edges.push({
        workspaceId,
        fromEntityKey: chunk.sourcePath,
        fromEntityKind: 'file',
        toEntityKey: imp.resolvedPath,
        toEntityKind: 'file',
        type: 'imports',
        weight: EDGE_WEIGHTS.imports,
        sourceChunkId: chunkId,
        rule: 'astgrep:import',
      });
    }
  }

  // ── Step 2: PR produced edges (file entities from diff) ───────────────────
  if (corpus === 'pr' && prDiff && prDiff.length > 0) {
    // The PR chunk itself is the "from" entity
    const prKey = chunkId; // e.g. "pr:42"
    const prEntityKey = prKey.startsWith('pr:') ? prKey : `pr:${prKey}`;
    const prNum = prEntityKey.replace('pr:', '');

    // Ensure the PR entity exists
    entities.push({
      workspaceId,
      kind: 'pr',
      key: `pr#${prNum}`,
      canonicalName: `PR #${prNum}`,
    });

    for (const filePath of prDiff) {
      entities.push({
        workspaceId,
        kind: 'file',
        key: filePath,
        canonicalName: basename(filePath),
      });
      edges.push({
        workspaceId,
        fromEntityKey: `pr#${prNum}`,
        fromEntityKind: 'pr',
        toEntityKey: filePath,
        toEntityKind: 'file',
        type: 'produced',
        weight: EDGE_WEIGHTS.produced,
        sourceChunkId: chunkId,
        rule: 'pr:produced',
      });
    }
  }

  // ── Step 3: implements edges via path convention ──────────────────────────
  // A code file "implements" a spec/docs file when they share the same stem.
  if (chunk.sourcePath && (corpus === 'code' || corpus === 'docs' || corpus === 'spec')) {
    const codeStem = stemName(basename(chunk.sourcePath));

    // Check speculative match paths supplied by caller (avoids I/O in pure fn)
    if (speculativeMatchPaths) {
      for (const specPath of speculativeMatchPaths) {
        const specStem = stemName(basename(specPath));
        if (codeStem === specStem && specPath !== chunk.sourcePath) {
          entities.push({
            workspaceId,
            kind: 'file',
            key: specPath,
            canonicalName: basename(specPath),
          });
          edges.push({
            workspaceId,
            fromEntityKey: chunk.sourcePath,
            fromEntityKind: 'file',
            toEntityKey: specPath,
            toEntityKind: 'file',
            type: 'implements',
            weight: EDGE_WEIGHTS.implements,
            sourceChunkId: chunkId,
            rule: 'path:implements',
          });
        }
      }
    }
  }

  // ── Step 4: outcome_of edge (task → mission) ──────────────────────────────
  const meta = chunk.metadata ?? {};
  if (corpus === 'task' && meta.missionId && meta.taskId) {
    const taskKey = `task:${meta.taskId}`;
    const missionKey = `mission:${meta.missionId}`;
    edges.push({
      workspaceId,
      fromEntityKey: taskKey,
      fromEntityKind: 'task',
      toEntityKey: missionKey,
      toEntityKind: 'mission',
      type: 'outcome_of',
      weight: EDGE_WEIGHTS.outcome_of,
      sourceChunkId: chunkId,
      rule: 'meta:outcome_of',
    });
  }

  // ── Step 5: part_of edges (heading → document) ───────────────────────────
  if (chunk.sourcePath && (corpus === 'docs' || corpus === 'spec')) {
    const docKey = chunk.sourcePath;
    const headingEntities = extracted.filter(e => e.kind === 'heading');
    for (const h of headingEntities) {
      edges.push({
        workspaceId,
        fromEntityKey: h.key,
        fromEntityKind: 'heading',
        toEntityKey: docKey,
        toEntityKind: 'file',
        type: 'part_of',
        weight: EDGE_WEIGHTS.part_of,
        sourceChunkId: chunkId,
        rule: 'heading:part_of',
      });
    }
  }

  // ── Step 6: references_doc edges (PR/task refs to PR entities) ───────────
  {
    let m: RegExpExecArray | null;
    PR_REF_RE.lastIndex = 0;
    while ((m = PR_REF_RE.exec(chunk.content)) !== null) {
      const refPrKey = `pr#${m[1]}`;
      // The current chunk's document entity references that PR
      const fromKey = chunk.sourcePath ?? chunkId;
      const fromKind: EntityKind = chunk.sourcePath ? 'file' : 'task';
      // Only add edge if the reference is to a different entity
      if (fromKey !== refPrKey) {
        edges.push({
          workspaceId,
          fromEntityKey: fromKey,
          fromEntityKind: fromKind,
          toEntityKey: refPrKey,
          toEntityKind: 'pr',
          type: 'references_doc',
          weight: EDGE_WEIGHTS.references_doc,
          sourceChunkId: chunkId,
          rule: 'text:pr_ref',
        });
      }
    }
  }

  // ── Step 7: wikilink references → pending refs (unresolved) ──────────────
  {
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(chunk.content)) !== null) {
      const target = m[1].trim();
      pendingRefs.push({
        workspaceId,
        rawRef: target,
        kindHint: 'concept',
        sourceChunkId: chunkId,
        source: 'ingest',
      });
    }
  }

  // ── Step 8: agent-asserted relations ─────────────────────────────────────
  if (agentRelations) {
    for (const rel of agentRelations) {
      const weight = rel.weight ?? EDGE_WEIGHTS[rel.type] ?? 0.7;

      // Both ends go to pending refs since we can't resolve in this pure fn
      pendingRefs.push({
        workspaceId,
        rawRef: rel.from,
        kindHint: undefined,
        sourceChunkId: chunkId,
        source: 'agent',
      });
      pendingRefs.push({
        workspaceId,
        rawRef: rel.to,
        kindHint: undefined,
        sourceChunkId: chunkId,
        source: 'agent',
      });

      // Store as a pending edge placeholder using loose keys
      // (the resolver will bind these later; for now we note them as pending)
      // We still emit them with loose keys so callers can track intent
      edges.push({
        workspaceId,
        fromEntityKey: rel.from.toLowerCase().replace(/\s+/g, '-'),
        fromEntityKind: 'concept',
        toEntityKey: rel.to.toLowerCase().replace(/\s+/g, '-'),
        toEntityKind: 'concept',
        type: rel.type as any,
        weight,
        sourceChunkId: chunkId,
        rule: 'agent:relation',
      });
    }
  }

  return {
    entities: dedupEntities(entities),
    edges: dedup(edges),
    pendingRefs,
  };
}

// ── DB-backed async edge writers ──────────────────────────────────────────────
// All DB access is lazy (dynamic imports) so pure-function tests for buildEdges
// don't pull in drizzle-orm or the DB client at module load time.

async function findEntityId(
  workspaceId: string,
  kind: string,
  key: string,
): Promise<string | null> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index');
  const res = await db.execute(sql`
    SELECT id FROM knowledge_entities
    WHERE workspace_id = ${workspaceId} AND kind = ${kind} AND key = ${key}
    LIMIT 1
  `);
  const row = res.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

async function resolveByAliasDb(
  workspaceId: string,
  ref: string,
): Promise<string | null> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index');
  const normalised = ref.toLowerCase().trim();
  const res = await db.execute(sql`
    SELECT ea.entity_id
    FROM entity_aliases ea
    JOIN knowledge_entities ke ON ke.id = ea.entity_id
    WHERE ke.workspace_id = ${workspaceId} AND ea.alias = ${normalised}
    LIMIT 1
  `);
  const row = res.rows[0] as { entity_id: string } | undefined;
  return row?.entity_id ?? null;
}

/**
 * Write a task→mission outcome_of edge.
 * No-ops if either entity doesn't exist yet.
 */
export async function buildOutcomeOfEdge(
  workspaceId: string,
  taskId: string,
  missionId: string,
  sourceChunkId: string | null = null,
): Promise<void> {
  const taskEntityId = await findEntityId(workspaceId, 'task', `task:${taskId}`);
  const missionEntityId = await findEntityId(workspaceId, 'mission', `mission:${missionId}`);
  if (!taskEntityId || !missionEntityId) return;
  const { upsertEdge } = await import('./entity-resolver');
  const { db } = await import('../db/index');
  await upsertEdge(
    db, workspaceId, taskEntityId, missionEntityId,
    'outcome_of', EDGE_WEIGHTS.outcome_of,
    sourceChunkId ?? undefined, 'metadata:missionId',
  );
}

/**
 * Build edges from agent-supplied relations.
 * Resolves from/to by alias; silently skips unresolvable refs.
 */
export async function buildAgentRelationEdges(
  workspaceId: string,
  relations: RelationRef[],
  sourceChunkId: string | null = null,
): Promise<void> {
  const { upsertEdge } = await import('./entity-resolver');
  const { db } = await import('../db/index');
  for (const rel of relations) {
    const fromId = await resolveByAliasDb(workspaceId, rel.from);
    const toId = await resolveByAliasDb(workspaceId, rel.to);
    if (!fromId || !toId) continue;
    const weight = rel.weight ?? EDGE_WEIGHTS[rel.type] ?? 0.7;
    await upsertEdge(
      db, workspaceId, fromId, toId,
      rel.type, weight,
      sourceChunkId ?? undefined, 'agent:relation',
    );
  }
}
