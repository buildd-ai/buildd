import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/failures' });
import { expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FailureGroupsSection } from './FailureGroups';
import { buildFailureGroups } from '@/lib/health-failure-groups';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('one-off causes remain available with their task and error evidence', () => {
  const now = Date.now();
  const groups = { ...buildFailureGroups({ failures: [{ workerId: 'w', taskId: 't', taskTitle: 'research: compare providers', workspaceName: 'Workspace', error: 'Unique error', exitCause: 'code_failure', completedAt: new Date(now).toISOString() }], traces: [] }), truncated: false };
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    act(() => root.render(<FailureGroupsSection groups={groups} headline={null} windowLabel="7d" now={now} />));
    expect(el.textContent).toContain('1 one-off failure');
    expect(el.querySelector('[data-testid="failure-group"]')).toBeNull();
    act(() => { el.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(el.querySelector('[data-testid="failure-group"]')).not.toBeNull();
    act(() => { el.querySelector<HTMLButtonElement>('[data-testid="failure-group"] button')!.click(); });
    expect(el.querySelector('[data-testid="failure-group-detail"]')?.textContent).toContain('Unique error');
    expect(el.querySelector('a')?.textContent).toBe('Compare providers');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/t');
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});
