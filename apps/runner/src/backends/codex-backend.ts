import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentBackend, RunStreamedOpts, BackendEvent } from './types.js';
import { mapCodexEventToSdkMessages } from './codex-events.js';

export interface CodexBackendConfig {
  /** Path to CODEX_HOME directory for auth.json (overrides env var) */
  codexHome?: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export class CodexBackend implements AgentBackend {
  constructor(private config: CodexBackendConfig = {}) {}

  async *runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent> {
    let codexSdk: any;
    try {
      codexSdk = await import('@openai/codex-sdk');
    } catch {
      throw new Error(
        '@openai/codex-sdk is not installed. Run: bun add @openai/codex-sdk',
      );
    }

    const Codex = codexSdk.Codex || codexSdk.default?.Codex;
    if (!Codex) {
      throw new Error('@openai/codex-sdk: Codex class not found in module exports');
    }

    const auth = this.resolveAuth(opts);
    const sandbox = this.mapSandboxMode(opts.sandboxMode);
    const prompt = await this.resolvePrompt(opts.prompt);
    const modelId = opts.model || 'codex';
    const codex = new Codex({
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      workingDirectory: opts.cwd,
      ...(opts.env?.OPENAI_BASE_URL ? { baseUrl: opts.env.OPENAI_BASE_URL } : {}),
    });
    const thread = codex.startThread({
      workingDirectory: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      sandboxMode: sandbox,
      skipGitRepoCheck: true,
    });

    const streamed = await thread.runStreamed(prompt);
    const spawnEnv = auth.codexHome
      ? { ...(opts.env || {}), CODEX_HOME: auth.codexHome }
      : opts.env;
    const events = this.withInitialSpawnEnv(streamed.events as AsyncIterable<unknown>, spawnEnv);
    let lastSummary = '';
    let lastStructuredOutput: unknown;
    let turnCount = 0;
    let totalCostUsd = 0;
    let threadId: string | undefined;
    const modelUsage = new Map<string, UsageTotals>();

    for await (const event of events) {
      const eventAny = event as any;

      // Capture the thread id so the adapter can stamp the synthetic init.
      if (eventAny.type === 'thread.started' && typeof eventAny.thread_id === 'string') {
        threadId = eventAny.thread_id;
      }

      // Channel 2: translate the Codex event into Claude-shaped SDKMessages and
      // feed each into handleMessage (via onProgress). This drives all rich
      // worker-state tracking (toolCalls, commits, milestones, loop detection,
      // MCP-failure tracking, the PR/artifact output-requirement gate, error
      // traces). Replaces the old raw `onProgress?.(event)` passthrough — the
      // raw Codex event shapes matched nothing in handleMessage.
      for (const sdkMsg of mapCodexEventToSdkMessages(event, { threadId })) {
        await opts.onProgress?.(sdkMsg);
      }

      if (eventAny.type === 'error') {
        yield { type: 'error', error: String(eventAny.message || 'Codex stream error') };
        return;
      }

      if (eventAny.type === 'turn.failed') {
        yield { type: 'error', error: String(eventAny.error?.message || 'Codex turn failed') };
        return;
      }

      if (eventAny.type === 'item.completed') {
        const item = eventAny.item || {};
        if (item.type === 'error') {
          yield { type: 'error', error: String(item.message || 'Codex item failed') };
          return;
        }

        const message = this.progressMessageForItem(item);
        if (message) {
          lastSummary = message.slice(0, 500);
          if (item.type === 'agent_message') {
            lastStructuredOutput = this.tryParseStructuredOutput(item.text, opts.outputSchema);
          }
          // R8 — dedupe worker.output writes. handleMessage's assistant-text
          // branch now pushes agent_message text to worker.output (via the
          // channel-2 adapter above). Yielding a channel-1 `progress` for the
          // same agent_message would double-write those lines, so skip it for
          // agent_message. Other item types (commands, file changes, etc.) keep
          // their live-progress yield — handleMessage maps those to tool_use,
          // not output lines, so there's no duplication.
          if (item.type !== 'agent_message') {
            yield { type: 'progress', message: message.slice(0, 200) };
          }
        }
      }

      if (eventAny.type === 'turn.completed') {
        turnCount++;
        const usage = eventAny.usage;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        if (usage) {
          inputTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
          outputTokens = usage.output_tokens ?? 0;
          const usageCost = this.estimateCostUsd(modelId, {
            inputTokens: usage.input_tokens ?? 0,
            cachedInputTokens: usage.cached_input_tokens ?? 0,
            outputTokens,
          }, opts.env);
          totalCostUsd += usageCost;
          const existing = modelUsage.get(modelId) || {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          };
          existing.inputTokens += usage.input_tokens ?? 0;
          existing.cacheReadInputTokens += usage.cached_input_tokens ?? 0;
          existing.outputTokens += outputTokens;
          existing.costUSD += usageCost;
          modelUsage.set(modelId, existing);
        }

        yield {
          type: 'turn_complete',
          ...(inputTokens !== undefined ? { usage: { inputTokens, outputTokens: outputTokens ?? 0 } } : {}),
          ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
        };

        if (auth.type !== 'oauth' && opts.maxBudgetUsd !== undefined && totalCostUsd > opts.maxBudgetUsd) {
          await opts.onProgress?.(this.resultEvent('error_max_budget_usd', modelUsage, turnCount, totalCostUsd));
          yield {
            type: 'error',
            error: `Budget limit exceeded (maxBudgetUsd): $${totalCostUsd.toFixed(4)} > $${opts.maxBudgetUsd.toFixed(4)}`,
          };
          return;
        }
      }
    }

    await opts.onProgress?.(this.resultEvent('success', modelUsage, turnCount, totalCostUsd));
    yield {
      type: 'complete',
      summary: lastSummary,
      ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
    };
  }

  private resolveAuth(opts: RunStreamedOpts): { apiKey?: string; codexHome?: string; type: 'api_key' | 'oauth' } {
    const codexHome =
      this.config.codexHome ||
      opts.env?.CODEX_HOME ||
      process.env.CODEX_HOME;

    if (codexHome) {
      const authPath = join(codexHome, 'auth.json');
      if (existsSync(authPath)) {
        try {
          const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
          const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
          if (tokens.api_key || tokens.apiKey) return { apiKey: tokens.api_key || tokens.apiKey, codexHome, type: 'api_key' };
          if (tokens.access_token) return { codexHome, type: 'oauth' };
          if (auth.api_key || auth.apiKey) return { apiKey: auth.api_key || auth.apiKey, codexHome, type: 'api_key' };
          if (auth.access_token) return { codexHome, type: 'oauth' };
        } catch {
        }
      }
    }

    const apiKey = opts.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) return { apiKey, type: 'api_key' };

    throw new Error(
      'No Codex auth found. Set CODEX_HOME (pointing to a directory with auth.json) or OPENAI_API_KEY.',
    );
  }

