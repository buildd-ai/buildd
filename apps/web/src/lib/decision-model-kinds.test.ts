import { describe, expect, it } from 'bun:test';
import { DECISION_MODEL_KINDS } from '@buildd/core/decision-model';
import { CLAIM_HOLD_DECISION } from '@buildd/core/orchestration-claim-decision';
import { OVERLAP_REAL_DECISION } from '@buildd/core/orchestration-overlap-decision';
import { SIZE_BUCKET_DECISION } from '@buildd/core/task-size-bucket-decision';
import { MANIFEST_DECISION_ID } from '@buildd/core/manifest-prediction';
import { POST_SESSION_TRIAGE_KIND } from '@buildd/core/decision-kind-post-session-triage';
import { FAILURE_INCIDENT_TRIAGE_KIND } from '@buildd/core/decision-kind-failure-incident-triage';
import { VISUAL_IMPACT_KIND } from '@buildd/core/decision-kind-visual-impact';
import { SCOUT_PROBE_SELECTION_KIND } from '@buildd/core/decision-kind-scout-probe-selection';
import { TASK_CATEGORY_MEASUREMENT_KIND } from './task-category-decision';
import { TASK_ROLE_MODEL_KIND } from './task-role-decision';
import { STRAND_CHOICE_DECISION_ID } from './strand-choice-decision';
import { MERGE_READINESS_KIND } from './merge-advice';
import { EARLY_RELEASE_KIND } from './early-release-decision';
import { SPEC_DUPLICATE_KIND } from './spec-duplicate-decision';
import { SPEC_AREA_KIND } from './spec-area-decision';
import { SPEC_TAXONOMY_KIND } from './spec-taxonomy-decision';
import { SPEC_PUBLICATION_KIND } from './spec-publication-decision';

/**
 * Each call site passes its decision's name to the access lookup, and a
 * team's per-decision model override is keyed by that name. A renamed
 * constant would orphan every override for it, silently.
 */
describe('decisions a team can give their own model', () => {
  it('is exactly the names the call sites pass', () => {
    const passed = [
      TASK_CATEGORY_MEASUREMENT_KIND, TASK_ROLE_MODEL_KIND, CLAIM_HOLD_DECISION.id, MANIFEST_DECISION_ID,
      OVERLAP_REAL_DECISION.id, SIZE_BUCKET_DECISION.id, STRAND_CHOICE_DECISION_ID, MERGE_READINESS_KIND,
      POST_SESSION_TRIAGE_KIND, FAILURE_INCIDENT_TRIAGE_KIND, SCOUT_PROBE_SELECTION_KIND, EARLY_RELEASE_KIND, SPEC_DUPLICATE_KIND, SPEC_AREA_KIND, SPEC_TAXONOMY_KIND, SPEC_PUBLICATION_KIND, VISUAL_IMPACT_KIND,
    ];
    expect([...passed].sort()).toEqual([...DECISION_MODEL_KINDS].sort());
  });
});
