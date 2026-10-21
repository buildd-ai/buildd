import { describe, expect, it } from 'bun:test';
import {
  MAX_UI_COPY_SEGMENTS,
  UI_COPY_CONFIG,
  UI_COPY_DECISIONS,
  parseUiCopyFeatures,
  uiCopyFindings,
  uiCopyKind,
  type UiCopyFeatures,
} from './decision-kind-ui-copy';
import { listBuilddDecisionKinds } from './decision-kinds';
import { INFERENCE_CAPABILITIES } from './inference-policy';

/**
 * Acceptance tests for "Registered requirement verification in Build, Verify
 * and Deliver" (revision 1): the initial semantic UI verifier, `buildd.ui_copy`.
 * Written before the build; `./decision-kind-ui-copy` does not exist on the
 * mission's starting commit.
 *
 * Contract these tests pin:
 *  - A first-party decision kind on the shared substrate (`decision-kinds.ts`)
 *    with its own opt-in inference capability `ui_copy`; the team's decision
 *    policy picks the model. Features carry no model, endpoint, credential or
 *    prompt of their own.
 *  - Features are the complete bounded card: every text segment with its role,
 *    every action with its semantic operation, and the project profile. A card
 *    over the bound is refused, not truncated.
 *  - `uiCopyFindings(raw, features)` turns the model's structured answer into
 *    findings: `repetition`, `unclear_action`, `process_narration`. It never
 *    marks a material fact (consequence, permission, prerequisite, recovery)
 *    as dispensable and never returns replacement text.
 */

const features = (over: Partial<UiCopyFeatures> = {}): UiCopyFeatures => ({
  profile: { id: 'buildd-ui', version: 1 },
  segments: [
    { id: 's1', text: 'Ready to merge', role: 'status' },
    { id: 's2', text: 'This task is ready to merge.', role: 'status' },
    { id: 's3', text: 'We checked the PR, then the checks, then prepared this card.', role: 'narration' },
    { id: 's4', text: 'Merging closes the task.', role: 'consequence' },
    { id: 's5', text: 'Only workspace owners can merge.', role: 'permission' },
  ],
  actions: [
    { id: 'a1', label: 'Merge', operation: 'merge' },
    { id: 'a2', label: 'Merge replacement', operation: 'confirm_replacement' },
  ],
  ...over,
});

describe('buildd.ui_copy decision kind', () => {
  it('AC-3: judges wordiness, not action state; keeps an action\'s own operation; never marks an operational fact dispensable', () => {
    const f = features();
    const out = uiCopyFindings({
      findings: [
        { kind: 'repetition', segmentIds: ['s1', 's2'] },
        { kind: 'process_narration', segmentIds: ['s3', 's4', 's5'] },
        { kind: 'unclear_action', actionIds: ['a2'] },
        // Not this verifier's call: action state belongs to the deterministic verifier.
        { kind: 'action_state_contradiction', actionIds: ['a1'] },
      ],
    }, f);

    expect(out.map((x) => x.kind).sort()).toEqual(['process_narration', 'repetition', 'unclear_action']);
    // The replacement confirmation is reported as what it does, never as a merge.
    const unclear = out.find((x) => x.kind === 'unclear_action')!;
    expect(unclear.actions).toEqual([{ id: 'a2', operation: 'confirm_replacement' }]);
    // The consequence and the permission survive: only the narration is dispensable.
    const narration = out.find((x) => x.kind === 'process_narration')!;
    expect(narration.segmentIds).toEqual(['s3']);
    for (const x of out) {
      expect(x.segmentIds ?? []).not.toContain('s4');
      expect(x.segmentIds ?? []).not.toContain('s5');
      expect(x).not.toHaveProperty('rewrite');
      expect(x).not.toHaveProperty('replacement');
    }
  });

  it('R-13: judges the complete bounded card, refuses one over the bound, and returns structured findings only', () => {
    expect(parseUiCopyFeatures(features()).ok).toBe(true);
    const many = Array.from({ length: MAX_UI_COPY_SEGMENTS + 1 }, (_, i) => ({ id: `s${i}`, text: 'x', role: 'status' as const }));
    expect(parseUiCopyFeatures(features({ segments: many })).ok).toBe(false);
    expect(parseUiCopyFeatures(features({ segments: [{ id: 's1', text: 'x', role: 'mystery' as never }] })).ok).toBe(false);
    expect(parseUiCopyFeatures(features({ actions: [{ id: 'a1', label: 'Merge' } as never] })).ok).toBe(false);
    expect([...UI_COPY_DECISIONS]).toEqual(['concise', 'needs_edit', 'insufficient_evidence']);
    // Unknown ids in the model's answer are dropped, not invented.
    expect(uiCopyFindings({ findings: [{ kind: 'repetition', segmentIds: ['nope'] }] }, features())).toEqual([]);
    // Not knowing never reads as concise.
    for (const cause of ['no_provider', 'low_confidence', 'provider_failure', 'invalid_features'] as const) {
      expect(UI_COPY_CONFIG.fallback(features(), cause).decision).toBe('insufficient_evidence');
      expect(UI_COPY_CONFIG.fallback(null, cause).decision).toBe('insufficient_evidence');
    }
  });

  it('R-17: runs under the scoped decision policy with its own opt-in capability; features cannot carry a model, endpoint, key or prompt', () => {
    expect(listBuilddDecisionKinds().map((k) => k.kind)).toContain('buildd.ui_copy');
    expect(uiCopyKind.binding.capability).toBe('ui_copy');
    expect(INFERENCE_CAPABILITIES.ui_copy.kind).toBe('opt_in');
    for (const key of ['model', 'endpoint', 'apiKey', 'credentials', 'prompt', 'baseUrl']) {
      expect(parseUiCopyFeatures({ ...features(), [key]: 'x' }).ok).toBe(false);
    }
  });
});
