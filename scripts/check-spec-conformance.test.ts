/**
 * CLI tests for check-spec-conformance.ts: design docs may be absent or live
 * in an out-of-tree checkout (a private repo mounted by CI).
 *
 * Run: bun run scripts/run-unit-tests.ts scripts/check-spec-conformance.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'check-spec-conformance.ts');

let repo: string;
let external: string;

async function run(extraArgs: string[]) {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, '--repo-root', repo, '--fail-on-contradiction', ...extraArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'check-conformance-repo-'));
  external = mkdtempSync(join(tmpdir(), 'check-conformance-external-'));
  mkdirSync(join(repo, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repo, 'thing.ts'), 'export const thing = 1;\n');
  writeFileSync(
    join(repo, 'docs', 'specs', 'widget.md'),
    ['---', 'status: active', 'assertions:', '  - id: t', '    type: test_file', '    path: thing.ts', '---', '# Widget', ''].join('\n'),
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

describe('check-spec-conformance with no design docs', () => {
  test('passes with a one-line notice when docs/design does not exist', async () => {
    const { code, stdout } = await run([]);
    expect(code).toBe(0);
    const notices = stdout.split('\n').filter((l) => /no design docs/i.test(l));
    expect(notices).toHaveLength(1);
    expect(stdout).toContain('docs/specs/widget.md');
  });

  test('passes with a notice when --design-root points at a nonexistent directory', async () => {
    const { code, stdout } = await run(['--design-root', join(external, 'nope')]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/no design docs/i);
  });

  test('passes with a notice when the design root is empty', async () => {
    const { code, stdout } = await run(['--design-root', external]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/no design docs/i);
  });
});

describe('check-spec-conformance with an out-of-tree design root', () => {
  test('evaluates design docs from the external checkout against the repo', async () => {
    writeFileSync(
      join(external, 'private.md'),
      ['---', 'status: implemented', 'assertions:', '  - id: t', '    type: test_file', '    path: thing.ts', '---', '# Private', ''].join('\n'),
    );
    const { code, stdout } = await run(['--design-root', external, '--json']);
    expect(code).toBe(0);
    const evals = JSON.parse(stdout.slice(stdout.indexOf('[')));
    const design = evals.find((e: any) => e.docType === 'design');
    expect(design.derivedStatus).toBe('implemented');
  });

  test('a contradiction in the external design docs still fails the check', async () => {
    writeFileSync(
      join(external, 'private.md'),
      ['---', 'status: implemented', 'assertions:', '  - id: t', '    type: test_file', '    path: missing-file.ts', '---', '# Private', ''].join('\n'),
    );
    const { code } = await run(['--design-root', external]);
    expect(code).toBe(1);
  });
});
