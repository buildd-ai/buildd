import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ExecutorSection, { describeExecutorSource } from './ExecutorSection';

const render = (props: Partial<Parameters<typeof ExecutorSection>[0]> = {}) =>
  renderToStaticMarkup(
    <ExecutorSection workspaceId="ws-1" explicit={null} effective="any" source="default" {...props} />,
  );

describe('ExecutorSection', () => {
  it('shows the effective value and that it came from the dispatch webhook', () => {
    const html = render({ effective: 'cloud', source: 'dispatch_webhook' });
    expect(html).toContain('Where work runs');
    expect(html).toContain('data-testid="workspace-executor-effective"');
    expect(html).toMatch(/>Cloud</);
    expect(html).toContain(describeExecutorSource('dispatch_webhook'));
  });

  it('offers automatic plus the three values, with the stored one selected', () => {
    const html = render({ explicit: 'host', effective: 'host', source: 'explicit' });
    for (const v of ['', 'cloud', 'host', 'any']) expect(html).toContain(`value="${v}"`);
    expect(html).toMatch(/<option value="host" selected="">/);
  });

  it('selects automatic when nothing is stored', () => {
    expect(render()).toMatch(/<option value="" selected="">/);
  });
});

describe('describeExecutorSource', () => {
  it('names each source in plain words', () => {
    expect(describeExecutorSource('explicit')).toBe('Set on this workspace.');
    expect(describeExecutorSource('dispatch_webhook')).toBe('From the cloud dispatch webhook.');
    expect(describeExecutorSource('default')).toBe('Default.');
  });
});
