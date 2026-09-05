import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseWidget } from './ReleaseWidget';
import type { ReleaseReadinessItem } from '@/lib/release-readiness';

const val = (n: number) => ({ kind: 'value' as const, value: n });

function item(overrides: Partial<ReleaseReadinessItem> = {}): ReleaseReadinessItem {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'demo',
    queueDepth: val(3),
    oldestMergedAt: { kind: 'value' as const, value: '2026-08-01T00:00:00.000Z' },
    baselineSource: 'healthy',
    ciState: 'passing',
    latestReleaseId: 'rel-1',
    ...overrides,
  };
}

describe('ReleaseWidget — release action button', () => {
  it('shows an enabled Release button when queue is over threshold and CI is green', () => {
    const html = renderToStaticMarkup(<ReleaseWidget items={[item()]} />);
    // Assert the rendered <button> carries the trigger label — a bare
    // `toContain('Release')` also matches the "Release Queue" section label and
    // the "Release →" ledger link, so it would pass with no button at all.
    expect(html).toMatch(/<button[^>]*>Release<\/button>/);
    expect(html).not.toContain('disabled=""');
  });

  it('does not show a Release button when CI is blocking, only the CI state (AC-38)', () => {
    const html = renderToStaticMarkup(<ReleaseWidget items={[item({ ciState: 'failing' })]} />);
    expect(html).not.toContain('<button');
    // ...and the CI-blocking state is what renders in its place, rather than
    // the widget silently collapsing to the unshipped count alone.
    expect(html).toContain('CI failing');
    expect(html).toContain('3 unshipped');
    // The release-detail link is part of the release affordance and must not
    // survive into the blocking state either.
    expect(html).not.toContain('/app/releases/');
  });

  it('renders nothing when queue is empty (widget hidden)', () => {
    const html = renderToStaticMarkup(<ReleaseWidget items={[item({ queueDepth: val(0) })]} />);
    expect(html).toBe('');
  });
});
