import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTypeChecks } from './type-check';

it('runs exactly the six existing type checks in order using native Bun arguments', async () => {
  const calls: Array<{ cmd: string[]; cwd: string }> = [];
  const root = resolve(import.meta.dir, '..');
  const code = await runTypeChecks((cmd, options) => {
    calls.push({ cmd, cwd: options.cwd });
    expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit']);
    return { exited: Promise.resolve(0) };
  });
  expect(code).toBe(0);
  expect(calls).toEqual([
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit'], cwd: resolve(root, 'apps/web') },
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit', '--project', 'tsconfig.test-d.json'], cwd: resolve(root, 'packages/core') },
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit'], cwd: resolve(root, 'apps/responder') },
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit'], cwd: resolve(root, 'packages/ai-kit') },
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit'], cwd: resolve(root, 'apps/dispatch') },
    { cmd: [process.execPath, 'x', 'tsc', '--noEmit'], cwd: resolve(root, 'apps/model-policy') },
  ]);
});

it('fails fast with the failing compiler exit code', async () => {
  let calls = 0;
  expect(await runTypeChecks(() => ({ exited: Promise.resolve(++calls === 2 ? 7 : 0) }))).toBe(7);
  expect(calls).toBe(2);
});

it('does not swallow a child launch failure', async () => {
  await expect(runTypeChecks(() => { throw new Error('launch failed'); })).rejects.toThrow('launch failed');
});

it('keeps heavyweight admission around the shell-free root command', () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8'));
  expect(pkg.scripts['type-check']).toBe('bun scripts/heavy-slot.ts -- bun scripts/type-check.ts');
});
