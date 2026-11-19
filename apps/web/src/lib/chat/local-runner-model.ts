/**
 * The chat model of a `local_runner` assignment
 * (docs/specs/local-runner-provider.md §7.2): an AI SDK language model whose
 * calls enqueue one `chat` relay job for the team's pinned runner and wait for
 * it. Text the runner reports while it generates is forwarded to the stream as
 * it appears; the provider contract itself is non-streaming.
 *
 * It holds no key and no URL. A relay failure is a `LocalRunnerUnavailableError`
 * and nothing else: there is no other provider behind this model, and none may
 * be added (a team that chose its own runner is never billed by another one).
 * Tools are not sent in this release, so a local turn answers in text.
 */
import type { LanguageModel } from 'ai';
import type { RelayChatPayload, RelayChatResult, RelayErrorCode } from '@buildd/shared';
import { runRelayJob, type RunRelayJobInput, type RunRelayJobOutcome } from '@buildd/core/model-relay';

export class LocalRunnerUnavailableError extends Error {
  readonly isLocalRunnerUnavailable = true;
  constructor(readonly code: RelayErrorCode, readonly reason: string, readonly runnerId: string | null) {
    super(`local_runner_unavailable (${code}): ${reason}`);
    this.name = 'LocalRunnerUnavailableError';
  }
}

/** The typed relay failure inside an error the AI SDK may have wrapped, or null. */
export function isLocalRunnerUnavailable(err: unknown): LocalRunnerUnavailableError | null {
  for (let e = err, depth = 0; e && depth < 6; depth++) {
    if (e instanceof LocalRunnerUnavailableError || (e as { isLocalRunnerUnavailable?: unknown }).isLocalRunnerUnavailable === true) {
      return e as LocalRunnerUnavailableError;
    }
    const next = (e as { cause?: unknown; lastError?: unknown; error?: unknown });
    e = next.cause ?? next.lastError ?? next.error;
  }
  return null;
}

// The slice of the AI SDK's v4 provider contract this model uses. The types
// live in a package the app does not depend on directly; the shapes are checked
// by the tests that drive this model through `generateText` and `streamText`.
type PromptPart = { type: string; text?: string; mediaType?: string; toolName?: string; output?: { type?: string; value?: unknown } };
type PromptMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | PromptPart[] };
interface CallOptions {
  prompt: PromptMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  seed?: number;
}
type StreamPart =
  | { type: 'stream-start'; warnings: unknown[] }
  | { type: 'text-start' | 'text-end'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'finish'; usage: ReturnType<typeof usageOf>; finishReason: ReturnType<typeof finishOf> }
  | { type: 'error'; error: unknown };

const TOOL_RESULT_MAX = 4_000;

function partText(part: PromptPart): string | null {
  switch (part.type) {
    case 'text': return part.text ?? '';
    case 'file': return `\n[attachment: ${part.mediaType ?? 'file'}, not sent to the local model]`;
    case 'tool-result': {
      const value = part.output?.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return `[result of ${part.toolName ?? 'a tool'}] ${text.slice(0, TOOL_RESULT_MAX)}`;
    }
    // Reasoning and tool calls of earlier turns are not text the local model can use.
    default: return null;
  }
}

/** The turn as the runner's model server takes it: role + text messages and sampling options. No tools. */
export function relayChatPayload(options: CallOptions): RelayChatPayload {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  for (const m of options.prompt) {
    const content = typeof m.content === 'string'
      ? m.content
      : m.content.map(partText).filter((t): t is string => t !== null).join('');
    if (!content) continue;
    // A tool result reaches the model as a user turn: it has no tool role to answer.
    messages.push({ role: m.role === 'tool' ? 'user' : m.role, content });
  }
  const opts: Record<string, unknown> = {};
  if (options.temperature !== undefined) opts.temperature = options.temperature;
  if (options.maxOutputTokens !== undefined) opts.maxOutputTokens = options.maxOutputTokens;
  if (options.stopSequences?.length) opts.stop = options.stopSequences;
  if (options.topP !== undefined) opts.topP = options.topP;
  if (options.topK !== undefined) opts.topK = options.topK;
  if (options.seed !== undefined) opts.seed = options.seed;
  return { messages, options: opts };
}

const FINISH = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']);
function finishOf(raw: unknown) {
  const reason = typeof raw === 'string' ? raw : undefined;
  return { unified: (reason && FINISH.has(reason) ? reason : 'other') as 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other', raw: reason };
}

function usageOf(result: RelayChatResult) {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = n(result.usage?.promptTokens);
  const output = n(result.usage?.completionTokens);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

export interface LocalRunnerModelOptions {
  teamId: string;
  workspaceId: string | null;
  /** The model tag chat relays to (`teams.local_runner.chatModel`). */
  modelId: string;
  /** Test seam; default `runRelayJob`. */
  run?: (input: RunRelayJobInput) => Promise<RunRelayJobOutcome>;
}

export function localRunnerLanguageModel(opts: LocalRunnerModelOptions): LanguageModel {
  const run = async (options: CallOptions, onPartialText?: (delta: string) => void): Promise<RelayChatResult> => {
    let out: RunRelayJobOutcome;
    try {
      out = await (opts.run ?? runRelayJob)({
        teamId: opts.teamId, workspaceId: opts.workspaceId, kind: 'chat', surface: 'chat', model: opts.modelId,
        payload: relayChatPayload(options), onPartialText,
      });
    } catch (err) {
      throw new LocalRunnerUnavailableError('runner_offline', err instanceof Error ? err.message : String(err), null);
    }
    if (!out.ok) throw new LocalRunnerUnavailableError(out.code, out.message, out.runnerId);
    return out.result as RelayChatResult;
  };

  const model = {
    specificationVersion: 'v4' as const,
    provider: 'local_runner',
    modelId: opts.modelId,
    supportedUrls: {},

    async doGenerate(options: CallOptions) {
      const result = await run(options);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        finishReason: finishOf(result.finishReason),
        usage: usageOf(result),
        warnings: [],
      };
    },

    async doStream(options: CallOptions) {
      const id = 'local-runner-text';
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          let sent = '';
          let open = false;
          const send = (delta: string) => {
            if (!delta) return;
            if (!open) { controller.enqueue({ type: 'text-start', id }); open = true; }
            controller.enqueue({ type: 'text-delta', id, delta });
            sent += delta;
          };
          run(options, send).then(result => {
            // The result holds the whole text; send only what the progress posts did not.
            if (result.text.startsWith(sent)) send(result.text.slice(sent.length));
            else if (!sent) send(result.text);
            if (open) controller.enqueue({ type: 'text-end', id });
            controller.enqueue({ type: 'finish', usage: usageOf(result), finishReason: finishOf(result.finishReason) });
            controller.close();
          }, error => {
            if (open) controller.enqueue({ type: 'text-end', id });
            controller.enqueue({ type: 'error', error });
            controller.close();
          });
        },
      });
      return { stream };
    },
  };
  return model as unknown as LanguageModel;
}
