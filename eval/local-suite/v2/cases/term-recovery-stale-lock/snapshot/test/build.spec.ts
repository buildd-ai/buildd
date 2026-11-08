import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(`${import.meta.dir}/../out/bundle.js`, 'utf8');

test('the bundle is complete', () => {
  expect(bundle.startsWith('// bundle v1\n')).toBe(true);
  expect(bundle.endsWith('//# end\n')).toBe(true);
});

test('the bundle contains every module', () => {
  for (const name of ['add', 'sub', 'shout', 'words']) expect(bundle).toContain(`export function ${name}(`);
});
