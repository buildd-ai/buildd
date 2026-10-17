import { expect, it } from 'bun:test';
import { CAPABILITY_OBJECTIVES, healthObjectiveLookup } from './decision-health-objectives';
import { STRAND_CHOICE_CAPABILITY } from './strand-choice-decision';
import { strandChoiceObjective } from './strand-choice-gold';
import { SPEC_AREA_KIND_ID, SPEC_DUPLICATE_KIND_ID, specAreaObjective, specDuplicateObjective } from './spec-decision-gold';
import { SPEC_DUPLICATE_KIND, specDuplicateKind } from './spec-duplicate-decision';
import { SPEC_AREA_KIND, specAreaKind } from './spec-area-decision';
import { postSessionTriageObjective } from '@buildd/core/decision-kind-post-session-triage';
import { scoutProbeSelectionObjective } from '@buildd/core/decision-kind-scout-probe-selection';

it('reuses the objective each kind already carries, and the strand choice\'s', async () => {
  const lookup = await healthObjectiveLookup();
  expect(lookup('buildd.post_session_triage')).toBe(postSessionTriageObjective);
  expect(lookup('buildd.scout_probe_selection')).toBe(scoutProbeSelectionObjective);
  expect(lookup('mission_strand_choice')).toBe(strandChoiceObjective);
  expect(lookup('buildd.operator_cause_merge')?.source).toBeTruthy();
});

it('scores the labels the adapters write', async () => {
  const lookup = await healthObjectiveLookup();
  const triage = lookup('buildd.post_session_triage')!;
  expect(triage.score({ label: 'actionable', value: null }, 'analyse')).toBe(true);
  expect(triage.score({ label: 'actionable', value: null }, 'skip')).toBe(false);
  const strand = lookup('mission_strand_choice')!;
  expect(strand.score({ label: 'wait-for-local', value: null }, 'continue-on-runner')).toBe(false);
});

it('a feature with no objective of its own has none: its labels stay coverage only', async () => {
  const lookup = await healthObjectiveLookup();
  expect(lookup('escalation_gate')).toBeUndefined();
  expect(lookup('buildd.spec_duplicate_unknown')).toBeUndefined();
});

it('the spec decisions are scored by their own objectives', async () => {
  const lookup = await healthObjectiveLookup();
  expect(lookup('buildd.spec_duplicate')).toBe(specDuplicateObjective);
  expect(lookup('buildd.spec_area')).toBe(specAreaObjective);
});

it('the spec kinds carry the same objectives on their bindings, and the lookup names their kind ids', () => {
  expect(specDuplicateKind.binding.readout?.objective).toBe(specDuplicateObjective);
  expect(specAreaKind.binding.readout?.objective).toBe(specAreaObjective);
  expect(SPEC_DUPLICATE_KIND_ID).toBe(SPEC_DUPLICATE_KIND);
  expect(SPEC_AREA_KIND_ID).toBe(SPEC_AREA_KIND);
});

it('names the strand choice by the same id its decisions are recorded under', () => {
  expect(Object.keys(CAPABILITY_OBJECTIVES)).toEqual([STRAND_CHOICE_CAPABILITY, SPEC_DUPLICATE_KIND, SPEC_AREA_KIND]);
});
