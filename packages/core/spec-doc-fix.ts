/**
 * The doc-fix dispatch — docs/design/spec-conformance.md §8/§12.
 *
 * §8's promotion table says the only valid actions on a `code_ahead` row are
 * "accept, or a docs-only follow-up task". Accept was the only one the surface
 * offered, so a card that named the remedy ("Code ahead — doc fix") gave the
 * human no way to reach it. This module is the follow-up task's text: the
 * title and description of the docs-only task dispatched from a grouped
 * code-ahead card.
 *
 * Two things are deliberately NOT here:
 *
 *  - The assertion-level claim detail. `findDispatchDiscrepancyBlock`
 *    (spec-discrepancy-dispatch.ts, §11) already injects the exact claim for
 *    every open row whose spec path is in the task's `pathManifest`, at claim
 *    time, from the ledger itself. The dispatched task sets
 *    `pathManifest: [specPath]` so that block fires; this description names
 *    the assertion ids it is discharging so the two agree even if the ledger
 *    moves underneath the task.
 *  - Any notion of the worker closing the rows. §9 closure is mechanical: a
 *    row resolves when a checker re-run says so, never because the doc-fix
 *    worker asserted completion. The description says so explicitly, because
 *    an agent told "reconcile these four assertions" will otherwise try to
 *    mark them done.
 */

export interface DocFixAssertion {
  assertionId: string;
  /** `evidence.detail` — what the checker actually read. Optional. */
  detail?: string | null;
}

export function docFixTaskTitle(specPath: string): string {
  return `Reconcile spec with shipped code: ${specPath}`;
}

/**
 * Title of the ONE child task an approved net-enhancement proposal mints. The
 * child finalizes both halves — the code change and the spec text describing
 * the finished state — so the assertions end up true rather than re-stale.
 */
export function proposalChildTaskTitle(specPath: string): string {
  return `Land proposed enhancements and finalize ${specPath}`;
}

const PROPOSAL_ITEM_FIELDS = [
  '- **Spec clause** — the exact clause or assertion the gap is measured against.',
  '- **Observed gap** — what the code does today, with the file/symbol you read.',
  '- **Proposed change** — what would close it.',
  '- **Why a net enhancement** — why this extends what exists rather than rewriting it.',
  '- **Estimated size** — roughly how much work, so a human can weigh it.',
].join('\n');

export function buildDocFixTaskDescription(params: {
  specPath: string;
  assertions: DocFixAssertion[];
}): string {
  const { specPath, assertions } = params;
  const claimList = assertions
    .map((a) => `- \`${a.assertionId}\`${a.detail ? ` — ${a.detail}` : ''}`)
    .join('\n');

  return [
    `\`${specPath}\` declares a non-terminal status while the assertions below already pass —`,
    'the code shipped and the document is what is out of date. Reconcile the document with',
    'the code that exists today.',
    '',
    '## Assertions being discharged',
    '',
    claimList,
    '',
    '## What to change',
    '',
    `1. The status frontmatter and any body text that still describes ${specPath} as unbuilt,`,
    '   proposed, or in progress. Use a status the checker recognises — `implemented` (design) or',
    '   `active` (spec) when everything shipped; `partially`, `proposed` or `accepted` when it has',
    '   not; `superseded` plus `superseded_by` when another doc replaced it. Anything else (for',
    '   example `shipped`) is not a status the checker can classify, so the rows stay open.',
    '2. Any claim text naming a symbol, path, route or migration that has since been renamed or',
    '   moved. Point the claim at what the code actually calls it now — this is the',
    "   naming-divergence case the spec's own Case 1 documents, where an assertion kept pointing",
    '   at a symbol that had merely been renamed.',
    '',
    'This PR is **docs-only**. Do not change code in it. It must be reviewable and mergeable on',
    'its own.',
    '',
    '## Do not close the ledger rows',
    '',
    'You do not resolve these discrepancies — a re-run of the conformance checker does, once it',
    'sees the assertion passing against a terminal status. Do not edit the ledger, and do not',
    'report the rows as resolved in your summary. Land the document change and stop.',
    '',
    '## Optional: propose net-enhancement code work',
    '',
    'While reading the code against the spec you may find things the spec intended that the code',
    'does not do well, or at all. Record them — do not build them. Spec before code: nothing you',
    'propose here is dispatched without a human approving it first.',
    '',
    'If and only if you have something to propose, return a `plan` in your structured output with',
    '**exactly one** step whose description lists each proposal item under these headings:',
    '',
    PROPOSAL_ITEM_FIELDS,
    '',
    'That single step, if approved, becomes one task that lands the code change AND updates this',
    'spec so its assertions describe the finished state.',
    '',
    '**Having nothing to propose is the expected outcome.** Return no plan at all in that case.',
    'An empty or padded proposal puts a decision in front of a human for no reason, which is worse',
    'than staying quiet.',
  ].join('\n');
}

