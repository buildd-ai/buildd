import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { checkPublicDocs, listDocFiles, stubBody } from './check-public-docs';

/**
 * Guards the open-core boundary for docs: strategy prose lives in the private
 * knowledge-base repo, and the public repo keeps only frontmatter stubs whose
 * assertions spec conformance checks. Each case writes a throwaway tree so the
 * check is shown to FAIL, not just to exist.
 */

const REPO_ROOT = join(import.meta.dir, '..');

const FRONTMATTER = [
  '---',
  'status: implemented',
  'assertions:',
  '  - id: "x"',
  '    type: "test_file"',
  '    path: "scripts/check-public-docs.test.ts"',
  '---',
  '',
].join('\n');

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'public-docs-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function stub(name: string): string {
  return `${FRONTMATTER}\n# ${name}\n\n${stubBody(name)}\n`;
}

function check(root: string) {
  return checkPublicDocs(root, listDocFiles(root, { useGit: false }));
}

describe('check-public-docs', () => {
  test("passes on this repo's own tree", () => {
    const violations = checkPublicDocs(REPO_ROOT, listDocFiles(REPO_ROOT));
    expect(violations).toEqual([]);
  });

  test('the stub helper reproduces a stub already on dev byte-for-byte', () => {
    const raw = readFileSync(join(REPO_ROOT, 'docs/design/cron-wake-windows.md'), 'utf8');
    expect(raw).toContain(`# cron-wake-windows\n\n${stubBody('cron-wake-windows')}`);
  });

  test('passes on a stub and the two allowed design files', () => {
    const root = tree({
      'docs/design/foo.md': stub('foo'),
      'docs/design/design-system.md': '# Design system\n\nprose is fine here\n',
      'docs/design/DESIGN-FORMAT.md': '# Format\n\nprose is fine here\n',
      'docs/reports/gate-audit.md': '# Gate audit\n\nprose\n',
    });
    expect(check(root)).toEqual([]);
  });

  test('fails on a prose design doc and points at knowledge-base', () => {
    const root = tree({
      'docs/design/foo.md': `${FRONTMATTER}\n# Foo\n\n## Problem\n\nOur strategy is...\n`,
    });
    const v = check(root);
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe('docs/design/foo.md');
    expect(v[0].message).toContain('knowledge-base');
    expect(v[0].message).toContain('buildd/design/foo.md');
    expect(v[0].message).toContain('frontmatter');
  });

  test('allows the explicitly requested human-question spec only at its exact path', () => {
    const root = tree({
      'docs/design/human-question-gate.md': '# Human question gate\n\nPublic contract.\n',
      'docs/design/human-question-gate-extra.md': '# Related design\n\nPrivate proposal.\n',
      'docs/design/nested/human-question-gate.md': '# Nested design\n\nPrivate proposal.\n',
    });
    expect(check(root).map(v => v.file).sort()).toEqual([
      'docs/design/human-question-gate-extra.md',
      'docs/design/nested/human-question-gate.md',
    ]);
  });

  test('fails on a stub with prose appended after the pointer', () => {
    const root = tree({ 'docs/design/foo.md': `${stub('foo')}\n## Extra\n\nmore\n` });
    expect(check(root)).toHaveLength(1);
  });

  test('fails on a stub whose pointer names a different doc', () => {
    const root = tree({ 'docs/design/foo.md': stub('bar') });
    expect(check(root)).toHaveLength(1);
  });

  test('fails on a design doc with no frontmatter', () => {
    const root = tree({ 'docs/design/foo.md': `# foo\n\n${stubBody('foo')}\n` });
    expect(check(root)).toHaveLength(1);
  });

  test('fails on a non-markdown or nested file under docs/design', () => {
    const root = tree({
      'docs/design/notes.txt': 'prose',
      'docs/design/sub/foo.md': stub('foo'),
    });
    expect(check(root).map((v) => v.file).sort()).toEqual([
      'docs/design/notes.txt',
      'docs/design/sub/foo.md',
    ]);
  });

  test('fails on any docs/plans file and any docs/reports file but gate-audit.md', () => {
    const root = tree({
      'docs/plans/rollout.md': '# plan',
      'docs/plans/archive/old.md': '# old',
      'docs/reports/gate-audit.md': '# ok',
      'docs/reports/drift.md': '# drift',
    });
    const v = check(root);
    expect(v.map((x) => x.file).sort()).toEqual([
      'docs/plans/archive/old.md',
      'docs/plans/rollout.md',
      'docs/reports/drift.md',
    ]);
    for (const x of v) expect(x.message).toContain('knowledge-base');
  });

  test('tolerates CRLF line endings in a stub', () => {
    const root = tree({ 'docs/design/foo.md': stub('foo').replace(/\n/g, '\r\n') });
    expect(check(root)).toEqual([]);
  });

  test('the CLI exits non-zero on a violation and zero on a clean tree', () => {
    const script = join(import.meta.dir, 'check-public-docs.ts');
    const bad = tree({ 'docs/design/foo.md': `${FRONTMATTER}\n# Foo\n\nprose\n` });
    const r1 = spawnSync('bun', ['run', script, '--root', bad, '--no-git'], { encoding: 'utf8' });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('docs/design/foo.md');

    const good = tree({ 'docs/design/foo.md': stub('foo') });
    const r2 = spawnSync('bun', ['run', script, '--root', good, '--no-git'], { encoding: 'utf8' });
    expect(r2.status).toBe(0);
  });
});

describe('public-docs check is wired into the gates', () => {
  test('package.json exposes public-docs:check', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['public-docs:check']).toBe('bun run scripts/check-public-docs.ts');
  });

  test('the build job runs it, and the build workflow gates PRs into dev', () => {
    const wf = readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8');
    expect(wf).toMatch(/run: bun run public-docs:check/);
    // pull_request trigger covers every base (dev included)
    expect(wf).toMatch(/pull_request:[\s\S]*?branches: \['\*\*'/);
  });

  test('the pre-commit hook runs it', () => {
    const hook = readFileSync(join(REPO_ROOT, '.githooks/pre-commit'), 'utf8');
    expect(hook).toContain('scripts/check-public-docs.ts');
  });
});
