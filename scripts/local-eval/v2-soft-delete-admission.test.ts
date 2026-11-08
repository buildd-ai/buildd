import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_ROOT, admitOne, loadSuiteV2 } from './v2';
import { sh } from './lib';

/**
 * change-soft-delete v1's final observation read `store.find('x')?.deletedAt`,
 * which assumes `find` is a raw lookup that still returns deleted notes. The
 * brief never says that: it asks for `deletedAt` to be set and for deleted
 * notes to be hidden from app reads. A store that keeps the marked note in
 * place and filters every store read (find/all/size) satisfies the brief and
 * failed only that check. v2 keeps the brief byte-identical and accepts the
 * mark wherever the deleted record is reachable (the object `createNote`
 * returned, or `find`), while still failing a store that never sets it.
 */
const c = loadSuiteV2(DEFAULT_ROOT).cases['change-soft-delete'];
const m = c.manifest;

/** Snapshot plus one overlay, as admission builds it; returns the verifier's failure lines. */
function verify(candidate: string): { pass: boolean; failures: string[]; dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'soft-delete-'));
  const cand = join(root, 'candidate');
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(cand, rel)), { recursive: true }); writeFileSync(join(cand, rel), body); };
  for (const p of m.files.snapshot) put(p.replace(/^snapshot\//, ''), c.files[p]);
  const prefix = candidate === 'reference' ? 'reference/' : `candidates/${candidate}/`;
  const overlay = candidate === 'reference' ? m.files.reference : m.files.candidates.files;
  for (const p of overlay) if (p.startsWith(prefix)) put(p.slice(prefix.length), c.files[p]);
  const vdir = join(root, 'verifier');
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, 'check.ts'), c.files['verifier/check.ts']);
  const r = sh('bun', ['run', join(vdir, 'check.ts')], { cwd: root, env: { ...process.env, CANDIDATE_DIR: cand }, timeoutMs: 60_000 });
  const failures = r.code === 0 ? [] : (r.err ?? '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
  return { pass: r.code === 0, failures, dir: cand, root };
}

const alternatives = m.files.candidates.alternative as string[];

describe('change-soft-delete v2 grader independence', () => {
  it('is a new version with the v1 brief unchanged, byte for byte', () => {
    expect(m.version).toBe(2);
    expect(createHash('sha256').update(c.files['instruction.md']).digest('hex')).toBe('c7b538d3d26b4967f0190ed8fbd54b95dd82826b5f0e7137b84256f24e4e9ed0');
  });

  it('names the filtering-store and clone-on-write designs as alternatives', () => {
    expect(alternatives).toEqual(expect.arrayContaining(['alt', 'filtered-find', 'clone-on-write']));
    expect(m.files.candidates.broken).toEqual(expect.arrayContaining(['filter-service-only', 'trash-copy', 'repeat-delete', 'unmarked-destroy']));
  });

  for (const name of ['reference', ...['alt', 'filtered-find', 'clone-on-write']]) {
    it(`${name}: passes the hidden verifier and the pristine visible tests`, () => {
      const v = verify(name);
      try {
        expect(v.failures).toEqual([]);
        expect(v.pass).toBe(true);
        const t = sh('bun', ['test'], { cwd: v.dir, timeoutMs: 60_000 });
        expect(t.code).toBe(0);
      } finally { rmSync(v.root, { recursive: true, force: true }); }
    }, 120_000);
  }

  // Each negative control fails for its own defect, and only that one.
  const expectedFailures: Record<string, string[]> = {
    'repeat-delete': ['delete again', 'api delete deleted'],
    'unmarked-destroy': ['marked, not destroyed'],
  };
  for (const [name, want] of Object.entries(expectedFailures)) {
    it(`${name}: fails exactly on ${want.join(', ')}`, () => {
      const v = verify(name);
      try {
        expect(v.pass).toBe(false);
        expect(v.failures).toEqual(want);
      } finally { rmSync(v.root, { recursive: true, force: true }); }
    }, 60_000);
  }

  it('is admitted: every alternative passes, the snapshot and every broken candidate fail', async () => {
    const ev = mkdtempSync(join(tmpdir(), 'ev-'));
    try {
      const r = await admitOne(c, ev);
      expect(r.gates.filter((g) => !g.ok)).toEqual([]);
      for (const a of alternatives) expect(r.verdicts[`alternative:${a}`]).toEqual([true]);
      for (const b of m.files.candidates.broken) expect(r.verdicts[`broken:${b}`]).toEqual([false]);
      expect(r.verdicts.snapshot).toEqual([false]);
    } finally { rmSync(ev, { recursive: true, force: true }); }
  }, 180_000);
});
