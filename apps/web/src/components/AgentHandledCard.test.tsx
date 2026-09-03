import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentHandledCard } from './AgentHandledCard';
import type { ActionQueueItem } from '@/lib/action-queue';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'https://github.com/org/repo/pull/2054',
    chip: 'FIXING_CI',
    prUrl: 'https://github.com/org/repo/pull/2054',
    prNumber: 2054,
    taskId: 'task-2',
    taskTitle: '[WU-2] Health tab restructure: metric contract',
    workspaceName: 'buildd',
    missionId: 'mis-2',
    missionTitle: 'Health analytics restructure',
    ...partial,
  };
}

describe('AgentHandledCard', () => {
  it('shows the fix attempt and links to it, with no merge affordance', () => {
    const html = renderToStaticMarkup(
      <AgentHandledCard
        item={item({ ciGate: { kind: 'fixing', label: 'Fixing CI · attempt 2 of 3', taskId: 'fix-1' } })}
      />,
    );
    expect(html).toContain('Fixing CI · attempt 2 of 3');
    expect(html).toContain('/app/tasks/fix-1');
    expect(html).toContain('Health analytics restructure');
    expect(html).not.toContain('Merge');
  });

  it('shows a running check suite without a fix link', () => {
    const html = renderToStaticMarkup(
      <AgentHandledCard item={item({ chip: 'CI_RUNNING', ciGate: { kind: 'running', label: 'CI running' } })} />,
    );
    expect(html).toContain('CI running');
    expect(html).not.toContain('View fix attempt');
  });
});
