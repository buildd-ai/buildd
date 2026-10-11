import { afterEach, expect, test } from 'bun:test';
import { buildPromptWithComposition, worktreeLocationLine } from '../../src/prompt-builder';

const saved = process.env.BUILDD_EXECUTOR;
afterEach(() => {
  if (saved === undefined) delete process.env.BUILDD_EXECUTOR;
  else process.env.BUILDD_EXECUTOR = saved;
});

for (const mode of ['cloud', 'host']) {
  test(`${mode} prompt describes the session checkout accurately`, () => {
    process.env.BUILDD_EXECUTOR = mode;
    const location = worktreeLocationLine('/tmp/session');
    const prompt = buildPromptWithComposition({
      task: { id: 'task-example', title: 'Example', description: 'Example task', workspaceId: 'workspace-example' },
      worker: { id: 'worker-example', workspaceName: 'example', worktreePath: '/tmp/session', branch: 'buildd/example' },
      gitConfig: { defaultBranch: 'dev' },
      isConfigured: true,
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
      inputPolicy: 'autonomous',
      hasApiKey: true,
    } as any).promptText;
    expect(location).toContain('/tmp/session');
    if (mode === 'cloud') {
      expect(location).toContain('session clone');
      expect(location).not.toContain('shared with other workers');
      expect(prompt).toContain('You are working in the session clone');
      expect(prompt).not.toContain('isolated worktree');
    } else {
      expect(location).toContain('shared with other workers');
      expect(prompt).toContain('isolated worktree');
    }
  });
}
