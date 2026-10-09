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
    expect(html).toContain('>Executor<');
    expect(html).toContain('data-testid="workspace-executor-effective"');
    expect(html).toMatch(/>Cloud</);
    expect(html).toContain(describeExecutorSource('dispatch_webhook'));
  });

  it('shows the stored value on the picker', () => {
    const html = render({ explicit: 'host', effective: 'host', source: 'explicit' });
    expect(html).toContain('data-testid="workspace-executor-select"');
    expect(html).toContain('Host runners only');
  });

  it('shows automatic when nothing is stored', () => {
    expect(render()).toContain('Automatic');
  });
});

describe('describeExecutorSource', () => {
  it('names each source in plain words', () => {
    expect(describeExecutorSource('explicit')).toBe('Set on this workspace.');
    expect(describeExecutorSource('dispatch_webhook')).toBe('From the cloud dispatch webhook.');
    expect(describeExecutorSource('default')).toBe('Default.');
  });
});
