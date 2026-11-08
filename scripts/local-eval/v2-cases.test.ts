import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADMISSION_GATES, CATEGORIES } from '../../packages/core/local-eval-v2';
import { DEFAULT_ROOT, loadSuiteV2, validateV2 } from './v2';

/** Shipped v2 cases: structure, admission evidence and the dev / sealed-holdout split. Does not run any model. */
const { suite, cases } = loadSuiteV2(DEFAULT_ROOT);
const list = Object.values(cases).map((c) => c.manifest);
const splits = JSON.parse(readFileSync(join(DEFAULT_ROOT, 'splits.json'), 'utf8')) as {
  dev: string[];
  sealedHoldout: { id: string; category: string; version: number; contentHash: string; admission: { admitted: boolean; gates: { gate: string; ok: boolean }[] } }[];
};

describe('shipped v2 cases', () => {
  it('the suite validates and pins every case', () => {
    expect(validateV2(DEFAULT_ROOT)).toEqual([]);
    expect(suite.cases.length).toBe(list.length);
  });

  it('every dev case carries a passing admission record and stored evidence at its own hash', () => {
    for (const m of list) {
      expect(m.admission?.admittedOn, m.id).toBeTruthy();
      for (const g of ADMISSION_GATES) expect(m.admission!.gates.find((x) => x.gate === g)?.ok, `${m.id} ${g}`).toBe(true);
      const f = join(DEFAULT_ROOT, 'admission', `${m.id}.v${m.version}.json`);
      expect(existsSync(f), f).toBe(true);
      const ev = JSON.parse(readFileSync(f, 'utf8'));
      expect(ev.admitted).toBe(true);
      expect(ev.contentHash).toBe(m.contentHash);
      // Raw verdicts are kept: the snapshot and every named broken candidate failed, the reference and the alternative passed.
      expect(ev.verdicts.snapshot).toEqual([false]);
      expect(ev.verdicts.alternative).toEqual([true]);
      expect(new Set(ev.verdicts.reference).size).toBe(1);
      expect(ev.verdicts.reference[0]).toBe(true);
      for (const b of m.files.candidates.broken) expect(ev.verdicts[`broken:${b}`], `${m.id} ${b}`).toEqual([false]);
    }
  });

  it('cases run with no GPU and no model', () => {
    for (const m of list) {
      expect(m.resources.cpuOnly, m.id).toBe(true);
      expect(m.resources.estimatedVramMb, m.id).toBeNull();
    }
  });

  it('answer-absent cases record a confirmer who is not the auditor', () => {
    const absent = list.filter((m) => m.expected.kind === 'abstain');
    expect(absent.length).toBeGreaterThan(0);
    for (const m of absent) {
      const s = (m.expected as { searchScope: { auditor: string; confirmer: string | null } }).searchScope;
      expect(s.confirmer, m.id).toBeTruthy();
      expect(s.confirmer).not.toBe(s.auditor);
    }
  });

  it('every file named by a case exists and no case imports third-party material under an unrecorded licence', () => {
    for (const m of list) expect(m.provenance.licence.trim().length, m.id).toBeGreaterThan(0);
  });
});

describe('dev and sealed-holdout split', () => {
  it('dev is exactly the open suite, and a holdout id is never also an open case', () => {
    expect(splits.dev).toEqual(suite.cases.map((c) => c.id).sort());
    const dirs = existsSync(join(DEFAULT_ROOT, 'cases')) ? readdirSync(join(DEFAULT_ROOT, 'cases')) : [];
    for (const h of splits.sealedHoldout) {
      expect(splits.dev).not.toContain(h.id);
      expect(dirs).not.toContain(h.id);
      expect(h.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('holdout descriptors carry hashes and labels only, never content', () => {
    const allowed = new Set(['id', 'category', 'version', 'contentHash', 'difficulty', 'skills', 'exposing', 'admission']);
    for (const h of splits.sealedHoldout) {
      expect(Object.keys(h).filter((k) => !allowed.has(k)), h.id).toEqual([]);
      expect(Object.keys(h.admission).sort()).toEqual(['admitted', 'checkedOn', 'gates', 'toolchain']);
      for (const g of h.admission.gates) expect(Object.keys(g).sort()).toEqual(['gate', 'ok']);
      expect(h.admission.admitted).toBe(true);
    }
  });

  it('three categories have at least four cases across both splits and one exposing case in the open split', () => {
    for (const cat of ['find-by-behaviour', 'causal-debugging', 'multi-file-change'] as const) {
      expect(CATEGORIES).toContain(cat);
      const open = list.filter((m) => m.category === cat);
      const sealed = splits.sealedHoldout.filter((h) => h.category === cat);
      expect(open.length + sealed.length, cat).toBe(4);
      expect(open.some((m) => m.exposing), cat).toBe(true);
    }
  });

  it('holdout hashes are distinct from every dev hash', () => {
    const dev = new Set(list.map((m) => m.contentHash));
    for (const h of splits.sealedHoldout) expect(dev.has(h.contentHash)).toBe(false);
  });
});
