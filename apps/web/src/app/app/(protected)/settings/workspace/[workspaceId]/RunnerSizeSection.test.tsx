import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import RunnerSizeSection, { describeRunnerSizeSource } from './RunnerSizeSection';

const render = (props: Partial<Parameters<typeof RunnerSizeSection>[0]> = {}) =>
  renderToStaticMarkup(
    <RunnerSizeSection workspaceId="ws-1" explicit={null} effective="standard" source="default" reason={null} {...props} />,
  );

describe('RunnerSizeSection', () => {
  it('shows the derived size and why', () => {
    const html = render({ effective: 'large', source: 'derived', reason: 'low_disk' });
    expect(html).toContain('Cloud runner size');
    expect(html).toContain('data-testid="workspace-runner-size-effective"');
    expect(html).toMatch(/>Large</);
    expect(html).toContain(describeRunnerSizeSource('derived', 'low_disk'));
  });

  it('shows the stored override on the picker', () => {
    const html = render({ explicit: 'standard', effective: 'standard', source: 'explicit' });
    expect(html).toContain('data-testid="workspace-runner-size-select"');
    expect(html).toContain('Set on this workspace.');
  });

  it('shows this month on the runner under the size line', () => {
    const html = render({ monthLine: 'This month: 9.1 h on the runner, counted as 18.2 h' });
    expect(html).toContain('data-testid="workspace-runner-month"');
    expect(html).toContain('This month: 9.1 h on the runner, counted as 18.2 h');
    expect(render()).not.toContain('workspace-runner-month');
  });

  it('shows automatic when nothing is stored', () => {
    expect(render()).toContain('Automatic');
  });
});

describe('describeRunnerSizeSource', () => {
  it('names each source in plain words', () => {
    expect(describeRunnerSizeSource('explicit', null)).toBe('Set on this workspace.');
    expect(describeRunnerSizeSource('default', null)).toBe('Default.');
    expect(describeRunnerSizeSource('derived', 'memory_pressure')).toBe('A recent run used nearly all of the standard memory.');
  });
});
