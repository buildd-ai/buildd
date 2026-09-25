import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactNode } from 'react';
import { TaskShipBadge } from './TaskShipBadge';

const badgeSource = await Bun.file(new URL('./TaskShipBadge.tsx', import.meta.url)).text();
const isClientModule = /^\s*['"]use client['"]/.test(badgeSource);

// Collects every function-valued prop in an element tree (host and composite
// elements alike, without rendering composites). A server component that hands
// a function to a client component (next/link) fails the RSC render with
// "Event handlers cannot be passed to Client Component props".
function functionProps(node: ReactNode, path = 'root'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => functionProps(n, `${path}[${i}]`));
  if (!isValidElement(node)) return [];
  const props = node.props as Record<string, unknown>;
  const own = Object.entries(props)
    .filter(([k, v]) => k !== 'children' && typeof v === 'function')
    .map(([k]) => `${path}.${k}`);
  return [...own, ...functionProps(props.children as ReactNode, `${path}>child`)];
}

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

  // Regression: the task detail page (a server component) mounts this badge.
  // With a shipped release it rendered <Link onClick={...}> from the server
  // graph and the whole page failed to render. Either the module is a client
  // component, or its server render carries no function props.
  it('is safe to mount from a server component when attributed to a release', () => {
    if (isClientModule) return;
    const tree = TaskShipBadge({ release: 'true', shippedReleaseId: 'rel-123' });
    expect(functionProps(tree)).toEqual([]);
  });

  it('declares itself a client component (it is mounted from the server task detail page)', () => {
    expect(isClientModule).toBe(true);
  });
});
