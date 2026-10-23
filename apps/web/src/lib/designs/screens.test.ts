import { describe, expect, it } from 'bun:test';
import { extractScreens, parseScreens } from './screens';

const OK = [
  { id: 'desktop-mission', name: 'Mission', viewport: '1440x900' },
  { id: 'phone-mission', name: 'Mission (phone)', viewport: '390x844' },
];

describe('parseScreens', () => {
  it('accepts a well-formed list', () => {
    expect(parseScreens(OK)).toEqual({ ok: true, screens: OK });
  });

  it('names the field of a malformed screen', () => {
    expect(parseScreens([{ id: 'a', name: 'A' }])).toMatchObject({ ok: false, field: 'viewport' });
    expect(parseScreens([{ id: 'a', name: 'A', viewport: 'wide' }])).toMatchObject({ ok: false, field: 'viewport' });
    expect(parseScreens([{ id: 'a b', name: 'A', viewport: '10x10' }])).toMatchObject({ ok: false, field: 'id' });
    expect(parseScreens([{ id: 'a', name: '', viewport: '390x844' }])).toMatchObject({ ok: false, field: 'name' });
  });

  it('refuses an empty list, a non-list and duplicate ids', () => {
    expect(parseScreens([])).toMatchObject({ ok: false, field: 'screens' });
    expect(parseScreens('x')).toMatchObject({ ok: false, field: 'screens' });
    expect(parseScreens([OK[0], OK[0]])).toMatchObject({ ok: false, field: 'id' });
  });

  it('puts the field name in the message', () => {
    const r = parseScreens([{ id: 'a', name: 'A', viewport: 'wide' }]);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.message).toContain('viewport');
  });
});

describe('extractScreens', () => {
  it('reads named screens from data attributes without executing anything', () => {
    const html = `<!doctype html><html><body>
      <script>document.title = 'x'; throw new Error('must not run')</script>
      <section data-screen="desktop-mission" data-screen-name="Mission" data-viewport="1440x900"></section>
      <div data-screen="phone-mission" data-screen-name="Mission (phone)" data-width="390" data-height="844"></div>
    </body></html>`;
    expect(extractScreens(html)).toEqual({ ok: true, screens: [
      { id: 'desktop-mission', name: 'Mission', viewport: '1440x900' },
      { id: 'phone-mission', name: 'Mission (phone)', viewport: '390x844' },
    ] });
  });

  it('falls back to the id for a missing name and refuses a screen with no size', () => {
    expect(extractScreens('<div data-screen="a" data-viewport="390x844"></div>')).toMatchObject({ ok: true, screens: [{ name: 'a' }] });
    expect(extractScreens('<div data-screen="a"></div>')).toMatchObject({ ok: false, field: 'viewport' });
  });

  it('finds none in a page with no screens', () => {
    expect(extractScreens('<html><body>hi</body></html>')).toMatchObject({ ok: false, field: 'screens' });
  });

  it('ignores screen markers inside comments and scripts', () => {
    expect(extractScreens('<!-- <div data-screen="a" data-viewport="1x1"></div> --><script>"<div data-screen=\\"b\\" data-viewport=\\"390x844\\">"</script>')).toMatchObject({ ok: false, field: 'screens' });
  });
});
