'use client';

/**
 * `?state=mission-plan&variant=ready|off|empty|error`: the Missions Plan page's
 * real view components over fixture data. See mission-plan-fixtures.ts.
 */
import { useEffect, useState } from 'react';
import { PlanError, PlanOff, PlanReady, PlanShell } from '@/app/app/(protected)/missions/plan/MissionPlanView';
import { missionPlanFixtureData, parseMissionPlanVariant, type MissionPlanVariant } from './mission-plan-fixtures';

export default function MissionPlanFixture() {
  const [variant, setVariant] = useState<MissionPlanVariant>('ready');
  // The chart is dated from "now"; read it after mount so server and client agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setVariant(parseMissionPlanVariant(new URLSearchParams(window.location.search).get('variant')));
    setNow(Date.now());
  }, []);
  if (now == null) return null;

  const data = missionPlanFixtureData(now);
  return (
    <PlanShell>
      {variant === 'off' && <PlanOff />}
      {variant === 'error' && <PlanError />}
      {variant === 'empty' && <PlanReady inputs={[]} plans={new Map()} now={now} />}
      {variant === 'ready' && <PlanReady inputs={data.inputs} plans={data.plans} now={now} />}
    </PlanShell>
  );
}
