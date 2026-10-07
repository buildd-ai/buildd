import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerRespondInput from './WorkerRespondInput';

describe('WorkerRespondInput options', () => {
  it('renders rich WaitingForOption objects without throwing', () => {
    const html = renderToStaticMarkup(
      <WorkerRespondInput
        workerId="w1"
        question="Which way?"
        options={[
          { label: 'Ship it', description: 'Merge now', recommended: true },
          { label: 'Hold' },
        ]}
      />,
    );
    expect(html).toContain('Ship it');
    expect(html).toContain('Hold');
    expect(html).toContain('title="Merge now"');
    expect(html).toContain('(recommended)');
  });

  it('still renders legacy string options', () => {
    const html = renderToStaticMarkup(
      <WorkerRespondInput workerId="w1" question="Which way?" options={['Yes', 'No']} />,
    );
    expect(html).toContain('Yes');
    expect(html).toContain('No');
  });

  it('accepts mixed options and skips malformed entries', () => {
    const html = renderToStaticMarkup(
      <WorkerRespondInput
        workerId="w1"
        question="q"
        options={['Legacy', { label: 'Rich' }, null as never, { label: 5 } as never]}
      />,
    );
    expect(html).toContain('Legacy');
    expect(html).toContain('Rich');
  });
});
