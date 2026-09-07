import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Every cron route must record its run through `withCronRun`, or be listed
 * below as a deliberate, temporary exception.
 *
 * This exists because a scheduled job that runs and accomplishes nothing is
 * indistinguishable, from the outside, from one that is working. Three PR
 * sweeps ran hourly for months returning "every row errored, nothing changed",
 * and nothing read it, because each route computed that verdict and then
 * discarded it at the route boundary (PR #2125).
 *
 * The point is not the current coverage number — it is that a NEW cron route
 * cannot be added without either instrumenting it or writing down, here, why
 * not. The list is expected to shrink to empty and is not a place to add
 * entries.
 */
const NOT_YET_INSTRUMENTED: Array<[route: string, why: string]> = [
  // Empty, and meant to stay that way: every cron route records its run.
  // An entry here is a claim that some route deliberately does not, with a
  // reason. Adding one should feel like a decision, not a shortcut.
];

function cronRouteFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z', 'apps/web/src/app/api/cron'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return (ls.stdout ?? '').split('\0').filter(f => f.endsWith('/route.ts'));
}

const routeName = (file: string) => file.split('/').slice(-2)[0];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Instrumented means: imports the wrapper AND actually calls it, in code.
 *
 * Two weaker versions of this check were written first, and both passed
 * against a route whose instrumentation had been deliberately removed:
 *
 *   - `src.includes('withCronRun')` matched a call renamed to
 *     `withCronRunXX(`, because that string still contains it.
 *   - `/\bwithCronRun\s*\(/` matched the route's own DOC COMMENT, because the
 *     prose "withCronRun (lib/cron-run.ts)" has a space before the paren.
 *
 * So comments are stripped first and the call must have no space before its
 * paren. A gate that cannot fail is exactly what this file exists to prevent.
 */
export function isInstrumentedSource(src: string): boolean {
  const code = stripComments(src);
  return /from '@\/lib\/cron-run'/.test(code) && /\bwithCronRun\(/.test(code);
}

const isInstrumented = (file: string) => isInstrumentedSource(readFileSync(file, 'utf8'));

describe('cron run instrumentation', () => {
  test('finds the cron routes at all', () => {
    // A path typo would make every assertion below vacuously true — the exact
    // failure mode this whole file guards against.
    expect(cronRouteFiles().length).toBeGreaterThan(5);
  });

  test('every cron route records its run, or is a listed exception', () => {
    const exempt = new Set(NOT_YET_INSTRUMENTED.map(([r]) => r));
    const missing = cronRouteFiles()
      .filter(f => !exempt.has(routeName(f)))
      .filter(f => !isInstrumented(f));

    expect(missing).toEqual([]);
  });

  test('the exception list has no stale entries', () => {
    // Once a route is instrumented its entry must go, or the list stops meaning
    // anything and quietly re-opens the hole.
    const files = cronRouteFiles();
    const stale = NOT_YET_INSTRUMENTED
      .map(([route]) => route)
      .filter(route => {
        const file = files.find(f => routeName(f) === route);
        return file !== undefined && isInstrumented(file);
      });

    expect(stale).toEqual([]);
  });

  test('every listed exception still exists', () => {
    const names = new Set(cronRouteFiles().map(routeName));
    const gone = NOT_YET_INSTRUMENTED.map(([r]) => r).filter(r => !names.has(r));
    expect(gone).toEqual([]);
  });

  test('rejects the decoys that fooled earlier versions of this check', () => {
    const IMPORT = "import { withCronRun } from '@/lib/cron-run';";

    // v1: substring match accepted a renamed call.
    expect(isInstrumentedSource(`${IMPORT}\nreturn withCronRunXX('x', req, h);`)).toBe(false);

    // v2: `\s*\(` accepted a comment that merely names the helper.
    expect(isInstrumentedSource(`// see withCronRun (lib/cron-run.ts)\n${IMPORT}\nreturn other();`)).toBe(false);
    expect(isInstrumentedSource(`/* withCronRun (lib/cron-run.ts) */\n${IMPORT}\nreturn other();`)).toBe(false);

    // Importing without calling is not instrumentation.
    expect(isInstrumentedSource(`${IMPORT}\nreturn NextResponse.json({});`)).toBe(false);

    // Calling without importing means it came from somewhere else.
    expect(isInstrumentedSource("return withCronRun('x', req, h);")).toBe(false);

    // The real shape passes.
    expect(isInstrumentedSource(`${IMPORT}\nreturn withCronRun('x', req, h);`)).toBe(true);
  });

  test('every exception carries a reason', () => {
    for (const [route, why] of NOT_YET_INSTRUMENTED) {
      expect(why.trim().length, `${route} needs a reason`).toBeGreaterThan(0);
    }
  });
});
