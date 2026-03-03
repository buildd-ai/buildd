/**
 * Unit tests for WorkerRunner agent teams support.
 *
 * Tests that CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is set in the env
 * passed to the SDK query() call.
 *
 * Run: bun test packages/core/__tests__/worker-runner-teams.test.ts
 */

import { describe, expect, test } from 'bun:test';

/**
 * Mirrors the env construction logic from WorkerRunner.start().
 * Extracted for isolated unit testing without DB dependencies.
 */
function buildWorkerEnv(config: {
  llmProvider?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Enable Agent Teams support
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

  if (config.llmProvider === 'openrouter' || config.llmBaseUrl) {
    env.ANTHROPIC_BASE_URL = config.llmBaseUrl || 'https://openrouter.ai/api';
    if (config.llmApiKey) {
      env.ANTHROPIC_AUTH_TOKEN = config.llmApiKey;
      env.ANTHROPIC_API_KEY = '';
    }
  }

  return env;
}

describe('WorkerRunner — agent teams env', () => {
  test('sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 by default', () => {
    const env = buildWorkerEnv({});
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  test('sets teams env alongside OpenRouter config', () => {
    const env = buildWorkerEnv({
      llmProvider: 'openrouter',
      llmBaseUrl: 'https://openrouter.ai/api',
      llmApiKey: 'or-key',
    });
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('or-key');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  test('sets teams env alongside custom base URL', () => {
    const env = buildWorkerEnv({
      llmBaseUrl: 'https://custom.llm/api',
      llmApiKey: 'custom-key',
    });
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://custom.llm/api');
  });

  test('teams env is always a string "1"', () => {
    const env = buildWorkerEnv({});
    expect(typeof env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('string');
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).not.toBe(1);
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).not.toBe(true);
  });
});

/**
 * Mirrors the skill + subagent configuration logic from WorkerRunner.
 * The core runner doesn't convert skills to agents (that's the runner's job),
 * but it should correctly handle the allowedTools and systemPrompt when
 * useSkillAgents is present.
 */
function buildSkillConfigWithAgents(taskContext: any): {
  allowedTools: string[];
  systemPromptAppend?: string;
} {
  const skillSlugs: string[] = taskContext?.skillSlugs || [];
  const useSkillAgents = !!taskContext?.useSkillAgents;

  const allowedTools: string[] = [];
  if (skillSlugs.length > 0 && !useSkillAgents) {
    for (const slug of skillSlugs) {
      allowedTools.push(`Skill(${slug})`);
    }
  }

  let systemPromptAppend: string | undefined;
  if (skillSlugs.length > 0 && !useSkillAgents) {
    systemPromptAppend =
      skillSlugs.length === 1
        ? `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`
        : `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
  }

  return { allowedTools, systemPromptAppend };
}

describe('WorkerRunner — skill config with useSkillAgents', () => {
  test('useSkillAgents=true disables Skill tool scoping', () => {
    const { allowedTools } = buildSkillConfigWithAgents({
      skillSlugs: ['deploy', 'review'],
      useSkillAgents: true,
    });
    expect(allowedTools).toEqual([]);
  });

  test('useSkillAgents=true disables system prompt append', () => {
    const { systemPromptAppend } = buildSkillConfigWithAgents({
      skillSlugs: ['deploy'],
      useSkillAgents: true,
    });
    expect(systemPromptAppend).toBeUndefined();
  });

  test('useSkillAgents=false preserves normal skill scoping', () => {
    const { allowedTools, systemPromptAppend } = buildSkillConfigWithAgents({
      skillSlugs: ['deploy'],
      useSkillAgents: false,
    });
    expect(allowedTools).toEqual(['Skill(deploy)']);
    expect(systemPromptAppend).toContain('MUST use the deploy skill');
  });

  test('useSkillAgents absent preserves normal skill scoping', () => {
    const { allowedTools, systemPromptAppend } = buildSkillConfigWithAgents({
      skillSlugs: ['deploy', 'review'],
    });
    expect(allowedTools).toEqual(['Skill(deploy)', 'Skill(review)']);
    expect(systemPromptAppend).toContain('deploy, review');
  });

  test('no skills with useSkillAgents=true returns empty', () => {
    const { allowedTools, systemPromptAppend } = buildSkillConfigWithAgents({
      skillSlugs: [],
      useSkillAgents: true,
    });
    expect(allowedTools).toEqual([]);
    expect(systemPromptAppend).toBeUndefined();
  });
});
