/**
 * Deterministic edge builder — NO LLM.
 *
 * Builds graph edges from:
 *   - SCIP occurrences (imports, defines, references)
 *   - Path conventions (implements: foo.ts ↔ docs/spec/foo.md)
 *   - PR diffs (file entities ← produced ← PR entity)
 *   - Agent-asserted relations
 *
 * All writes are idempotent: INSERT ... ON CONFLICT DO NOTHING.
 * The function is pure when called with the injected resolver — no global state.
 */

import { sql } from 'drizzle-orm';
import type { RelationRef } from './types';
import type { ScipSymbol } from './entity-extractor';

// ── Edge weight catalog ───────────────────────────────────────────────────────

const EDGE_WEIGHTS: Record<string, number> = {
  defines:       1.0,
  imports:       0.8,
  references:    0.5,
  implements:    0.9,
  produced:      1.0,
  supersedes:    1.0,
  references_doc: 0.7,
  relates_to:    0.7,
  outcome_of:    1.0,
  part_of:       0.9,
};

// ── DB accessor ───────────────────────────────────────────────────────────────

async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

// ── Edge upsert ───────────────────────────────────────────────────────────────

export async function upsertEdge(
  workspaceId: string,
  fromEntityId: string,
  toEntityId: string,
  type: string,
  rule: string,
  sourceChunkId: string | null = null,
  weight?: number,
): Promise<void> {
  const db = await getDb();
  const w = weight ?? EDGE_WEIGHTS[type] ?? 1.0;
  await db.execute(sql`
    INSERT INTO knowledge_edges (workspace_id, from_entity_id, to_entity_id, type, weight, source_chunk_id, rule)
    VALUES (${workspaceId}, ${fromEntityId}, ${toEntityId}, ${type}, ${w}, ${sourceChunkId}, ${rule})
    ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO UPDATE
      SET weight = EXCLUDED.weight
  `);
}

// ── Entity lookup helpers ─────────────────────────────────────────────────────

async function findEntityId(
  workspaceId: string,
  kind: string,
  key: string,
): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute(sql`
    SELECT id FROM knowledge_entities
    WHERE workspace_id = ${workspaceId} AND kind = ${kind} AND key = ${key}
    LIMIT 1
  `);
  const row = res.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

// ── SCIP-derived edges ────────────────────────────────────────────────────────

/**
 * Build defines + references edges from SCIP symbol output.
 *
 * For each DEFINITION: file A --defines--> symbol S
 * For each REFERENCE:  file A --references--> symbol S (+ file A --imports--> file B if defined elsewhere)
 */
export async function buildScipEdges(
  workspaceId: string,
  symbols: ScipSymbol[],
): Promise<void> {
  // Group by file
  const byFile = new Map<string, ScipSymbol[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.filePath) ?? [];
    arr.push(s);
    byFile.set(s.filePath, arr);
  }

  // Build a map: moniker → definedInFile (for reference edge resolution)
  const monikerToFile = new Map<string, string>();
  for (const s of symbols) {
    if (s.kind === 'definition') monikerToFile.set(s.moniker, s.filePath);
  }

  for (const [filePath, fileSymbols] of byFile) {
    const fileEntityId = await findEntityId(workspaceId, 'file', filePath);
    if (!fileEntityId) continue;

    for (const sym of fileSymbols) {
      const symEntityId = await findEntityId(workspaceId, 'symbol', sym.moniker);
      if (!symEntityId) continue;

      if (sym.kind === 'definition') {
        await upsertEdge(workspaceId, fileEntityId, symEntityId, 'defines', 'scip:definition', null);
      } else {
        // reference
        await upsertEdge(workspaceId, fileEntityId, symEntityId, 'references', 'scip:reference', null);

        // Derive import edge: file A imports file B (where B defines the symbol)
        const definedInFile = monikerToFile.get(sym.moniker);
        if (definedInFile && definedInFile !== filePath) {
          const targetFileId = await findEntityId(workspaceId, 'file', definedInFile);
          if (targetFileId) {
            await upsertEdge(workspaceId, fileEntityId, targetFileId, 'imports', 'scip:import', null);
          }
        }
      }
    }
  }
}

// ── Path-convention edges (implements) ───────────────────────────────────────

