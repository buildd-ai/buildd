import { describe, expect, it } from 'bun:test';
import { DESIGN_STORED_CONTENT_TYPE, MAX_DESIGN_BYTES, validateDesignHtml } from './upload';

const html = '<!doctype html><html><body><div data-screen="a" data-viewport="390x844"></div></body></html>';

describe('validateDesignHtml', () => {
  it('accepts an html document and returns its bytes', () => {
    const r = validateDesignHtml(html);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBe(Buffer.byteLength(html));
  });
  it('refuses a body over the limit with 413', () => {
    const r = validateDesignHtml('<html>' + 'x'.repeat(MAX_DESIGN_BYTES));
    expect(r).toMatchObject({ ok: false, status: 413 });
  });
  it('refuses an empty body, non-text and non-html with 400/415', () => {
    expect(validateDesignHtml('')).toMatchObject({ ok: false, status: 400 });
    expect(validateDesignHtml(undefined)).toMatchObject({ ok: false, status: 400 });
    expect(validateDesignHtml('just some prose, no markup')).toMatchObject({ ok: false, status: 415 });
    expect(validateDesignHtml(html + String.fromCharCode(0))).toMatchObject({ ok: false, status: 415 });
  });
  it('refuses a declared content type that is not html or json', () => {
    expect(validateDesignHtml(html, 'image/png')).toMatchObject({ ok: false, status: 415 });
    expect(validateDesignHtml(html, 'text/html; charset=utf-8')).toMatchObject({ ok: true });
  });
  it('is stored with a content type that cannot run on buildd\'s origin', () => {
    expect(DESIGN_STORED_CONTENT_TYPE).not.toMatch(/html|javascript|svg|xml/);
  });
});
