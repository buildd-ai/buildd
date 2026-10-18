import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { TERMS } from '../packages/shared/src/terms';
import { TERMS_DOC, renderTermsDoc } from './terms-doc';

describe('docs/design/terms.md', () => {
  it('is generated from the catalog and committed current (run `bun run terms:doc`)', () => {
    expect(readFileSync(TERMS_DOC, 'utf8')).toBe(renderTermsDoc());
  });

  it('lists every term', () => {
    const doc = renderTermsDoc();
    for (const key of Object.keys(TERMS)) expect(doc).toContain(`| \`${key}\` |`);
  });
});
