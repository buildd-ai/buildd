/**
 * The task page's agent-error evidence, as rows a person can review: each
 * stored trace with its parsed command and output (never clipped), what the
 * rules say it means (lib/trace-consequence.ts), which attempt it came from,
 * and what the agent did just before and after it.
 *
 * Pure: the page loads traces, consequences, attempt labels and worker
 * milestones; `TaskErrorEvidence.tsx` renders the result.
 */
import { BASH_FAILURE_PATTERN, parseBashTraceExcerpt, verifyFamilyOf } from '@buildd/core/bash-failure-trace';
import type { TraceConsequence, TracePresentation } from '@/lib/trace-consequence';

export interface ErrorEvidenceContextLine {
  ts: string;
  text: string;
}

export interface ErrorEvidenceItem {
  id: string;
  pattern: string;
  source: string | null;
  /** ISO timestamp. */
  ts: string;
  /** The full stored (already redacted) excerpt, never clipped. */
  excerpt: string;
  /** Parsed from a `bash_nonzero_exit` excerpt; null for any other pattern. */
  command: string | null;
  exitCode: number | null;
  /** Output after the `$ cmd [exit N]` header, or the whole excerpt when unparsed. */
  output: string;
  presentation: TracePresentation;
  reason: string;
  decidedBy: 'rule' | 'model';
  /** A plain name for the event, when a rule knows it; the row shows it instead of the excerpt. */
  headline: string | null;
  attempt: { label: string; workerId: string | null };
  /** What the agent did just before / after, oldest first (at most 4 each). */
  before: ErrorEvidenceContextLine[];
  after: ErrorEvidenceContextLine[];
  /** A CI or log URL that appears in the excerpt itself; never invented. */
  logUrl: string | null;
}

/**
 * One `workers.milestones` entry (`WorkerMilestone` in packages/core/db/schema.ts):
 * `{ type, label?, ts: number (epoch ms), cmd?, path?, tool?, event? }`. Typed
 * loosely because the column is jsonb written by runners of many versions.
 */
export interface EvidenceMilestone {
  type?: string;
  label?: string;
  text?: string;
  ts?: number | string;
  tool?: string;
  path?: string;
  cmd?: string;
  event?: string;
}

export interface ErrorEvidenceTrace {
  id: string;
  workerId: string | null;
  pattern: string;
  excerpt: string;
  source: string | null;
  ts: Date | string;
}

const CONTEXT_LINES = 4;
const FALLBACK_ATTEMPT = 'Attempt';
const UNCLASSIFIED: TraceConsequence = {
  presentation: 'unclear',
  reason: 'The record does not say whether this affected the outcome.',
  decidedBy: 'rule',
};

