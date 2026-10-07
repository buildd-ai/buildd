// The model-policy service is standalone: it must not import buildd's code
// (no @buildd/core, @buildd/shared or apps/web: no tables, no buildd auth, no
// secret resolution), only the kit's policy module and its own files.
// Test-only files may also use bun:* / node:*.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = import.meta.dir;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);
}

test('src imports only @builddai/ai-kit/policy and relative files inside src', () => {
  const bad: string[] = [];
  for (const f of files(SRC)) {
    const testOnly = f.endsWith('.test.ts');
    const src = readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(m => m[1]!);
    for (const s of specs) {
      const ok =
        s === '@builddai/ai-kit/policy' ||
        (s.startsWith('.') && !relative(SRC, resolve(join(f, '..'), s)).startsWith('..')) ||
        (testOnly && (s.startsWith('bun:') || s.startsWith('node:')));
      if (!ok) bad.push(`${relative(SRC, f)} -> ${s}`);
    }
  }
  expect(bad).toEqual([]);
});

test('the guard sees the files it is meant to police', () => {
  const names = files(SRC).map(f => relative(SRC, f));
  expect(names).toContain('handler.ts');
  expect(names).toContain('auth.ts');
});
