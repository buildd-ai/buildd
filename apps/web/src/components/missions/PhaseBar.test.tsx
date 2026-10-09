import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PhaseBar from './PhaseBar';

// Regression (UX review, missions list at 390px): a centred label wider than
// its cell was clipped at both ends ("nvoice", "heckou"). The label now sits
// in a truncating span, so a narrow cell reads "invo…" from its first letter.
describe('PhaseBar cell labels', () => {
  const html = renderToStaticMarkup(
    <PhaseBar
      phases={[{
        key: 'p1', phaseKey: 'p1', label: 'Currency through the product', done: 0, total: 1,
        cells: [{ taskId: 't1', label: 'invoices', title: 'render in currency', state: 'queued', href: '/app/tasks/t1' }],
      }]}
    />,
  );

  it('truncates the label from its end instead of clipping both sides', () => {
    expect(html).toMatch(/<span class="[^"]*\btruncate\b[^"]*">invoices<\/span>/);
  });
});
