/**
 * Flag on vs off for claim-time memory index injection (task caa30c0f), over
 * the golden query set. Pure and deterministic: no DB, no embedder. Every
 * memory is synthesized from the golden query's own text, so the numbers are
 * about the renderings, not about anyone's data.
 *
 * What it measures, per golden query:
 *
 * - **recall@k.** The retrieval is the same in both arms (the flag only
 *   changes rendering), so the question is whether the rendering still puts
 *   every relevant memory in front of the agent. Off shows each retrieved
 *   memory as a body line; on shows it as an index line. A memory the index
 *   budget drops counts as not shown.
 * - **prompt bytes.** UTF-8 bytes of the memory text an agent receives, for
 *   the runner prompt (claim-time block + `## Workspace Memory`, where the
 *   index dedupes across the two) and for the `claim_task` reply.
 * - **bytes with pulls.** On, plus the full body of every relevant memory,
 *   as if the agent pulled each one with `recall`. The honest comparison: the
 *   index saves only what the agent does not go on to fetch.
 *
 * The off renderings mirror the shipped formats: claim-time lines come from
 * the real `renderHitLines`; the `claim_task` (200-char) and runner (300-char)
 * body lines copy their inline formats in mcp-tools.ts and
 * apps/runner/src/memory-digest-policy.ts.
 */
import { renderHitLines } from '../prior-work-render';
import {
  buildMemoryIndex,
  memoryIndexEntriesTokens,
  DEFAULT_MEMORY_INDEX_TOKEN_BUDGET,
  type MemoryIndexEntry,
} from '../memory-claim-index';
import { recallAtK, mean } from './eval-metrics';
import type { QueryResult } from '../knowledge-store/types';

export interface GoldenQueryLike {
  id: string;
  query: string;
}

export interface SyntheticMemory {
  id: string;
  type: string;
  title: string;
  content: string;
  relevant: boolean;
}

export interface QueryComparison {
  queryId: string;
  k: number;
  recallOff: number;
  recallOn: number;
  runnerBytesOff: number;
  runnerBytesOn: number;
  replyBytesOff: number;
  replyBytesOn: number;
  /** runnerBytesOn plus every relevant memory's body, as pulled. */
  runnerBytesOnWithPulls: number;
}

export interface ComparisonReport {
  queries: QueryComparison[];
  totals: {
    queries: number;
    meanRecallOff: number;
    meanRecallOn: number;
    runnerBytesOff: number;
    runnerBytesOn: number;
    runnerBytesOnWithPulls: number;
    replyBytesOff: number;
    replyBytesOn: number;
  };
}

