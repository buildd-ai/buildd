import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBSCRIBERS } from './modules';
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

  it('task.completed: chat, then the ledger, then the team push', () => {
    expect(byEvent('task.completed')).toEqual([
      'chat:chat-task-completed',
      'notifications:ledger-task-completed',
      'notifications:push-task-completed',
    ]);
  });

  it('task.failed: the ledger, then the push (which carries the credential alert)', () => {
    expect(byEvent('task.failed')).toEqual(['notifications:ledger-task-failed', 'notifications:push-task-failed']);
  });

  it('the rest', () => {
    expect(byEvent('task.retrying')).toEqual(['notifications:push-task-retrying']);
    expect(byEvent('task.terminal')).toEqual(['knowledge:task-evidence']);
    expect(byEvent('worker.finished')).toEqual(['knowledge:memory-use-labels']);
    expect(byEvent('task.needs_input')).toEqual(['notifications:ledger-task-needs-input']);
    expect(byEvent('pr.merged')).toEqual(['notifications:ledger-pr-merged']);
    expect(byEvent('pr.ci_failed')).toEqual(['notifications:ledger-pr-ci-failed']);
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
