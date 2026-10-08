import { describe, it, expect } from 'bun:test';
import { kindDefaultRole, KIND_DEFAULT_ROLE, kindDefaultStamp } from './task-role-default';

const candidates = (...slugs: string[]) => slugs.map(slug => ({ slug }));

describe('kindDefaultRole', () => {
  it('maps a kind to its role when that role is a candidate in the workspace', () => {
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'engineering', taskClass: 'work', candidates: candidates('builder', 'researcher') })).toBe('builder');
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'research', taskClass: 'work', candidates: candidates('builder', 'researcher') })).toBe('researcher');
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'coordination', taskClass: 'work', candidates: candidates('organizer') })).toBe('organizer');
  });

  it('never replaces a role the caller stated', () => {
    expect(kindDefaultRole({ statedRoleSlug: 'reviewer', kind: 'engineering', taskClass: 'work', candidates: candidates('builder') })).toBeNull();
  });

  it('leaves the role empty when the workspace has no such role', () => {
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'writing', taskClass: 'work', candidates: candidates('builder') })).toBeNull();
  });

  it('leaves kinds without a default role empty', () => {
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'design', taskClass: 'work', candidates: candidates('builder', 'designer') })).toBeNull();
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'observation', taskClass: 'work', candidates: candidates('visual-auditor') })).toBeNull();
    expect(kindDefaultRole({ statedRoleSlug: null, kind: null, taskClass: 'work', candidates: candidates('builder') })).toBeNull();
  });

  it('only work rows get a default; bookkeeping keeps none', () => {
    expect(kindDefaultRole({ statedRoleSlug: null, kind: 'coordination', taskClass: 'bookkeeping', candidates: candidates('organizer') })).toBeNull();
  });

  it('every mapped role is an ordinary routable role, never an opt-in one', () => {
    for (const slug of Object.values(KIND_DEFAULT_ROLE)) expect(slug).not.toBe('visual-auditor');
  });
});

describe('kindDefaultStamp', () => {
  it('marks the role as inferred from the kind, so it is never mistaken for a stated one', () => {
    const s = kindDefaultStamp('builder', 3, new Date('2026-10-05T00:00:00Z'));
    expect(s).toEqual({ slug: 'builder', source: 'kind', confidence: 0, model: 'kind-default', candidates: 3, at: '2026-10-05T00:00:00.000Z' });
  });
});

describe('kindDefaultCandidates', () => {
  const { kindDefaultCandidates } = require('./task-role-default') as typeof import('./task-role-default');
  const row = (slug: string, over: Record<string, unknown> = {}) => ({
    slug, name: slug, workspaceId: null, enabled: true, isRole: true, metadata: null,
    allowedTools: null, connectorRefs: null, defaultBackend: null, ...over,
  });
  const task = { workspaceId: 'w', backend: 'claude', outputRequirement: 'pr_required', pathManifestIsConcrete: true, emitsPlan: false };

  it('keeps enabled, routable roles even without routing text', () => {
    expect(kindDefaultCandidates([row('builder')], task).map(c => c.slug)).toEqual(['builder']);
  });

  it('drops disabled, opt-in, routing-disabled, read-only (for a PR task) and wrong-backend roles', () => {
    const rows = [
      row('off', { enabled: false }),
      row('visual-auditor'),
      row('quiet', { metadata: { routing: { disabled: true } } }),
      row('readonly', { allowedTools: ['Read'] }),
      row('codexy', { defaultBackend: 'codex' }),
      row('builder'),
    ];
    expect(kindDefaultCandidates(rows, task).map(c => c.slug)).toEqual(['builder']);
  });
});
