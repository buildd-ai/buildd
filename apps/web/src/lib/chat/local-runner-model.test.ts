// Chat on the relay (docs/specs/local-runner-provider.md §7.2): the model a
// `local_runner` chat assignment resolves to. It enqueues one `chat` job,
// forwards partial text as it appears, and fails with a typed error. It holds
// no key and no URL, so there is nothing it could fall back to.
import { describe, it, expect } from 'bun:test';
import { generateText, streamText } from 'ai';
import { LocalRunnerUnavailableError, isLocalRunnerUnavailable, localRunnerLanguageModel, relayChatPayload } from './local-runner-model';

const TEAM = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';

function model(run: (input: any) => Promise<any>) {
  const jobs: any[] = [];
  const m = localRunnerLanguageModel({ teamId: TEAM, workspaceId: 'ws-1', modelId: 'llama3.1:8b', run: async (input) => { jobs.push(input); return run(input); } });
  return { m, jobs };
}

describe('relayChatPayload', () => {
  it('flattens the prompt to role + text messages and keeps the sampling options; tools are not sent', () => {
    const payload = relayChatPayload({
      prompt: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is ' }, { type: 'text', text: 'in flight?' }, { type: 'file', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'Two tasks.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'list_tasks', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'list_tasks', output: { type: 'json', value: { count: 2 } } }] },
      ],
      temperature: 0.2, maxOutputTokens: 512, stopSequences: ['END'], topP: 0.9, seed: 7,
      tools: [{ type: 'function', name: 'list_tasks', inputSchema: {} }],
    } as any);
    expect(payload.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is in flight?\n[attachment: image/png, not sent to the local model]' },
      { role: 'assistant', content: 'Two tasks.' },
      { role: 'user', content: '[result of list_tasks] {"count":2}' },
    ]);
    expect(payload.options).toEqual({ temperature: 0.2, maxOutputTokens: 512, stop: ['END'], topP: 0.9, seed: 7 });
    expect(JSON.stringify(payload)).not.toContain('inputSchema');
  });
});

describe('localRunnerLanguageModel', () => {
  it('generate: one chat job for the team, the runner\'s text and usage back', async () => {
    const { m, jobs } = model(async () => ({
      ok: true, runnerId: RUNNER,
      result: { text: 'Two tasks are running.', finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 5 } },
    }));
    const out = await generateText({ model: m, prompt: 'what is in flight?' });
    expect(out.text).toBe('Two tasks are running.');
    expect(out.usage.inputTokens).toBe(12);
    expect(out.usage.outputTokens).toBe(5);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ teamId: TEAM, workspaceId: 'ws-1', kind: 'chat', surface: 'chat', model: 'llama3.1:8b' });
    expect(jobs[0].payload.messages.at(-1)).toEqual({ role: 'user', content: 'what is in flight?' });
  });

  it('stream: partial text is forwarded as it arrives and the rest on the result, with no text repeated', async () => {
    const { m } = model(async (input) => {
      input.onPartialText('Two ');
      input.onPartialText('tasks');
      return { ok: true, runnerId: RUNNER, result: { text: 'Two tasks are running.', finishReason: 'stop', partialText: 'Two tasks' } };
    });
    const result = streamText({ model: m, prompt: 'hi' });
    const chunks: string[] = [];
    for await (const delta of result.textStream) chunks.push(delta);
    expect(chunks).toEqual(['Two ', 'tasks', ' are running.']);
    expect(await result.finishReason).toBe('stop');
  });

  it('stream: a result that does not extend the partial text is sent whole only when nothing was forwarded', async () => {
    const { m } = model(async () => ({ ok: true, runnerId: RUNNER, result: { text: 'Hello.', finishReason: 'length' } }));
    const result = streamText({ model: m, prompt: 'hi' });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('Hello.');
    expect(await result.finishReason).toBe('length');
  });

  it('generate: a relay failure is a typed LocalRunnerUnavailableError naming the runner and the reason', async () => {
    const { m } = model(async () => ({ ok: false, code: 'ollama_error', message: 'model requires more system memory', runnerId: RUNNER }));
    let caught: unknown;
    try { await generateText({ model: m, prompt: 'hi', maxRetries: 0 }); } catch (err) { caught = err; }
    const cause = isLocalRunnerUnavailable(caught);
    expect(cause).toBeInstanceOf(LocalRunnerUnavailableError);
    expect(cause).toMatchObject({ code: 'ollama_error', runnerId: RUNNER, reason: 'model requires more system memory' });
  });

  it('stream: a relay failure surfaces as the typed error, never as text', async () => {
    const { m } = model(async () => ({ ok: false, code: 'runner_offline', message: 'no runner answered before the deadline', runnerId: RUNNER }));
    const errors: unknown[] = [];
    const result = streamText({ model: m, prompt: 'hi', maxRetries: 0, onError: ({ error }) => { errors.push(error); } });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('');
    expect(isLocalRunnerUnavailable(errors[0])).toMatchObject({ code: 'runner_offline', runnerId: RUNNER });
  });

  it('a relay that throws is the same typed error', async () => {
    const { m } = model(async () => { throw new Error('boom'); });
    let caught: unknown;
    try { await generateText({ model: m, prompt: 'hi', maxRetries: 0 }); } catch (err) { caught = err; }
    expect(isLocalRunnerUnavailable(caught)).toMatchObject({ code: 'runner_offline' });
  });
});
