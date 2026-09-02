import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseActionButton, releaseButtonLabel } from './ReleaseActionButton';

describe('releaseButtonLabel', () => {
  it('shows "Release" when not releasing', () => {
    expect(releaseButtonLabel(false)).toBe('Release');
  });

  it('shows "Releasing…" when releasing', () => {
    expect(releaseButtonLabel(true)).toBe('Releasing…');
  });
});

describe('ReleaseActionButton (SSR)', () => {
  it('renders an enabled Release button on initial mount', () => {
    const html = renderToStaticMarkup(<ReleaseActionButton workspaceId="ws-1" />);
    expect(html).toContain('Release');
    expect(html).not.toContain('disabled=""');
  });
});
