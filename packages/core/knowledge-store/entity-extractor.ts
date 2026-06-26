/**
 * Deterministic entity extraction — NO LLM.
 *
 * Extracts named entities from chunk content / metadata using purely
 * deterministic rules: regex patterns, path parsing, and SCIP output.
 * All extraction is idempotent; calling it twice on the same input yields
 * the same result.
 *
 * Entity types extracted here:
 *   file     — from source_path
 *   heading  — ## headings in docs/spec chunks
 *   pr       — #\d+ references in text
 *   task     — UUID patterns matching known task-id format
 *   mission  — mission id in metadata
 *   wikilink — [[Target]] syntax in markdown
 *   symbol   — exported symbols from SCIP output (Phase 3 / optional)
 */

import type { EntityKind, EntityRef } from './types';

// ── Patterns ─────────────────────────────────────────────────────────────────

// PR reference: #123 or PR #123 (but not #PR123 which is the entity key format)
const PR_REF = /#(\d{1,6})\b/g;

// Task / mission UUID: standard UUID v4 pattern appearing standalone
const UUID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

// Markdown headings at any level
const HEADING_PATTERN = /^#{1,6}\s+(.+)$/gm;

// Wikilinks: [[Target]] or [[Target|Alias]]
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// Relative markdown links: [label](./path) or [label](../path)
const RELATIVE_LINK_PATTERN = /\[[^\]]*\]\((\.[^)]+)\)/g;

// ── Extraction functions ──────────────────────────────────────────────────────

export interface ExtractedEntity {
  kind: EntityKind;
  key: string;
  canonicalName: string;
  role: 'defines' | 'references' | 'mentions';
}

export interface ExtractionInput {
  content: string;
  sourcePath?: string | null;
  metadata?: Record<string, unknown>;
  /** Corpus signals whether to extract headings (docs/spec only). */
  corpus?: string;
}

/**
 * Extract all deterministic entities from a chunk.
 * Returns a deduplicated list of entity descriptors.
 */
export function extractEntities(input: ExtractionInput): ExtractedEntity[] {
  const seen = new Set<string>();
  const results: ExtractedEntity[] = [];

  function add(e: ExtractedEntity) {
    const dedup = `${e.kind}:${e.key}`;
    if (!seen.has(dedup)) {
      seen.add(dedup);
      results.push(e);
    }
  }

  // ── File entity (from source_path) ─────────────────────────────────────
  if (input.sourcePath) {
    add({
      kind: 'file',
      key: input.sourcePath,
      canonicalName: input.sourcePath.split('/').pop() ?? input.sourcePath,
      role: 'defines',
    });
  }

  // ── Heading entities (docs / spec only) ────────────────────────────────
  const corpus = input.corpus ?? '';
  if ((corpus === 'docs' || corpus === 'spec') && input.sourcePath) {
    const headingMatches = input.content.matchAll(HEADING_PATTERN);
    for (const m of headingMatches) {
      const heading = m[1].trim();
      if (heading) {
        const key = `${input.sourcePath}#${heading}`;
        add({ kind: 'heading', key, canonicalName: heading, role: 'defines' });
      }
    }
  }

  // ── PR references ──────────────────────────────────────────────────────
  const prMatches = input.content.matchAll(PR_REF);
  for (const m of prMatches) {
    const prNum = m[1];
    add({ kind: 'pr', key: `pr#${prNum}`, canonicalName: `PR #${prNum}`, role: 'mentions' });
  }

  // ── Task / mission UUID references ─────────────────────────────────────
  const uuidMatches = input.content.matchAll(UUID_PATTERN);
  for (const m of uuidMatches) {
    const id = m[1].toLowerCase();
    // Heuristic: if also present in metadata.taskId or missionId, call it out explicitly
    const taskId = input.metadata?.taskId as string | undefined;
    const missionId = input.metadata?.missionId as string | undefined;

    if (taskId && id === taskId.toLowerCase()) {
      add({ kind: 'task', key: `task:${id}`, canonicalName: `Task ${id.slice(0, 8)}`, role: 'mentions' });
    } else if (missionId && id === missionId.toLowerCase()) {
      add({ kind: 'mission', key: `mission:${id}`, canonicalName: `Mission ${id.slice(0, 8)}`, role: 'mentions' });
    }
    // Non-metadata UUIDs: skip to avoid false positives
  }

  // Explicit metadata IDs (authoritative)
  if (input.metadata?.taskId) {
    const tid = String(input.metadata.taskId);
    add({ kind: 'task', key: `task:${tid}`, canonicalName: `Task ${tid.slice(0, 8)}`, role: 'defines' });
  }
  if (input.metadata?.missionId) {
    const mid = String(input.metadata.missionId);
    add({ kind: 'mission', key: `mission:${mid}`, canonicalName: `Mission ${mid.slice(0, 8)}`, role: 'mentions' });
  }
  if (input.metadata?.prNumber != null) {
    const prNum = String(input.metadata.prNumber);
    add({ kind: 'pr', key: `pr#${prNum}`, canonicalName: `PR #${prNum}`, role: 'defines' });
  }

  // ── Wikilinks ──────────────────────────────────────────────────────────
  const wikiMatches = input.content.matchAll(WIKILINK_PATTERN);
  for (const m of wikiMatches) {
    const target = m[1].trim();
    if (target) {
      const key = target.toLowerCase().replace(/\s+/g, '-');
      add({ kind: 'wikilink', key, canonicalName: target, role: 'references' });
    }
  }

  // ── Relative markdown links (doc cross-references) ─────────────────────
  const relLinkMatches = input.content.matchAll(RELATIVE_LINK_PATTERN);
  for (const m of relLinkMatches) {
    const relPath = m[1];
    if (relPath && input.sourcePath) {
      // Resolve relative to the source file's directory
      const dir = input.sourcePath.split('/').slice(0, -1).join('/');
      const resolved = resolveRelativePath(dir, relPath);
      if (resolved) {
        add({ kind: 'file', key: resolved, canonicalName: resolved.split('/').pop() ?? resolved, role: 'references' });
      }
    }
  }

  return results;
}