export function docFixFollowUpTaskTitle(specPath: string): string {
  return `Settle stale spec assertions after a merged doc fix: ${specPath}`;
}

/**
 * The ONE automatic follow-up (docs/design/spec-conformance.md §9/§12): a doc
 * fix merged, the conformance re-run evaluated it, and the rows are still
 * open. By then the prose is rarely the problem — the assertion structurally
 * passes but does not certify what the doc's status is waiting on — so this
 * brief asks for a decision between exactly three remedies instead of another
 * prose reconcile, which would reproduce the same result.
 */
export function buildDocFixFollowUpDescription(params: {
  specPath: string;
  assertions: DocFixAssertion[];
  priorTaskId: string | null;
  priorPrUrl: string | null;
  declaredStatus: string | null;
}): string {
  const { specPath, assertions, priorTaskId, priorPrUrl, declaredStatus } = params;
  const claimList = assertions
    .map((a) => `- \`${a.assertionId}\`${a.detail ? ` — ${a.detail}` : ''}`)
    .join('\n');
  const prior = [
    priorPrUrl ? `the doc-fix PR ${priorPrUrl}` : null,
    priorTaskId ? `task \`${priorTaskId.slice(0, 8)}\`` : null,
  ].filter(Boolean).join(', ');

  return [
    `A doc fix for \`${specPath}\` already merged${prior ? ` (${prior})` : ''}, and the conformance`,
    're-run that evaluated it still finds these assertions passing while the doc declares',
    `\`${declaredStatus ?? 'no recognised status'}\`:`,
    '',
    claimList,
    '',
    'Another prose reconcile will not close them. This is the one automatic follow-up these rows',
    'get; if it does not settle them, the card goes to the owner.',
    '',
    '## First: check what already happened',
    '',
    `Run \`git log --oneline -- ${specPath}\` and read the prior reconcile PRs before changing`,
    'anything. If one of them already made the decision below, finish it rather than redoing it.',
    '',
    '## Then decide — exactly one per assertion',
    '',
    '1. **Promote the status.** Everything the doc describes has shipped: set `implemented`',
    '   (design) or `active` (spec). Check the doc\'s other assertions first — a failing one means',
    '   this is not the right remedy.',
    '2. **Correct the assertion.** It passes but tests the wrong thing (a pre-existing symbol, a',
    '   file that exists for another reason). Point it at the deliverable the status is waiting',
    '   on, so it fails until that ships.',
    '3. **Suppress it** with `skip_until` + `skip_reason` (docs/design/spec-conformance.md §6).',
    '   It genuinely passes and genuinely belongs to this doc, but the doc must stay non-terminal',
    '   for other, still-unbuilt work. Say that in `skip_reason`, and pick a date you would want',
    '   to look again.',
    '',
    'Use a status the checker recognises (`implemented`, `active`, `partially`, `proposed`,',
    '`accepted`, `draft`, or `superseded` with `superseded_by`). This PR is docs-only.',
    '',
    '## Do not close the ledger rows',
    '',
    'A re-run of the conformance checker closes them, and only if its evaluation is clean. Do',
    'not edit the ledger or report the rows as resolved. Land the change and stop.',
  ].join('\n');
}

/**
 * The description of the single child task an approved proposal mints. The
 * proposal text is carried verbatim — the human approved what the doc-fixer
 * actually wrote, not a re-summary of it.
 */
export function buildProposalChildDescription(params: {
  specPath: string;
  assertionIds: string[];
  proposal: string;
}): string {
  const { specPath, assertionIds, proposal } = params;
  return [
    '## Approved proposal',
    '',
    proposal,
    '',
    '## Finalize the spec in the same PR',
    '',
    `Land the change above AND update \`${specPath}\` so it describes the finished state.`,
    assertionIds.length > 0
      ? `The assertions this touches: ${assertionIds.map((a) => `\`${a}\``).join(', ')}.`
      : '',
    'A code change that leaves the spec describing the old behaviour just re-opens the',
    'discrepancy the doc fix closed.',
    '',
    'If the proposal turns out to be wrong on contact with the code, stop and report why rather',
    'than building something adjacent to it.',
  ]
    .filter(Boolean)
    .join('\n');
}
