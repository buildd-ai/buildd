import { describe, expect, it } from 'bun:test';
import {
  UI_ACTION_STATE_VERIFIER,
  canPromoteVerifier,
  checkUiActionState,
  evaluationCaseFromCorrection,
  parseUiEvidence,
  type UiEvidence,
} from './ui-verification';

/**
 * Acceptance tests for "Registered requirement verification in Build, Verify
 * and Deliver" (revision 1): UI evidence and the initial deterministic UI
 * verifier. Written before the build; `./ui-verification` does not exist on
 * the mission's starting commit.
 *
 * Contract these tests pin:
 *  - `parseUiEvidence(input)` validates a UI evidence snapshot: route and
 *    scenario, code (and capture) identity, ordered visible text, actions each
 *    with a semantic `operation` (the label is only what the person reads),
 *    prominence, independently supplied `state` facts and per-part coverage.
 *    It reports which evidence capabilities the snapshot carries: `text`,
 *    `actions`, `state`, and `pixels` only when a screenshot is attached.
 *  - `checkUiActionState(evidence)` is `ui.action-state@1`, deterministic. It
 *    compares enabled actions and displayed verification claims with the
 *    supplied state. It never reads the label or the prose for meaning.
 *    Missing required facts or partial coverage are `inconclusive`.
 */

const SHA = 'c'.repeat(40);

const card = (over: Partial<UiEvidence> = {}): UiEvidence => ({
  route: '/app/tasks/[id]',
  scenario: 'completed-task-with-pr',
  codeSha: SHA,
  text: [
    { text: 'Ready to merge', prominence: 'primary' },
    { text: 'Merging closes the task.', prominence: 'secondary' },
  ],
  actions: [{ label: 'Merge', operation: 'merge', enabled: true, prominence: 'primary' }],
  claims: [],
  state: { pr: 'open', verification: 'verified', replacementPending: false },
  coverage: { text: 'complete', actions: 'complete', state: 'complete' },
  ...over,
});

const parsed = (e: unknown) => {
  const r = parseUiEvidence(e);
  if (!r.ok) throw new Error(`evidence refused: ${JSON.stringify(r)}`);
  return r.evidence;
};

