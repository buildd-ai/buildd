import { describe, expect, it } from 'bun:test';
import { AGENT_CREDENTIAL_PURPOSES, AGENT_INFERENCE_KEY_LABELS, firstTaskState, gettingStartedChecklist } from './getting-started';

const none = { runnerConnected: false, hasAgentCredential: false, firstTask: 'none' as const };

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
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, firstTask: 'done' });
    expect(c.steps.map((s) => s.done)).toEqual([true, false, true]);
    expect(c.doneCount).toBe(2);
  });

  it('the current step is the first one not done, even when a later one is', () => {
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: true, firstTask: 'none' });
    expect(c.steps.find((s) => s.current)?.id).toBe('task');
    const d = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, firstTask: 'done' });
    expect(d.steps.find((s) => s.current)?.id).toBe('credential');
    expect(d.steps.filter((s) => s.current)).toHaveLength(1);
  });

  it('a filed task is not a finished one: only a task that succeeded ticks the third step', () => {
    // The fresh-user walkthrough: runner up, task filed, no key, so the task failed.
    for (const firstTask of ['open', 'failed'] as const) {
      const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, firstTask });
      expect(c.steps.find((s) => s.id === 'task')?.done).toBe(false);
      expect(c.doneCount).toBe(1);
      expect(c.visible).toBe(true);
    }
    // A key added after the failure: the list stays until a task succeeds.
    expect(gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: true, firstTask: 'failed' }).visible).toBe(true);
  });

  it('carries the first task state so the step can say what happened', () => {
    const step = (firstTask: 'none' | 'open' | 'failed' | 'done') =>
      gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: true, firstTask }).steps.find((s) => s.id === 'task');
    expect(step('failed')?.taskState).toBe('failed');
    expect(step('open')?.taskState).toBe('open');
    expect(step('none')?.taskState).toBe('none');
  });

  it('the old walkthrough shape still has one current step', () => {
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: false, firstTask: 'failed' });
    expect(c.steps.find((s) => s.current)?.id).toBe('credential');
    expect(c.steps.filter((s) => s.current)).toHaveLength(1);
  });

  it('hides once all three are done', () => {
    const c = gettingStartedChecklist({ runnerConnected: true, hasAgentCredential: true, firstTask: 'done' });
    expect(c.complete).toBe(true);
    expect(c.visible).toBe(false);
    expect(c.steps.some((s) => s.current)).toBe(false);
  });

  it('counts every agent-backend credential, and nothing chat-only', () => {
    for (const p of ['anthropic_api_key', 'oauth_token', 'claude_credential', 'codex_credential', 'openai_api_key', 'agent_endpoint']) {
      expect(AGENT_CREDENTIAL_PURPOSES as readonly string[]).toContain(p);
    }
    // A chat key is counted only through its label (AGENT_INFERENCE_KEY_LABELS).
    expect(AGENT_CREDENTIAL_PURPOSES as readonly string[]).not.toContain('inference_key');
  });

  it('counts the Anthropic and OpenAI keys in canonical storage (agent runs read them), and no other chat key', () => {
    expect([...AGENT_INFERENCE_KEY_LABELS]).toEqual(['anthropic', 'openai']);
  });
});

describe('firstTaskState: from top-level task counts by status', () => {
  it('no tasks, or only cancelled ones, is none', () => {
    expect(firstTaskState({})).toBe('none');
    expect(firstTaskState({ cancelled: 2 })).toBe('none');
  });
  it('one succeeded task is done, whatever else failed', () => {
    expect(firstTaskState({ completed: 1, failed: 3 })).toBe('done');
  });
  it('only failures is failed', () => {
    expect(firstTaskState({ failed: 1 })).toBe('failed');
    expect(firstTaskState({ failed: 1, cancelled: 1 })).toBe('failed');
  });
  it('a task still queued or running is open, even after a failure', () => {
    expect(firstTaskState({ pending: 1 })).toBe('open');
    expect(firstTaskState({ in_progress: 1, failed: 1 })).toBe('open');
    expect(firstTaskState({ assigned: 1 })).toBe('open');
  });
  it('ignores zero counts', () => {
    expect(firstTaskState({ completed: 0, failed: 0, pending: 0 })).toBe('none');
  });
});
