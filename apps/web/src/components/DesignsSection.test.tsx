/**
 * DesignsSection, server-rendered: the designs on a mission, task or spec page
 * use the sandboxed viewer, not a Download link. Pins the sandbox (no
 * allow-same-origin) and that every frame loads from the storage origin.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/components/DesignsSection.test.tsx
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import DesignsSection, { type DesignSectionItem } from './DesignsSection';

const storageOrigin = 'https://storage.example';
const item = (id: string, over: Partial<DesignSectionItem['view']> = {}): DesignSectionItem => ({
  id,
  title: `Design ${id}`,
  downloadUrl: `/api/artifacts/${id}/download`,
  view: {
    revision: 2,
    frameUrl: `${storageOrigin}/b/${id}.html?X-Amz-Signature=sig`,
    revisionNote: null,
    screens: [
      { id: 'phone', name: 'Phone', viewport: { width: 390, height: 844 } },
      { id: 'desktop', name: 'Desktop', viewport: { width: 1440, height: 900 } },
    ],
    ...over,
  },
});

const iframes = (html: string) => html.match(/<iframe\b[^>]*>/g) ?? [];

describe('DesignsSection', () => {
  it('renders nothing without designs', () => {
    expect(renderToStaticMarkup(<DesignsSection designs={[]} />)).toBe('');
  });

  it('shows each design in the viewer with its screen picker and zoom toggle', () => {
    const html = renderToStaticMarkup(<DesignsSection designs={[item('a1'), item('b2')]} />);
    expect(html).toContain('data-testid="designs-section"');
    expect(html.match(/data-testid="design-item"/g)?.length).toBe(2);
    expect(html.match(/data-testid="design-screen-picker"/g)?.length).toBe(2);
    expect(html.match(/data-testid="design-zoom-full"/g)?.length).toBe(2);
    expect(html).toContain('Design preview · Design a1 · revision 2');
  });

  it('pins every frame: sandbox is exactly allow-scripts, src is the storage origin, no srcdoc', () => {
    const html = renderToStaticMarkup(<DesignsSection designs={[item('a1'), item('b2')]} />);
    const tags = iframes(html);
    expect(tags.length).toBe(2);
    for (const tag of tags) {
      const sandbox = /sandbox="([^"]*)"/.exec(tag)![1];
      expect(sandbox.split(/\s+/).filter(Boolean)).toEqual(['allow-scripts']);
      expect(tag).not.toContain('allow-same-origin');
      expect(tag).not.toContain('srcdoc');
      expect(new URL(/src="([^"]*)"/.exec(tag)![1].replace(/&amp;/g, '&')).origin).toBe(storageOrigin);
    }
  });

  it('frames nothing when storage cannot serve the file', () => {
    const html = renderToStaticMarkup(<DesignsSection designs={[item('a1', { frameUrl: null })]} />);
    expect(iframes(html).length).toBe(0);
    expect(html).toContain('data-testid="design-frame-unavailable"');
  });
});
