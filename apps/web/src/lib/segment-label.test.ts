import { describe, expect, it } from 'bun:test';
import { taskShortLabel } from './segment-label';

describe('taskShortLabel', () => {
  const cases: Array<[string, string | null, string, string]> = [
    ['feat(db): currency on invoices', null, 'db', 'currency on invoices'],
    ['RESEARCH: Rate providers compared', null, 'research', 'Rate providers compared'],
    ['docs: admin guide', null, 'docs', 'admin guide'],
    ['test(e2e): pay an invoice', null, 'e2e', 'pay an invoice'],
    ['[builder · after CI #1] feat(invoices): render totals', null, 'invoices', 'render totals'],
    ['feat: onboarding checklist', null, 'onboarding', 'checklist'],
    ['Mission: Example goal', 'planning', 'plan', 'Example goal'],
    ['Tidy the release notes', null, 'tidy', 'the release notes'],
  ];
  for (const [title, mode, label, rest] of cases) {
    it(`${title} → ${label}`, () => {
      expect(taskShortLabel({ title, mode })).toEqual({ label, rest });
    });
  }

  it('clips a long label', () => {
    expect(taskShortLabel({ title: 'feat(supercalifragilistic): x' }).label.length).toBeLessThanOrEqual(12);
  });

  it('a "Mission:" title outside planning mode is not the plan', () => {
    expect(taskShortLabel({ title: 'Mission: Example', mode: 'execution' }).label).toBe('mission');
  });
});
