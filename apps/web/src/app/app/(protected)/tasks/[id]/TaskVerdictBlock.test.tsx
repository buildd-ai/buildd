import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskVerdictBlock from './TaskVerdictBlock';
import type { TaskVerdict } from '@/lib/task-verdict';

const V = (over: Partial<TaskVerdict> = {}): TaskVerdict => ({
  state: 'done', headline: 'Done', cause: null, actions: [], causeKey: 'done', failingChecks: [], wordedBy: 'rules', ...over,
});
const render = (v: TaskVerdict) => renderToStaticMarkup(<TaskVerdictBlock verdict={v} displayStatus="completed" />);
const count = (html: string, s: string) => html.split(s).length - 1;

describe('TaskVerdictBlock: one compact outcome (docs/specs/task-page.md)', () => {
  it('has no "Why this?" control and no ledger prose', () => {
    const html = render(V({ wordedBy: 'model' }));
    expect(html).not.toContain('Why this');
    expect(html).not.toContain('task-verdict-why');
    expect(html).not.toContain('decision model');
  });

  it('AC-8: "Done" appears once, with no heading repeating it', () => {
    const html = render(V());
    expect(count(html, '>Done<')).toBe(1);
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('card');
  });

  it('a review outcome uses its own word', () => {
    const html = render(V({ label: 'Review approved', headline: 'Review approved' }));
    expect(count(html, 'Review approved')).toBe(1);
    expect(html).not.toContain('>Done<');
  });

  it('a headline that starts with the label keeps only the rest', () => {
    const html = render(V({ state: 'shipped', headline: 'Shipped · PR #12 merged', actions: [{ label: 'View PR #12', href: 'https://x/pull/12', tone: 'quiet', external: true }] }));
    expect(html).toContain('PR #12 merged');
    expect(count(html, 'Shipped')).toBe(1);
    // A quiet link stays inline: no card, no button row.
    expect(html).not.toContain('task-verdict-actions');
    expect(html).toContain('View PR #12');
  });

  it('a decision keeps the card and its primary action', () => {
    const html = render(V({ state: 'needs_you', headline: 'Ready to merge · PR #12', actions: [{ label: 'Review & merge', href: 'https://x/pull/12', tone: 'primary', external: true }] }));
    expect(html).toContain('card-decision');
    expect(html).toContain('task-verdict-actions');
  });

  it('keeps the e2e status hook', () => {
    expect(render(V())).toContain('data-testid="task-header-status"');
  });
});
