/**
 * Regression: clicking the needs-input banner opened the task sheet and the
 * whole page failed with "e.trim is not a function". The runner writes
 * question options as objects ({ label, consequence, recommended }); this
 * input was typed, and only ever tested, with plain strings.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerRespondInput from './WorkerRespondInput';

describe('WorkerRespondInput', () => {
  it('renders the option objects a live question carries', () => {
    const html = renderToStaticMarkup(
      <WorkerRespondInput
        workerId="w1"
        question="Round per line, or only the total?"
        options={[
          { label: 'Round each line', consequence: 'The total matches the card charge.', recommended: true },
          { label: 'Round the total', description: 'Matches the ledger.' },
        ]}
      />,
    );
    expect(html).toContain('Round each line');
    expect(html).toContain('Round the total');
    expect(html).not.toContain('[object Object]');
  });

  it('still renders plain-string options from older rows', () => {
    const html = renderToStaticMarkup(<WorkerRespondInput workerId="w1" question="Go?" options={['Yes', 'No']} />);
    expect(html).toContain('>Yes<');
    expect(html).toContain('>No<');
  });
});
