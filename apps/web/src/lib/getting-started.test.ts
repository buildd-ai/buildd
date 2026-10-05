import { describe, expect, it } from 'bun:test';
import { AGENT_CREDENTIAL_PURPOSES, gettingStartedChecklist } from './getting-started';

const none = { runnerConnected: false, hasAgentCredential: false, hasTask: false };

describe('gettingStartedChecklist: one ordered list, done state from real data', () => {
  it('lists runner, agent key, first task in that order', () => {
    expect(gettingStartedChecklist(none).steps.map((s) => s.id)).toEqual(['runner', 'credential', 'task']);
  });

  it('a brand-new team: nothing done, the runner step is current, the list shows', () => {
    const c = gettingStartedChecklist(none);
    expect(c.visible).toBe(true);
    expect(c.doneCount).toBe(0);
    expect(c.steps.map((s) => s.done)).toEqual([false, false, false]);
    expect(c.steps.find((s) => s.current)?.id).toBe('runner');
  });

  it('marks each step done from its own fact', () => {
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, hasTask: true });
    expect(c.steps.map((s) => s.done)).toEqual([true, false, true]);
    expect(c.doneCount).toBe(2);
  });

  it('the current step is the first one not done, even when a later one is', () => {
    // The fresh-user walkthrough: runner up, task filed, no key, so the task failed.
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, hasTask: true });
    expect(c.steps.find((s) => s.current)?.id).toBe('credential');
    expect(c.steps.filter((s) => s.current)).toHaveLength(1);
  });

  it('hides once all three are done', () => {
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: true, hasTask: true });
    expect(c.complete).toBe(true);
    expect(c.visible).toBe(false);
    expect(c.steps.some((s) => s.current)).toBe(false);
  });

  it('counts every agent-backend credential, and nothing chat-only', () => {
    for (const p of ['anthropic_api_key', 'oauth_token', 'claude_credential', 'codex_credential', 'openai_api_key', 'agent_endpoint']) {
      expect(AGENT_CREDENTIAL_PURPOSES as readonly string[]).toContain(p);
    }
    expect(AGENT_CREDENTIAL_PURPOSES as readonly string[]).not.toContain('inference_key');
  });
});
