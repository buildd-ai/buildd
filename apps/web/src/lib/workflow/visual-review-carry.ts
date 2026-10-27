/**
 * Does a new commit void an earlier visual review? Only when the mission's OWN
 * rendered-UI delta moved since the reviewed commit. Pure path-diff rule, no
 * audit loop: a migration-only commit, or a dev merge that brings in trunk's
 * (already reviewed) UI changes, leaves the review valid.
 *
 * Both diffs are branch-against-trunk (three-dot), so a change that arrived by
 * merging trunk is in neither: only what the mission itself edited shows up.
 * A UI file counts as moved when it is in one diff and not the other, or its
 * patch differs. A file whose patch GitHub did not return cannot be shown
 * unchanged, so it counts as moved.
 */
import { classifyImpactFile, type ImpactFile } from './visual-review-impact';

/** What the scheduler records on the audit task for one head: the evidence for the page and every merge door. */
export interface ReviewCarry {
  /** The head this judgement is for. */
  headSha: string;
  /** The reviewed commit the review is carried from. */
  from: string;
  state: 'carried' | 'changed';
  /** The UI files that moved since the review (empty when carried). */
  files: string[];
}

const MAX_FILES = 20;

function renderedPatches(files: readonly ImpactFile[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of files) {
    if (classifyImpactFile(f) === 'no_render') continue;
    out.set(f.path, f.patch ?? null);
  }
  return out;
}

export function judgeReviewCarry(
  auditedDiff: readonly ImpactFile[],
  headDiff: readonly ImpactFile[],
): { state: 'carried' | 'changed'; files: string[] } {
  const was = renderedPatches(auditedDiff);
  const now = renderedPatches(headDiff);
  const moved: string[] = [];
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(path);
    const b = now.get(path);
    const same = a !== undefined && b !== undefined && a !== null && b !== null && a === b;
    if (!same) moved.push(path);
  }
  moved.sort();
  return moved.length === 0 ? { state: 'carried', files: [] } : { state: 'changed', files: moved.slice(0, MAX_FILES) };
}

/** `context.visualReview.carry`, when it is well-formed. */
export function readReviewCarry(auditContext: unknown): ReviewCarry | null {
  const vr = auditContext && typeof auditContext === 'object' && !Array.isArray(auditContext)
    ? (auditContext as Record<string, unknown>).visualReview : null;
  const c = vr && typeof vr === 'object' ? (vr as Record<string, unknown>).carry : null;
  if (!c || typeof c !== 'object') return null;
  const { headSha, from, state, files } = c as Record<string, unknown>;
  if (typeof headSha !== 'string' || typeof from !== 'string') return null;
  if (state !== 'carried' && state !== 'changed') return null;
  return { headSha: headSha.toLowerCase(), from: from.toLowerCase(), state, files: Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [] };
}

/** The one line that says why a review was voided. */
export function uiDeltaLine(files: readonly string[]): string {
  const shown = files.slice(0, 3).map(f => f.split('/').slice(-2).join('/'));
  const more = files.length - shown.length;
  return `New UI changes since your review: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}
