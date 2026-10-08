import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });
import { afterEach, expect, it } from 'bun:test';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { CostByBasis } = await import('./CostByBasis');
const { usageByBasis } = await import('./usage-model');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const row = (basis: 'real' | 'virtual' | 'mixed' | 'unknown', executor: 'runner' | 'interactive', costUsd: number) =>
  ({ role: 'r', tier: null, tokens: 10, costUsd, hours: 0, basis, executor });

// docs/specs/real-and-virtual-cost.md "Reporting".
it('shows real and plan dollars on separate rows, by runner and interactive, with a labelled combined total', () => {
  act(() => root.render(<CostByBasis split={usageByBasis([row('real', 'runner', 2), row('virtual', 'interactive', 5), row('virtual', 'runner', 1)])} />));
  expect(q('cost-basis-real')!.textContent).toContain('Real cost');
  expect(q('cost-basis-real')!.textContent).toContain('$2.00');
  expect(q('cost-basis-virtual')!.textContent).toContain('list price');
  expect(q('cost-basis-virtual')!.textContent).toContain('$5.00');
  expect(q('cost-basis-virtual')!.textContent).toContain('$6.00');
  expect(q('cost-basis-combined')!.textContent).toContain('Combined');
  expect(q('cost-basis-combined')!.textContent).toContain('$8.00');
  expect(q('cost-basis-unknown')).toBeNull();
  expect(q('cost-basis-mixed')).toBeNull();
  expect(container.textContent).not.toContain('—');
});

it('names usage without a reported basis on its own row', () => {
  act(() => root.render(<CostByBasis split={usageByBasis([row('unknown', 'runner', 1.5)])} />));
  expect(q('cost-basis-unknown')!.textContent).toContain('Basis not reported');
  expect(q('cost-basis-unknown')!.textContent).toContain('$1.50');
});

it('renders nothing when no worker in the window recorded usage', () => {
  act(() => root.render(<CostByBasis split={usageByBasis([])} />));
  expect(q('insights-cost-basis')).toBeNull();
});
