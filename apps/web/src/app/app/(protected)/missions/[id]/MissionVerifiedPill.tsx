'use client';

import { useState } from 'react';
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import { deriveCriteriaGatePresentation, CRITERIA_GATE_TONE_CLASS } from '@buildd/core/mission-helpers';
import BottomSheet from '@/components/BottomSheet';
import MissionGoalCriteria from './MissionGoalCriteria';

interface Props {
  missionId: string;
  criteria: GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  autoVerify: boolean | null;
  readonly?: boolean;
  failingCiPrNumbers?: number[];
  overall: 'pass' | 'fail' | 'UNVERIFIED' | 'NOT_EVALUATED' | 'PENDING' | null;
}

/**
 * Tappable Verified pill (mission-card-density-spec §2) — the single entry
 * point into goal criteria on this page. Wraps the existing, unmodified
 * `MissionGoalCriteria` panel in a bottom sheet rather than rendering it
 * always-visible below the fold.
 */
export default function MissionVerifiedPill({
  missionId,
  criteria,
  criteriaState,
  autoVerify,
  readonly,
  failingCiPrNumbers,
  overall,
}: Props) {
  const [open, setOpen] = useState(false);
  const criteriaCount = criteria.length;

  // No criteria and nothing to add (terminal/readonly mission): no chrome at
  // all, matching the always-visible block's prior behavior exactly.
  if (criteriaCount === 0 && readonly) return null;

  if (criteriaCount === 0) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-border-default text-text-muted font-mono text-[10px] rounded-sm hover:text-text-secondary transition-colors"
        >
          + Criteria
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} title="Goal criteria">
          <MissionGoalCriteria
            missionId={missionId}
            criteria={criteria}
            criteriaState={criteriaState}
            autoVerify={autoVerify}
            readonly={readonly}
            failingCiPrNumbers={failingCiPrNumbers}
          />
        </BottomSheet>
      </>
    );
  }

  let icon = '?';
  let text = 'Needs verification';
  let title = 'Goal criteria set but not yet verified';
  let toneClass = CRITERIA_GATE_TONE_CLASS.warning;

  if (overall === 'NOT_EVALUATED') {
    icon = '–';
    text = 'No evaluator';
    title = 'Criteria set — no evaluator available';
    toneClass = 'text-text-muted/60 border-border-default';
  } else if (overall === 'PENDING') {
    icon = '⋯';
    text = 'Evaluating';
    title = 'Evaluation in progress';
    toneClass = 'text-text-muted/70 border-border-default/70';
  } else {
    const gate = deriveCriteriaGatePresentation({ criteriaCount, overall });
    if (gate) {
      icon = gate.state === 'clear' ? '✓' : gate.state === 'failing' ? '✗' : '?';
      text = gate.state === 'clear' ? 'Verified' : gate.state === 'failing' ? 'Not met' : 'Needs verification';
      title = gate.state === 'clear' ? 'All goal criteria verified' : gate.state === 'failing' ? 'Goal criteria not met' : 'Goal criteria set but not yet verified';
      toneClass = CRITERIA_GATE_TONE_CLASS[gate.tone];
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[10px] rounded-sm transition-opacity hover:opacity-80 ${toneClass}`}
      >
        {icon} {text}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Goal criteria">
        <MissionGoalCriteria
          missionId={missionId}
          criteria={criteria}
          criteriaState={criteriaState}
          autoVerify={autoVerify}
          readonly={readonly}
          failingCiPrNumbers={failingCiPrNumbers}
        />
      </BottomSheet>
    </>
  );
}
