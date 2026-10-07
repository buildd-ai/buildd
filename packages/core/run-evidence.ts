/** Pure lifecycle projection. Narration and legacy percentages never prove progress. */
export type RunPhaseKey = 'claimed' | 'started' | 'changed' | 'committed' | 'pushed' | 'pr_open' | 'ci' | 'review' | 'merged' | 'delivered';
export interface RunEvidencePhase {
  key: RunPhaseKey;
  label: string;
  state: 'done' | 'current' | 'todo' | 'skipped' | 'failed' | 'unknown';
  at: number | null;
  source: 'observed' | 'reported' | 'inferred' | 'implied';
  subState?: string;
}
export interface RunEvidence { phases: RunEvidencePhase[] }
export interface RunEvidenceInput {
  status?: string | null;
  createdAt?: Date | string | number | null;
  startedAt?: Date | string | number | null;
  completedAt?: Date | string | number | null;
  mergedAt?: Date | string | number | null;
  milestones?: unknown;
  dirtyWorktree?: boolean | null;
  observedTouches?: unknown[] | null;
  filesChanged?: number | null;
  lastCommitSha?: string | null;
  commitCount?: number | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prIsDraft?: boolean | null;
  prLifecycleStatus?: string | null;
  outputRequirement?: string | null;
  deliverableArtifactCount?: number | null;
  usesReviewer?: boolean;
  reviewState?: string | null;
}
function epoch(value: RunEvidenceInput['createdAt']): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}
export function deriveRunEvidence(input: RunEvidenceInput): RunEvidence {
  const milestones = Array.isArray(input.milestones) ? input.milestones : [];
  const checkpoint = (event: string): number | null => {
    const times = milestones.filter(m => m?.type === 'checkpoint' && m.event === event && Number.isFinite(m.ts)).map(m => m.ts as number);
    return times.length ? Math.min(...times) : null;
  };
  const phase = (key: RunPhaseKey, label: string, lit: boolean, known: boolean, at: number | null = null, source: RunEvidencePhase['source'] = 'observed'): RunEvidencePhase => ({ key, label, state: lit ? 'done' : known ? 'todo' : 'unknown', at, source });
  const started = checkpoint('session_started') ?? epoch(input.startedAt);
  const changed = checkpoint('first_edit');
  const observedChange = changed != null || input.dirtyWorktree === true || !!input.observedTouches?.length;
  const reportedChange = (input.filesChanged ?? 0) > 0;
  const committed = checkpoint('first_commit');
  const observedCommit = !!input.lastCommitSha && (input.commitCount ?? 0) > 0;
  const pushed = checkpoint('first_push');
  const hasPr = !!(input.prNumber || input.prUrl);
  const merged = !!input.mergedAt || input.prLifecycleStatus === 'merged';
  const lifecycle = input.prLifecycleStatus;
  const ciStates: Record<string, string> = { ci_running:'running', ci_green:'passed', ci_failed:'failed', conflict:'conflict' };
  const ci = phase('ci', 'CI', lifecycle === 'ci_green', lifecycle != null);
  if (lifecycle && ciStates[lifecycle]) {
    ci.subState = ciStates[lifecycle];
    ci.state = lifecycle === 'ci_green' ? 'done' : lifecycle === 'ci_running' ? 'current' : 'failed';
  } else ci.state = 'unknown'; // A later lifecycle does not prove prior checks.
  const reviewExists = !!input.reviewState && input.reviewState !== 'not_requested';
  const review = phase('review', 'Review', input.reviewState === 'approved', input.reviewState != null || input.usesReviewer === true);
  if (reviewExists) {
    review.subState = input.reviewState!;
    review.state = ['changes_requested','escalated','review_failed'].includes(input.reviewState!) ? 'failed' : input.reviewState === 'approved' ? 'done' : 'current';
  } else if (input.usesReviewer === false) review.state = 'skipped';
  const pr = phase('pr_open', input.prIsDraft ? 'Draft PR' : 'PR', hasPr, input.prUrl !== undefined || input.prNumber !== undefined);
  if (lifecycle === 'closed' && !merged) pr.state = 'failed';
  const phases: RunEvidencePhase[] = [
    phase('claimed', 'Claimed', true, true, epoch(input.createdAt)),
    phase('started', 'Started', started != null, input.startedAt !== undefined, started),
    phase('changed', 'Changes', observedChange || reportedChange, input.dirtyWorktree != null || input.observedTouches != null || input.filesChanged != null, changed, observedChange ? 'observed' : reportedChange ? 'reported' : 'observed'),
    phase('committed', 'Commit', observedCommit || committed != null, input.commitCount === 0 || (!!input.lastCommitSha && input.commitCount != null), committed, observedCommit ? 'observed' : committed != null ? 'inferred' : 'observed'),
    phase('pushed', 'Pushed', pushed != null || hasPr, false, pushed, pushed != null ? 'observed' : hasPr ? 'implied' : 'observed'),
    pr, ci, review,
    phase('merged', 'Merged', merged, input.mergedAt !== undefined, epoch(input.mergedAt)),
  ];
  const artifactPath = input.outputRequirement === 'artifact_required' || input.outputRequirement === 'none';
  const selected = artifactPath ? [phases[0], phases[1], ...(observedChange || reportedChange ? [phases[2]] : []), phase('delivered', 'Delivered', (input.deliverableArtifactCount ?? 0) > 0 || input.status === 'completed', input.deliverableArtifactCount != null || input.status != null, epoch(input.completedAt))] : phases;
  // Unknown means unavailable evidence, never a manufactured pending step.
  const live = ['running','starting','working','waiting_input','waiting'].includes(input.status ?? '');
  if (live && !selected.some(p => p.state === 'current' || p.state === 'failed')) {
    const next = selected.find(p => p.state === 'todo');
    if (next) next.state = 'current';
  }
  return { phases: selected };
}
