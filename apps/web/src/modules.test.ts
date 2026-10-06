import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBSCRIBERS, COMPLETION_POLICIES } from './modules';
import { COMPLETION_SLOTS } from './lib/completion-policy';
import { moduleOf } from '../../../scripts/module-boundaries';

/**
 * The composition root's order is behaviour: subscribers to one event run in
 * list order. These are the orders the inline calls in the worker PATCH, the
 * GitHub webhook and PR reconciliation ran in before they moved behind emit().
 */
const byEvent = (type: string) => SUBSCRIBERS.filter(s => s.on === type).map(s => `${s.module}:${s.label}`);

describe('composition root', () => {
  it('worker.reported: criteria verdicts before the mission completion attempt, then the subject sweep', () => {
    expect(byEvent('worker.reported')).toEqual([
      'missions:criteria-verification-outcome',
      'missions:criteria-prose-outcome',
      'missions:criteria-worker-eval-outcome',
      'missions:mission-completion-attempt',
      'missions:subject-anchor-sweep',
    ]);
  });

  it('task.completed: a resolved release\'s mission attempt, chat, the ledger, the team push, then its analytics row', () => {
    expect(byEvent('task.completed')).toEqual([
      'missions:mission-completion-on-release-completed',
      'chat:chat-task-completed',
      'notifications:ledger-task-completed',
      'notifications:push-task-completed',
      'health-quality:release-outcome-analytics-completed',
    ]);
  });

  it('task.failed: a resolved release\'s mission attempt, the ledger, the push (which carries the credential alert), then its analytics row', () => {
    expect(byEvent('task.failed')).toEqual([
      'missions:mission-completion-on-release-failed',
      'notifications:ledger-task-failed',
      'notifications:push-task-failed',
      'health-quality:release-outcome-analytics-failed',
    ]);
  });

  it('task.created: the category look is scheduled before the mission chain starts', () => {
    expect(byEvent('task.created')).toEqual(['jev-decisions:task-category-look', 'missions:task-created-mission-feed']);
  });

  it('the rest', () => {
    expect(byEvent('team.created')).toEqual(['roles-skills:seed-default-roles']);
    expect(byEvent('task.retrying')).toEqual(['notifications:push-task-retrying']);
    expect(byEvent('task.terminal')).toEqual(['knowledge:task-evidence']);
    expect(byEvent('worker.finished')).toEqual(['knowledge:memory-use-labels']);
    expect(byEvent('task.needs_input')).toEqual(['notifications:ledger-task-needs-input']);
    expect(byEvent('pr.merged')).toEqual(['releases:release-record-prod-merge', 'notifications:ledger-pr-merged']);
    expect(byEvent('task.pr_merge_delivered')).toEqual(['missions:loop-advance-on-merge', 'missions:open-mission-integration-pr']);
    // The mission wakes and dependents unblock before the release trigger.
    expect(byEvent('task.pr_merged')).toEqual([
      'missions:mission-wake-on-merge', 'missions:unblock-dependent-missions', 'releases:release-path-b-trigger',
    ]);
    // The verdict is measured before the reviewer is superseded.
    expect(byEvent('pr.closed')).toEqual([
      'missions:settle-surface-intents',
      'reviews:merge-review-telemetry',
      'reviews:supersession-detect-on-close',
      'reviews:supersession-reconcile-on-close',
      'reviews:dead-pr-shutdown',
    ]);
    expect(byEvent('pr.close_delivered')).toEqual(['reviews:pr-activity-on-close', 'reviews:review-callback-on-close']);
    expect(byEvent('pr.review_submitted')).toEqual(['reviews:capture-review-feedback', 'reviews:github-verdict-mission-note']);
    expect(byEvent('pr.review_comment_created')).toEqual(['reviews:capture-review-comment']);
    expect(byEvent('pr.base_changed')).toEqual(['missions:retarget-surface-intents']);
    expect(byEvent('pr.needs_human')).toEqual(['missions:notify-mission-pr-ready']);
    expect(byEvent('workflow_run.completed')).toEqual(['releases:release-workflow-run-readback']);
    expect(byEvent('pr.ci_failed')).toEqual(['notifications:ledger-pr-ci-failed']);
  });

  it('completion policies: exactly one per core-declared slot, in core\'s order', () => {
    expect(COMPLETION_SLOTS).toEqual(['evidence', 'loop', 'release']);
    expect(Object.keys(COMPLETION_POLICIES).sort()).toEqual([...COMPLETION_SLOTS].sort());
  });

  it('labels are unique, so a page names exactly one step', () => {
    const labels = SUBSCRIBERS.map(s => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every subscriber file is module code, not core: core only emits', () => {
    const src = readFileSync(join(import.meta.dir, 'modules.ts'), 'utf8');
    const files = [...src.matchAll(/^import \{[^}]*\} from '@\/(lib\/[^']+)'/gm)].map(m => `apps/web/src/${m[1]}.ts`);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) expect(moduleOf(f), f).not.toBe('core');
  });
});
