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

/**
 * Wrapping `withCronRun` only buys a heartbeat row. `evaluateCronHealth`
 * ignores any run that reported neither `changed` nor `errors`
 * (`reportedAVerdict` in lib/cron-health.ts), so a route that never calls its
 * report callback can never reach MIN_RUNS_FOR_ALARM — it is unalarmable by
 * construction.
 *
 * Six of fourteen routes were in exactly that state, including
 * `release-health-check`, whose entire job is to notice releases that stalled
 * silently. Its 29 most recent production runs were all `ok=true` with a NULL
 * verdict while a release sat stranded through 25 of them.
 */
const NO_VERDICT_REPORTED: Array<[route: string, why: string]> = [
  // Empty, and meant to stay that way. An entry here claims a route runs on a
  // schedule and yet has no outcome worth judging — which is nearly always
  // false, and is a decision to write down rather than a box to tick.
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

/**
 * Does this route actually hand a verdict back?
 *
 * The callback's NAME cannot be assumed to be `report`: `mission-invariants`
 * has a local `report` holding its human-readable text and aliases the callback
 * to `cronReport`. A check hardcoding `report(` reports that route as silent —
 * I made exactly that mistake while auditing this, and it inverted the finding.
 *
 * So the name is resolved first, from either the `CronReport` type annotation
 * or the arrow parameter handed to `withCronRun`, and then we look for a call
 * to whatever it is actually called.
 */
export function reportsAVerdictSource(src: string): boolean {
  const code = stripComments(src);
  const names = new Set<string>();
  for (const m of code.matchAll(/(\w+)\s*:\s*CronReport/g)) names.add(m[1]);
  for (const m of code.matchAll(/withCronRun\([^,]+,[^,]+,\s*(?:async\s*)?\(?(\w+)\)?\s*=>/g)) {
    names.add(m[1]);
  }
  // An identifier that is only ever forwarded (`h => runCronJob(req, h)`) is
  // not a verdict; require a call of the form `name(`.
  return [...names].some(n => new RegExp(`\\b${n}\\(`).test(code.replace(
    new RegExp(`runCronJob\\(\\s*req\\s*,\\s*${n}\\s*\\)`, 'g'), '',
  )));
}

const reportsAVerdict = (file: string) => reportsAVerdictSource(readFileSync(file, 'utf8'));

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

  test('every cron route reports a verdict, or is a listed exception', () => {
    const exempt = new Set(NO_VERDICT_REPORTED.map(([r]) => r));
    const silent = cronRouteFiles()
      .filter(f => !exempt.has(routeName(f)))
      .filter(f => !reportsAVerdict(f));

    expect(silent).toEqual([]);
  });

  test('the no-verdict exception list has no stale or missing entries', () => {
    const files = cronRouteFiles();
    const stale = NO_VERDICT_REPORTED
      .map(([route]) => route)
      .filter(route => {
        const file = files.find(f => routeName(f) === route);
        return file !== undefined && reportsAVerdict(file);
      });
    expect(stale).toEqual([]);

    const names = new Set(files.map(routeName));
    expect(NO_VERDICT_REPORTED.map(([r]) => r).filter(r => !names.has(r))).toEqual([]);

    for (const [route, why] of NO_VERDICT_REPORTED) {
      expect(why.trim().length, `${route} needs a reason`).toBeGreaterThan(0);
    }
  });

  test('the verdict check resolves the callback name instead of assuming it', () => {
    const SIG = 'async function runCronJob(req: NextRequest, report: CronReport) {';

    // Forwarding the callback is not reporting with it.
    expect(reportsAVerdictSource(
      "return withCronRun('x', req, report => runCronJob(req, report));\n" + SIG,
    )).toBe(false);

    // A comment mentioning it is not reporting either.
    expect(reportsAVerdictSource(`${SIG}\n// report({ changed: 1 })`)).toBe(false);

    // The real shape passes.
    expect(reportsAVerdictSource(`${SIG}\nreport({ changed: 1 });`)).toBe(true);

    // And it must still pass when the callback is aliased, as mission-invariants
    // does to dodge a local `report` — the case a hardcoded /report\(/ inverts.
    expect(reportsAVerdictSource(
      "async function runCronJob(req: NextRequest, cronReport: CronReport) {\n" +
      "const report = formatInvariantReport();\ncronReport({ changed: 1 });",
    )).toBe(true);
  });

  test('every exception carries a reason', () => {
    for (const [route, why] of NOT_YET_INSTRUMENTED) {
      expect(why.trim().length, `${route} needs a reason`).toBeGreaterThan(0);
    }
  });
});
