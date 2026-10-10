import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConcurrencySection from './ConcurrencySection';

describe('ConcurrencySection', () => {
  it('shows the current max concurrent tasks and the stepper', () => {
    const html = renderToStaticMarkup(
      <ConcurrencySection workspaceId="ws-1" initialMaxConcurrentTasks={5} />,
    );
    expect(html).toContain('Max concurrent tasks');
    expect(html).toContain('data-testid="workspace-concurrency-value"');
    expect(html).toMatch(/>5</);
    expect(html).toContain('aria-label="Lower"');
    expect(html).toContain('aria-label="Raise"');
    // Unchanged value: no Save button yet.
    expect(html).not.toContain('>Save<');
  });
});
