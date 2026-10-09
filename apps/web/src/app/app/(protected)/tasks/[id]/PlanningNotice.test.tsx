import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanningNotice from './PlanningNotice';

describe('PlanningNotice: a planning task’s state as the shared Notice', () => {
  it('approved with child tasks: ok', () => {
    const html = renderToStaticMarkup(<PlanningNotice subTaskCount={3} running={false} status="completed" />);
    expect(html).toContain('class="notice notice-ok');
    expect(html).toContain('Plan approved · 3 child tasks created');
    expect(renderToStaticMarkup(<PlanningNotice subTaskCount={1} running={false} status="completed" />)).toContain('1 child task created');
  });

  it('writing: neutral info, never a tinted box', () => {
    const html = renderToStaticMarkup(<PlanningNotice subTaskCount={0} running status="assigned" />);
    expect(html).toContain('class="notice notice-info');
    expect(html).toContain('The agent is writing a plan…');
    expect(html).not.toMatch(/bg-status-/);
  });

  it('pending or assigned: neutral info that a plan is coming', () => {
    for (const status of ['pending', 'assigned']) {
      expect(renderToStaticMarkup(<PlanningNotice subTaskCount={0} running={false} status={status} />)).toContain('A planning agent will write a plan for your review');
    }
  });

  it('a completed plan awaiting review renders nothing (the review panel owns it)', () => {
    expect(renderToStaticMarkup(<PlanningNotice subTaskCount={0} running={false} status="completed" />)).toBe('');
  });
});
