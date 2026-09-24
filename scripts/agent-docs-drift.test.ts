import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * The agent-facing docs (CLAUDE.md, docs/testing-strategy.md) are read by every
 * worker before it touches the repo, so a wrong path there sends each of them
 * hunting for a file that does not exist. These checks pin the claims that are
 * mechanically checkable: repo paths exist, named symbols live where the doc
 * says, `data-testid` conventions are real attributes, and the test-running
 * instructions do not tell anyone to use bare `bun test`.
 */

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

const PATH_PREFIXES = ['apps/', 'packages/', 'docs/', 'scripts/', '.github/', 'tests/'];

/** Backticked tokens in the doc that look like repo paths (no globs, no placeholders). */
function backtickedPaths(doc: string): string[] {
  const out = new Set<string>();
  for (const m of doc.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1];
    if (!PATH_PREFIXES.some(p => token.startsWith(p))) continue;
    if (/[*<>{}]/.test(token)) continue;
    out.add(token.replace(/[:#].*$/, ''));
  }
  return [...out].sort();
}

describe('CLAUDE.md', () => {
  const doc = read('CLAUDE.md');
  const files = trackedFiles();

  it('every backticked repo path exists (as a tracked file or directory)', () => {
    const missing = backtickedPaths(doc).filter(p => {
      const dir = p.endsWith('/') ? p : `${p}/`;
      return !files.includes(p) && !files.some(f => f.startsWith(dir));
    });
    expect(missing).toEqual([]);
  });

  it('names the module that actually exports deriveMissionHealth', () => {
    const m = doc.match(/`deriveMissionHealth` in `([^`]+)`/);
    expect(m).not.toBeNull();
    expect(read(m![1])).toMatch(/export function deriveMissionHealth\b/);
  });

  it('lists only data-testid values that exist in apps/web/src', () => {
    const section = doc.split('### data-testid Conventions')[1]?.split('\n## ')[0] ?? '';
    const ids = [...section.matchAll(/^- `([a-z0-9-]+)`/gm)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    const src = files
      .filter(f => f.startsWith('apps/web/src/') && f.endsWith('.tsx') && !f.includes('.test.'))
      .map(f => read(f))
      .join('\n');
    const absent = ids.filter(id => !src.includes(`data-testid="${id}"`));
    expect(absent).toEqual([]);
  });

  it('points the fixtures URL at the port `bun dev` serves on (Next default 3000)', () => {
    const m = doc.match(/http:\/\/localhost:(\d+)\/app\/dev\/fixtures/);
    expect(m).not.toBeNull();
    expect(read('apps/web/package.json')).not.toMatch(/next dev[^"]*(-p|--port)/);
    expect(m![1]).toBe('3000');
  });
});

describe('docs/testing-strategy.md', () => {
  it('never instructs running unit tests with bare `bun test`', () => {
    const doc = read('docs/testing-strategy.md');
    const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
    const bare = blocks.split('\n').filter(line => /^\s*bun test\b/.test(line));
    expect(bare).toEqual([]);
  });
});
