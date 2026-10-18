/**
 * Which conformance scenarios cover each row of the
 * docs/specs/workflow-state-kernel.md §16 test matrix. A row is covered by
 * scenarios named here (each entry is the start of exactly one scenario
 * name, so a rename breaks the guard instead of silently dropping the row),
 * or exempted with a reason when it is not kernel behaviour. The guard
 * (packages/core/__tests__/workflow-kernel-matrix-coverage.test.ts) fails when a row of the spec has no entry, when
 * an entry names no scenario, and when an exemption has no reason.
 *
 * `hostSide` records the part of a covered row the kernel does not decide
 * (a route, a UI surface, a fact reader); the host's own tests carry it.
 */
export type MatrixRow = { scenarios: string[]; hostSide?: string } | { exempt: string };

export const MATRIX_COVERAGE: Record<string, MatrixRow> = {
  S1: { scenarios: ['S1:'], hostSide: 'the completion gate\'s 400 delivery_not_advanced is the worker route\'s' },
  S2: { scenarios: ['S2:'] },
  S3: { scenarios: ['S3:'], hostSide: 'the fact layer that decides content-equivalence and own_refresh is the host\'s' },
  S4: { scenarios: ['S4:'] },
  S5: { scenarios: ['S5: a duplicate event'] },
  S6: { scenarios: ['S6:'], hostSide: 'the workers columns and the old-SHA CI fact cache are written by the host\'s funnel' },
  S7: { scenarios: ['S7:'] },
  S8: { scenarios: ['S8:'] },
  S9: { scenarios: ['S9:'], hostSide: 'the reaper\'s own task write (never completed with a result sha) is the host\'s' },
  S10: {
    scenarios: [
      'handlers/landing: the merge is pinned to the approved head',
      'handlers/landing: an indeterminate answer at an open, unmoved head',
      'AC-11 (the kernel',
    ],
  },
  S11: { scenarios: ['S11:', 'AC-15: a person merges on GitHub over an open verdict'] },
  S12: { scenarios: ['S12:', 'handlers/supersession:'], hostSide: 'the caller-task authorisation and mission completion are the host\'s' },
  S13: { scenarios: ['S13:'] },
  S14: { exempt: 'a static write-site guard over source files, not a state-machine behaviour: packages/core/__tests__/workflow-write-sites.test.ts reads the tree and fails on a guarded write outside the allowlist' },
  S15: { scenarios: ['S15:', 'lane: one holder per repo + base'], hostSide: 'the disjoint-delta rule\'s inputs and the landing-lane config are read by the host' },
  S16: { scenarios: ['S16:'], hostSide: 'canCompleteMission and the legacy inputs are the host\'s' },
  S17: { scenarios: ['S17:'], hostSide: 'each UI surface (home chip, task header, chat dock, PR pill) reading the one view is the host\'s' },
  S18: { scenarios: ['S18:'], hostSide: 'the branch deletion is detected and the re-opened PR found by the host\'s scan' },
  S19: { scenarios: ['S19:'] },
  S20: { scenarios: ['S20:'], hostSide: 'the routes\' HTTP 409 is the host\'s' },
  S21: { scenarios: ['S21:'], hostSide: 'the owner / caller-names-PR / sibling / other-workspace / human matrix is decided by the routes, which hand the kernel an authorised flag' },
  S22: { scenarios: ['drain §14: a switched-off delivery is released'] },
  S23: { scenarios: ['S23:'], hostSide: 'the manual "Fix CI" cap is read by the route from workspace config' },
  S24: { scenarios: ['S24:', 'handlers/trunk: one trunk fix per red base'] },
  S25: {
    scenarios: [
      'handlers/ci: a fix owed at a head that moved',
      'handlers/review: a fix owed for a round the delivery moved on from',
      'handlers/conflict: an agent fix whose bound head moved files nothing',
    ],
  },
  S26: { scenarios: ['handlers/activity: every transition is rendered'], hostSide: 'the sticky comment\'s text and the duplicate-comment cleanup are the host\'s renderer' },
  S27: {
    scenarios: [
      'handlers/conflict: a refused mechanical refresh allocates the agent attempt',
      'handlers/conflict: T26',
    ],
    hostSide: 'the byte-identical-renumber test and the lagging-mission-branch collision read git, which the host does',
  },
  S28: { scenarios: ['S28:'], hostSide: 'the comment and explain texts that print the same 1-based count are the host\'s' },
  S29: { scenarios: ['S29:', '1bd26ae7: dispatch_review that cannot file a reviewer'], hostSide: 'telling prose from a verdict, and the legacy requeue and note, are the host\'s' },
  S30: { scenarios: ['S30:'], hostSide: 'the runner deciding no outcome was confirmed is the runner\'s' },
  S31: { scenarios: ['S31:'], hostSide: 'create_pr refusing a body the CI scan would reject, and the runner preflight, are the host\'s' },
  S32: { scenarios: ['S32:'] },
  S33: { scenarios: ['S33:', 'handlers/review: a composition'] },
  S34: { scenarios: ['S34:'] },
  S35: { scenarios: ['S35:'] },
  S36: { scenarios: ['S36:'], hostSide: 'the Home and task surfaces projecting it are the host\'s' },
  S37: { scenarios: ['S37:', 'handlers/conflict: an agent fix whose bound head moved files nothing'], hostSide: 'finding and repairing the stalled task is the host\'s' },
  S38: { scenarios: ['S32:', 'S33:', 'S34:'], hostSide: 'reading the merge from whole trees (constituent proof, CI-regenerated files, a renumbered migration) builds the attestation and is the host\'s' },
};

/** The row ids of §16's table, in the order the spec lists them. */
export function specMatrixRows(markdown: string): string[] {
  const start = markdown.indexOf('\n## 16. Test matrix');
  if (start < 0) throw new Error('the spec has no "## 16. Test matrix" section');
  const rest = markdown.slice(start + 1);
  const end = rest.slice(3).search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end + 3);
  return [...section.matchAll(/^\| (S\d+) \|/gm)].map((m) => m[1]!);
}

/** Row ids that have no scenario (or exemption), and entries that name no scenario or more than one. */
export function matrixProblems(rows: string[], coverage: Record<string, MatrixRow>, scenarioNames: string[]): string[] {
  const problems: string[] = [];
  for (const id of rows) {
    const entry = coverage[id];
    if (!entry) { problems.push(`${id}: no scenario and no exemption`); continue; }
    if ('exempt' in entry) {
      if (entry.exempt.trim().length < 30) problems.push(`${id}: an exemption needs a real reason`);
      continue;
    }
    if (entry.scenarios.length === 0) problems.push(`${id}: names no scenario`);
    for (const prefix of entry.scenarios) {
      const hits = scenarioNames.filter((n) => n.startsWith(prefix));
      if (hits.length !== 1) problems.push(`${id}: "${prefix}" matches ${hits.length} scenarios, want exactly 1`);
    }
  }
  for (const id of Object.keys(coverage)) if (!rows.includes(id)) problems.push(`${id}: not a row of the spec's §16`);
  return problems;
}
