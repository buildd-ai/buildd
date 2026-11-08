import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, buildEvidence, gradeReview, type CaseManifestV2, type EvidenceBuild, type SeededDefect } from '../../packages/core/local-eval-v2';
import { DEFAULT_ROOT, loadSuiteV2 } from './v2';

/** Code-review, long-context and terminal/compaction cases, and the whole suite's per-category floor. Runs no model. */
const { cases } = loadSuiteV2(DEFAULT_ROOT);
const list = Object.values(cases);
const open = list.map((c) => c.manifest);
const splits = JSON.parse(readFileSync(join(DEFAULT_ROOT, 'splits.json'), 'utf8')) as { sealedHoldout: { category: string; exposing: boolean; admission: { admitted: boolean } }[] };
const inCategory = (cat: string) => list.filter((c) => c.manifest.category === cat);

describe('suite floor', () => {
  it('every one of the six categories has at least four admitted cases and an exposing open case', () => {
    for (const cat of CATEGORIES) {
      const admitted = open.filter((m) => m.category === cat && m.admission?.admittedOn).length + splits.sealedHoldout.filter((h) => h.category === cat && h.admission.admitted).length;
      expect(admitted, cat).toBeGreaterThanOrEqual(4);
      expect(open.some((m) => m.category === cat && m.exposing), cat).toBe(true);
    }
  });

  it('at least 24 cases are admitted across the open and sealed splits', () => {
    const n = open.filter((m) => m.admission?.admittedOn).length + splits.sealedHoldout.filter((h) => h.admission.admitted).length;
    expect(n).toBeGreaterThanOrEqual(24);
  });

  it('every exposing case names two broken candidates', () => {
    for (const m of open.filter((x) => x.exposing)) expect(m.files.candidates.broken.length, m.id).toBeGreaterThanOrEqual(2);
  });
});

describe('code-review cases', () => {
  const review = inCategory('code-review');
  const defects = (m: CaseManifestV2): SeededDefect[] => (m.expected.kind === 'review' ? m.expected.defects : []);

  it('has seeded-defect cases and a clean control, each with a diff and a visible test', () => {
    expect(review.length).toBe(4);
    expect(review.some((c) => defects(c.manifest).length === 0)).toBe(true);
    expect(review.some((c) => defects(c.manifest).length > 0)).toBe(true);
    for (const c of review) {
      expect(c.manifest.files.snapshot).toContain('snapshot/change.diff');
      expect(c.manifest.files.snapshot.some((p) => p.endsWith('.spec.ts')), c.manifest.id).toBe(true);
    }
  });

  it('every seeded defect points at lines that exist in the post-change tree', () => {
    for (const c of review) {
      for (const d of defects(c.manifest)) {
        const text = c.files[`snapshot/${d.file}`];
        expect(text, `${c.manifest.id} ${d.file}`).toBeDefined();
        expect(d.endLine, `${c.manifest.id} ${d.id}`).toBeLessThanOrEqual(text.split('\n').length);
        expect(d.startLine).toBeGreaterThan(0);
      }
    }
  });

  it('the diff and the tree agree: each added line of the diff is in the tree', () => {
    for (const c of review) {
      const diff = c.files['snapshot/change.diff'];
      for (const line of diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && l.trim().length > 6)) {
        const added = line.slice(1);
        expect(Object.entries(c.files).some(([p, t]) => p.startsWith('snapshot/') && t.includes(added)), `${c.manifest.id}: ${added}`).toBe(true);
      }
    }
  });

  it('the grader reproduces the label on every known-answer probe, and clean-control findings are false positives', () => {
    const cal = JSON.parse(readFileSync(join(DEFAULT_ROOT, 'review-calibration/calibration.json'), 'utf8')) as {
      probes: { case: string; file: string; line: number; description: string; label: string; defect?: string }[];
    };
    expect(cal.probes.some((p) => p.label === 'clean')).toBe(true);
    for (const p of cal.probes) {
      const m = cases[p.case].manifest;
      const r = gradeReview([{ file: p.file, line: p.line, description: p.description }], defects(m));
      if (p.label === 'true-positive') expect(r.truePositives, `${p.case}: ${p.description}`).toEqual([p.defect!]);
      else {
        expect(r.falsePositives.length, `${p.case}: ${p.description}`).toBe(1);
        if (p.label === 'clean') expect(defects(m).length).toBe(0);
      }
    }
  });

  it('a finding on the clean control is a false positive and reported as such', () => {
    const clean = review.find((c) => defects(c.manifest).length === 0)!;
    const r = gradeReview([{ file: 'src/invoice.ts', line: 9, description: 'anything' }], []);
    expect(r.pass).toBe(false);
    expect(r.metrics.cleanControlFalsePositive).toBe(1);
    expect(gradeReview([], defects(clean.manifest)).pass).toBe(true);
  });
});

