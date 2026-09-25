/**
 * Visual QA judge — file plumbing around the OAuth judge in visual-qa.yml.
 * No network, no API key: the judgment is done by anthropics/claude-code-action
 * on the team's OAuth seat, between the two subcommands below.
 *
 *   bun scripts/qa/judge.ts prepare
 *       captures.json + manifest → $QA_OUTPUT/judge-input.json (what to look at,
 *       what each route should show) and an empty $QA_OUTPUT/verdicts/.
 *
 *   (claude-code-action reads judge-input.json, screenshots/, a11y/ and writes
 *    $QA_OUTPUT/verdicts/<route-id>.json)
 *
 *   bun scripts/qa/judge.ts report
 *       verdicts/*.json → $QA_OUTPUT/verdicts.json + report.md, which the
 *       PR-comment / check-run step consumes.
 *
 * Env vars:
 *   QA_OUTPUT   — directory containing captures.json / screenshots / a11y (default /tmp/qa)
 *   QA_MANIFEST — path to visual-qa-routes.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { buildJudgeInput, assembleVerdicts, renderReport, type JudgeInput, type RawVerdict } from './judge-format';

const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';
const mode = process.argv[2];

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf-8')) as T;
const capturesPath = join(OUTPUT_DIR, 'captures.json');
const captures = existsSync(capturesPath) ? readJson<any[]>(capturesPath) : [];

if (mode === 'prepare') {
  const manifest = readJson<any>(resolve(MANIFEST_PATH));
  const input = buildJudgeInput(manifest, captures);
  mkdirSync(join(OUTPUT_DIR, 'verdicts'), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'judge-input.json'), JSON.stringify(input, null, 2));
  console.log(`[judge] prepared ${input.routes.filter(r => r.judge).length}/${input.routes.length} route(s) for judgment`);
} else if (mode === 'report') {
  const input = readJson<JudgeInput>(join(OUTPUT_DIR, 'judge-input.json'));
  const raw: Record<string, RawVerdict | undefined> = {};
  for (const r of input.routes) {
    const p = join(OUTPUT_DIR, 'verdicts', `${r.id}.json`);
    if (!existsSync(p)) continue;
    try {
      raw[r.id] = readJson<RawVerdict>(p);
    } catch (err) {
      console.warn(`[judge] ${r.id}: unreadable verdict file (${(err as Error).message})`);
    }
  }
  const verdicts = assembleVerdicts(input, raw, captures);
  writeFileSync(join(OUTPUT_DIR, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'report.md'), renderReport(verdicts));
  for (const v of verdicts) console.log(`[judge] ${v.id} → ${v.overallVerdict}`);
} else {
  console.error('usage: bun scripts/qa/judge.ts prepare|report');
  process.exit(2);
}
