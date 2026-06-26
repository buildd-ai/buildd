import { describe, it, expect } from 'bun:test';
import { isNavActive } from './nav-active';

describe('isNavActive', () => {
  describe('/app/home', () => {
    it('matches /app/home exactly', () => {
      expect(isNavActive('/app/home', '/app/home')).toBe(true);
    });

    it('matches legacy /app/dashboard', () => {
      expect(isNavActive('/app/dashboard', '/app/home')).toBe(true);
    });

    it('does not match other routes', () => {
      expect(isNavActive('/app/missions', '/app/home')).toBe(false);
    });
  });

  describe('/app/missions', () => {
    it('matches /app/missions', () => {
      expect(isNavActive('/app/missions', '/app/missions')).toBe(true);
    });

    it('matches nested /app/missions/abc', () => {
      expect(isNavActive('/app/missions/abc-123', '/app/missions')).toBe(true);
    });
  });

  describe('/app/tasks (Activity)', () => {
    it('matches /app/tasks', () => {
      expect(isNavActive('/app/tasks', '/app/tasks')).toBe(true);
    });

    it('matches nested task detail', () => {
      expect(isNavActive('/app/tasks/123', '/app/tasks')).toBe(true);
    });
  });

  describe('/app/team', () => {
    it('matches /app/team', () => {
      expect(isNavActive('/app/team', '/app/team')).toBe(true);
    });

    it('matches nested team pages', () => {
      expect(isNavActive('/app/team/roles', '/app/team')).toBe(true);
    });

    it('does not match /app/teams (old orphan route)', () => {
      expect(isNavActive('/app/teams', '/app/team')).toBe(false);
    });
  });

  describe('/app/health', () => {
    it('matches /app/health', () => {
      expect(isNavActive('/app/health', '/app/health')).toBe(true);
    });

    it('matches nested health pages', () => {
      expect(isNavActive('/app/health/project-123', '/app/health')).toBe(true);
    });
  });

  describe('routes that were previously mis-bucketed under Settings', () => {
    it('/app/you is not active for any primary nav tab', () => {
      expect(isNavActive('/app/you', '/app/home')).toBe(false);
      expect(isNavActive('/app/you', '/app/missions')).toBe(false);
      expect(isNavActive('/app/you', '/app/tasks')).toBe(false);
      expect(isNavActive('/app/you', '/app/team')).toBe(false);
      expect(isNavActive('/app/you', '/app/health')).toBe(false);
    });

    it('/app/artifacts is not active for any primary nav tab', () => {
      expect(isNavActive('/app/artifacts', '/app/health')).toBe(false);
      expect(isNavActive('/app/artifacts', '/app/team')).toBe(false);
    });

    it('/app/accounts is not active for any primary nav tab', () => {
      expect(isNavActive('/app/accounts', '/app/health')).toBe(false);
    });
  });
});
