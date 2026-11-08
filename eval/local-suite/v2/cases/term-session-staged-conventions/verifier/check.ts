import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

// Hidden stage checks for the log-digest case. The standing rules are checked
// at every stage; STAGE=<n> runs one stage, otherwise all four. Prints a JSON
// vector of per-stage results.
const dir = process.env.CANDIDATE_DIR!;
const api = await import(`${dir}/src/index.ts`).catch(() => ({}) as Record<string, never>);
const NOW = new Date('2026-03-02T12:00:00Z');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function stageTests(stage: number): boolean {
  try {
    if (stage === 1) {
      return (
        same(api.parseLine('2026-03-02T10:00:00Z ERROR api disk is  full'), { at: '2026-03-02T10:00:00Z', level: 'ERROR', service: 'api', message: 'disk is  full' }) &&
        api.parseLine('2026-03-02T10:00:00Z FATAL api x') === null &&
        api.parseLine('yesterday INFO api x') === null &&
        api.parseLine('2026-03-02T10:00:00Z INFO api') === null &&
        api.parseLine('') === null &&
        api.parseLine('2026-03-02T10:00:00Z  INFO api x') === null
      );
    }
    if (stage === 2) {
      const e = (at: string, level: string, service: string) => ({ at, level, service, message: 'm' });
      const s = api.summarize(
        [
          e('2026-03-01T12:00:00Z', 'ERROR', 'web'), // exactly 24h before: counted
          e('2026-03-01T11:59:59Z', 'ERROR', 'db'), // just outside: not counted, service still listed
          e('2026-03-02T12:00:00Z', 'ERROR', 'api'), // exactly now: counted
          e('2026-03-02T12:00:01Z', 'ERROR', 'api'), // future: not counted
          e('2026-03-02T09:00:00Z', 'WARN', 'cache'),
          e('2026-03-02T09:30:00Z', 'INFO', 'cache'),
        ],
        NOW,
      );
      const later = api.summarize([e('2026-03-02T12:00:00Z', 'ERROR', 'api')], new Date('2026-03-04T12:00:00Z'));
      return same(s, { total: 6, byLevel: { INFO: 1, WARN: 1, ERROR: 4 }, recentErrors: 2, errorServices: ['api', 'db', 'web'] }) && later.recentErrors === 0 && same(api.summarize([], NOW), { total: 0, byLevel: { INFO: 0, WARN: 0, ERROR: 0 }, recentErrors: 0, errorServices: [] });
    }
    if (stage === 3) {
      const md = api.renderMarkdown({ total: 3, byLevel: { INFO: 1, WARN: 1, ERROR: 1 }, recentErrors: 1, errorServices: ['api', 'web'] });
      const none = api.renderMarkdown({ total: 0, byLevel: { INFO: 0, WARN: 0, ERROR: 0 }, recentErrors: 0, errorServices: [] });
      return md === '# Log digest\n- total: 3\n- INFO: 1\n- WARN: 1\n- ERROR: 1\n- errors in the last 24h: 1\nServices with errors: api, web\n' && none.endsWith('Services with errors: none\n');
    }
    if (stage === 4) {
      const text = ['2026-03-02T10:00:00Z ERROR api boom', '', 'garbage', '2026-03-02T11:00:00Z INFO web fine', '2026-02-20T11:00:00Z ERROR db old'].join('\n') + '\n';
      const a = api.digest(text, NOW);
      const b = api.digest(text, new Date('2026-03-10T00:00:00Z'));
      return a === '# Log digest\n- total: 3\n- INFO: 1\n- WARN: 0\n- ERROR: 2\n- errors in the last 24h: 1\nServices with errors: api, db\n' && b.includes('- errors in the last 24h: 0');
    }
  } catch {
    return false;
  }
  return false;
}

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]));
function constraints(): Record<string, boolean> {
  const code = walk(`${dir}/src`)
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .map((p) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'));
  let deps = false;
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].every((k) => !pkg[k] || Object.keys(pkg[k]).length === 0);
  } catch {
    deps = false;
  }
  return {
    'named-exports-only': existsSync(`${dir}/src/index.ts`) && !code.some((c) => /\bexport\s+default\b|\bas\s+default\b|\{\s*default\b/.test(c)),
    'no-system-clock': !code.some((c) => /Date\.now\s*\(|new\s+Date\s*\(\s*\)|performance\.now|process\.hrtime/.test(c)),
    'no-dependencies': deps,
  };
}

const cons = constraints();
const stages = (process.env.STAGE ? [Number(process.env.STAGE)] : [1, 2, 3, 4]).map((stage) => ({ stage, constraints: cons, testsPass: stageTests(stage) }));
console.log(JSON.stringify({ stages }));
const failedRules = Object.entries(cons).filter(([, v]) => !v).map(([k]) => k);
const failedStages = stages.filter((s) => !s.testsPass).map((s) => s.stage);
if (failedRules.length || failedStages.length) {
  console.error(`failed: ${failedStages.length ? `stage tests ${failedStages.join(',')}; ` : ''}${failedRules.join(', ')}`);
  process.exit(1);
}
