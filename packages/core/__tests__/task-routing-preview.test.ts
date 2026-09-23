import { describe, it, expect } from 'bun:test';
import { inferRouting, computeRoutingPreview } from '../task-routing-preview';

describe('inferRouting', () => {
  describe('emitsPlan → coordination', () => {
    it('infers coordination when emitsPlan is true', () => {
      const r = inferRouting({ emitsPlan: true });
      expect(r.kind).toBe('coordination');
      expect(r.kindInferred).toBe(true);
      expect(r.kindReason).toContain('emitsPlan');
    });

    it('does not infer when emitsPlan is false', () => {
      const r = inferRouting({ emitsPlan: false });
      expect(r.kind).toBe('engineering');
      expect(r.kindInferred).toBe(false);
      expect(r.kindReason).toBeNull();
    });
  });

  describe('mission-coordination title patterns → coordination', () => {
    it('infers coordination for a mission heartbeat title', () => {
      const r = inferRouting({ title: 'Mission: ship the thing' });
      expect(r.kind).toBe('coordination');
      expect(r.kindInferred).toBe(true);
      expect(r.kindReason).toContain('Mission:');
    });

    it('does not infer for an unrelated title', () => {
      const r = inferRouting({ title: 'Fix the flaky test' });
      expect(r.kind).toBe('engineering');
      expect(r.kindInferred).toBe(false);
    });
  });

  describe('pathManifest breadth → complex', () => {
    it('infers complex when the manifest touches 6+ files', () => {
      const r = inferRouting({
        pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      });
      expect(r.complexity).toBe('complex');
      expect(r.complexityInferred).toBe(true);
      expect(r.complexityReason).toContain('6 files');
    });

    it('does not infer for a small manifest', () => {
      const r = inferRouting({ pathManifest: ['a.ts', 'b.ts'] });
      expect(r.complexity).toBe('normal');
      expect(r.complexityInferred).toBe(false);
    });

    it('ignores an advisory (wildcard) manifest for breadth', () => {
      const r = inferRouting({
        pathManifest: ['**'],
        pathManifestIsConcrete: false,
      });
      expect(r.complexity).toBe('normal');
      expect(r.complexityInferred).toBe(false);
    });
  });

  describe('sensitive paths (schema/claim/auth) → complex', () => {
    it('infers complex when the manifest touches the schema', () => {
      const r = inferRouting({ pathManifest: ['packages/core/db/schema.ts'] });
      expect(r.complexity).toBe('complex');
      expect(r.complexityInferred).toBe(true);
      expect(r.complexityReason).toContain('schema.ts');
    });

    it('infers complex when the manifest touches the claim route', () => {
      const r = inferRouting({ pathManifest: ['apps/web/src/app/api/workers/claim/route.ts'] });
      expect(r.complexity).toBe('complex');
      expect(r.complexityInferred).toBe(true);
    });

    it('infers complex when the manifest touches an auth file', () => {
      const r = inferRouting({ pathManifest: ['apps/web/src/lib/auth-helpers.ts'] });
      expect(r.complexity).toBe('complex');
      expect(r.complexityInferred).toBe(true);
    });

    it('does not infer for an unrelated single file', () => {
      const r = inferRouting({ pathManifest: ['apps/web/src/lib/foo.ts'] });
      expect(r.complexity).toBe('normal');
      expect(r.complexityInferred).toBe(false);
    });
  });

  describe('description length → complex', () => {
    it('infers complex for a very long description', () => {
      const r = inferRouting({ description: 'x'.repeat(2000) });
      expect(r.complexity).toBe('complex');
      expect(r.complexityInferred).toBe(true);
      expect(r.complexityReason).toContain('2000 characters');
    });

    it('does not infer for a short description', () => {
      const r = inferRouting({ description: 'Fix the typo in the README.' });
      expect(r.complexity).toBe('normal');
      expect(r.complexityInferred).toBe(false);
    });
  });

  describe('explicit values always win', () => {
    it('never overrides an explicit kind, even when a rule would fire', () => {
      const r = inferRouting({ kind: 'writing', emitsPlan: true, title: 'Mission: plan it' });
      expect(r.kind).toBe('writing');
      expect(r.kindInferred).toBe(false);
      expect(r.kindReason).toBeNull();
    });

    it('never overrides an explicit complexity, even when a rule would fire', () => {
      const r = inferRouting({
        complexity: 'simple',
        pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      });
      expect(r.complexity).toBe('simple');
      expect(r.complexityInferred).toBe(false);
    });
  });

  it('composes independently — kind and complexity can each infer separately', () => {
    const r = inferRouting({
      emitsPlan: true,
      pathManifest: ['packages/core/db/schema.ts'],
    });
    expect(r.kind).toBe('coordination');
    expect(r.kindInferred).toBe(true);
    expect(r.complexity).toBe('complex');
    expect(r.complexityInferred).toBe(true);
  });
});

describe('computeRoutingPreview', () => {
  it('names the default plainly when nothing is given', () => {
    const p = computeRoutingPreview({});
    expect(p.tier).toBe('standard');
    expect(p.model).toBe('claude-sonnet-5');
    expect(p.inferred).toBe(false);
    expect(p.reason).toContain('no kind/complexity given');
    expect(p.reason).toContain('defaulted to engineering/normal');
    expect(p.reason).toContain('standard');
  });

  it('explains an inferred upgrade to a higher tier', () => {
    const p = computeRoutingPreview({
      pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    });
    expect(p.tier).toBe('premium');
    expect(p.inferred).toBe(true);
    expect(p.reason).toContain('inferred');
    expect(p.reason).toContain('complex');
  });

  it('states the explicit kind/complexity without inference language', () => {
    const p = computeRoutingPreview({ kind: 'engineering', complexity: 'complex' });
    expect(p.tier).toBe('premium');
    expect(p.inferred).toBe(false);
    expect(p.reason).not.toContain('inferred');
    expect(p.reason).not.toContain('defaulted');
  });

  it('an explicit tier bypasses kind/complexity routing entirely', () => {
    const p = computeRoutingPreview({ tier: 'premium', kind: 'observation', complexity: 'simple' });
    expect(p.tier).toBe('premium');
    expect(p.model).toBe('claude-opus-5');
    expect(p.reason).toContain('tier:"premium" pinned');
  });

  it('an explicit model pin bypasses tier resolution too', () => {
    const p = computeRoutingPreview({ model: 'claude-sonnet-4-6' });
    expect(p.tier).toBeNull();
    expect(p.model).toBe('claude-sonnet-4-6');
    expect(p.reason).toContain('pinned');
  });

  it('treats context.model of "inherit" as no pin', () => {
    const p = computeRoutingPreview({ model: 'inherit' });
    expect(p.tier).toBe('standard');
    expect(p.reason).not.toContain('pinned');
  });
});
