import { expect, it } from 'bun:test';
import { parseSpecFrontmatter } from './repo-spec';

it('parses CRLF frontmatter without changing the original body', () => {
  const raw = '---\r\ntitle: Example\r\nstatus: active\r\nsurfaces: [src/example.ts]\r\n---\r\n# Body\r\n';
  expect(parseSpecFrontmatter(raw)).toEqual({
    fm: { title: 'Example', status: 'active', surfaces: ['src/example.ts'] },
    body: '\r\n# Body\r\n',
  });
});
