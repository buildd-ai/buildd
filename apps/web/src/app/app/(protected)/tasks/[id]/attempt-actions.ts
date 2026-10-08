/**
 * What an attempt did that a diff cannot show. A CI fix whose whole job was a
 * PR-body edit, a re-run or a comment pushes no commit, and "+0 −0 · 0 files"
 * reads as "nothing happened". Read from the worker's recorded tool calls
 * (milestones of type `action`), never from its summary.
 */
import type { WorkerMilestone } from '@buildd/core/db/schema';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgh\s+pr\s+edit\b[^\n]*(?:--body|-b\b|--body-file|-F\b)/, 'Edited PR body'],
  [/\bgh\s+pr\s+edit\b[^\n]*(?:--title|-t\b)/, 'Edited PR title'],
  [/\bgh\s+api\b[^\n]*\/pulls\/\d+\b[^\n]*(?:-X\s*PATCH|--method\s+PATCH)[^\n]*\bbody=/, 'Edited PR body'],
  [/\bgh\s+(?:run\s+rerun|workflow\s+run)\b|\/actions\/(?:runs|jobs)\/\d+\/rerun/, 'Re-ran checks'],
  [/\bgh\s+pr\s+(?:comment|review)\b|\/issues\/\d+\/comments\b/, 'Posted a comment'],
];

/** The non-diff actions an attempt took, deduplicated, in rule order. */
export function nonDiffActions(milestones: readonly WorkerMilestone[] | null | undefined): string[] {
  const found = new Set<string>();
  for (const m of milestones ?? []) {
    if (m.type !== 'action') continue;
    const cmd = [(m as { cmd?: string }).cmd, m.label].filter(Boolean).join('\n');
    for (const [re, label] of RULES) if (re.test(cmd)) found.add(label);
  }
  return RULES.map(([, l]) => l).filter((l, i, all) => found.has(l) && all.indexOf(l) === i);
}
