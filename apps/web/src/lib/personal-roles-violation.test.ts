import { describe, expect, it } from 'bun:test';
import { isSharedSlugViolation } from './personal-roles';

describe('isSharedSlugViolation', () => {
  it('recognises the team slug index violation, directly or wrapped', () => {
    expect(isSharedSlugViolation({ code: '23505', constraint: 'ws_skills_team_slug_idx' })).toBe(true);
    expect(isSharedSlugViolation({ message: 'x', cause: { code: '23505', constraint: 'ws_skills_team_slug_idx' } })).toBe(true);
    expect(isSharedSlugViolation({ code: '23505' })).toBe(true);
  });

  it('ignores other constraints and other errors', () => {
    expect(isSharedSlugViolation({ code: '23505', constraint: 'ws_skills_owner_slug_idx' })).toBe(false);
    expect(isSharedSlugViolation({ code: '23503' })).toBe(false);
    expect(isSharedSlugViolation(new Error('boom'))).toBe(false);
    expect(isSharedSlugViolation(null)).toBe(false);
  });
});