describe('long-context cases', () => {
  const ctx = inCategory('long-context-requirements');
  const SIZES = [8192, 16384, 32768];
  const POSITIONS = ['start', 'middle', 'end', 'dispersed'] as const;

  it('has four cases that declare all three sizes and all four positions, with one unanswerable question', () => {
    expect(ctx.length).toBe(4);
    for (const c of ctx) {
      expect(c.manifest.longContext?.sizes).toEqual(SIZES);
      expect([...(c.manifest.longContext?.positions ?? [])].sort()).toEqual([...POSITIONS].sort());
    }
    expect(ctx.some((c) => c.files['reference/answer.json'].includes('"abstain":true'))).toBe(true);
  });

  for (const c of ctx) {
    const needles = JSON.parse(c.files['snapshot/evidence/needles.json']) as { id: string; text: string }[];
    const pool = c.files['snapshot/evidence/filler.md'].split('\n\n').map((s) => s.trim()).filter(Boolean);

    it(`${c.manifest.id}: evidence builds at 8K, 16K and 32K with the needles at each position`, () => {
      const builds = new Map<string, EvidenceBuild>();
      for (const size of SIZES) {
        for (const position of POSITIONS) {
          const b = buildEvidence({ pool, needles, targetTokens: size, position });
          if ('kind' in b) throw new Error(`${c.manifest.id} ${size} ${position}: overflow`);
          expect(b.tokens).toBeLessThanOrEqual(size);
          expect(b.tokens).toBeGreaterThan(size * 0.97);
          expect(b.needles.map((n) => n.id)).toEqual(needles.map((n) => n.id)); // order kept: an amendment never comes before what it amends
          for (const n of needles) expect(b.text.split(n.text).length - 1, `${n.id} appears once`).toBe(1);
          builds.set(`${size}/${position}`, b);
        }
      }
      for (const size of SIZES) {
        const f = (p: string) => builds.get(`${size}/${p}`)!.needles.map((n) => n.fraction);
        expect(Math.max(...f('start'))).toBeLessThan(0.05);
        expect(Math.min(...f('end'))).toBeGreaterThan(0.95);
        expect(Math.min(...f('middle'))).toBeGreaterThan(0.4);
        expect(Math.max(...f('middle'))).toBeLessThan(0.6);
        const d = f('dispersed');
        expect(d[d.length - 1] - d[0]).toBeGreaterThan(0.3);
      }
    });

    it(`${c.manifest.id}: the filler never contains a needle or its id, so the evidence is the only source`, () => {
      const all = pool.join('\n');
      for (const n of needles) {
        expect(all.includes(n.id), n.id).toBe(false);
        expect(all.includes(n.text)).toBe(false);
      }
    });
  }

  it('the filler of a smaller size is a prefix of the filler of a larger one (same material at every size)', () => {
    const c = ctx[0];
    const needles = JSON.parse(c.files['snapshot/evidence/needles.json']) as { id: string; text: string }[];
    const pool = c.files['snapshot/evidence/filler.md'].split('\n\n').map((s) => s.trim()).filter(Boolean);
    const strip = (t: string) => needles.reduce((a, n) => a.replace(n.text + '\n\n', ''), t);
    const small = buildEvidence({ pool, needles, targetTokens: 8192, position: 'start' });
    const large = buildEvidence({ pool, needles, targetTokens: 32768, position: 'start' });
    if ('kind' in small || 'kind' in large) throw new Error('overflow');
    expect(strip(large.text).startsWith(strip(small.text).slice(0, strip(small.text).length - 200))).toBe(true);
  });
});

describe('terminal and compaction cases', () => {
  const term = inCategory('terminal-recovery-compaction');

  it('has four cases, each with a hidden verifier outside the agent tree', () => {
    expect(term.length).toBe(4);
    for (const c of term) {
      expect(existsSync(join(c.dir, 'verifier/check.ts'))).toBe(true);
      expect(c.manifest.files.snapshot.some((p) => p.startsWith('snapshot/verifier'))).toBe(false);
    }
  });

  it('constraint-style cases report a per-stage vector the compaction grader can read', () => {
    for (const id of ['term-compaction-constraints', 'term-session-staged-conventions', 'term-recovery-stale-lock']) {
      const v = cases[id].files['verifier/check.ts'];
      expect(v, id).toContain('process.env.STAGE');
      expect(v, id).toContain('constraints');
      expect(v, id).toContain('testsPass');
    }
  });
});
