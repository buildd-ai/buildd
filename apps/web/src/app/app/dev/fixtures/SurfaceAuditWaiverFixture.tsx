'use client';

/**
 * `?state=surface-audit-waiver`: the mission page's "Waive visual audit"
 * (task 16ccb1b3), on the real Board and the real Visual review card.
 *
 *   &variant=mission-branch  (default) the blocked audit on a mission-branch
 *                            mission: why it can't run, and the waiver
 *   &variant=direct          the same audit on a direct mission: the waiver only
 *   &variant=waived          a waiver already recorded: reason, who, when
 *   &sheet=1                 open the waiver sheet
 *
 * Display only: the actions post to the live routes, so do not press them here.
 */
import { useEffect, useState } from 'react';
import MissionBoard from '@/app/app/(protected)/missions/[id]/MissionBoard';
import MissionVisualReviewSetting from '@/app/app/(protected)/missions/[id]/MissionVisualReviewSetting';
import {
  MissionSurfaceAuditWaiverProvider,
  type MissionSurfaceAuditWaiverProps,
} from '@/app/app/(protected)/missions/[id]/MissionSurfaceAuditWaiver';
import {
  SURFACE_AUDIT_FIXTURE_TASK,
  stripFixtureId,
  surfaceAuditStripFixture,
  type MissionTaskStripFixture as Fixture,
} from './mission-task-strip-fixtures';
import { SURFACE_AUDIT_WAIVER_FIXTURE_STATE } from './visual-review-fixtures';

const MISSION_ID = stripFixtureId(910);
const WORKSPACE_ID = stripFixtureId(911);
const VARIANTS = ['mission-branch', 'direct', 'waived'] as const;
type Variant = (typeof VARIANTS)[number];

function waiverProps(variant: Variant): Omit<MissionSurfaceAuditWaiverProps, 'variant'> {
  return {
    missionId: MISSION_ID,
    missionBranch: variant !== 'direct',
    waiver: variant === 'waived'
      ? { reason: 'CI Visual QA cannot capture this mission branch; I checked both pages on a phone by hand.', actorLabel: 'owner@example.com', at: '2026-10-01T12:00:00.000Z' }
      : null,
  };
}

export default function SurfaceAuditWaiverFixture() {
  const [state, setState] = useState<{ variant: Variant; fixture: Fixture; sheet: boolean } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const v = q.get('variant');
    const variant: Variant = (VARIANTS as readonly string[]).includes(v ?? '') ? (v as Variant) : 'mission-branch';
    setState({ variant, fixture: surfaceAuditStripFixture(Date.now()), sheet: q.get('sheet') === '1' });
  }, []);
  // Open on the audit's cell, the way a tap would.
  useEffect(() => {
    if (!state) return;
    document.querySelector<HTMLButtonElement>(`[data-testid="landed-strip-cell"][data-task-ref="${SURFACE_AUDIT_FIXTURE_TASK}"]`)?.click();
    if (state.sheet) {
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="landed-strip-drawer"] [data-action="waive-visual-audit"]')?.click());
    }
  }, [state]);
  if (!state) return <div className="min-h-screen bg-surface-1" />;
  const props = waiverProps(state.variant);

  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-heading font-semibold">{`Waive visual audit: ${state.variant}`}</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {VARIANTS.map(v => (
            <a key={v} href={`?state=${SURFACE_AUDIT_WAIVER_FIXTURE_STATE}&variant=${v}`} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-meta text-text-secondary hover:border-border-strong hover:text-text-primary">
              {v}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-2 md:px-8">
        <MissionSurfaceAuditWaiverProvider {...props}>
          <MissionBoard
            model={state.fixture.model}
            missionId={MISSION_ID}
            workspaceId={WORKSPACE_ID}
            executor={state.fixture.executor}
          />
        </MissionSurfaceAuditWaiverProvider>
        <div className="max-w-xl">
          <MissionVisualReviewSetting missionId={MISSION_ID} initialEnabled visual={null} auditWaiver={props} />
        </div>
      </main>
    </div>
  );
}
