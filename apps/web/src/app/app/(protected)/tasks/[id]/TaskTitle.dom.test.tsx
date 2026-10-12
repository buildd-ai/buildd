/**
 * The task page title on a phone (docs/specs/task-page.md §Mobile header):
 * three lines, then "Show full title" expands in place and "Show less"
 * collapses again. Runs in its own process (scripts/run-unit-tests.ts), so the
 * happy-dom globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/task-1' });

import { describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const { default: TaskTitle } = await import('./TaskTitle');
const { default: TaskSubjectLink } = await import('./TaskSubjectLink');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG = 'PR #4562: fix(migrations): the merge-safety inspector treats a refresh PR\'s migration renumber as a renumber, not lineage tampering';

async function mount(title: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<TaskTitle title={title} />); });
  return el;
}

describe('TaskTitle', () => {
  it('a long title is clamped to three lines below md, with a 44px "Show full title" that expands and collapses in place', async () => {
    // happy-dom has no layout: report the h1 as clipped (taller than it shows).
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.tagName === 'H1' ? 200 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.tagName === 'H1' ? 75 : 0; } });
    const el = await mount(LONG);
    const h1 = el.querySelector('h1')!;
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="task-title-toggle"]')!;
    expect(h1.textContent).toBe(LONG);
    expect(h1.className).toContain('line-clamp-3');
    expect(h1.className).toContain('md:line-clamp-none');
    expect(h1.className).toContain('text-heading');
    expect(toggle.textContent).toBe('Show full title');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(h1.id);
    expect(toggle.className).toContain('min-h-11');
    expect(toggle.className).toContain('md:hidden');

    await act(async () => { toggle.click(); });
    expect(h1.className).not.toContain('line-clamp-3');
    expect(h1.className).toContain('[overflow-wrap:anywhere]');
    expect(toggle.textContent).toBe('Show less');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle.click(); });
    expect(h1.className).toContain('line-clamp-3');
  });

  it('a title that fits has no toggle', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 25; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 25; } });
    const el = await mount('Short title');
    expect(el.querySelector('[data-testid="task-title-toggle"]')).toBeNull();
  });
});

describe('TaskSubjectLink', () => {
  it('names the deliverable by PR number, keeping its full title in the accessible name and tooltip', () => {
    const html = renderToStaticMarkup(<TaskSubjectLink kind="review" href="/app/tasks/d" prNumber={4562} title={LONG.slice(10)} />);
    expect(html).toContain('Review of');
    expect(html).toContain('PR #4562');
    expect(html).toContain(`<span class="sr-only">: ${LONG.slice(10).replace(/'/g, '&#x27;')}</span>`);
    expect(html).toMatch(/title="fix\(migrations\)/);
    expect(html).toContain('min-h-11');
  });

  it('without a PR, the title is the reference, held to one line', () => {
    const html = renderToStaticMarkup(<TaskSubjectLink kind="fix" href="/app/tasks/d" prNumber={null} title="Rework the claim loop" />);
    expect(html).toContain('Fix for');
    expect(html).toMatch(/<span class="truncate">Rework the claim loop<\/span>/);
  });
});
