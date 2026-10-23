'use client';

import type { VisualReviewModel } from '@buildd/shared';
import { visualCheck } from '@/lib/mission-checks';
import { decideReadyToMerge, readyToMergeReason } from '@/lib/ready-to-merge';
import { resolveVisualReviewPolicy } from '@/lib/workflow/visual-review-policy';
import { deriveMissionVisualReview, reviewInputFromModel } from '@/lib/workflow/visual-review-state';

/**
 * The mission page's Verify row and merge refusal for this model, through the
 * production chain (state, presentation, row, ready-to-merge) on an approved
 * mission PR, so the words a person sees in the stuck state are on screen.
 */
export default function VerifyRowPreview({ model }: { model: VisualReviewModel }) {
    const state = deriveMissionVisualReview({
        policy: resolveVisualReviewPolicy({}),
        uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
        audit: model.audit ? { id: model.audit.id, createdAt: model.audit.createdAt, errorType: model.audit.errorType, status: model.audit.status } : null,
        review: reviewInputFromModel(model),
        waiver: null,
        branch: { headSha: '127d7b92aa', base: 'mission/fixture', integrationPr: { number: 9, state: 'open', ready: true, blocked: false }, workLanded: true },
    });
    const row = visualCheck(state, { mergeTier: 'human' });
    const merge = decideReadyToMerge({ kind: 'mission_integration_pr', workHolder: null, visual: state });
    return (
        <section data-testid="visual-review-verify-row-fixture" className="flex flex-col gap-2">
            <h2 className="section-label">Verify row</h2>
            <div className="flex flex-col gap-1.5 border-2 border-border-strong bg-card p-4">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-semibold">{row.label}</span>
                    {row.chip && <span className="font-mono text-meta text-text-secondary">{row.chip}</span>}
                    <span className="font-mono text-meta text-text-primary">{row.state}</span>
                </p>
                {row.detail && <p className="text-body text-text-secondary [overflow-wrap:anywhere]">{row.detail}</p>}
                {!merge.ready && <p className="font-mono text-meta text-text-muted [overflow-wrap:anywhere]">Merge: {readyToMergeReason(merge)}</p>}
            </div>
        </section>
    );
}

