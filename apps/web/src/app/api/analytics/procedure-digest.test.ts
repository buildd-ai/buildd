/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-9 (R-3). */
import { describe, expect, it } from 'bun:test';
import { procedureDigest } from './procedure-digest';

describe('procedure_digest', () => {
  it('AC-9: rows carry only short id, role, basis, tool names and registered skill slugs', async () => {
    const rows = await procedureDigest({
      workspaceId: 'w1', callerWorkspaceIds: ['w1'], window: '30d', limit: 10,
      load: async () => [{
        id: 'e3666436-f997-439e-8236-5a4b58d2ca10', roleSlug: 'builder', verifiedBasis: 'pr_merged',
        title: 'secret title', summary: 'secret summary', files: ['/home/x/y'],
        toolCalls: [{ name: 'Read', args: { path: '/home/x' } }, { name: 'Bash', args: { cmd: 'ls' } }],
        skillsLoaded: ['known', 'unregistered'],
      }],
      registeredSkillSlugs: ['known'],
    });
    expect(rows).toEqual([{
      taskId: 'e3666436', roleSlug: 'builder', verifiedBasis: 'pr_merged',
      tools: ['Read', 'Bash'], skills: ['known'],
    }]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|\/home|args/);
  });

  it('AC-9: a caller outside the workspace is refused', async () => {
    await expect(procedureDigest({
      workspaceId: 'w1', callerWorkspaceIds: ['w2'], window: '30d', limit: 10,
      load: async () => [], registeredSkillSlugs: [],
    })).rejects.toThrow(/forbidden|refused/i);
  });
});
