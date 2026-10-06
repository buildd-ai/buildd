import { describe, it, expect, mock } from 'bun:test';
import {
  admitDocsWithinCap,
  loadTeamEntitlements,
  planDocsAdmission,
  BILLING_SETTINGS_HINT,
} from '../billing-limits';
import { FREE_KNOWLEDGE_BASE_DOC_CAP } from '../entitlements';

const ON = { BILLING_ENFORCED: '1' };
const OFF = {};

const never = () => mock(async (): Promise<any> => { throw new Error('must not be read while billing is off'); });

describe('loadTeamEntitlements', () => {
  it('billing off: unlimited, and the team row is never read', async () => {
    const loadTeam = never();
    const ent = await loadTeamEntitlements('t1', { env: OFF, loadTeam });
    expect(ent.maxMembers).toBeNull();
    expect(ent.knowledgeBaseCap).toBeNull();
    expect(loadTeam).not.toHaveBeenCalled();
  });

  it('billing on: reads the plan', async () => {
    const ent = await loadTeamEntitlements('t1', { env: ON, loadTeam: async () => ({ plan: 'free' }) });
    expect(ent.maxMembers).toBe(1);
    expect(ent.decisionCallsIncluded).toBe(false);
  });

  it('a failed lookup is unlimited, never a refusal', async () => {
    const ent = await loadTeamEntitlements('t1', { env: ON, loadTeam: async () => { throw new Error('db down'); } });
    expect(ent.maxMembers).toBeNull();
  });
});

describe('planDocsAdmission', () => {
  it('no cap: everything admitted', () => {
    const res = planDocsAdmission({ cap: null, storedCount: 999, alreadyStored: new Set(), paths: ['a.md'] });
    expect(res).toEqual({ admitted: ['a.md'], refused: [], cap: null, message: null });
  });

  it('admits new documents up to the cap and refuses the rest', () => {
    const res = planDocsAdmission({ cap: 3, storedCount: 1, alreadyStored: new Set(), paths: ['a.md', 'b.md', 'c.md'] });
    expect(res.admitted).toEqual(['a.md', 'b.md']);
    expect(res.refused).toEqual(['c.md']);
    expect(res.message).toContain(BILLING_SETTINGS_HINT);
    expect(res.message).toContain('stays searchable');
  });

  it('an already-stored document is an update and always goes through, even over the cap', () => {
    const res = planDocsAdmission({
      cap: 2, storedCount: 5, alreadyStored: new Set(['old.md']), paths: ['old.md', 'new.md'],
    });
    expect(res.admitted).toEqual(['old.md']);
    expect(res.refused).toEqual(['new.md']);
  });

  it('the same new path twice uses one slot', () => {
    const res = planDocsAdmission({ cap: 1, storedCount: 0, alreadyStored: new Set(), paths: ['a.md', 'a.md'] });
    expect(res.admitted).toEqual(['a.md', 'a.md']);
    expect(res.refused).toEqual([]);
  });
});

describe('admitDocsWithinCap', () => {
  const paths = ['docs/new.md'];

  it('billing off: everything admitted, nothing read', async () => {
    const loadWorkspaceTeam = never();
    const res = await admitDocsWithinCap('ws1', paths, { env: OFF, loadWorkspaceTeam });
    expect(res.refused).toEqual([]);
    expect(res.admitted).toEqual(paths);
    expect(loadWorkspaceTeam).not.toHaveBeenCalled();
  });

  it('billing on, free team at the cap: new documents refused', async () => {
    const res = await admitDocsWithinCap('ws1', paths, {
      env: ON,
      loadWorkspaceTeam: async () => ({ teamId: 't1', plan: 'free' }),
      countTeamDocs: async () => FREE_KNOWLEDGE_BASE_DOC_CAP,
      storedDocPaths: async () => new Set(),
    });
    expect(res.admitted).toEqual([]);
    expect(res.refused).toEqual(paths);
    expect(res.cap).toBe(FREE_KNOWLEDGE_BASE_DOC_CAP);
  });

  it('billing on, free team at the cap: updates to stored documents still go through', async () => {
    const res = await admitDocsWithinCap('ws1', ['docs/old.md'], {
      env: ON,
      loadWorkspaceTeam: async () => ({ teamId: 't1', plan: 'free' }),
      countTeamDocs: async () => FREE_KNOWLEDGE_BASE_DOC_CAP + 10,
      storedDocPaths: async () => new Set(['docs/old.md']),
    });
    expect(res.admitted).toEqual(['docs/old.md']);
    expect(res.refused).toEqual([]);
  });

  it('billing on, paid plan: no cap, docs never counted', async () => {
    const countTeamDocs = never();
    const res = await admitDocsWithinCap('ws1', paths, {
      env: ON, loadWorkspaceTeam: async () => ({ teamId: 't1', plan: 'pro' }), countTeamDocs,
    });
    expect(res.admitted).toEqual(paths);
    expect(countTeamDocs).not.toHaveBeenCalled();
  });

  it('a failed lookup admits everything', async () => {
    const res = await admitDocsWithinCap('ws1', paths, {
      env: ON,
      loadWorkspaceTeam: async () => ({ teamId: 't1', plan: 'free' }),
      countTeamDocs: async () => { throw new Error('db down'); },
      storedDocPaths: async () => new Set(),
    });
    expect(res.admitted).toEqual(paths);
  });
});
