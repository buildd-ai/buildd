'use client';

/**
 * `?state=branch-panel`: the mission branch panel in every stage, built from the
 * real canonical state and presentation (no hand-written copy), so the words a
 * phone shows are the ones the product ships. Display only: the actions post to
 * live routes, so do not press them here.
 */
import MissionBranchPanel from '@/app/app/(protected)/missions/[id]/MissionBranchPanel';
import MissionVisualRecord from '@/app/app/(protected)/missions/[id]/MissionVisualRecord';
import { resolveVisualReviewPolicy } from '@/lib/workflow/visual-review-policy';
import { deriveMissionVisualReview, type VisualReviewStateInput } from '@/lib/workflow/visual-review-state';
import { presentVisualReview } from '@/lib/workflow/visual-review-presentation';

const audit = { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null };
const review = (over: Record<string, unknown> = {}) => ({
  phase: 'reviewed' as const, screens: 6, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false,
  needsYouReason: null, captured: 0, expected: null, ...over,
});
const branch = (pr: Record<string, unknown>): VisualReviewStateInput['branch'] => ({
  headSha: 'abcdef1234567', base: 'dev', workLanded: true,
  integrationPr: { number: 4501, state: 'open', ready: false, blocked: false, ...pr },
});
const base: VisualReviewStateInput = {
  policy: resolveVisualReviewPolicy({}), uiChange: { state: 'yes', source: 'diff', uiFiles: 12 },
  audit: null, review: null, waiver: null, branch: branch({}),
};

const CASES: Array<{ name: string; over: Partial<VisualReviewStateInput>; merge?: boolean }> = [
  { name: 'Verifying', over: { audit, review: review({ phase: 'capturing', captured: 3, expected: 8 }) } },
  { name: 'Fixing', over: { audit, review: review({ phase: 'fixing', effectiveIssues: 2, openFixes: 2 }) } },
  { name: 'Retrying a failed check', over: { audit, review: review({ phase: 'failed' }), autoRetriesLeft: 2 } },
  { name: 'Check could not run', over: { audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 } },
  { name: 'Preview setup needed', over: { audit, review: review({ phase: 'failed' }), captureConfigError: 'protection_bypass_missing' } },
  { name: 'Your call after fixes', over: { audit, review: review({ phase: 'needs_you', effectiveIssues: 3, roundCapOpen: true }) } },
  { name: 'Ask policy', over: { policy: resolveVisualReviewPolicy({ workspace: 'ask' }) } },
  { name: 'Ready to merge', over: { audit, review: review(), auditedSha: 'abcdef1234567', branch: branch({ ready: true }) }, merge: true },
  { name: 'Merged', over: { audit, review: review(), auditedSha: 'abcdef1234567', branch: branch({ state: 'merged', ready: true }) } },
];

export default function BranchPanelFixture() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-4" data-testid="branch-panel-fixture">
      {CASES.map(c => {
        const p = presentVisualReview(deriveMissionVisualReview({ ...base, ...c.over }), { ownerMergesIntegration: c.merge });
        return (
          <div key={c.name}>
            <p className="mb-1 font-mono text-meta text-text-muted">{c.name}</p>
            <MissionBranchPanel missionId="fixture" presentation={p} prUrl="#" workspaceSettingsHref="#" />
          </div>
        );
      })}
      <div>
        <p className="mb-1 font-mono text-meta text-text-muted">Records</p>
        <MissionVisualRecord record={{ kind: 'waiver', text: 'Visual check waived', detail: 'Emergency copy fix', reason: 'Emergency copy fix', actor: 'owner', at: '2026-10-02T10:00:00Z', policy: 'ask' }} />
        <MissionVisualRecord record={{ kind: 'auto_no_impact', text: 'No visual changes', detail: 'Checked automatically. No visual review was needed.' }} />
      </div>
    </div>
  );
}
