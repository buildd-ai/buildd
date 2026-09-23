import { describe, it, expect } from 'bun:test';
import {
  parseKeyLevel,
  maxKeyLevelForRole,
  isKeyLevelAllowed,
  clampKeyLevel,
  canAdministerTeamKeys,
} from './key-level-policy';

describe("key level policy — API key level is capped by the creator's team role", () => {
  it('owners and admins may create admin-level keys', () => {
    expect(maxKeyLevelForRole('owner')).toBe('admin');
    expect(maxKeyLevelForRole('admin')).toBe('admin');
  });

  it('members are capped at worker level', () => {
    expect(maxKeyLevelForRole('member')).toBe('worker');
    expect(isKeyLevelAllowed('member', 'admin')).toBe(false);
    expect(isKeyLevelAllowed('member', 'worker')).toBe(true);
    expect(isKeyLevelAllowed('member', 'trigger')).toBe(true);
  });

  it('clamps a requested level down to the role maximum, never up', () => {
    expect(clampKeyLevel('member', 'admin')).toBe('worker');
    expect(clampKeyLevel('member', 'trigger')).toBe('trigger');
    expect(clampKeyLevel('admin', 'admin')).toBe('admin');
  });

  it('parses only known levels', () => {
    expect(parseKeyLevel('worker')).toBe('worker');
    expect(parseKeyLevel('owner')).toBeNull();
    expect(parseKeyLevel(undefined)).toBeNull();
    expect(parseKeyLevel(3)).toBeNull();
  });

  it('only owners and admins administer team keys', () => {
    expect(canAdministerTeamKeys('owner')).toBe(true);
    expect(canAdministerTeamKeys('admin')).toBe(true);
    expect(canAdministerTeamKeys('member')).toBe(false);
    expect(canAdministerTeamKeys(null)).toBe(false);
  });
});
