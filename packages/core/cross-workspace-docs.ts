/**
 * Cross-workspace docs retrieval (docs/design/cross-workspace-retrieval.md).
 *
 * Retrieval is scoped to one workspace, so a workspace whose docs live in another
 * (the product docs, a private knowledge base) cannot be compared against its own
 * code. This lets a workspace's `recall` and `spec_compare` also search the
 * `docs`/`spec` namespace of sibling workspaces it has been explicitly pointed at.
 *
 * Bounds, all enforced in `resolveReadableWorkspaces` and fail-closed:
 *   - explicit opt-in: only sources named in the reader's `crossWorkspaceDocs`
 *     config are ever read, never "every sibling";
 *   - same team: a named source outside the reader's team is dropped;
 *   - directional: a `standard` reader needs the owner's `acknowledgeSensitive`
 *     on a source to read a `sensitive` one; a `sensitive` reader (which cannot
 *     `learn`, so has no way to write back into a shared corpus) may read either;
 *   - an unresolved source class is a deny, not a default;
 *   - a caller holding untrusted external input (a reviewer reading a contributor
 *     diff) gets nothing, whatever the classes say.
 *
 * Docs only: `code` never crosses a workspace. Everything that does cross is
 * labelled with its origin and fenced as untrusted data when rendered.
 *
 * Pure and DB-free so the runner and the web app share it; the web side supplies
 * the rows (apps/web/src/lib/cross-workspace-docs.ts).
 */

import type { Corpus, KnowledgeStore, QueryParams, QueryResult } from './knowledge-store/types';
import { wrapUntrustedText } from './untrusted-text';

/**
 * `buildNamespace` from the vector store, restated here so this module (and the
 * web helper that imports it) does not pull in the store's drizzle dependency.
 * A test pins the two together.
 */
export function docsNamespace(workspaceId: string, corpus: Corpus): string {
  return `${workspaceId}:${corpus}`;
}

export type DataClass = 'standard' | 'sensitive';

/** Upper bound on foreign namespaces one retrieval fans out to. */
export const MAX_CROSS_WORKSPACE_SOURCES = 3;

/** Corpora whose prose may be read across workspaces. `code` is deliberately absent. */
export const CROSS_WORKSPACE_CORPORA: ReadonlySet<Corpus> = new Set<Corpus>(['docs', 'spec']);

/** Metadata key a foreign result carries; written by the fan-out, never trusted from storage. */
const ORIGIN_KEY = 'crossWorkspaceOrigin';

export interface CrossWorkspaceDocsSource {
  workspaceId: string;
  /**
   * The owner's explicit statement that a `standard` reader may read this
   * `sensitive` source. Without it the direction rule denies the read.
   */
  acknowledgeSensitive?: boolean;
}

/** Stored in the reader's `gitConfig.crossWorkspaceDocs`. */
export interface CrossWorkspaceDocsConfig {
  sources: CrossWorkspaceDocsSource[];
}

/** A workspace of the reader's team, as the web layer loaded it. */
export interface TeamWorkspace {
  id: string;
  name: string;
  /** Effective class; null when it could not be resolved. See `effectiveDataClass`. */
  dataClass: DataClass | null | undefined;
}

export interface ReadableWorkspace {
  id: string;
  name: string;
  dataClass: DataClass;
}

/**
 * The class a workspace is treated as. `workspaces.dataClass` is the column every
 * sensitivity gate reads; `gitConfig.dataClass` is a legacy jsonb copy that task
 * creation reads. Sensitive if either says so; unresolved (null) if the column is
 * missing or holds a value neither class recognises — callers must deny on null
 * for a source, because a default of `standard` would make an unreadable row
 * readable.
 */
export function effectiveDataClass(column: unknown, gitConfigValue: unknown): DataClass | null {
  if (column !== 'standard' && column !== 'sensitive') return null;
  return column === 'sensitive' || gitConfigValue === 'sensitive' ? 'sensitive' : 'standard';
}

/** Parse the stored value. Malformed entries are dropped; non-objects are null. */
export function normalizeCrossWorkspaceDocs(raw: unknown): CrossWorkspaceDocsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(list)) return null;
  const sources: CrossWorkspaceDocsSource[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { workspaceId, acknowledgeSensitive } = entry as Record<string, unknown>;
    if (typeof workspaceId !== 'string' || workspaceId === '') continue;
    sources.push(acknowledgeSensitive === true ? { workspaceId, acknowledgeSensitive: true } : { workspaceId });
  }
  return { sources };
}

export interface ResolveReadableWorkspacesInput {
  readerWorkspaceId: string;
  /** Null/undefined (unresolved) is treated as `standard`: fewer rights, not more. */
  readerDataClass: DataClass | null | undefined;
  config: CrossWorkspaceDocsConfig | null | undefined;
  /** Only the reader's own team's workspaces. A named source not in this list is refused. */
  teamWorkspaces: readonly TeamWorkspace[];
  /** The caller's context includes attacker-influenced input (e.g. a contributor diff). */
  untrustedInput?: boolean;
  maxSources?: number;
}

