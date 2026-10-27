import { describe, expect, it } from 'bun:test';
import { extractScreens, parseScreens, screenSource } from './screens';

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

  it('keeps kind and code on a screen, and refuses a bad one naming the field (AC-11)', () => {
    const row = { id: 'c-row', name: 'Row', kind: 'component', code: 'apps/web/src/components/X.tsx', viewport: '360x120' };
    expect(parseScreens([row, { ...OK[0], kind: 'page' }])).toEqual({ ok: true, screens: [row, { ...OK[0], kind: 'page' }] });
    const widget = parseScreens([{ ...row, kind: 'widget' }]);
    expect(widget).toMatchObject({ ok: false, field: 'kind' });
    if (!widget.ok) expect(widget.message).toContain('kind');
    expect(parseScreens([{ ...row, code: '../secret.ts' }])).toMatchObject({ ok: false, field: 'code' });
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

  it('reads data-kind and data-code', () => {
    expect(extractScreens('<div data-screen="c-row" data-kind="component" data-code="apps/web/src/components/X.tsx" data-viewport="360x120"></div>'))
      .toEqual({ ok: true, screens: [{ id: 'c-row', name: 'c-row', kind: 'component', code: 'apps/web/src/components/X.tsx', viewport: '360x120' }] });
  });
});

describe('screenSource (R-15 / AC-12)', () => {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>D</title><style>.row{color:red}</style>
<script>window.shared = 1</script></head>
<body>
<nav class="dc-index"><a href="#c-row">Row</a><a href="#home">Home</a></nav>
<section id="home" data-screen="home" data-viewport="1440x900"><h2>Home board</h2><section class="inner">nested home</section></section>
<!-- <section data-screen="c-row">a comment</section> -->
<section id="c-row" data-screen="c-row" data-viewport="360x120"><div class="row">Row board</div>
<section class="inner"><p>nested row</p></section>
<script>var s = "</section><section data-screen=\\"home\\">"; document.title = s</script>
</section>
<section id="other" data-screen="other" data-viewport="390x844">Other board</section>
<script>function show(){}</script>
</body></html>`;

  it("returns that board's markup and the file's logic, without the other boards", () => {
    const r = screenSource(html, 'c-row');
    if (!r.ok) throw new Error(r.message);
    expect(r.html).toContain('Row board');
    expect(r.html).toContain('nested row');
    expect(r.html).toContain('document.title = s');
    expect(r.html).toContain('.row{color:red}');
    expect(r.html).toContain('window.shared = 1');
    expect(r.html).toContain('function show(){}');
    expect(r.html).not.toContain('Home board');
    expect(r.html).not.toContain('nested home');
    expect(r.html).not.toContain('Other board');
    expect(r.html.startsWith('<!doctype html>')).toBe(true);
  });

  it('handles a board that is not a section and the last board in the file', () => {
    const r = screenSource('<body><div data-screen="a" data-viewport="10x10"><div>A</div></div><div data-screen="b" data-viewport="10x10"><div>B</div></div></body>', 'b');
    if (!r.ok) throw new Error(r.message);
    expect(r.html).toContain('<div>B</div>');
    expect(r.html).not.toContain('<div>A</div>');
  });

  it('refuses a screen the file does not hold, naming screenId', () => {
    expect(screenSource(html, 'missing')).toMatchObject({ ok: false, field: 'screenId' });
    expect(screenSource(html, 'inner')).toMatchObject({ ok: false, field: 'screenId' });
  });
});
