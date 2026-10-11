/**
 * A task's result as people read it (docs/specs/task-page.md): prose and, for
 * a review, a verdict. Agents often hand back their structured output as the
 * summary string itself (`{"summary": …, "verdict": "approve", "confidence":
 * 0.8}`), and the page used to print that string. This reads the known result
 * shape out of either the summary or `structuredOutput`; the untouched payload
 * is returned as `raw`, for the Raw output diagnostic only. Pure.
 */
import type { PrReviewVerdict } from '@/lib/pr-review-status';

export type ReviewVerdictWord = PrReviewVerdict;

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdictWord, string> = {
  approve: 'Review approved',
  'request-changes': 'Changes requested',
  escalate: 'Escalated to a person',
};

export interface ReadableResult {
  /** The result as prose (paragraphs kept), or null when there is none. */
  prose: string | null;
  verdict: ReviewVerdictWord | null;
  /** The structured payload as recorded, for Raw output; null for plain text. */
  raw: Record<string, unknown> | null;
  /** The summary looked like JSON but did not parse: prose is the text as-is. */
  malformed: boolean;
}

const PROSE_KEYS = ['summary', 'message', 'text'] as const;
const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i;

/** Every spelling the reviewer contract has produced, to the one vocabulary. */
export function normaliseReviewVerdict(v: unknown): ReviewVerdictWord | null {
  if (typeof v !== 'string') return null;
  switch (v.trim().toLowerCase().replace(/_/g, '-')) {
    case 'approve': case 'approved': return 'approve';
    case 'request-changes': case 'changes-requested': return 'request-changes';
    case 'escalate': case 'escalated': return 'escalate';
    default: return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function proseOf(o: Record<string, unknown> | null): string | null {
  if (!o) return null;
  for (const k of PROSE_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** A summary that is JSON (bare or fenced): parsed, or `malformed` when it only looks like it. */
function parseJsonish(text: string): { obj: Record<string, unknown> | null; malformed: boolean } {
  const body = FENCE_RE.exec(text)?.[1]?.trim() ?? text;
  if (!body.startsWith('{')) return { obj: null, malformed: false };
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? { obj: parsed, malformed: false } : { obj: null, malformed: true };
  } catch {
    return { obj: null, malformed: true };
  }
}

export function readableTaskResult(summary: unknown, structuredOutput: unknown): ReadableResult {
  const text = typeof summary === 'string' ? summary.trim() : '';
  const structured = isObject(structuredOutput) ? structuredOutput : null;
  const parsed = text ? parseJsonish(text) : { obj: null, malformed: false };

  let prose: string | null;
  if (parsed.obj) prose = proseOf(parsed.obj);
  else prose = text || null;
  if (!prose) prose = proseOf(structured);

  const raw = parsed.obj || structured ? { ...(structured ?? {}), ...(parsed.obj ?? {}) } : null;
  return {
    prose,
    verdict: normaliseReviewVerdict(parsed.obj?.verdict) ?? normaliseReviewVerdict(structured?.verdict),
    raw,
    malformed: parsed.malformed,
  };
}
