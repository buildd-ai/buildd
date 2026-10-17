/**
 * Inline attachments on spec surfaces (living-specs.md §21, AC-104, AC-106),
 * mounted in happy-dom: `![caption](attachment:<name>)` renders the
 * attachment's lasting buildd link as an image; a name the revision does not
 * attach renders a visible "missing attachment" placeholder, never an <img>;
 * a non-image attachment is a link; and an outside image on a spec stays a
 * link, as before.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MarkdownContent } = await import('./MarkdownContent');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (content: string, attachments?: Record<string, { src: string; alt: string | null; image: boolean }>) =>
  act(() => root.render(<MarkdownContent content={content} images="link" surface="spec" attachments={attachments} />));

const LINK = '/api/specs/s1/attachments/pay-screen?revision=2';

describe('attachment: images on a spec', () => {
  it('an attached image renders inline from its buildd link, with the caption as alt text', () => {
    render('![The pay screen](attachment:pay-screen)', { 'pay-screen': { src: LINK, alt: 'Pay screen', image: true } });
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(LINK);
    expect(img?.getAttribute('alt')).toBe('The pay screen');
    expect(container.querySelector('[data-testid="spec-attachment-image"]')).not.toBeNull();
  });

  it('a name that is not attached shows as missing, never as an image', () => {
    render('![The refund screen](attachment:refund-screen)', { 'pay-screen': { src: LINK, alt: null, image: true } });
    expect(container.querySelector('img')).toBeNull();
    const missing = container.querySelector('[data-testid="spec-attachment-missing"]');
    expect(missing?.textContent).toContain('refund-screen');
    expect(missing?.textContent?.toLowerCase()).toContain('missing attachment');
  });

  it('with no attachments at all, an attachment reference is still missing, not a broken image', () => {
    render('![x](attachment:pay-screen)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="spec-attachment-missing"]')).not.toBeNull();
  });

  it('a non-image attachment renders as a link to it', () => {
    render('![Research notes](attachment:research)', { research: { src: '/api/specs/s1/attachments/research?revision=2', alt: null, image: false } });
    expect(container.querySelector('img')).toBeNull();
    const a = container.querySelector('a[data-testid="spec-attachment-link"]');
    expect(a?.getAttribute('href')).toBe('/api/specs/s1/attachments/research?revision=2');
  });

  it('an outside image on a spec is still only a link', () => {
    render('![tracker](https://elsewhere.test/pixel.png)', {});
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://elsewhere.test/pixel.png');
  });
});