const TYPES = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
/** Hits per query: claim-time takes 3, the runner and claim_task take 5 each. */
const HITS_PER_QUERY = 8;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** FNV-1a, for deterministic synthetic ids and lengths. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function syntheticId(seed: string): string {
  const hex = [0, 1, 2, 3].map(i => hash(`${seed}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic memories for a golden query: two relevant, the rest not. */
export function synthesizeMemories(q: GoldenQueryLike): SyntheticMemory[] {
  const words = q.query.split(/\s+/).filter(Boolean);
  return Array.from({ length: HITS_PER_QUERY }, (_, i) => {
    const seed = `${q.id}:${i}`;
    const title = `${words.slice(i % words.length).concat(words).slice(0, 6).join(' ')} (note ${i + 1})`;
    // Bodies of 200 to 1400 chars: memories are written as paragraphs.
    const len = 200 + (hash(seed) % 1200);
    const sentence = `${words.join(' ')}. `;
    const content = sentence.repeat(Math.ceil(len / sentence.length)).slice(0, len);
    const relevant = i === hash(`${q.id}:rel`) % 3 || i === 3 + (hash(`${q.id}:rel2`) % 3);
    return { id: syntheticId(seed), type: TYPES[hash(`${seed}:t`) % TYPES.length], title, content, relevant };
  });
}

function asQueryResult(m: SyntheticMemory, rank: number): QueryResult {
  return {
    id: m.id,
    namespace: 'team:memory',
    corpus: 'memory',
    sourceType: 'memory',
    sourcePath: null,
    sourceUrl: `/app/memory/${m.id}`,
    content: `${m.title}\n${m.content}`,
    metadata: { memoryId: m.id, type: m.type },
    score: Math.round((0.9 - rank * 0.05) * 100) / 100,
    createdAt: null,
  } as QueryResult;
}

const bodyLine = (m: SyntheticMemory, cap: number) =>
  `- **[${m.type}] ${m.title}**: ${m.content.length > cap ? `${m.content.slice(0, cap)}...` : m.content}`;

const entryOf = (m: SyntheticMemory, why: MemoryIndexEntry['why']): MemoryIndexEntry =>
  ({ id: m.id, type: m.type, title: m.title, why });

export function compareQuery(q: GoldenQueryLike, budgetTokens = DEFAULT_MEMORY_INDEX_TOKEN_BUDGET): QueryComparison {
  const mems = synthesizeMemories(q);
  const claimHits = mems.slice(0, 3);
  const runnerHits = mems.slice(1, 6);
  const replyHits = mems.slice(0, 5);
  const relevant = new Set(mems.filter(m => m.relevant).map(m => m.id));
  const k = new Set([...claimHits, ...runnerHits, ...replyHits].map(m => m.id)).size;
  const recall = (shown: string[]) => recallAtK(shown.map(id => ({ id, sourcePath: null })), relevant, k);

  // Off: bodies on every surface, no dedupe.
  const claimOff = ['### Team memory', ...claimHits.flatMap((m, i) => renderHitLines(asQueryResult(m, i)))].join('\n');
  const runnerOff = ['### Relevant to This Task', ...runnerHits.map(m => bodyLine(m, 300))].join('\n');
  const replyOff = ['## Relevant Memory', 'READ these memories before starting work:', ...replyHits.map(m => bodyLine(m, 200))].join('\n');
  const shownOff = [...new Set([...claimHits, ...runnerHits, ...replyHits].map(m => m.id))];

  // On: one index, the runner block deduped against the claim-time block and
  // charged to the same budget; the reply merges both, deduped.
  const claimIdx = buildMemoryIndex(claimHits.map(m => entryOf(m, 'title')), { budgetTokens });
  const runnerIdx = buildMemoryIndex(runnerHits.map(m => entryOf(m, 'path')), {
    budgetTokens: budgetTokens - memoryIndexEntriesTokens(claimIdx.shown),
    exclude: claimIdx.shown.map(e => e.id),
  });
  const replyIdx = buildMemoryIndex([...claimIdx.shown, ...replyHits.map(m => entryOf(m, 'title'))], { budgetTokens });
  const claimOn = ['### Team memory', ...claimIdx.lines].join('\n');
  const runnerOn = ['### Relevant to This Task', ...runnerIdx.lines].join('\n');
  const replyOn = ['## Relevant Memory', ...replyIdx.lines].join('\n');
  const shownOn = [...new Set([...claimIdx.shown, ...runnerIdx.shown, ...replyIdx.shown].map(e => e.id))];

  const runnerBytesOn = bytes(claimOn) + bytes(runnerOn);
  const pulled = mems.filter(m => m.relevant && shownOn.includes(m.id)).reduce((n, m) => n + bytes(`# ${m.title}\n\n${m.content}`), 0);

  return {
    queryId: q.id,
    k,
    recallOff: recall(shownOff),
    recallOn: recall(shownOn),
    runnerBytesOff: bytes(claimOff) + bytes(runnerOff),
    runnerBytesOn,
    replyBytesOff: bytes(replyOff),
    replyBytesOn: bytes(replyOn),
    runnerBytesOnWithPulls: runnerBytesOn + pulled,
  };
}

export function compareMemoryIndex(queries: readonly GoldenQueryLike[], budgetTokens?: number): ComparisonReport {
  const rows = queries.map(q => compareQuery(q, budgetTokens));
  const sum = (f: (r: QueryComparison) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    queries: rows,
    totals: {
      queries: rows.length,
      meanRecallOff: mean(rows.map(r => r.recallOff)),
      meanRecallOn: mean(rows.map(r => r.recallOn)),
      runnerBytesOff: sum(r => r.runnerBytesOff),
      runnerBytesOn: sum(r => r.runnerBytesOn),
      runnerBytesOnWithPulls: sum(r => r.runnerBytesOnWithPulls),
      replyBytesOff: sum(r => r.replyBytesOff),
      replyBytesOn: sum(r => r.replyBytesOn),
    },
  };
}

const pct = (on: number, off: number) => (off > 0 ? `${Math.round((1 - on / off) * 100)}%` : 'n/a');

export function formatComparison(r: ComparisonReport): string {
  const t = r.totals;
  return [
    `Memory index injection, flag off vs on (${t.queries} golden queries, synthetic memories)`,
    `recall@k        off ${t.meanRecallOff.toFixed(3)}  on ${t.meanRecallOn.toFixed(3)}`,
    `runner prompt   off ${t.runnerBytesOff} B  on ${t.runnerBytesOn} B  saved ${pct(t.runnerBytesOn, t.runnerBytesOff)}`,
    `  with pulls    on ${t.runnerBytesOnWithPulls} B  saved ${pct(t.runnerBytesOnWithPulls, t.runnerBytesOff)}`,
    `claim_task      off ${t.replyBytesOff} B  on ${t.replyBytesOn} B  saved ${pct(t.replyBytesOn, t.replyBytesOff)}`,
  ].join('\n');
}