  private mapSandboxMode(mode?: 'read-only' | 'workspace-write'): string {
    if (mode === 'read-only') return 'read-only';
    return 'workspace-write';
  }

  private async resolvePrompt(prompt: string | AsyncIterable<unknown>): Promise<string> {
    if (typeof prompt === 'string') return prompt;
    throw new Error('Codex backend does not support non-text prompts yet.');
  }

  private progressMessageForItem(item: any): string {
    switch (item.type) {
      case 'agent_message':
        return String(item.text || '');
      case 'reasoning':
        return String(item.text || '');
      case 'command_execution':
        return item.command
          ? `${item.status || 'completed'}: ${item.command}`
          : String(item.aggregated_output || '');
      case 'file_change':
        return Array.isArray(item.changes)
          ? item.changes.map((change: any) => `${change.kind}: ${change.path}`).join(', ')
          : `file_change ${item.status || ''}`.trim();
      case 'mcp_tool_call':
        return `${item.status || 'completed'}: ${item.server || 'mcp'}.${item.tool || 'tool'}`;
      case 'web_search':
        return `web_search: ${item.query || ''}`.trim();
      case 'todo_list':
        return Array.isArray(item.items)
          ? item.items.map((todo: any) => `${todo.completed ? '✓' : '•'} ${todo.text}`).join('\n')
          : '';
      default:
        return '';
    }
  }

  private tryParseStructuredOutput(text: unknown, outputSchema?: Record<string, unknown>): unknown {
    if (!outputSchema || typeof text !== 'string') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private resultEvent(
    subtype: 'success' | 'error_max_budget_usd',
    modelUsage: Map<string, UsageTotals>,
    turnCount: number,
    totalCostUsd: number,
  ): Record<string, unknown> {
    return {
      type: 'result',
      subtype,
      stop_reason: subtype === 'success' ? 'end_turn' : 'max_budget_usd',
      total_cost_usd: totalCostUsd,
      num_turns: turnCount,
      usage: {
        byModel: Object.fromEntries(modelUsage),
      },
    };
  }

  private estimateCostUsd(
    modelId: string,
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
    env?: Record<string, string>,
  ): number {
    const prices = this.priceForModel(modelId, env);
    return (
      usage.inputTokens * prices.input +
      usage.cachedInputTokens * prices.cachedInput +
      usage.outputTokens * prices.output
    ) / 1_000_000;
  }

  private priceForModel(modelId: string, env?: Record<string, string>): { input: number; cachedInput: number; output: number } {
    const override = {
      input: this.numberEnv('CODEX_INPUT_USD_PER_M_TOKENS', env),
      cachedInput: this.numberEnv('CODEX_CACHED_INPUT_USD_PER_M_TOKENS', env),
      output: this.numberEnv('CODEX_OUTPUT_USD_PER_M_TOKENS', env),
    };
    if (override.input !== undefined && override.cachedInput !== undefined && override.output !== undefined) {
      return override as { input: number; cachedInput: number; output: number };
    }

    const id = modelId.toLowerCase();
    if (id.includes('mini') || id.includes('nano')) return { input: 0.75, cachedInput: 0.075, output: 4.5 };
    if (id.includes('5.5')) return { input: 5, cachedInput: 0.5, output: 30 };
    if (id.includes('5.4')) return { input: 2.5, cachedInput: 0.25, output: 15 };
    return { input: 1.25, cachedInput: 0.125, output: 10 };
  }

  private numberEnv(name: string, env?: Record<string, string>): number | undefined {
    const raw = env?.[name] || process.env[name];
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  private async *withInitialSpawnEnv<T>(events: AsyncIterable<T>, env?: Record<string, string>): AsyncIterable<T> {
    if (!env) {
      yield* events;
      return;
    }

    const iterator = events[Symbol.asyncIterator]();
    const first = await this.withEnv(env, () => iterator.next());
    if (first.done) return;
    yield first.value;

    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  private async withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
