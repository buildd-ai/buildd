'use client';

import { useCallback, useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import { deriveCriteriaGatePresentation, CRITERIA_GATE_TONE_CLASS } from '@buildd/core/mission-helpers';
import BottomSheet from '@/components/BottomSheet';
import MissionGoalCriteria from './MissionGoalCriteria';
import { MISSION_CRITERIA_ANCHOR } from '@/components/missions/MissionSituationBlock';

/**
 * Open the criteria sheet from the situation's "Go to goal criteria" link, and
 * on arrival with `#mission-criteria`. A delegated click listener rather than
 * `hashchange`: a client-side link writes the hash with `pushState`, which
 * fires no `hashchange`, and a second tap on the same hash changes nothing.
 */
function useOpenOnCriteriaLink(open: () => void) {
  useEffect(() => {
    if (window.location.hash === `#${MISSION_CRITERIA_ANCHOR}`) open();
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`a[href$="#${MISSION_CRITERIA_ANCHOR}"]`)) open();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);
}

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
 *
 * Syncs open state with ?criteria=open URL parameter so the panel persists
 * across client-side navigation (e.g. after tapping the chip and navigating
 * within the app, the panel stays open on return).
 */
function MissionVerifiedPillInner({
  missionId,
  criteria,
  criteriaState,
  autoVerify,
  readonly,
  failingCiPrNumbers,
  overall,
}: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const criteriaCount = criteria.length;

  // Sync with URL parameter on mount and when searchParams change
  useEffect(() => {
    const showCriteria = searchParams.get('criteria') === 'open';
    setOpen(showCriteria);
  }, [searchParams]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.set('criteria', 'open');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams]);

  const handleClose = useCallback(() => {
    setOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('criteria');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const openSheet = useCallback(() => handleOpen(), [handleOpen]);
  useOpenOnCriteriaLink(openSheet);

  // No criteria and nothing to add (terminal/readonly mission): no chrome at
  // all, matching the always-visible block's prior behavior exactly.
  if (criteriaCount === 0 && readonly) return null;

  if (criteriaCount === 0) {
    return (
      <>
        <button
          type="button"
          id={MISSION_CRITERIA_ANCHOR}
          onClick={handleOpen}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-border-default text-text-muted font-mono text-[11px] md:text-[10px] rounded-sm hover:text-text-secondary transition-colors"
        >
          + Criteria
        </button>
        <BottomSheet open={open} onClose={handleClose} title="Goal criteria">
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

  if (overall == null) {
    // Nothing has evaluated the criteria yet: name them, claim no verdict.
    icon = '';
    text = `${criteriaCount} ${criteriaCount === 1 ? 'criterion' : 'criteria'}`;
    title = 'Goal criteria, not evaluated yet';
    toneClass = CRITERIA_GATE_TONE_CLASS.neutral;
  } else if (overall === 'NOT_EVALUATED') {
    icon = '–';
    text = 'No evaluator';
    title = 'Criteria set, no evaluator available';
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
        id={MISSION_CRITERIA_ANCHOR}
        onClick={handleOpen}
        title={title}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[11px] md:text-[10px] rounded-sm transition-opacity hover:opacity-80 ${toneClass}`}
      >
        {icon ? `${icon} ${text}` : text}
      </button>
      <BottomSheet open={open} onClose={handleClose} title="Goal criteria">
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

export default function MissionVerifiedPill(props: Props) {
  return (
    <Suspense>
      <MissionVerifiedPillInner {...props} />
    </Suspense>
  );
}
