/**
 * docs/specs/task-page.md: a structured result reads as prose; its raw payload
 * (confidence included) only inside Run details › Raw output, wrapped.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

// Disclosures mount their body only while open; render them open.
mock.module('@/components/ui/Disclosure', () => ({
  default: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => <div>{summary}{children}</div>,
}));
mock.module('@/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-md="">{content}</div>,
}));

const { TaskShippedBody, TaskShippedDetails } = await import('./TaskShippedHeader');
const { buildTaskShippedView } = await import('./task-shipped-header');

const SCREENSHOT = JSON.stringify({ summary: 'Both PRs land.\n\nRecovery is unblocked.', verdict: 'approve', confidence: 0.8 });
const reviewView = () => buildTaskShippedView({
  taskStatus: 'completed', taskMode: 'execution', conventionalType: null, category: null, record: null,
  summary: SCREENSHOT, summarySource: 'agent', heroShots: [], subject: { kind: 'review', prNumber: 4413 }, shipped: false,
})!;

describe('a review result on the page', () => {
  it('the body is the summary prose, not JSON', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={reviewView()} />);
    expect(html).toContain('Both PRs land.');
    expect(html).not.toContain('{&quot;summary');
    expect(html).not.toContain('confidence');
  });

  it('Technical summary never shows JSON; Raw output holds it, wrapped', () => {
    const html = renderToStaticMarkup(<TaskShippedDetails view={reviewView()} runDetails={[{ label: 'Turns', value: '9' }]} />);
    expect(html).not.toContain('Technical summary');
    const [beforeRaw, raw] = html.split('Raw output');
    expect(beforeRaw).not.toContain('confidence');
    expect(raw).toContain('&quot;confidence&quot;: 0.8');
    expect(raw).toContain('whitespace-pre-wrap');
    expect(raw).not.toContain('overflow-x-auto');
  });
});
