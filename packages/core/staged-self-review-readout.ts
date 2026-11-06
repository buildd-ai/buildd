/**
 * Staged self-review readout: turns the structured records the runner stores
 * as worker milestones into the touch / flip rates and the rubber-stamp label
 * (classifyStagedReview). Pure; the query half is staged-self-review-readout-source.ts.
 *
 * Two label shapes carry a record: `Self-review record: {json}` (recording
 * mode, bounded to stay valid JSON) and `Self-review: {json}` (the acting
 * hook's entry, possibly cut at the label cap, in which case it is skipped
 * rather than guessed at). Only a stage that was answered counts: a denial
 * with no answer, an exemption or a control arm says nothing about touching.
 */
import { classifyStagedReview, type StagedReviewReadout, type StagedReviewRecord } from './staged-self-review';

const RECORD_PREFIXES = ['Self-review record: ', 'Self-review: '];

export interface MilestoneLike { label?: string | null }

function answerValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(a => (a && typeof a === 'object' ? String((a as { answer?: unknown }).answer ?? '') : String(a ?? '')));
}

/** One milestone label to a staged record, or null when it is not an answered one. */
export function parseStagedRecordLabel(label: string | null | undefined, taskId?: string): StagedReviewRecord | null {
  if (!label) return null;
  const prefix = RECORD_PREFIXES.find(p => label.startsWith(p) && label.charAt(p.length) === '{');
  if (!prefix) return null;
  let j: Record<string, any>;
  try { j = JSON.parse(label.slice(prefix.length)); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const answers = answerValues(j.answers);
  // Recording mode never asks, so an answer is only volunteered; acting rows must be 'answered'.
  if (j.outcome === 'answered' || (j.mode === 'recording' && j.outcome === 'eligible' && answers.length > 0)) {
    return {
      taskId,
      toolCallsBetween: Array.isArray(j.toolCallsBetween) ? j.toolCallsBetween.map(String) : [],
      changedAfterDenial: j.workChangedAfterDenial === true,
      answers,
    };
  }
  return null;
}

/** The answered staged records across workers, at most one per task (the last wins). */
export function stagedRecordsFromWorkers(
  workers: ReadonlyArray<{ taskId: string | null; milestones?: ReadonlyArray<MilestoneLike> | null }>,
): StagedReviewRecord[] {
  const byTask = new Map<string, StagedReviewRecord>();
  for (const w of workers) {
    for (const m of w.milestones ?? []) {
      const rec = parseStagedRecordLabel(m?.label, w.taskId ?? undefined);
      if (rec) byTask.set(w.taskId ?? `w${byTask.size}`, rec);
    }
  }
  return [...byTask.values()];
}

export function computeStagedReadout(
  workers: Parameters<typeof stagedRecordsFromWorkers>[0],
  limits: { touchRate?: number; flipRate?: number } = {},
): StagedReviewReadout & { label: 'rubber_stamped' | 'not_rubber_stamped' | 'no_records' } {
  const out = classifyStagedReview(stagedRecordsFromWorkers(workers), limits);
  return { ...out, label: out.n === 0 ? 'no_records' : out.rubberStamped ? 'rubber_stamped' : 'not_rubber_stamped' };
}
