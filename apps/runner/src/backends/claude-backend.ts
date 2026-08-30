import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OutputFormat } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, RunStreamedOpts, BackendEvent } from './types.js';

export interface ClaudeBackendConfig {
  /** Pre-built query options from workers.ts (excludes sessionId, cwd, model, maxTurns, env — those come from RunStreamedOpts) */
  options: Record<string, unknown>;
  /** Multi-turn input stream (ralph loop, user responses, nudges) */
  inputStream: AsyncIterable<unknown>;
  /** Called once with queryInstance immediately after query() is created */
  onInit?: (queryInstance: ReturnType<typeof query>) => void;
}

export class ClaudeBackend implements AgentBackend {
  /** The raw SDK query instance — available after runStreamed() starts iterating */
  queryInstance: ReturnType<typeof query> | null = null;

  constructor(private config: ClaudeBackendConfig) {}

  async *runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent> {
    const isResume = Boolean(this.config.options.resume);

    // 'json_schema' is the SDK's only OutputFormatType. Its transport does
    // `type === 'json_schema' ? schema : undefined`, so any other type string
    // drops the schema silently: no structured output is requested and
    // result.structured_output is never populated. Nothing fails loudly — the
    // agent just answers in prose, and a reviewer verdict returned as prose is
    // discarded by handleReviewerOutcomeIfNeeded, leaving the PR unmerged.
    // Typed as OutputFormat (not inlined into the Record<string, unknown>
    // literal below) so a wrong type string is a compile error, not a silent
    // behaviour change.
    const outputFormat: OutputFormat | undefined = opts.outputSchema
      ? { type: 'json_schema', schema: opts.outputSchema }
      : undefined;

    const queryOptions: Record<string, unknown> = {
      ...this.config.options,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      // Only override when this run carries an explicit schema — workers.ts
      // already put resolveOutputFormat(task) in config.options, which is how
      // planning tasks get the implicit planning schema.
      ...(outputFormat ? { outputFormat } : {}),
    };

    // The CLI rejects --session-id alongside --resume unless --fork-session is also set.
    // For resume sessions the existing session is identified by `resume` alone; omit sessionId.
    // For fresh sessions, pin the session UUID to the buildd worker id for correlation.
    if (isResume) {
      delete queryOptions.sessionId;
    } else {
      queryOptions.sessionId = opts.sessionId;
    }

    const queryInstance = query({
      prompt: opts.prompt as Parameters<typeof query>[0]['prompt'],
      options: queryOptions as Parameters<typeof query>[0]['options'],
    });

    this.queryInstance = queryInstance;

    // Connect multi-turn input stream (allows ralph loop and user responses)
    queryInstance.streamInput(this.config.inputStream as any);

    // Notify caller with the query instance so they can set up discovery/rewindFiles
    this.config.onInit?.(queryInstance);

    let lastSummary = '';
    let lastStructuredOutput: unknown;

    for await (const msg of queryInstance) {
      // Pass raw SDK messages to the progress handler for detailed tracking
      // (tool calls, milestones, rate limits, file checkpoints, etc.)
      await opts.onProgress?.(msg);

      const msgAny = msg as any;

      if (msg.type === 'assistant') {
        const content = msgAny.message?.content || [];
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            lastSummary = block.text.trim();
            yield { type: 'progress', message: lastSummary };
          }
        }
      } else if (msg.type === 'result') {
        if (msgAny.structured_output && typeof msgAny.structured_output === 'object') {
          lastStructuredOutput = msgAny.structured_output;
        }

        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        if (msgAny.usage) {
          inputTokens = (msgAny.usage.input_tokens ?? 0) + (msgAny.usage.cache_read_input_tokens ?? 0);
          outputTokens = msgAny.usage.output_tokens ?? 0;
        }

        yield {
          type: 'turn_complete',
          ...(inputTokens !== undefined ? { usage: { inputTokens, outputTokens: outputTokens ?? 0 } } : {}),
          ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
        };
      }
    }

    yield {
      type: 'complete',
      summary: lastSummary,
      ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
    };
  }
}
