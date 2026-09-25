import { describe, it, expect } from 'bun:test';
import {
  checkWorkspaceHealth,
  hasLegacyMergeFields,
  describePolicyConfig,
  type WorkspaceHealthInput,
} from './workspace-health';

// A workspace nothing here should complain about: confirmed, restricted, a
// risk-class policy, and a user who belongs to one team.
const healthy: WorkspaceHealthInput = {
  name: 'app',
  repo: 'https://github.com/example/app',
  configStatus: 'admin_confirmed',
  accessMode: 'restricted',
  gitConfig: { policyConfig: { preset: 'balanced', riskClasses: [] } },
  userTeamCount: 1,
};

const ids = (input: WorkspaceHealthInput) => checkWorkspaceHealth(input).map(i => i.id);

describe('checkWorkspaceHealth', () => {
  it('returns nothing for a healthy workspace', () => {
    expect(checkWorkspaceHealth(healthy)).toEqual([]);
  });

  describe('policy rule', () => {
    it('flags a workspace whose config was never confirmed', () => {
      const items = checkWorkspaceHealth({ ...healthy, configStatus: 'unconfigured' });
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('policy');
      expect(items[0].severity).toBe('warning');
      expect(items[0].action).toEqual({ kind: 'review-policy', label: 'Review proposed policy' });
    });

    it('flags legacy merge fields with no policyConfig', () => {
      expect(ids({ ...healthy, gitConfig: { autoMergeDenyPaths: ['db/'] } })).toEqual(['policy']);
    });

    it('does not flag legacy merge fields when a policyConfig exists', () => {
      expect(ids({
        ...healthy,
        gitConfig: { autoMergeMaxLines: 400, policyConfig: { preset: 'balanced', riskClasses: [] } },
      })).toEqual([]);
    });

    it('emits one line, not two, when unconfigured AND legacy', () => {
      expect(ids({
        ...healthy,
        configStatus: 'unconfigured',
        gitConfig: { autoMergePR: true },
      })).toEqual(['policy']);
    });

    it('does not flag a confirmed workspace with no legacy fields and no policyConfig', () => {
      expect(ids({ ...healthy, gitConfig: {} })).toEqual([]);
      expect(ids({ ...healthy, gitConfig: null })).toEqual([]);
    });
  });

  describe('access rule', () => {
    it('flags open access with the restrict action', () => {
      const items = checkWorkspaceHealth({ ...healthy, accessMode: 'open' });
      expect(items.map(i => i.id)).toEqual(['access-open']);
      expect(items[0].action?.kind).toBe('restrict-access');
      expect(items[0].action?.label).toBe('Restrict to team members');
      expect(items[0].note).toBeTruthy();
    });
  });

  describe('team placement rule', () => {
    it('is absent when the user belongs to one team', () => {
      expect(ids({ ...healthy, userTeamCount: 1 })).not.toContain('team-placement');
    });

    it('is an action, not a warning, when the user belongs to more than one team', () => {
      const items = checkWorkspaceHealth({ ...healthy, userTeamCount: 2 });
      expect(items.map(i => i.id)).toEqual(['team-placement']);
      expect(items[0].severity).toBe('action');
      expect(items[0].action).toEqual({ kind: 'move-team', label: 'Move to team…' });
    });
  });

  it('orders warnings before actions', () => {
    expect(ids({
      ...healthy,
      configStatus: 'unconfigured',
      accessMode: 'open',
      userTeamCount: 3,
    })).toEqual(['policy', 'access-open', 'team-placement']);
  });

  describe('system workspace exemption', () => {
    const coordination: WorkspaceHealthInput = {
      name: '__coordination',
      repo: null,
      configStatus: 'unconfigured',
      accessMode: 'open',
      gitConfig: { autoMergePR: true },
      userTeamCount: 2,
    };

    it('shows only the info line for a repo-less system workspace', () => {
      const items = checkWorkspaceHealth(coordination);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('system-workspace');
      expect(items[0].severity).toBe('info');
      expect(items[0].label).toBe('System workspace for orchestration — no repo by design');
      expect(items[0].action).toBeNull();
    });

    it('treats an empty-string repo as no repo', () => {
      expect(ids({ ...coordination, repo: '' })).toEqual(['system-workspace']);
    });

    it('does not exempt a __-prefixed workspace that has a repo', () => {
      expect(ids({ ...coordination, repo: 'https://github.com/example/app' }))
        .toEqual(['policy', 'access-open', 'team-placement']);
    });

    it('does not exempt a repo-less workspace without the system prefix', () => {
      expect(ids({ ...coordination, name: 'notes' }))
        .toEqual(['policy', 'access-open', 'team-placement']);
    });
  });
});

describe('hasLegacyMergeFields', () => {
  it('detects each legacy field', () => {
    expect(hasLegacyMergeFields({ autoMergePR: false })).toBe(true);
    expect(hasLegacyMergeFields({ autoMergeDenyPaths: ['x/'] })).toBe(true);
    expect(hasLegacyMergeFields({ autoMergeMaxLines: 800 })).toBe(true);
    expect(hasLegacyMergeFields({ mergePolicy: { agentReview: { escalateToPaths: ['x/'] } } })).toBe(true);
  });

  it('ignores empty or absent values', () => {
    expect(hasLegacyMergeFields(null)).toBe(false);
    expect(hasLegacyMergeFields({})).toBe(false);
    expect(hasLegacyMergeFields({ autoMergeDenyPaths: [] })).toBe(false);
    expect(hasLegacyMergeFields({ mergePolicy: { agentReview: { escalateToPaths: [] } } })).toBe(false);
    // autoMergeOnGreenCI is the current field, not a legacy one
    expect(hasLegacyMergeFields({ autoMergeOnGreenCI: true })).toBe(false);
  });
});

describe('describePolicyConfig', () => {
  it('lists every risk class with its preset action and paths', () => {
    const rows = describePolicyConfig({
      preset: 'balanced',
      riskClasses: [
        { name: 'destructive_schema_change', detectedPaths: ['db/migrations/'], userPaths: ['db/seed.sql'] },
        { name: 'dependency_bump', detectedPaths: [] },
      ],
    });
    expect(rows).toEqual([
      {
        name: 'destructive_schema_change',
        label: 'Destructive schema changes',
        action: 'human',
        actionLabel: 'Human review',
        paths: ['db/migrations/', 'db/seed.sql'],
      },
      {
        name: 'dependency_bump',
        label: 'Dependency bumps',
        action: 'auto',
        actionLabel: 'Auto-merge',
        paths: [],
      },
    ]);
  });

  it('tolerates a hand-authored entry with no detectedPaths', () => {
    const rows = describePolicyConfig({
      preset: 'cautious',
      riskClasses: [{ name: 'auth_and_secrets' } as any],
    });
    expect(rows[0].paths).toEqual([]);
    expect(rows[0].actionLabel).toBe('Human review');
  });
});
