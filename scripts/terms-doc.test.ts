import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { TERMS } from '../packages/shared/src/terms';
import { TERMS_DOC, renderTermsDoc, termsDocIsCurrent } from './terms-doc';

describe('docs/design/terms.md', () => {
  it('is generated from the catalog and committed current (run `bun run terms:doc`)', () => {
    expect(termsDocIsCurrent(readFileSync(TERMS_DOC, 'utf8'))).toBe(true);
  });

  it('accepts checkout CRLF without hiding real generated content drift', () => {
    expect(termsDocIsCurrent(renderTermsDoc().replace(/\n/g, '\r\n'))).toBe(true);
    expect(termsDocIsCurrent(renderTermsDoc().replace('Terms catalog', 'Wrong title'))).toBe(false);
  });

  it('lists every term', () => {
    const doc = renderTermsDoc();
    for (const key of Object.keys(TERMS)) expect(doc).toContain(`| \`${key}\` |`);
  });
});
