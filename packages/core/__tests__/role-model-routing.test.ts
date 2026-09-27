import { describe, it, expect } from 'bun:test';
import {
  pickRoleRowForTask,
  resolveClaimModelInputs,
  countRoleInferenceCandidates,
  isExactRoleModel,
  roleFloorTier,
} from '../role-model-routing';

describe('resolveClaimModelInputs — precedence', () => {
  it('an explicit tasks.tier beats a role pinned to an exact model id (email-agent case)', () => {
    const r = resolveClaimModelInputs({
      pin: null, taskTier: 'premium', roleModel: 'claude-sonnet-5', roleInferred: false,
    });
    expect(r.explicitModel).toBeNull();
    // An exact id is not a floor either, so the tier lookup is untouched.
    expect(r.routerRoleFloor).toBeNull();
    expect(r.roleTierOverride).toBeNull();
  });

  it('the role exact id still wins over the matrix when no tier is set', () => {
    const r = resolveClaimModelInputs({
      pin: null, taskTier: null, roleModel: 'claude-sonnet-5', roleInferred: false,
    });
    expect(r.explicitModel).toBe('claude-sonnet-5');
  });

  it('a context.model pin wins over tier and role', () => {
    const r = resolveClaimModelInputs({
      pin: 'claude-opus-4-8', taskTier: 'budget', roleModel: 'claude-sonnet-5', roleInferred: false,
    });
    expect(r.explicitModel).toBe('claude-opus-4-8');
  });

  it('maps tier and legacy role floors to router vocabulary', () => {
    const floor = (m: string) => resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: m, roleInferred: false }).routerRoleFloor;
    expect(floor('premium')).toBe('opus');
    expect(floor('opus')).toBe('opus');
    expect(floor('standard')).toBe('sonnet');
    expect(floor('sonnet')).toBe('sonnet');
    expect(floor('budget')).toBe('haiku');
    expect(floor('inherit')).toBe('inherit');
  });

  it('a premium-plus role floor resolves to premium-plus, not premium', () => {
    const r = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: 'premium-plus', roleInferred: false });
    expect(r.routerRoleFloor).toBe('opus');
    expect(r.roleTierOverride).toBe('premium-plus');
  });

  it('an explicit tasks.tier beats a premium-plus role floor', () => {
    const r = resolveClaimModelInputs({ pin: null, taskTier: 'standard', roleModel: 'premium-plus', roleInferred: false });
    expect(r.roleTierOverride).toBeNull();
  });
});

describe('resolveClaimModelInputs — an inferred role never touches the model', () => {
  it('drops an inferred role floor', () => {
    const r = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: 'opus', roleInferred: true });
    expect(r.roleModel).toBeNull();
    expect(r.routerRoleFloor).toBeNull();
    expect(r.roleTierOverride).toBeNull();
  });

  it('drops an inferred role exact-id pin', () => {
    const r = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: 'claude-sonnet-5', roleInferred: true });
    expect(r.explicitModel).toBeNull();
    expect(r.roleModel).toBeNull();
  });

  it('drops an inferred premium-plus floor', () => {
    const r = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: 'premium-plus', roleInferred: true });
    expect(r.roleTierOverride).toBeNull();
  });
});

describe('pickRoleRowForTask — per-task scoping', () => {
  const rows = [
    { slug: 'builder', model: 'opus', workspaceId: 'ws-a', teamId: 'team-1' },
    { slug: 'builder', model: 'budget', workspaceId: 'ws-b', teamId: 'team-1' },
    { slug: 'builder', model: 'standard', workspaceId: null, teamId: 'team-1' },
    { slug: 'builder', model: 'premium', workspaceId: null, teamId: 'team-2' },
  ];

  it('two workspaces overriding the same slug each get their own row', () => {
    expect(pickRoleRowForTask(rows, { roleSlug: 'builder', workspaceId: 'ws-a', teamId: 'team-1' })?.model).toBe('opus');
    expect(pickRoleRowForTask(rows, { roleSlug: 'builder', workspaceId: 'ws-b', teamId: 'team-1' })?.model).toBe('budget');
  });

  it('row order does not change the answer', () => {
    const reversed = [...rows].reverse();
    expect(pickRoleRowForTask(reversed, { roleSlug: 'builder', workspaceId: 'ws-a', teamId: 'team-1' })?.model).toBe('opus');
  });

  it('falls back to the task team default, never another workspace or team', () => {
    expect(pickRoleRowForTask(rows, { roleSlug: 'builder', workspaceId: 'ws-c', teamId: 'team-1' })?.model).toBe('standard');
    expect(pickRoleRowForTask(rows, { roleSlug: 'builder', workspaceId: 'ws-c', teamId: 'team-2' })?.model).toBe('premium');
    expect(pickRoleRowForTask(rows, { roleSlug: 'builder', workspaceId: 'ws-c', teamId: 'team-3' })).toBeNull();
  });

  it('no role → no row', () => {
    expect(pickRoleRowForTask(rows, { roleSlug: null, workspaceId: 'ws-a', teamId: 'team-1' })).toBeNull();
  });
});

describe('countRoleInferenceCandidates', () => {
  const routed = (whenToUse: string) => ({ routing: { whenToUse } });

  it('counts effective roles with routing text, override wins', () => {
    const n = countRoleInferenceCandidates([
      { slug: 'builder', model: 'inherit', workspaceId: null, metadata: routed('Code changes that end in a PR') },
      { slug: 'researcher', model: 'inherit', workspaceId: null, metadata: routed('Investigate without changing code') },
      // Override opts researcher out in this workspace.
      { slug: 'researcher', model: 'inherit', workspaceId: 'ws-1', metadata: { routing: { disabled: true } } },
      { slug: 'writer', model: 'inherit', workspaceId: null, metadata: null },
      { slug: 'visual-auditor', model: 'inherit', workspaceId: null, metadata: routed('Screenshots of UI work') },
      { slug: 'other', model: 'inherit', workspaceId: 'ws-2', metadata: routed('Another workspace only') },
    ], 'ws-1');
    expect(n).toBe(1);
  });
});

describe('role model vocabulary', () => {
  it('distinguishes exact ids from tier aliases', () => {
    expect(isExactRoleModel('claude-sonnet-5')).toBe(true);
    expect(isExactRoleModel('premium-plus')).toBe(false);
    expect(isExactRoleModel('inherit')).toBe(false);
    expect(isExactRoleModel(null)).toBe(false);
    expect(roleFloorTier('opus')).toBe('premium');
    expect(roleFloorTier('inherit')).toBeNull();
    expect(roleFloorTier('claude-sonnet-5')).toBeNull();
  });
});
