import { describe, expect, it } from 'bun:test';
import { taskDisplayLabel } from '@buildd/core/task-label';
import { taskShortLabel } from './segment-label';

describe('taskShortLabel', () => {
  const cases: Array<[string, string | null, string]> = [
    ['feat(db): currency on invoices', null, 'db'],
    ['RESEARCH: Rate providers compared', null, 'research'],
    ['docs: admin guide', null, 'docs'],
    ['test(e2e): pay an invoice', null, 'e2e'],
    ['[builder · after CI #1] feat(invoices): render totals', null, 'invoices'],
    ['Mission: Example goal', 'planning', 'plan'],
  ];
  for (const [title, mode, label] of cases) {
    it(`${title} → ${label}`, () => {
      expect(taskShortLabel({ title, mode }).label).toBe(label);
    });
  }

  it('the line beside the cell is the shared short label', () => {
    const title = 'feat(export): accounting CSV carries both currencies';
    expect(taskShortLabel({ title }).rest).toBe(taskDisplayLabel({ title }).label);
  });

  it('a stored label wins for the line; the scope still names the cell', () => {
    const t = { title: 'feat(api): currency on the public API', label: 'Public API currency' };
    expect(taskShortLabel(t)).toEqual({ label: 'api', rest: 'Public API currency' });
  });

  it('with no scope or telling type, the label’s first word names the cell', () => {
    const t = taskShortLabel({ title: 'feat: onboarding checklist for admins' });
    expect(t.label).toBe(taskDisplayLabel({ title: 'feat: onboarding checklist for admins' }).label.split(' ')[0].toLowerCase());
  });

  it('clips a long label', () => {
    expect(taskShortLabel({ title: 'feat(supercalifragilistic): x' }).label.length).toBeLessThanOrEqual(12);
  });
});