export function resolveReadableWorkspaces(input: ResolveReadableWorkspacesInput): ReadableWorkspace[] {
  if (input.untrustedInput) return [];
  const sources = input.config?.sources;
  if (!sources || sources.length === 0) return [];

  const readerIsSensitive = input.readerDataClass === 'sensitive';
  const team = new Map(input.teamWorkspaces.map((w) => [w.id, w]));
  const cap = input.maxSources ?? MAX_CROSS_WORKSPACE_SOURCES;
  const out: ReadableWorkspace[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (out.length >= cap) break;
    if (source.workspaceId === input.readerWorkspaceId || seen.has(source.workspaceId)) continue;
    seen.add(source.workspaceId);

    const target = team.get(source.workspaceId);
    if (!target) continue;
    if (target.dataClass !== 'standard' && target.dataClass !== 'sensitive') continue;
    if (target.dataClass === 'sensitive' && !readerIsSensitive && source.acknowledgeSensitive !== true) continue;

    out.push({ id: target.id, name: target.name, dataClass: target.dataClass });
  }
  return out;
}

export interface ForeignOrigin {
  workspaceId: string;
  workspaceName: string;
}

export function foreignOrigin(r: Pick<QueryResult, 'metadata'>): ForeignOrigin | null {
  const o = r.metadata?.[ORIGIN_KEY] as Partial<ForeignOrigin> | undefined;
  if (!o || typeof o.workspaceId !== 'string' || typeof o.workspaceName !== 'string') return null;
  return { workspaceId: o.workspaceId, workspaceName: o.workspaceName };
}

export interface ForeignQueryFailure {
  workspaceName: string;
  reason: string;
}

/**
 * Query `corpus` in the reader's own namespace and in each readable workspace's,
 * merge by score and cut to topK. A foreign namespace that fails is reported and
 * skipped; the reader's own failing still throws, as it did before this existed.
 */
export async function queryDocsAcrossWorkspaces(
  ks: KnowledgeStore,
  ownWorkspaceId: string,
  readable: readonly ReadableWorkspace[],
  corpus: Corpus,
  params: QueryParams,
): Promise<{ results: QueryResult[]; failures: ForeignQueryFailure[] }> {
  const targets = CROSS_WORKSPACE_CORPORA.has(corpus) ? readable : [];
  const failures: ForeignQueryFailure[] = [];

  const [own, foreign] = await Promise.all([
    ks.query(docsNamespace(ownWorkspaceId, corpus), params),
    Promise.all(
      targets.map(async (w): Promise<QueryResult[]> => {
        try {
          const rows = await ks.query(docsNamespace(w.id, corpus), params);
          return rows.map((r) => ({
            ...r,
            metadata: { ...r.metadata, [ORIGIN_KEY]: { workspaceId: w.id, workspaceName: w.name } },
          }));
        } catch (e) {
          failures.push({ workspaceName: w.name, reason: e instanceof Error ? e.message : 'unknown error' });
          return [];
        }
      }),
    ),
  ]);

  if (targets.length === 0) return { results: own, failures };
  const merged = [...own, ...foreign.flat()].sort((a, b) => b.score - a.score);
  return { results: merged.slice(0, params.topK), failures };
}

/** A workspace name is admin-set text going into a prompt: keep it to one short, quote-free line. */
function labelName(name: string): string {
  return name.replace(/["\r\n]+/g, ' ').trim().slice(0, 80);
}

/**
 * The text of one docs hit. A native hit is shown as before: collapsed onto one
 * line and cut to `maxChars`, or whole when `block` is set. A foreign hit is
 * prefixed with the workspace it came from and fenced as untrusted data, so
 * instructions written into another workspace's prose are read, not obeyed.
 */
export function renderDocsResult(
  r: Pick<QueryResult, 'content' | 'metadata'>,
  opts: { maxChars: number; block?: boolean },
): string {
  const origin = foreignOrigin(r);
  if (!origin) {
    return opts.block ? r.content : r.content.replace(/\s+/g, ' ').slice(0, opts.maxChars);
  }
  const name = labelName(origin.workspaceName);
  const body = opts.block ? r.content : r.content.slice(0, opts.maxChars);
  return `[from workspace "${name}"]\n${wrapUntrustedText(body, { source: `docs from workspace "${name}"` })}`;
}

/** One line per skipped source, for appending to a result; '' when none failed. */
export function formatForeignFailures(failures: readonly ForeignQueryFailure[]): string {
  if (failures.length === 0) return '';
  return `\n\n(${failures.length} other-workspace docs source(s) unavailable: ${failures
    .map((f) => `${labelName(f.workspaceName)} (${f.reason})`)
    .join(', ')})`;
}
