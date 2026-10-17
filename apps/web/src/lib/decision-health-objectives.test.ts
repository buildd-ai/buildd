import { expect, it } from 'bun:test';
import { healthObjectiveLookup } from './decision-health-objectives';
import { strandChoiceObjective } from './strand-choice-gold';
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
  expect(lookup('buildd.spec_duplicate')).toBeUndefined();
});
