#!/usr/bin/env bun
/**
 * Public-docs boundary gate (`bun run public-docs:check`).
 *
 * This repo is public; strategy and design prose lives in the private
 * knowledge-base repo under buildd/design/. What stays here:
 *
 *   docs/design/design-system.md, docs/design/DESIGN-FORMAT.md  — any content
 *   docs/design/human-question-gate.md — explicitly requested public contract
 *   docs/design/<name>.md   — frontmatter + the standard pointer stub only, so
 *                             spec conformance can still check its assertions
 *   docs/reports/gate-audit.md                                   — any content
 *
 * Everything else under docs/design/, docs/plans/ or docs/reports/ fails.
 *
 * Files come from `git ls-files --cached` (tracked + staged), so an untracked
 * local draft never blocks a commit. Falls back to a filesystem walk outside a
 * git checkout, or with --no-git.
 *
 * Usage: bun run scripts/check-public-docs.ts [--root <dir>] [--no-git]
 */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const GUARDED_DIRS = ['docs/design', 'docs/plans', 'docs/reports'] as const;
/** Files kept in full in the public repo. */
export const ALLOWED_FULL = new Set([
  'docs/design/design-system.md',
  'docs/design/DESIGN-FORMAT.md',
  // Owner explicitly requested this contract here; other designs remain stubs.
  'docs/design/human-question-gate.md',
  'docs/reports/gate-audit.md',
]);

export interface Violation {
  file: string;
  message: string;
}

/** The pointer paragraph every design-doc stub carries (the shape PR #3366 wrote). */
export function stubBody(name: string): string {
  return (
    `This design doc's body lives in the private knowledge base at \`knowledge-base: buildd/design/${name}.md\`; ` +
    'workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are ' +
    'checked against the code on every push (see `scripts/check-spec-conformance.ts`).'
  );
}

function fixMessage(file: string): string {
  const name = file.split('/').pop()!.replace(/\.md$/, '');
  return (
    `public repo keeps no design/strategy prose. Move the prose to the private knowledge-base repo ` +
    `(buildd-ai/knowledge-base, buildd/design/${name}.md) and keep only frontmatter here: ` +
    `the frontmatter block, then "# ${name}", then the standard pointer paragraph ` +
    `(see any stub in docs/design/, or stubBody() in scripts/check-public-docs.ts). ` +
    `Design docs with no assertions can simply be deleted.`
  );
}

/** True when `raw` is `---\n<frontmatter>\n---` followed only by `# name` and the pointer. */
export function isStub(name: string, raw: string): boolean {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return false;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return false;
  const body = text
    .slice(end + 5)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n');
  return body === `# ${name}\n${stubBody(name)}`;
}

export function checkPublicDocs(root: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of [...files].sort()) {
    if (ALLOWED_FULL.has(file)) continue;
    const m = /^docs\/design\/([^/]+)\.md$/.exec(file);
    if (m) {
      const raw = readFileSync(join(root, file), 'utf8');
      if (isStub(m[1], raw)) continue;
    }
    violations.push({ file, message: fixMessage(file) });
  }
  return violations;
}

function walk(root: string, dir: string, out: string[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

export function listDocFiles(root: string, opts: { useGit?: boolean } = {}): string[] {
  if (opts.useGit !== false) {
    const r = spawnSync('git', ['ls-files', '--cached', '-z', '--', ...GUARDED_DIRS], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      // Skip paths staged for deletion / missing on disk.
      return r.stdout
        .split('\0')
        .filter((f) => f && existsSync(join(root, f)));
    }
  }
  const out: string[] = [];
  for (const d of GUARDED_DIRS) walk(root, d, out);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : join(import.meta.dir, '..');
  const violations = checkPublicDocs(root, listDocFiles(root, { useGit: !args.includes('--no-git') }));
  if (violations.length === 0) {
    console.log('public-docs: ok (docs/design holds only stubs and explicitly allowed files)');
    process.exit(0);
  }
  for (const v of violations) console.error(`✖ ${v.file}: ${v.message}`);
  console.error(`\npublic-docs: ${violations.length} file(s) outside the public-docs boundary.`);
  process.exit(1);
}
