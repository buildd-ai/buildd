/**
 * Every gate slug must be wired, and every wired slug must be documented.
 *
 * The failure this guards against is the one the whole ledger exists to stop: a
 * gate that looks accounted for and is not. A slug declared in `GATE_SLUGS` but
 * never fired reads as covered in the vocabulary and produces zero rows
 * forever; a slug fired from a route but missing from the audit means the next
 * person reading `docs/reports/gate-audit.md` believes the list is complete
 * when it is not.
 *
 * Scanned against `git ls-files`, not the filesystem, for the same reason
 * `scripts/skills-listed.test.ts` does: an untracked scratch file must not make
 * this pass (or fail) for everyone else.
 */
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_SLUGS } from '../gate-events';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Source files that could plausibly fire a gate. Tests and docs excluded. */
function wiringSources(): string[] {
  return trackedFiles().filter(f =>
    (f.startsWith('apps/web/src/') || f.startsWith('packages/core/'))
    && (f.endsWith('.ts') || f.endsWith('.tsx'))
    && !f.endsWith('.test.ts')
    && !f.endsWith('.test.tsx')
    && !f.endsWith('gate-events.ts'),
  );
}

const slugs = Object.entries(GATE_SLUGS);

describe('gate slug coverage', () => {
  const corpus = wiringSources()
    .map(f => readFileSync(join(REPO_ROOT, f), 'utf8'))
    .join('\n');

  it.each(slugs)('%s is referenced by at least one wired call site', (constName, slug) => {
    // Call sites use the GATE_SLUGS constant, so the constant NAME is what
    // appears in the source — asserting on the literal slug string would pass
    // on the definition file alone, which is excluded above.
    expect(
      corpus.includes(`GATE_SLUGS.${constName}`),
      `GATE_SLUGS.${constName} ('${slug}') is declared but never fired — either wire it or drop it`,
    ).toBe(true);
  });

  it.each(slugs)('%s appears in the gate audit', (_constName, slug) => {
    const audit = readFileSync(join(REPO_ROOT, 'docs/reports/gate-audit.md'), 'utf8');
    expect(
      audit.includes(slug),
      `gate '${slug}' is wired but missing from docs/reports/gate-audit.md`,
    ).toBe(true);
  });

  it('has no slug collisions', () => {
    const values = slugs.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});
