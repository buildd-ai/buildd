import type { Verdict } from './outcome';

/**
 * Check commands on spec criteria (Living Specs V1, mechanical path). A
 * requirement (R-n) or acceptance criterion (AC-n) may name one command that
 * decides it, on a line of its own under the criterion:
 *
 *   R-1: Totals are in the shopper's currency.
 *     check: `bun run scripts/run-unit-tests.ts apps/web/src/lib/fx.test.ts`
 *
 * The line belongs to the nearest criterion above it, until the next id or
 * heading. The first check under a criterion wins; one under a decision, an
 * invariant or a heading is ignored. Fenced blocks are skipped, as the id
 * parser skips them. Parsed from the body, like the ids: the approved
 * revision's text is the only place a check lives.
 */
export interface CriterionCheck { criterionId: string; command: string }

export const MAX_CHECK_COMMAND = 1000;

const ID = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?(?:\*\*|__)?\s*(R|AC|D|I)-(\d+)\b/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Every `<label>: value` line under a criterion, in order, by the same rule as
 * check lines: the line belongs to the nearest R-n or AC-n above it, until the
 * next id or heading; fenced blocks are skipped; a repeated id owns nothing.
 */
export function criterionLines(body: string, label: string): Array<{ criterionId: string; value: string }> {
  const LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?(?:\\*\\*|__)?${label}(?:\\*\\*|__)?\\s*:\\s*(.+?)\\s*$`, 'i');
  const out: Array<{ criterionId: string; value: string }> = [];
  const seen = new Set<string>();
  let current: string | null = null;
  let fenced = false;
  for (const raw of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const id = ID.exec(raw);
    if (id) {
      const key = `${id[1]}-${Number(id[2])}`;
      // The first definition of an id wins (requirements.ts); a repeat owns no line.
      current = (id[1] === 'R' || id[1] === 'AC') && !seen.has(key) ? key : null;
      seen.add(key);
      continue;
    }
    if (HEADING.test(raw)) { current = null; continue; }
    const m = LINE.exec(raw);
    if (m && current) out.push({ criterionId: current, value: m[1]! });
  }
  return out;
}

export function criterionChecks(body: string): CriterionCheck[] {
  const out: CriterionCheck[] = [];
  const checked = new Set<string>();
  for (const { criterionId, value } of criterionLines(body, 'check')) {
    if (checked.has(criterionId)) continue;
    const command = value.replace(/^`+|`+$/g, '').trim();
    if (!command || command.length > MAX_CHECK_COMMAND) continue;
    checked.add(criterionId);
    out.push({ criterionId, command });
  }
  return out;
}

/**
 * The design screens a criterion covers (D-8), named on a line under it:
 *
 *   - AC-2: An empty cart shows the empty state.
 *     screen: cart-empty, cart-empty-mobile
 *
 * Ids are matched against the revision's design reference by the host.
 * Several lines under one criterion add up; repeats are dropped.
 */
export function criterionScreens(body: string): Array<{ criterionId: string; screens: string[] }> {
  const byId = new Map<string, string[]>();
  for (const { criterionId, value } of criterionLines(body, 'screens?')) {
    const list = byId.get(criterionId) ?? [];
    for (const s of value.split(',').map((x) => x.replace(/`/g, '').trim()).filter(Boolean)) if (!list.includes(s)) list.push(s);
    byId.set(criterionId, list);
  }
  return [...byId].map(([criterionId, screens]) => ({ criterionId, screens }));
}

/** The exit code the wrapper uses when the judged commit cannot be checked out. */
export const CHECKOUT_FAILED_EXIT = 125;

/**
 * The command a verification task runs: the criterion's command at exactly
 * `headSha`. The worktree is cut from the PR's branch, which may have moved
 * since; checking the commit out first binds the exit code to the head the
 * verdict names. A checkout that fails exits 125, read as inconclusive, never
 * as a failure of the criterion.
 */
export function checkCommandAt(command: string, headSha: string): string {
  const sha = headSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('headSha must be a full commit SHA');
  return `(git fetch -q origin ${sha} >/dev/null 2>&1; git checkout -q --detach ${sha}) || exit ${CHECKOUT_FAILED_EXIT}; ${command}`;
}

export interface CheckRunEvidence { outcome?: unknown; exitCode?: unknown }

/**
 * A run's verdict: exit 0 passes, a non-zero exit of the command fails. A
 * timeout, a command that never launched, or a checkout of the head that
 * failed asserted nothing about the criterion, so it is inconclusive.
 */
export function checkVerdict(ev: CheckRunEvidence): Verdict | null {
  if (ev.outcome === 'ok') return 'pass';
  if (ev.outcome === 'timeout' || ev.outcome === 'exec_error') return 'inconclusive';
  if (ev.outcome === 'failed') return ev.exitCode === CHECKOUT_FAILED_EXIT ? 'inconclusive' : 'fail';
  return null;
}
