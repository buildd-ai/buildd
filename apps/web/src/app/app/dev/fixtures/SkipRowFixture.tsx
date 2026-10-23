'use client';

/**
 * The visual review row's Skip, live, through the production chain (spec
 * 072de598 r15 I-7, I-18, AC-24, AC-26): two buttons, an optional note, no
 * minimum length — and, for `held`, a Skip already recorded that a later
 * audit round raised more findings under, which still read as information,
 * never a blocker.
 *
 * `held=0`: the row is open, waivable, nothing skipped yet — tap Skip to see
 * the two buttons. `held=1`: a person already skipped it (dated before the
 * audit that found the issues below), so the row reads waived with their
 * name, and the later findings are named as information under it.
 */
import { useEffect, useState } from 'react';
import { visualCheck } from '@/lib/mission-checks';
import { recaptureFixtureInput } from '@/lib/visual-review-model.fixtures';
import { buildVisualReviewModel } from '@/lib/visual-review-model';
import { resolveVisualReviewPolicy } from '@/lib/workflow/visual-review-policy';
import { deriveMissionVisualReview, reviewInputFromModel } from '@/lib/workflow/visual-review-state';
import { ChecksCard } from '@/app/app/(protected)/missions/[id]/MissionChecks';
import { MissionSurfaceAuditWaiverProvider } from '@/app/app/(protected)/missions/[id]/MissionSurfaceAuditWaiver';

const HEAD = 'abc1234def5678';
const openPr = { number: 9, state: 'open' as const, ready: true, blocked: false };

/** Dated well before the fixture's audit, so a held Skip reads waived through its later round (AC-24). */
const EARLY_WAIVER = { reason: 'Ship it anyway: The loading state is intentional', actorLabel: 'Sam', at: '2026-01-01T00:00:00Z' };

export default function SkipRowFixture() {
  // Read the URL after mount, like VisualReviewFixture, so server and client render alike.
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => { setHeld(new URLSearchParams(window.location.search).get('held') === '1'); }, []);
  if (held === null) return <div className="min-h-screen bg-surface-1" />;

  const model = buildVisualReviewModel(recaptureFixtureInput('recapture-decide'));
  const state = deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    audit: model.audit ? { id: model.audit.id, createdAt: model.audit.createdAt, errorType: model.audit.errorType, status: model.audit.status } : null,
    review: reviewInputFromModel(model),
    waiver: held ? EARLY_WAIVER : null,
    auditedSha: HEAD,
    branch: { headSha: HEAD, base: 'mission/x', integrationPr: openPr, workLanded: true },
  });
  const row = visualCheck(state, { mergeTier: 'human' });

  return (
    <div data-testid="skip-row-fixture" className="min-h-screen bg-surface-1 p-4 text-text-primary md:p-8">
      <header className="mb-6">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-title font-semibold">Visual review row: {held ? 'a held Skip' : 'Skip'}</h1>
        <p className="mt-1 max-w-xl text-body text-text-secondary">
          {held
            ? 'Skipped before this audit round ran. The round’s findings show under the Skip as information, never a blocker, and the row never reads passed.'
            : 'Open findings, not yet skipped. Tap Skip to see the two buttons and the optional note.'}
        </p>
        <a href={held ? '?state=skip-row' : '?state=skip-row&held=1'} className="mt-2 inline-block font-mono text-meta text-accent-text underline underline-offset-4">
          {held ? 'See it before skipping' : 'See it held through a later round'}
        </a>
      </header>
      <div className="mx-auto max-w-2xl">
        <MissionSurfaceAuditWaiverProvider missionId="fixture-mission" waiver={held ? EARLY_WAIVER : null} missionBranch={false} readonly={false}>
          <ChecksCard rows={[row]} />
        </MissionSurfaceAuditWaiverProvider>
      </div>
    </div>
  );
}
