/**
 * create_pr's prose preflight (§6.10 tier 1, S31) must say exactly what CI's
 * No Production Data check says about a PR title and body. CI runs the Python
 * script; the server runs packages/core/no-prod-data-prose.ts. This test runs
 * both on one fixture set and fails on any disagreement, so the two cannot
 * drift into a refusal CI would not make, or a pass CI would fail.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/no-prod-data-prose.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { describeProseFindings, scanPrProse } from '../no-prod-data-prose';

const SCRIPTS = resolve(import.meta.dir, '../../../scripts');
// Synthetic, built at run time so no UUID-shaped literal sits in the tree.
const FAKE_UUID = ['aaaaaaaa', 'bbbb', 'cccc', 'dddd', 'eeeeeeeeeeee'].join('-');

const FIXTURES: Array<{ name: string; title: string; body: string }> = [
  { name: 'clean prose', title: 'feat(runner): hand-off failures arrive as unproven', body: 'The runner now says when its work is not on GitHub.' },
  { name: 'full UUID self-citation', title: 'fix: thing', body: `Closes task ${FAKE_UUID}.` },
  { name: 'UUID in the title', title: `fix: task ${FAKE_UUID}`, body: '' },
  { name: 'short id is fine', title: 'fix: thing', body: 'Task `8237cfa9`, as the branch name says.' },
  { name: 'tenancy count at any size', title: 'chore', body: 'This affected 9 teams.' },
  { name: 'big volume count', title: 'chore', body: 'Backfilled 12,500 rows overnight.' },
  { name: 'slash form', title: 'chore', body: 'Migrated 1,200/1,300 records.' },
  { name: 'small volume count in prod context', title: 'chore', body: 'Prod has 40 workers stuck.' },
  { name: 'small volume count without context', title: 'chore', body: 'Cap at 60 workers per runner.' },
  { name: 'live inside a code span is an identifier', title: 'chore', body: 'Set `mode: live` for 40 workers in tests.' },
  { name: 'units make it a measurement', title: 'chore', body: 'Payloads above 1,024 KB are refused; 3,600 seconds of backoff.' },
  { name: 'squash subject number', title: 'Merge (#1964) tasks', body: '' },
  { name: 'migration index', title: 'chore', body: 'Renumbered 0223 tasks migration.' },
  { name: 'allow marker suppresses', title: `docs ${FAKE_UUID}`, body: `no-prod-data: allow documenting the rule\nExample: ${FAKE_UUID}` },
  { name: 'allow marker must start a line', title: 'docs', body: `Mentioning \`no-prod-data: allow x\` is not using it. ${FAKE_UUID}` },
  { name: 'multi-line body, finding on line 3', title: 'chore', body: 'one\ntwo\nWe have 30 customers.' },
  { name: 'CRLF body', title: 'chore', body: 'ok\r\nno-prod-data: allow reason\r\nwith 5 teams' },
];

/** CI's verdict per fixture: scan_prose's Report, run on the exact strings. */
function pythonVerdicts(): Array<{ failed: boolean; lines: number[] }> {
  const program = `
import json, sys, io, contextlib
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import check_no_prod_data as c
out = []
for f in json.load(sys.stdin):
    rep = c.Report()
    allow = c.ALLOW_RE.search(f["body"])
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        c.scan_prose(f["title"], "PR title", rep, allow is None)
        if f["body"]:
            c.scan_prose(f["body"], "PR body", rep, allow is None)
    lines = sorted({int(l.split(" at line ")[1].split(" ")[0]) for l in buf.getvalue().splitlines() if " at line " in l})
    out.append({"failed": rep.failed, "lines": lines})
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-I', '-c', program], {
    input: JSON.stringify(FIXTURES),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('scanPrProse agrees with CI (scripts/check_no_prod_data.py scan_prose)', () => {
  const ci = pythonVerdicts();
  FIXTURES.forEach((f, i) => {
    test(f.name, () => {
      const ts = scanPrProse({ title: f.title, body: f.body });
      expect(ts.findings.length > 0).toBe(ci[i].failed);
      expect([...new Set(ts.findings.map((x) => x.line))].sort((a, b) => a - b)).toEqual(ci[i].lines);
    });
  });

  test('the fixture set exercises both verdicts', () => {
    expect(ci.some((v) => v.failed)).toBe(true);
    expect(ci.some((v) => !v.failed)).toBe(true);
  });
});

describe('describeProseFindings', () => {
  test('names category and line, never the matched value', () => {
    const scan = scanPrProse({ title: 'fix', body: `one\nCloses ${FAKE_UUID}` });
    const text = describeProseFindings(scan.findings);
    expect(text).toContain('PR body line 2: possible UUID');
    expect(text).not.toContain(FAKE_UUID);
    expect(text).not.toContain('aaaaaaaa');
  });
});
