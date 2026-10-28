import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionFinalScreens from './MissionFinalScreens';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';

describe('MissionFinalScreens', () => {
  const model = buildVisualReviewFixtureModel('needs_you', { needsYou: 'round_cap' });

  it('shows one screenshot per current screen', () => {
    const html = renderToStaticMarkup(<MissionFinalScreens model={model} followUps={[]} />);
    expect(html).toContain('data-testid="mission-final-screens"');
    expect(html.split('data-testid="mission-final-screen"').length - 1).toBe(model.cells.length);
  });

  it('marks screens left open and lists the follow-ups filed for them', () => {
    const html = renderToStaticMarkup(<MissionFinalScreens model={model} followUps={[{ id: 't1', title: '[surface fix] /app/x: y', status: 'pending' }]} />);
    expect(html).toContain('data-open="true"');
    expect(html).toContain('filed as a follow-up fix');
    expect(html).toContain('href="/app/tasks/t1"');
  });

  it('renders nothing for a model with no screens', () => {
    expect(renderToStaticMarkup(<MissionFinalScreens model={{ ...model, cells: [] }} followUps={[]} />)).toBe('');
  });
});
