import { describe, expect, it } from 'bun:test';
import { planAdoption, isAdoptableFile } from './adopt';

const HTML = `<!doctype html><body>
<section data-screen="phone-nav" data-screen-name="Nav (phone)" data-viewport="390x844"></section>
<section data-screen="desktop-nav" data-viewport="1440x900"></section></body>`;

describe('isAdoptableFile', () => {
  it('an HTML file in storage, by mime type or file name', () => {
    expect(isAdoptableFile({ storageKey: 'k', metadata: { mimeType: 'text/html; charset=utf-8' } })).toBe(true);
    expect(isAdoptableFile({ storageKey: 'k', metadata: { filename: 'navigation-r6.html' } })).toBe(true);
  });
  it('not a file without a stored object, nor a non-HTML one', () => {
    expect(isAdoptableFile({ storageKey: null, metadata: { mimeType: 'text/html' } })).toBe(false);
    expect(isAdoptableFile({ storageKey: 'k', metadata: { mimeType: 'application/pdf' } })).toBe(false);
    expect(isAdoptableFile({ storageKey: 'k', metadata: null })).toBe(false);
  });
});

describe('planAdoption', () => {
  it('marks the file a design and lists the screens it declares, keeping nothing else', () => {
    const r = planAdoption(HTML);
    expect(r).toEqual({
      ok: true,
      screens: [
        { id: 'phone-nav', name: 'Nav (phone)', viewport: '390x844' },
        { id: 'desktop-nav', name: 'desktop-nav', viewport: '1440x900' },
      ],
    });
  });
  it('refuses a file with no screens, saying how to mark them', () => {
    const r = planAdoption('<html><body>hi</body></html>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('data-screen');
  });
});