function toMs(ts: Date | string | number | null | undefined): number | null {
  if (ts == null || ts === '') return null;
  const n = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

function toIso(ts: Date | string): string {
  const ms = toMs(ts);
  return ms == null ? String(ts) : new Date(ms).toISOString();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** The one line a milestone reads as, or null when it says nothing. */
function milestoneText(m: EvidenceMilestone): string | null {
  const cmd = str(m.cmd);
  const tool = str(m.tool);
  const path = str(m.path);
  return (
    str(m.text) ??
    str(m.label) ??
    (cmd ? `$ ${cmd}` : null) ??
    (tool && path ? `${tool} ${path}` : null) ??
    path ??
    str(m.event)
  );
}

function contextFor(
  traceMs: number | null,
  milestones: ReadonlyArray<EvidenceMilestone> | null | undefined,
): { before: ErrorEvidenceContextLine[]; after: ErrorEvidenceContextLine[] } {
  if (traceMs == null || !Array.isArray(milestones)) return { before: [], after: [] };
  const lines = milestones
    .flatMap(m => {
      if (!m || typeof m !== 'object') return [];
      const ms = toMs(m.ts);
      const text = milestoneText(m);
      return ms == null || !text ? [] : [{ ms, text }];
    })
    .sort((a, b) => a.ms - b.ms);
  const line = (l: { ms: number; text: string }) => ({ ts: new Date(l.ms).toISOString(), text: l.text });
  return {
    before: lines.filter(l => l.ms <= traceMs).slice(-CONTEXT_LINES).map(line),
    after: lines.filter(l => l.ms > traceMs).slice(0, CONTEXT_LINES).map(line),
  };
}

const LOG_URL = /https?:\/\/[^\s"'<>)\]]*(?:\/actions\/runs\/|\/checks?\b|\/logs?\b|\/jobs?\/)[^\s"'<>)\]]*/i;

export function buildErrorEvidenceItems(input: {
  traces: ReadonlyArray<ErrorEvidenceTrace>;
  consequences: ReadonlyMap<string, TraceConsequence>;
  attemptLabelByWorker: ReadonlyMap<string, string>;
  milestonesByWorker: ReadonlyMap<string, ReadonlyArray<EvidenceMilestone> | null | undefined>;
}): ErrorEvidenceItem[] {
  const items = input.traces.map(t => {
    const parsed = t.pattern === BASH_FAILURE_PATTERN ? parseBashTraceExcerpt(t.excerpt) : null;
    const consequence = input.consequences.get(t.id) ?? UNCLASSIFIED;
    const traceMs = toMs(t.ts);
    const { before, after } = contextFor(traceMs, t.workerId ? input.milestonesByWorker.get(t.workerId) : null);
    const item: ErrorEvidenceItem = {
      id: t.id,
      pattern: t.pattern,
      source: t.source ?? null,
      ts: toIso(t.ts),
      excerpt: t.excerpt,
      command: parsed ? parsed.command : null,
      exitCode: parsed ? parsed.exitCode : null,
      output: parsed ? parsed.output : t.excerpt,
      presentation: consequence.presentation,
      reason: consequence.reason,
      decidedBy: consequence.decidedBy,
      headline: consequence.headline ?? null,
      attempt: {
        label: (t.workerId && input.attemptLabelByWorker.get(t.workerId)) || FALLBACK_ATTEMPT,
        workerId: t.workerId ?? null,
      },
      before,
      after,
      logUrl: LOG_URL.exec(t.excerpt)?.[0] ?? null,
    };
    return { item, ms: traceMs ?? 0 };
  });
  return items.sort((a, b) => b.ms - a.ms).map(x => x.item);
}

export interface GroupedErrorEvidence {
  attention: ErrorEvidenceItem[];
  unclear: ErrorEvidenceItem[];
  recovered: ErrorEvidenceItem[];
  noise: ErrorEvidenceItem[];
}

export function groupErrorEvidence(items: ReadonlyArray<ErrorEvidenceItem>): GroupedErrorEvidence {
  const g: GroupedErrorEvidence = { attention: [], unclear: [], recovered: [], noise: [] };
  for (const item of items) {
    if (item.presentation === 'needs_attention') g.attention.push(item);
    else if (item.presentation === 'recovered') g.recovered.push(item);
    else if (item.presentation === 'noise') g.noise.push(item);
    else g.unclear.push(item);
  }
  return g;
}

const ATTENTION_BY_FAMILY = {
  test: 'Tests did not pass, so the change is not verified.',
  typecheck: 'The type check did not pass, so the code may not build.',
  lint: 'Lint did not pass, so CI may reject the change.',
} as const;

/**
 * What the trace means for the result, in one plain sentence. The rule's own
 * reason when it has one; the verify-family line for a failed check, which
 * says what it costs. Rows and the evidence sheet both show only this, once.
 */
export function affectsLine(item: Pick<ErrorEvidenceItem, 'presentation' | 'command' | 'pattern' | 'reason' | 'decidedBy'>): string {
  const family = item.command ? verifyFamilyOf(item.command) : null;
  if (item.presentation === 'needs_attention') {
    if (family) return ATTENTION_BY_FAMILY[family];
    if (item.decidedBy === 'model') {
      return item.command
        ? 'This command failed and the work never got past it.'
        : 'This error may have stopped the work.';
    }
  }
  return item.reason;
}