/**
 * Build implements edges from path convention:
 * `src/foo.ts` implements `docs/spec/foo.md` when both exist and share normalised basename.
 */
export async function buildImplementsEdges(
  workspaceId: string,
  allFilePaths: string[],
): Promise<void> {
  // Build basename → path maps for code and doc files
  const codeFiles = new Map<string, string>();
  const docFiles = new Map<string, string>();

  for (const p of allFilePaths) {
    const basename = normaliseBasename(p);
    if (!basename) continue;
    if (isDocPath(p)) {
      docFiles.set(basename, p);
    } else if (isCodePath(p)) {
      codeFiles.set(basename, p);
    }
  }

  for (const [basename, codePath] of codeFiles) {
    const docPath = docFiles.get(basename);
    if (!docPath) continue;

    const codeId = await findEntityId(workspaceId, 'file', codePath);
    const docId = await findEntityId(workspaceId, 'file', docPath);
    if (!codeId || !docId) continue;

    await upsertEdge(workspaceId, codeId, docId, 'implements', 'path-convention', null);
  }
}

// ── PR → file edges (produced) ────────────────────────────────────────────────

/**
 * Build produced edges: PR entity --produced--> each changed file entity.
 */
export async function buildPrProducedEdges(
  workspaceId: string,
  prNumber: string | number,
  changedFiles: string[],
  sourceChunkId: string | null = null,
): Promise<void> {
  const prKey = `pr#${prNumber}`;
  const prId = await findEntityId(workspaceId, 'pr', prKey);
  if (!prId) return;

  for (const filePath of changedFiles) {
    const fileId = await findEntityId(workspaceId, 'file', filePath);
    if (!fileId) continue;
    await upsertEdge(workspaceId, prId, fileId, 'produced', 'pr:diff', sourceChunkId);
  }
}

// ── Task → mission edge (outcome_of) ─────────────────────────────────────────

export async function buildOutcomeOfEdge(
  workspaceId: string,
  taskId: string,
  missionId: string,
  sourceChunkId: string | null = null,
): Promise<void> {
  const taskEntityId = await findEntityId(workspaceId, 'task', `task:${taskId}`);
  const missionEntityId = await findEntityId(workspaceId, 'mission', `mission:${missionId}`);
  if (!taskEntityId || !missionEntityId) return;
  await upsertEdge(workspaceId, taskEntityId, missionEntityId, 'outcome_of', 'metadata:missionId', sourceChunkId);
}

// ── Agent-asserted relation edges ────────────────────────────────────────────

/**
 * Build edges from agent-supplied relations. Each relation's `from` and `to`
 * are looked up by alias (best-effort — unresolved refs are silently skipped).
 */
export async function buildAgentRelationEdges(
  workspaceId: string,
  relations: RelationRef[],
  sourceChunkId: string | null = null,
): Promise<void> {
  const db = await getDb();

  for (const rel of relations) {
    // Look up from/to by alias
    const fromId = await resolveByAlias(db, workspaceId, rel.from);
    const toId = await resolveByAlias(db, workspaceId, rel.to);
    if (!fromId || !toId) continue;
    await upsertEdge(workspaceId, fromId, toId, rel.type, 'agent:relation', sourceChunkId, rel.weight);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function resolveByAlias(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string,
  ref: string,
): Promise<string | null> {
  const normalised = ref.toLowerCase().trim();
  const res = await db.execute(sql`
    SELECT ea.entity_id
    FROM entity_aliases ea
    JOIN knowledge_entities ke ON ke.id = ea.entity_id
    WHERE ke.workspace_id = ${workspaceId}
      AND ea.alias = ${normalised}
    LIMIT 1
  `);
  const row = res.rows[0] as { entity_id: string } | undefined;
  return row?.entity_id ?? null;
}

function normaliseBasename(path: string): string | null {
  const name = path.split('/').pop();
  if (!name) return null;
  // Remove extension
  return name.replace(/\.[^.]+$/, '').toLowerCase();
}

function isDocPath(p: string): boolean {
  return p.startsWith('docs/') || p.endsWith('.md') || p.endsWith('.mdx');
}

function isCodePath(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|mjs)$/.test(p);
}
