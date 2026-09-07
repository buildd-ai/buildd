import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Parse every runner source file in strict mode.
 *
 * `apps/runner` has no `tsconfig.json` and no type-check job, so nothing else
 * in CI reads these files as a whole. That gap let a real defect live for a
 * long time: `index.ts` imported a symbol from `./updater` and ALSO declared a
 * local function with the same name. Bun's runtime tolerates that ES-spec
 * violation silently and the local copy wins — so editing the exported one had
 * no effect, which is exactly the kind of invisible divergence that made the
 * stale-runner bug hard to diagnose. Two such shadows existed; the second
 * (`checkForUpdate`) survived the first fix.
 *
 * The transpiler rejects duplicate declarations, so this catches the whole
 * class for the price of a parse.
 */
const SRC = join(import.meta.dir, '../../src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('runner sources parse in strict mode', () => {
  const files = tsFiles(SRC);

  test('there are sources to check (guards against an empty-set pass)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test('no file has a syntax error or a duplicate declaration', async () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const failures: string[] = [];
    for (const f of files) {
      const src = await Bun.file(f).text();
      try {
        transpiler.transformSync(src);
      } catch (err: any) {
        failures.push(`${f.slice(SRC.length + 1)}: ${err.message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
