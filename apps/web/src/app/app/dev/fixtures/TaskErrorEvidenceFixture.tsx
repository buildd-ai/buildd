'use client';

/**
 * `?state=task-error-evidence`: the task page's Agent errors section for a
 * retried task. Two cases: a fresh start after a session that never began
 * (routine, diagnostic only) and an earlier attempt's commits missing from the
 * remote (current, red). Illustrative data only.
 */
import TaskErrorEvidence from '../../(protected)/tasks/[id]/TaskErrorEvidence';
import type { ErrorEvidenceItem } from '../../(protected)/tasks/[id]/error-evidence';

const excerpt = (branch: string) => `Branch "${branch}" was missing on remote - starting fresh from "dev".`;

const base = (over: Partial<ErrorEvidenceItem>): ErrorEvidenceItem => ({
  id: 'fixture-trace', pattern: 'resume_branch_fallback', source: 'git-operations', ts: '2026-09-30T13:46:04.000Z',
  excerpt: '', command: null, exitCode: null, output: '', presentation: 'noise', reason: '', decidedBy: 'rule',
  headline: null, attempt: { label: 'Attempt 2', workerId: 'fixture-worker-2' },
  before: [{ ts: '2026-09-30T13:46:02.000Z', text: 'Claimed task' }],
  after: [{ ts: '2026-09-30T13:46:09.000Z', text: 'Installing dependencies in the background' }],
  logUrl: null, ...over,
});

const FRESH_START = base({
  id: 'fixture-fresh', excerpt: excerpt('buildd/fixture-recon-specs'), output: excerpt('buildd/fixture-recon-specs'),
  headline: 'Started fresh after the previous session never began',
  reason: 'It made no commits, so nothing was lost.',
});

const LOST_WORK = base({
  id: 'fixture-lost', excerpt: excerpt('buildd/fixture-rebase-pr'), output: excerpt('buildd/fixture-rebase-pr'),
  presentation: 'needs_attention', headline: "A previous attempt's commits were not on the remote",
  reason: 'This attempt started over without them; check whether that work needs redoing.',
});

export default function TaskErrorEvidenceFixture() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-10">
      <section data-testid="fixture-fresh-start">
        <p className="mb-2 text-meta text-text-muted">Retry after a session that never began · task Done</p>
        <TaskErrorEvidence items={[FRESH_START]} taskTitle="Recon: living specs" terminalSucceeded taskState="Done" />
      </section>
      <section data-testid="fixture-lost-work">
        <p className="mb-2 text-meta text-text-muted">Retry after an attempt whose commits never reached the remote · task Done</p>
        <TaskErrorEvidence items={[LOST_WORK]} taskTitle="Rebase the PR onto the mission branch" terminalSucceeded taskState="Done" />
      </section>
    </div>
  );
}
