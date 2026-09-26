import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskShipBadge } from './TaskShipBadge';

const badgeSource = await Bun.file(new URL('./TaskShipBadge.tsx', import.meta.url)).text();

describe('TaskShipBadge', () => {
  it('renders "Skip release" (muted) when release=false', () => {
    const html = renderToStaticMarkup(<TaskShipBadge release="false" />);
    expect(html).toContain('Skip release');
    expect(html).not.toContain('Force release');
    expect(html).not.toContain('Shipped');
  });

  it('renders "Force release" (amber) when release=true', () => {
    const html = renderToStaticMarkup(<TaskShipBadge release="true" />);
    expect(html).toContain('Force release');
    expect(html).toContain('status-warning');
    expect(html).not.toContain('Skip release');
  });

  // AC-49 — inherit with no attribution is the unchanged default: no noise.
  it('renders nothing when release=inherit and not yet attributed', () => {
    expect(renderToStaticMarkup(<TaskShipBadge release="inherit" shippedReleaseId={null} />)).toBe('');
  });

  it('renders nothing when release is null/undefined and not attributed', () => {
    expect(renderToStaticMarkup(<TaskShipBadge release={null} />)).toBe('');
    expect(renderToStaticMarkup(<TaskShipBadge release={undefined} />)).toBe('');
  });

  // AC-48 — attributed via release_tasks to a healthy release.
  it('renders "Shipped" (muted-success) linking to the release page when attributed to a healthy release', () => {
    const html = renderToStaticMarkup(<TaskShipBadge release="inherit" shippedReleaseId="rel-123" />);
    expect(html).toContain('Shipped');
    expect(html).toContain('/app/releases/rel-123');
    expect(html).toContain('status-success');
  });

  // States are additive: force-released AND that release is now healthy.
  it('shows both "Force release" and "Shipped" together (additive)', () => {
    const html = renderToStaticMarkup(<TaskShipBadge release="true" shippedReleaseId="rel-123" />);
    expect(html).toContain('Force release');
    expect(html).toContain('Shipped');
    expect(html).toContain('/app/releases/rel-123');
  });

  it('shows both "Skip release" and "Shipped" together (additive)', () => {
    const html = renderToStaticMarkup(<TaskShipBadge release="false" shippedReleaseId="rel-9" />);
    expect(html).toContain('Skip release');
    expect(html).toContain('Shipped');
  });

  // Regression: the task detail page (a server component) mounts this badge,
  // and with a shipped release it renders <Link onClick={...}>. Without the
  // directive that handler crossed the RSC boundary and the whole page failed
  // to render ("Event handlers cannot be passed to Client Component props").
  it('declares itself a client component (it is mounted from the server task detail page)', () => {
    expect(badgeSource).toMatch(/^\s*['"]use client['"]/);
  });
});
