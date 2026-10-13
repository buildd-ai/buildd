/**
 * Diagrams and tables on spec surfaces (living-specs.md §15, AC-57..AC-60),
 * mounted in happy-dom with the mermaid library stubbed: a ```mermaid block
 * draws through the lazy loader, a failure shows the source and why, other
 * surfaces never load it, and spec tables sit in a sideways-scrolling box.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MarkdownContent } = await import('./MarkdownContent');
const { mermaidLoader } = await import('./MermaidBlock');

const DIAGRAM = '```mermaid\ngraph TD\n  A[Cart] --> B[Checkout]\n```\n';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realLoad = mermaidLoader.load;
let loads = 0;
let config: Record<string, unknown> | null = null;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  loads = 0;
  config = null;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mermaidLoader.load = realLoad;
});
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('mermaid on a spec surface', () => {
  it('draws the diagram through the lazy loader, strictly, from the block source', async () => {
    const seen: string[] = [];
    mermaidLoader.load = async () => {
      loads++;
      return {
        initialize: (c) => { config = c; },
        render: async (_id, source) => { seen.push(source); return { svg: '<svg data-x="1"><text>Cart</text></svg>' }; },
      };
    };
    act(() => root.render(<MarkdownContent content={`Intro\n\n${DIAGRAM}`} surface="spec" />));
    // Before the library answers, the source shows as code.
    expect(q('mermaid-source')!.textContent).toContain('A[Cart] --> B[Checkout]');
    await flush();
    expect(q('mermaid-diagram')!.querySelector('svg')).not.toBeNull();
    expect(seen).toEqual(['graph TD\n  A[Cart] --> B[Checkout]']);
    expect(config).toMatchObject({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false });
    expect(loads).toBe(1);
  });

  it('a diagram that fails shows its source and the reason', async () => {
    mermaidLoader.load = async () => ({ initialize: () => {}, render: async () => { throw new Error('Parse error on line 2'); } });
    act(() => root.render(<MarkdownContent content={DIAGRAM} surface="spec" />));
    await flush();
    const err = q('mermaid-error')!;
    expect(err.textContent).toContain('This diagram could not be drawn: Parse error on line 2');
    expect(err.querySelector('pre')!.textContent).toContain('A[Cart] --> B[Checkout]');
  });

  it('other surfaces, and specs with no diagram, never load the library', async () => {
    mermaidLoader.load = async () => { loads++; throw new Error('should not load'); };
    act(() => root.render(<MarkdownContent content={DIAGRAM} />));
    await flush();
    expect(q('mermaid-source')).toBeNull();
    expect(container.querySelector('pre code')!.textContent).toContain('graph TD');
    act(() => root.render(<MarkdownContent content={'```ts\nconst x = 1\n```\n'} surface="spec" />));
    await flush();
    expect(loads).toBe(0);
  });
});

describe('tables on a spec surface', () => {
  const TABLE = '| ID | Requirement | Check | Owner | Area | Notes |\n|---|---|---|---|---|---|\n| AC-1 | Empty cart shows the empty state | unit | max | cart | a long note that makes the row wide |\n| AC-2 | Totals in the shopper currency | unit | max | cart | another note |\n';
  it('sit in a box that scrolls sideways, with ruled cells', () => {
    act(() => root.render(<MarkdownContent content={TABLE} surface="spec" />));
    const box = q('spec-table')!;
    expect(box.className).toContain('overflow-x-auto');
    expect(box.className).toContain('max-w-full');
    expect(box.querySelectorAll('th')).toHaveLength(6);
    expect(box.querySelector('td')!.className).toContain('border-border-default');
    expect(box.querySelector('table')!.className).toContain('w-max');
  });
  it('elsewhere keep their plain look', () => {
    act(() => root.render(<MarkdownContent content={TABLE} />));
    expect(q('spec-table')).toBeNull();
    expect(container.querySelector('td')!.className).toBe('');
  });
});
