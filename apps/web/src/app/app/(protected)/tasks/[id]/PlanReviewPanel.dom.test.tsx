/**
 * PlanStepDescription in a browser (happy-dom): the "Show more" toggle follows
 * the measured overflow of the clamped box, not the character count. Runs in
 * its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
const { PlanStepDescription, PLAN_STEP_PREVIEW_CHARS } = await import('./PlanReviewPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom does no layout, so stub the two heights the component compares.
function withHeights(scrollHeight: number, clientHeight: number) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ['scrollHeight', 'clientHeight'].map(k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight });
  return () => { for (const [k, d] of saved) d ? Object.defineProperty(proto, k, d) : delete proto[k]; };
}

async function mount(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => { createRoot(el).render(<PlanStepDescription content={content} />); });
  return el;
}

const LONG = 'word '.repeat(PLAN_STEP_PREVIEW_CHARS);

describe('PlanStepDescription — measured overflow', () => {
  it('hides "Show more" for a long step that fits in four lines (wide column)', async () => {
    const restore = withHeights(80, 80);
    try {
      const el = await mount(LONG);
      expect(el.textContent).not.toContain('Show more');
    } finally { restore(); }
  });

  it('shows "Show more" for a short step whose lines overflow the clamp', async () => {
    const restore = withHeights(200, 80);
    try {
      const el = await mount('- a\n- b\n- c\n- d\n- e\n- f');
      expect(el.textContent).toContain('Show more');
    } finally { restore(); }
  });
});
