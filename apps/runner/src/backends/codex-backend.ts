import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentBackend, RunStreamedOpts, BackendEvent } from './types.js';

export interface CodexBackendConfig {
  /** Path to CODEX_HOME directory for auth.json (overrides env var) */
  codexHome?: string;
}

export class CodexBackend implements AgentBackend {
  constructor(private config: CodexBackendConfig = {}) {}

  async *runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent> {
    // Dynamic import so missing package only errors on Codex tasks, not all tasks
    let codexSdk: any;
    try {
      codexSdk = await import('@openai/codex-sdk');
    } catch {
      throw new Error(
        '@openai/codex-sdk is not installed. Run: bun add @openai/codex-sdk',
      );
    }

    const apiKey = this.resolveApiKey(opts);
    const sandbox = this.mapSandboxMode(opts.sandboxMode);

    const codexOpts: Record<string, unknown> = {
      working_dir: opts.cwd,
      model: opts.model,
      sandbox,
      ...(opts.maxTurns !== undefined ? { max_turns: opts.maxTurns } : {}),
      ...(opts.outputSchema ? { output_schema: opts.outputSchema } : {}),
      api_key: apiKey,
    };

    const stream: AsyncIterable<unknown> = codexSdk.runStreamed
      ? await codexSdk.runStreamed(opts.prompt, codexOpts)
      : await codexSdk.default?.runStreamed(opts.prompt, codexOpts);

    if (!stream) {
      throw new Error('@openai/codex-sdk: runStreamed() not found in module exports');
    }

    let lastSummary = '';
    let lastStructuredOutput: unknown;

    for await (const item of stream) {
      await opts.onProgress?.(item);

      const itemAny = item as any;

      // item.completed: an individual tool/action completed
      if (itemAny.type === 'item.completed' || itemAny.event === 'item.completed') {
        const message = itemAny.content || itemAny.message || JSON.stringify(item);
        lastSummary = String(message).slice(0, 200);
        yield { type: 'progress', message: lastSummary };
      }

      // turn.completed: a full model turn completed
      if (itemAny.type === 'turn.completed' || itemAny.event === 'turn.completed') {
        const usage = itemAny.usage;
        if (itemAny.structured_output) {
          lastStructuredOutput = itemAny.structured_output;
        }
        yield {
          type: 'turn_complete',
          ...(usage
            ? {
                usage: {
                  inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
                  outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
                },
              }
            : {}),
          ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
        };
      }

      // session/run completed
      if (
        itemAny.type === 'session.completed' ||
        itemAny.type === 'run.completed' ||
        itemAny.event === 'done'
      ) {
        if (itemAny.output || itemAny.summary) {
          lastSummary = String(itemAny.output || itemAny.summary).slice(0, 500);
        }
        break;
      }
    }

    yield {
      type: 'complete',
      summary: lastSummary,
      ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
    };
  }

  private resolveApiKey(opts: RunStreamedOpts): string {
    // Priority 1: CODEX_HOME env var (from task env or process env)
    const codexHome =
      this.config.codexHome ||
      opts.env?.CODEX_HOME ||
      process.env.CODEX_HOME;

    if (codexHome) {
      const authPath = join(codexHome, 'auth.json');
      if (existsSync(authPath)) {
        try {
          const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
          if (auth.api_key || auth.apiKey) return auth.api_key || auth.apiKey;
        } catch {
          // Fall through to OPENAI_API_KEY
        }
      }
    }

    // Priority 2: OPENAI_API_KEY env var
    const apiKey = opts.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) return apiKey;

    throw new Error(
      'No Codex auth found. Set CODEX_HOME (pointing to a directory with auth.json) or OPENAI_API_KEY.',
    );
  }

  private mapSandboxMode(mode?: 'read-only' | 'workspace-write'): string {
    if (mode === 'read-only') return 'read-only';
    // 'workspace-write' or default
    return 'workspace-write';
  }
}
