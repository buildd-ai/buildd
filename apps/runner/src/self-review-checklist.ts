/**
 * Staged self-review checklist (Living Spec f3742450, step T1).
 *
 * Pure and I/O-free. It complements verify-guard and never re-checks anything
 * verify-guard, the output-requirement gate or the reviewer already covers: the
 * checklist is intent-only, i.e. "did I do what was asked", never "do the
 * tests / typecheck / lint / build pass", PR state, the diff, CI or any
 * verification command (AC-5).
 *
 * No wiring here: callers decide when to show it and must fail open on null.
 */

export const SELF_REVIEW_CHECKLIST_VERSION = 1;

export type SelfReviewItemKind = 'requirement' | 'scope' | 'criterion';

export interface SelfReviewItem {
  /** Stable within a checklist version: req-1.., scope, crit-<id>. */
  id: string;
  kind: SelfReviewItemKind;
  text: string;
}

export interface SelfReviewChecklist {
  version: number;
  items: SelfReviewItem[];
}

export interface SelfReviewTaskInput {
  title?: string | null;
  description?: string | null;
  /** Declared paths the task is expected to touch. */
  pathManifest?: unknown;
  /** Living Spec acceptance criterion ids (e.g. "AC-3"). */
  specCriterionIds?: string[] | null;
}

export interface SelfReviewExemptionInput {
  error?: unknown;
  blockedOnTaskId?: string | null;
  discardEdits?: boolean;
  roleSlug?: string | null;
  bookkeeping?: boolean;
  planning?: boolean;
  alreadyShippedIn?: number | string | null;
  outputRequirement?: string | null;
}

/** Mechanical verification topics; items about these belong to verify-guard. */
const DENYLIST =
  /\b(tests?|testing|typecheck|type-check|type check|tsc|lint(ing|er)?|eslint|build|builds|pull request|prs?|diff|ci|verification|verify|verifies|verified)\b/i;

export function isMechanicalItem(text: string): boolean {
  return DENYLIST.test(text);
}

const REQUIREMENT_LINE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.+?)\s*$/;

function requirementLines(description: string): string[] {
  const out: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = REQUIREMENT_LINE.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

function manifestPaths(manifest: unknown): string[] {
  if (!Array.isArray(manifest)) return [];
  const paths: string[] = [];
  for (const entry of manifest) {
    if (typeof entry === 'string' && entry.trim()) paths.push(entry.trim());
    else if (entry && typeof entry === 'object' && typeof (entry as any).path === 'string' && (entry as any).path.trim()) {
      paths.push((entry as any).path.trim());
    }
  }
  return paths;
}

function build(task: SelfReviewTaskInput): SelfReviewChecklist {
  const items: SelfReviewItem[] = [];
  let n = 0;
  for (const line of requirementLines(task.description ?? '')) {
    if (isMechanicalItem(line)) continue;
    n += 1;
    items.push({ id: `req-${n}`, kind: 'requirement', text: `Did you deliver: ${line}` });
  }
  const paths = manifestPaths(task.pathManifest);
  if (paths.length > 0) {
    items.push({
      id: 'scope',
      kind: 'scope',
      text: `Did the work stay within the declared scope (${paths.join(', ')}), with nothing unrelated changed?`,
    });
  }
  for (const raw of task.specCriterionIds ?? []) {
    const id = String(raw).trim();
    if (!id) continue;
    items.push({ id: `crit-${id}`, kind: 'criterion', text: `Is spec criterion ${id} met?` });
  }
  return { version: SELF_REVIEW_CHECKLIST_VERSION, items };
}

/**
 * Build the checklist for a task. Returns null if building throws, so the
 * caller fails open (AC-7). An empty checklist is returned as-is; callers
 * should treat zero items as "nothing to ask".
 */
export function buildSelfReviewChecklist(task: SelfReviewTaskInput): SelfReviewChecklist | null {
  try {
    return build(task);
  } catch {
    return null;
  }
}

const EXEMPT_ROLES: Record<string, string> = {
  reviewer: 'reviewer-role',
  'visual-auditor': 'visual-auditor-role',
};

/** Reason this task skips the stage, or null when the stage applies (AC-3). */
export function selfReviewExemption(input: SelfReviewExemptionInput): string | null {
  if (input.error) return 'error';
  if (input.blockedOnTaskId) return 'blocked';
  if (input.discardEdits) return 'discard-edits';
  const role = input.roleSlug?.trim().toLowerCase();
  if (role && EXEMPT_ROLES[role]) return EXEMPT_ROLES[role];
  if (input.bookkeeping) return 'bookkeeping';
  if (input.planning) return 'planning';
  if (input.alreadyShippedIn !== undefined && input.alreadyShippedIn !== null && input.alreadyShippedIn !== '') {
    return 'already-shipped';
  }
  if (input.outputRequirement === 'none') return 'output-requirement-none';
  return null;
}
