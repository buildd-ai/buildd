import { criterionFingerprint, isStandardCriterion } from '@buildd/core/mission-helpers';
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';

/**
 * The completion gate's and Verify's reading of a mission's standards (Living
 * Specs D-43, Navigation R-17). Pure and free of the database: the completion
 * gate, pages and client components import it. Snapshotting and the marker
 * live in ./standards.ts.
 */

/** Opt-in until the shadow logs are read. Anything but `enforce` is shadow. */
export function standardsGateEnforced(): boolean {
  return process.env.STANDARDS_GATE === 'enforce';
}

// ── The completion gate's reading ────────────────────────────────────────────

export interface StandardsHold {
  /** Each standard not passing on the integrated result, with its verdict. */
  unmet: Array<{ specId: string; label: string; verdict: string }>;
  enforced: boolean;
}

/**
 * Pure: the mission's standards that do not pass, from the evaluated state. A
 * standard with no entry, or an entry produced for another selection, is not
 * a pass. Null when the mission carries no standards or every one passes.
 */
export function standardsHoldOf(criteria: readonly GoalCriterion[], state: GoalCriteriaState | null, enforced = standardsGateEnforced()): StandardsHold | null {
  const byIndex = new Map((state?.criteria ?? []).map((e) => [e.index, e]));
  const unmet: StandardsHold['unmet'] = [];
  criteria.forEach((c, i) => {
    if (!isStandardCriterion(c) || c.type !== 'living_spec') return;
    const e = byIndex.get(i);
    const current = e && (!e.fingerprint || e.fingerprint === criterionFingerprint(c));
    const verdict = current ? e!.verdict : 'NOT_EVALUATED';
    if (verdict !== 'pass') unmet.push({ specId: c.specId, label: c.label ?? `Standard revision ${c.revision}`, verdict });
  });
  return unmet.length ? { unmet, enforced } : null;
}

// ── Verify's Standards line (Navigation R-17) ────────────────────────────────

export type StandardItemStatus = 'met' | 'not_met' | 'checking' | 'not_checked';

export interface StandardItem {
  key: string;
  label: string;
  status: StandardItemStatus;
  /** The spec page, for a spec standard. */
  href: string | null;
}

export interface StandardsLine {
  /** `All met`, how many are not met, or how many of all are met so far. `None` with nothing to check. */
  text: string;
  allMet: boolean;
  /** Opened on its own only when one fails; otherwise on request. */
  open: boolean;
  items: StandardItem[];
}

const statusOfVerdict = (v: string | undefined): StandardItemStatus =>
  v === 'pass' ? 'met' : v === 'fail' ? 'not_met' : v === 'PENDING' ? 'checking' : 'not_checked';

/**
 * The Standards line of Verify: CI and code review, from the merge policy,
 * beside the mission's spec standards (product voice, the design system, …).
 * Pure; `ci` and `codeReview` are null when the merge policy has no such
 * check, and are then left out.
 */
export function standardsLine(input: {
  criteria: readonly GoalCriterion[];
  state: GoalCriteriaState | null;
  ci: StandardItemStatus | null;
  codeReview: StandardItemStatus | null;
  /** Spec titles by id, when loaded; else the entry's label. */
  titles?: Readonly<Record<string, string>>;
}): StandardsLine {
  const byIndex = new Map((input.state?.criteria ?? []).map((e) => [e.index, e]));
  const items: StandardItem[] = [];
  if (input.ci) items.push({ key: 'ci', label: 'CI', status: input.ci, href: null });
  if (input.codeReview) items.push({ key: 'code-review', label: 'Code review', status: input.codeReview, href: null });
  input.criteria.forEach((c, i) => {
    if (!isStandardCriterion(c) || c.type !== 'living_spec') return;
    const e = byIndex.get(i);
    const current = e && (!e.fingerprint || e.fingerprint === criterionFingerprint(c));
    items.push({
      key: `standard-${c.specId}`,
      label: input.titles?.[c.specId] ?? c.label ?? `Standard revision ${c.revision}`,
      status: current ? statusOfVerdict(e!.verdict) : 'not_checked',
      href: `/app/specs/${c.specId}`,
    });
  });
  const notMet = items.filter((it) => it.status === 'not_met').length;
  const allMet = items.length > 0 && items.every((it) => it.status === 'met');
  const text = items.length === 0 ? 'None' : allMet ? 'All met' : notMet > 0 ? `${notMet} not met` : `${items.filter((it) => it.status === 'met').length} of ${items.length} met`;
  return { text, allMet, open: notMet > 0, items };
}