describe('ui.action-state verifier', () => {
  it('AC-3: an action-state contradiction is a finding, wordiness is not; a replacement confirmation is not a merge; the card is left as it was', () => {
    // Contradiction: a merge enabled on a closed PR.
    const contradiction = checkUiActionState(parsed(card({ state: { pr: 'closed', verification: 'verified', replacementPending: false } })));
    expect(contradiction.verdict).toBe('fail');
    expect(contradiction.method).toBe('deterministic');
    expect(contradiction.findings).toEqual([expect.objectContaining({ kind: 'action_state_contradiction', operation: 'merge', fact: 'pr' })]);

    // Wordiness alone is not this verifier's finding: a long but truthful card passes it.
    const wordy = card({
      text: [
        { text: 'Ready to merge', prominence: 'primary' },
        { text: 'This task is ready to merge. It is ready because its PR is open and checks passed.', prominence: 'secondary' },
        { text: 'We checked the PR, then we checked the checks, then we prepared this card.', prominence: 'secondary' },
        { text: 'Ready to merge', prominence: 'secondary' },
      ],
    });
    const verbose = checkUiActionState(parsed(wordy));
    expect(verbose.verdict).toBe('pass');
    expect(verbose.findings).toEqual([]);

    // A replacement confirmation labelled with the word "merge" is judged as what it does.
    const replacement = card({
      actions: [{ label: 'Merge replacement', operation: 'confirm_replacement', enabled: true, prominence: 'primary' }],
      state: { pr: 'closed', verification: 'unverified', replacementPending: true },
    });
    const confirm = checkUiActionState(parsed(replacement));
    expect(confirm.verdict).toBe('pass');
    expect(confirm.findings.some((f) => f.operation === 'merge')).toBe(false);

    // The verifier returns findings; it rewrites nothing and keeps every fact on the card.
    const input = parsed(wordy);
    const before = structuredClone(input);
    const result = checkUiActionState(input);
    expect(input).toEqual(before);
    expect(result).not.toHaveProperty('rewrite');
    expect(result).not.toHaveProperty('text');
  });

  it('R-11: evidence names route, scenario, identity, ordered text, operations, prominence and coverage; pixels are a separate capability', () => {
    const noPixels = parseUiEvidence(card());
    expect(noPixels.ok).toBe(true);
    if (!noPixels.ok) return;
    expect(noPixels.evidence.text.map((t) => t.text)).toEqual(['Ready to merge', 'Merging closes the task.']);
    expect([...noPixels.capabilities].sort()).toEqual(['actions', 'state', 'text']);
    const withPixels = parseUiEvidence({ ...card(), captureSha: SHA, pixels: { screenshotArtifactId: 'shot-1' } });
    expect(withPixels.ok && [...withPixels.capabilities].sort()).toEqual(['actions', 'pixels', 'state', 'text']);
    for (const drop of ['route', 'scenario', 'codeSha', 'text', 'actions', 'coverage'] as const) {
      const { [drop]: _gone, ...rest } = card();
      const r = parseUiEvidence(rest);
      expect(r.ok).toBe(false);
    }
    // An action with no semantic operation is refused: a label is not an operation.
    expect(parseUiEvidence(card({ actions: [{ label: 'Merge', enabled: true, prominence: 'primary' } as never] })).ok).toBe(false);
  });

  it('R-12: never infers an operation from a label or lifecycle state from prose; missing facts are inconclusive', () => {
    const detailsLabelledMerge = card({
      actions: [{ label: 'Merge', operation: 'open_details', enabled: true, prominence: 'primary' }],
      state: { pr: 'closed', verification: 'unverified', replacementPending: false },
    });
    expect(checkUiActionState(parsed(detailsLabelledMerge)).verdict).toBe('pass');

    const proseOnly = card({ text: [{ text: 'PR closed. Nothing to merge.', prominence: 'primary' }], state: { verification: 'verified' } });
    const r = checkUiActionState(parsed(proseOnly));
    expect(r.verdict).toBe('inconclusive');
    expect(r.missingFacts).toContain('pr');

    const claim = card({ claims: [{ kind: 'verification', value: 'verified' }], state: { pr: 'open', verification: 'unverified', replacementPending: false } });
    const c = checkUiActionState(parsed(claim));
    expect(c.verdict).toBe('fail');
    expect(c.findings).toEqual([expect.objectContaining({ kind: 'claim_state_contradiction', fact: 'verification' })]);
    expect(UI_ACTION_STATE_VERIFIER).toMatchObject({ id: 'ui.action-state', version: 1, method: 'deterministic' });
  });

  it('R-16: partial or absent declared evidence is inconclusive, even when collection reported success', () => {
    const partial = card({ coverage: { text: 'complete', actions: 'complete', state: 'partial' } });
    expect(checkUiActionState(parsed(partial)).verdict).toBe('inconclusive');
    const noState = { ...card(), state: undefined, collection: { ok: true } };
    const r = parseUiEvidence(noState);
    if (r.ok) expect(checkUiActionState(r.evidence).verdict).toBe('inconclusive');
    else expect(r.ok).toBe(false);
  });

  it('R-21: only a confirmed human correction becomes an evaluation case; a new verifier version is promoted only after passing them', () => {
    const evidence = parsed(card());
    expect(evaluationCaseFromCorrection({ evidence, expected: 'fail', confirmedBy: null })).toBeNull();
    expect(evaluationCaseFromCorrection({ evidence, expected: 'fail', confirmedBy: { kind: 'agent', id: 'w1' } })).toBeNull();
    const kase = evaluationCaseFromCorrection({ evidence, expected: 'fail', confirmedBy: { kind: 'person', id: 'u1' } });
    expect(kase).toMatchObject({ expected: 'fail' });

    expect(canPromoteVerifier({ current: { id: 'ui.copy', version: 1 }, candidate: { id: 'ui.copy', version: 1 }, results: [{ case: kase!, verdict: 'fail' }] }).ok).toBe(false);
    expect(canPromoteVerifier({ current: { id: 'ui.copy', version: 1 }, candidate: { id: 'ui.copy', version: 2 }, results: [] }).ok).toBe(false);
    expect(canPromoteVerifier({ current: { id: 'ui.copy', version: 1 }, candidate: { id: 'ui.copy', version: 2 }, results: [{ case: kase!, verdict: 'pass' }] }).ok).toBe(false);
    expect(canPromoteVerifier({ current: { id: 'ui.copy', version: 1 }, candidate: { id: 'ui.copy', version: 2 }, results: [{ case: kase!, verdict: 'fail' }] }).ok).toBe(true);
  });
});
