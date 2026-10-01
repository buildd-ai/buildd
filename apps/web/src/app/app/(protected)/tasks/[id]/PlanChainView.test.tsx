import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanChainView from './PlanChainView';

const roleMap = { builder: { name: 'Builder', color: '#C47A3A' } };

function task(over: Record<string, unknown>) {
  return { id: 't', title: 'Step', status: 'pending', roleSlug: null, worker: null, artifacts: [], ...over } as never;
}

function eyebrows(html: string): string[] {
  return [...html.matchAll(/data-testid="plan-card-eyebrow"[^>]*>([\s\S]*?)<\/span>(?=<\/div>)/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").trim());
}

// Regression: most tasks carry no role, so every plan card read "unassigned" —
// including completed ones, where "unassigned · completed #3221" read as if
// nobody did the work (docs/design/task-presentation.md, "Eyebrow").
describe('PlanChainView eyebrow', () => {
  it('never prints "unassigned"', () => {
    const html = renderToStaticMarkup(
      <PlanChainView
        currentTaskId="a"
        roleMap={roleMap}
        tasks={[
          task({ id: 'a', status: 'completed', worker: { prUrl: null, prNumber: 3221, turns: 1, branch: 'b', mergedAt: new Date(), prLifecycleStatus: 'merged' } }),
          task({ id: 'b', status: 'pending' }),
        ]}
      />,
    );
    expect(html).not.toContain('unassigned');
  });

  it('lets the PR state carry a completed card, and drops its role', () => {
    const html = renderToStaticMarkup(
      <PlanChainView
        currentTaskId="x"
        roleMap={roleMap}
        tasks={[
          task({ id: 'a', status: 'completed', roleSlug: 'builder', worker: { prUrl: null, prNumber: 3221, turns: 1, branch: 'b', mergedAt: new Date(), prLifecycleStatus: 'merged' } }),
          task({ id: 'b', status: 'completed', worker: { prUrl: null, prNumber: 3222, turns: 1, branch: 'c', mergedAt: null, prLifecycleStatus: 'ci_green' } }),
        ]}
      />,
    );
    expect(eyebrows(html)).toEqual(['merged #3221', 'PR open #3222']);
    expect(html).not.toContain('Builder');
  });

  it('shows the role on a pending card and nothing for a roleless one', () => {
    const html = renderToStaticMarkup(
      <PlanChainView
        currentTaskId="x"
        roleMap={roleMap}
        tasks={[task({ id: 'a', roleSlug: 'builder' }), task({ id: 'b', roleInferred: true, roleSlug: 'builder' }), task({ id: 'c' })]}
      />,
    );
    expect(eyebrows(html)).toEqual(['Builder', 'Builderauto']);
  });

  it('names the runner of a running card only when more than one runner is online', () => {
    const running = task({ id: 'a', status: 'in_progress', roleSlug: 'builder', worker: { prUrl: null, prNumber: null, turns: 3, branch: 'b', status: 'running', runner: 'atlas' } });
    const one = renderToStaticMarkup(<PlanChainView currentTaskId="x" roleMap={roleMap} tasks={[running]} onlineRunners={1} />);
    const two = renderToStaticMarkup(<PlanChainView currentTaskId="x" roleMap={roleMap} tasks={[running]} onlineRunners={2} />);
    expect(one).not.toContain('atlas');
    expect(two).toContain('atlas');
  });
});
