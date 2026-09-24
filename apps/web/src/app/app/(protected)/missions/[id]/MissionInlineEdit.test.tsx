/**
 * Settings' title editor (F5): the masthead already shows the title, so
 * Settings must not render it a second time, and it no longer carries the
 * description (that lives once, near the top — MissionDescription).
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { default: MissionInlineEdit } = await import('./MissionInlineEdit');

describe('MissionInlineEdit in Settings', () => {
  const html = renderToStaticMarkup(<MissionInlineEdit missionId="m-1" initialTitle="Example mission title" />);

  it('does not render the mission title again', () => {
    expect(html).not.toContain('Example mission title');
    expect(html).not.toContain('<h1');
  });

  it('offers a Rename affordance with a 44px target', () => {
    expect(html).toContain('data-testid="mission-rename"');
    expect(html).toContain('Rename mission');
    expect(html).toContain('min-h-11');
  });

  it('does not render the description', () => {
    expect(html).not.toContain('Add a description');
    expect(html).not.toContain('<textarea');
  });
});
