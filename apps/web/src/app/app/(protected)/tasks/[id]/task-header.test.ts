import { describe, test, expect } from 'bun:test';
import { taskHeading } from './task-header';

describe('taskHeading', () => {
  test('a conventional title becomes eyebrow parts + a readable subject', () => {
    expect(taskHeading({ title: "feat(invoices): render invoices in the customer's currency", label: null }, 'Builder')).toEqual({
      eyebrow: ['feat', 'invoices', 'Builder'],
      heading: "Render invoices in the customer's currency",
    });
  });

  test('a stored scope-less title keeps the whole title and just the role', () => {
    expect(taskHeading({ title: 'Investigate the flaky login test', label: null }, 'Researcher')).toEqual({
      eyebrow: ['Researcher'],
      heading: 'Investigate the flaky login test',
    });
  });

  test('type without scope, and no role', () => {
    expect(taskHeading({ title: 'fix: handle empty carts', label: null }, null)).toEqual({
      eyebrow: ['fix'],
      heading: 'Handle empty carts',
    });
  });

  test('retry bracket prefixes are peeled into the eyebrow, not the heading', () => {
    const h = taskHeading({ title: '[builder · after CI #1] feat(invoices): render invoices', label: null }, 'Builder');
    expect(h.heading).toBe('Render invoices');
    expect(h.eyebrow).toEqual(['feat', 'invoices', 'Builder', 'after CI #1']);
  });
});

describe('taskHeading delegates to displayTaskTitle', () => {
  test('a mission refresh title reads the same as on every other surface', () => {
    expect(taskHeading({ title: 'chore(mission): merge dev into the Widget Polish integration branch', label: null }, null).heading)
      .toBe('Refresh Widget Polish from dev');
  });

  test('a ship title behind a retry wrap', () => {
    expect(taskHeading({ title: '[builder · after review #2] Ship mission: Widget Polish', label: null }, null).heading)
      .toBe('Ship Widget Polish');
  });
});