/** Convert extracted entities to EntityRef (agent-style) for storage. */
export function toEntityRefs(extracted: ExtractedEntity[]): EntityRef[] {
  return extracted.map(e => ({
    kind: e.kind,
    ref: e.key,
    role: e.role,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveRelativePath(baseDir: string, relPath: string): string | null {
  // Strip query/fragment
  const clean = relPath.split('?')[0].split('#')[0];
  if (!clean) return null;

  const parts = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'));
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  return resolved.join('/') || null;
}

// ── SCIP integration (optional, no-build) ────────────────────────────────────

/**
 * Lightweight SCIP occurrence representation. We consume only the fields we
 * need from the binary protobuf — a full proto parser is not required because
 * we use `scip-typescript --output-format json` (when available) or fall back
 * to ast-grep for symbol extraction.
 */
export interface ScipSymbol {
  moniker: string;       // SCIP canonical symbol id
  name: string;          // short human-readable name
  filePath: string;      // repo-relative file path
  kind: 'definition' | 'reference';
  startLine: number;
}

/**
 * Convert SCIP JSON output (from scip-typescript --output-format json or
 * the scip-dump tool) into entity descriptors.
 *
 * The input is an array of SCIP document objects (each with filePath + occurrences).
 * We only emit DEFINITION occurrences as symbol entities; REFERENCE occurrences
 * produce edges (handled in edge-builder.ts).
 */
export function extractFromScipSymbols(symbols: ScipSymbol[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const results: ExtractedEntity[] = [];

  for (const sym of symbols) {
    if (sym.kind !== 'definition') continue;
    const dedup = `symbol:${sym.moniker}`;
    if (!seen.has(dedup)) {
      seen.add(dedup);
      results.push({
        kind: 'symbol',
        key: sym.moniker,
        canonicalName: sym.name,
        role: 'defines',
      });
    }
  }

  return results;
}

/**
 * Run scip-typescript on the given tsconfig path and parse the JSON output.
 * Returns empty array if scip-typescript is not installed or the run fails —
 * graceful degradation is by design.
 */
export async function runScipExtraction(
  tsconfigPath: string,
  repoRoot: string,
): Promise<ScipSymbol[]> {
  try {
    const { spawn } = await import('child_process');
    const { promisify } = await import('util');
    const { exec: execCb } = await import('child_process');
    const exec = promisify(execCb);

    // Check if scip-typescript is available
    try {
      await exec('which scip-typescript');
    } catch {
      return []; // Not installed — graceful fallback
    }

    const tmpFile = `/tmp/scip-index-${Date.now()}.json`;
    const cmd = `scip-typescript index --tsconfig "${tsconfigPath}" --output "${tmpFile}" --format json`;

    await exec(cmd, { cwd: repoRoot, timeout: 120_000 });

    const { readFile, unlink } = await import('fs/promises');
    const raw = await readFile(tmpFile, 'utf8');
    await unlink(tmpFile).catch(() => {});

    return parseScipJson(raw);
  } catch {
    // SCIP extraction failed — ast-grep fallback is caller's responsibility
    return [];
  }
}

/** Parse SCIP JSON output into ScipSymbol[]  */
function parseScipJson(json: string): ScipSymbol[] {
  try {
    const data = JSON.parse(json) as { documents?: Array<{ relativePath?: string; occurrences?: Array<{ symbol?: string; symbolRoles?: number; range?: number[] }> }> };
    const results: ScipSymbol[] = [];

    for (const doc of data.documents ?? []) {
      const filePath = doc.relativePath ?? '';
      for (const occ of doc.occurrences ?? []) {
        if (!occ.symbol) continue;
        // symbolRoles: 1 = Definition (see SCIP spec)
        const isDefinition = (occ.symbolRoles ?? 0) & 1;
        const startLine = occ.range?.[0] ?? 0;
        const name = occ.symbol.split('/').pop()?.replace(/[#.!].*$/, '') ?? occ.symbol;

        results.push({
          moniker: occ.symbol,
          name,
          filePath,
          kind: isDefinition ? 'definition' : 'reference',
          startLine,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}
