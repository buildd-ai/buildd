import type { EntityKind, EntityUpsert } from './types';
import type { Corpus } from './types';

export interface ExtractEntityInput {
  content: string;
  corpus: Corpus;
  workspaceId: string;
  sourcePath?: string | null;
  metadata?: Record<string, unknown>;
}

const PR_REF_RE = /#(\d+)/g;
const TASK_UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;

const DOC_CORPORA: Set<Corpus> = new Set(['docs', 'spec']);

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function dedup(entities: EntityUpsert[]): EntityUpsert[] {
  const seen = new Set<string>();
  return entities.filter(e => {
    const key = `${e.kind}:${e.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deterministically extract entity references from a chunk.
 * Pure function — no I/O. Returns canonical EntityUpsert records for
 * the entity table (workspaceId, kind, key, canonicalName).
 */
export function extractEntities(input: ExtractEntityInput): EntityUpsert[] {
  const { content, corpus, workspaceId, sourcePath, metadata } = input;
  const entities: EntityUpsert[] = [];

  // ── file entity ──────────────────────────────────────────────────────────
  if (sourcePath) {
    entities.push({
      workspaceId,
      kind: 'file',
      key: sourcePath,
      canonicalName: basename(sourcePath),
    });
  }

  // ── heading entities (docs/spec only) ────────────────────────────────────
  if (DOC_CORPORA.has(corpus)) {
    let m: RegExpExecArray | null;
    HEADING_RE.lastIndex = 0;
    while ((m = HEADING_RE.exec(content)) !== null) {
      const heading = m[1].trim();
      const key = sourcePath ? `${sourcePath}#${heading}` : heading;
      entities.push({
        workspaceId,
        kind: 'heading',
        key,
        canonicalName: heading,
      });
    }
  }

  // ── PR references (#NNN) ────────────────────────────────────────────────
  {
    let m: RegExpExecArray | null;
    PR_REF_RE.lastIndex = 0;
    while ((m = PR_REF_RE.exec(content)) !== null) {
      const num = m[1];
      entities.push({
        workspaceId,
        kind: 'pr',
        key: `pr#${num}`,
        canonicalName: `PR #${num}`,
      });
    }
  }

  // ── Task UUID references ─────────────────────────────────────────────────
  {
    let m: RegExpExecArray | null;
    TASK_UUID_RE.lastIndex = 0;
    while ((m = TASK_UUID_RE.exec(content)) !== null) {
      const uuid = m[1].toLowerCase();
      entities.push({
        workspaceId,
        kind: 'task',
        key: `task:${uuid}`,
        canonicalName: `Task ${uuid.slice(0, 8)}`,
      });
    }
  }

  // ── Wikilink references [[Target]] ───────────────────────────────────────
  {
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(content)) !== null) {
      const target = m[1].trim();
      entities.push({
        workspaceId,
        kind: 'wikilink',
        key: target.toLowerCase().replace(/\s+/g, '-'),
        canonicalName: target,
      });
    }
  }

  // ── Mission from metadata ────────────────────────────────────────────────
  if (metadata?.missionId && typeof metadata.missionId === 'string') {
    entities.push({
      workspaceId,
      kind: 'mission',
      key: `mission:${metadata.missionId}`,
      canonicalName: `Mission ${metadata.missionId.slice(0, 8)}`,
    });
  }

  // ── Task from metadata.taskId ─────────────────────────────────────────────
  if (metadata?.taskId && typeof metadata.taskId === 'string') {
    const tid = metadata.taskId as string;
    entities.push({
      workspaceId,
      kind: 'task',
      key: `task:${tid}`,
      canonicalName: `Task ${tid.slice(0, 8)}`,
    });
  }

  return dedup(entities);
}
