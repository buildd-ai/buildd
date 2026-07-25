import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentBackend, RunStreamedOpts, BackendEvent } from './types.js';
import { mapCodexEventToSdkMessages } from './codex-events.js';

export interface CodexBackendConfig {
  /** Path to CODEX_HOME directory for auth.json (overrides env var) */
  codexHome?: string;
  /**
   * Multi-turn input stream (Phase 1B). When provided, the backend runs the
   * initial prompt then parks on `inputStream.next()` between turns: each
   * message that arrives (a Claude-shaped SDKUserMessage) is run as another
   * turn on the SAME persistent Codex `Thread`; when the stream ends the
   * backend yields `complete`. This is how workers.ts's review/nudge/steering
   * enqueues reach Codex, mirroring the Claude path's `streamInput`.
   */
  inputStream?: AsyncIterable<unknown>;
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
    const sandbox = this.mapSandboxMode(opts.sandboxMode, opts.bwrapSupported ?? true);
    const prompt = await this.resolvePrompt(opts.prompt);
    const modelId = opts.model || 'codex';
    const signal = opts.signal;
    // Allow pointing at a specific `codex` binary (CODEX_PATH_OVERRIDE) instead of
    // the one bundled with @openai/codex-sdk. The bundled binary's version gates
    // which models are accepted; a host with a newer codex CLI can run newer
    // account models (e.g. gpt-5.5) that the bundled binary rejects.
    const codexPathOverride = opts.env?.CODEX_PATH_OVERRIDE || process.env.CODEX_PATH_OVERRIDE;
    const codex = new Codex({
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      workingDirectory: opts.cwd,
      ...(opts.env?.OPENAI_BASE_URL ? { baseUrl: opts.env.OPENAI_BASE_URL } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
    });
    const threadOpts = {
      workingDirectory: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      sandboxMode: sandbox,
      skipGitRepoCheck: true,
    };
    // Phase 1C / R5: a follow-up resumes the prior Codex thread by id (located
    // against the stable per-worker CODEX_HOME). Otherwise start a fresh thread.
    const thread = opts.resumeThreadId
      ? codex.resumeThread(opts.resumeThreadId, threadOpts)
      : codex.startThread(threadOpts);

    const spawnEnv = auth.codexHome
      ? { ...(opts.env || {}), CODEX_HOME: auth.codexHome }
      : opts.env;

    // Usage/cost accumulate ACROSS turns so the synthetic `result` (R4) is
    // emitted exactly once at the end with aggregate totals — never per turn,
    // or worker.resultMeta would over-count.
    let lastSummary = '';
    let lastStructuredOutput: unknown;
    let turnCount = 0;
    let totalCostUsd = 0;
    let threadId: string | undefined;
    const modelUsage = new Map<string, UsageTotals>();

    // R3: if the caller already aborted before we start, run nothing.
    if (signal?.aborted) {
      return;
    }

    // Multi-turn loop (Phase 1B). The first iteration runs the initial prompt.
    // After each turn completes we park on the input-stream iterator: a message
    // drives another turn on the SAME thread; stream-end (or no stream) yields
    // `complete` and returns. workers.ts breaking the consuming `for await`
    // (DONE gate / error / exhausted) triggers THIS generator's implicit
    // `.return()`, unwinding even while parked on `it.next()` (R6) — and on the
    // first turn the SDK's own generator `finally` then kills `codex exec`.
    const it = this.config.inputStream?.[Symbol.asyncIterator]();
    let prompt_ = prompt;

    // Phase 3A — structured-output repair. The Codex SDK has no schema param, so
    // we JSON.parse + (lightly) validate the agent's final text. When a schema is
    // expected but the output fails to parse/validate, we self-drive a bounded
    // number of repair turns asking the agent to re-emit valid JSON.
    const MAX_REPAIR_ATTEMPTS = 2;
    let repairAttempts = 0;

    while (true) {
      const streamed = await thread.runStreamed(prompt_);
      const events = this.withInitialSpawnEnv(streamed.events as AsyncIterable<unknown>, spawnEnv);

      // Track whether THIS turn ended via turn.completed (vs. abort/stream-end)
      // so we only consult the input stream after a real turn boundary.
      let turnCompleted = false;

      for await (const event of events) {
        // R3: stop consuming events the moment we're aborted. Breaking the
        // `for await` closes the SDK event generator, whose `finally` calls
        // child.kill() on the spawned `codex exec` process.
        if (signal?.aborted) {
          return;
        }

        const eventAny = event as any;

        // Capture the thread id so the adapter can stamp the synthetic init.
        if (eventAny.type === 'thread.started' && typeof eventAny.thread_id === 'string') {
          threadId = eventAny.thread_id;
        }

        // Channel 2: translate the Codex event into Claude-shaped SDKMessages
        // and feed each into handleMessage (via onProgress). This drives all
        // rich worker-state tracking (toolCalls, commits, milestones, loop
        // detection, MCP-failure tracking, the PR/artifact output-requirement
        // gate, error traces, and R1's worker.lastAssistantMessage).
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
            // branch pushes agent_message text to worker.output (via the
            // channel-2 adapter above). A channel-1 `progress` for the same
            // agent_message would double-write, so skip it. Other item types
            // map to tool_use, not output lines — keep their live progress.
            if (item.type !== 'agent_message') {
              yield { type: 'progress', message: message.slice(0, 200) };
            }
          }
        }

        if (eventAny.type === 'turn.completed') {
          turnCount++;
          turnCompleted = true;
          const usage = eventAny.usage;
          let inputTokens: number | undefined;
          let outputTokens: number | undefined;
          if (usage) {
            inputTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
            // Reasoning tokens (confirmed live, codex-cli 0.140) bill as OUTPUT
            // but arrive in a separate `reasoning_output_tokens` field that the
            // estimator previously ignored — under-counting cost. Fold them in.
            outputTokens = (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);
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

          // The event stream for a turn typically ends right after
          // turn.completed. Stop draining and decide on the next turn below.
          break;
        }
      }

      // Aborted while draining (signal flipped after the inner break check, or
      // the stream ended without turn.completed under abort): stop, no result.
      if (signal?.aborted) {
        return;
      }

      // Phase 3A — structured-output repair. If a schema was requested but the
      // turn's output didn't parse/validate, self-drive a bounded repair turn
      // (independent of the external review/nudge inputStream) before completing.
      if (
        turnCompleted &&
        opts.outputSchema &&
        lastStructuredOutput === undefined &&
        repairAttempts < MAX_REPAIR_ATTEMPTS
      ) {
        repairAttempts++;
        prompt_ = this.buildRepairPrompt(opts.outputSchema);
        continue;
      }

      // No multi-turn input stream → single-shot semantics: complete now.
      // Also: if the turn did NOT complete (stream ended early / no usage),
      // there's nothing to continue from, so complete.
      if (!it || !turnCompleted) {
        break;
      }

      // R6: park here until workers.ts enqueues a review/nudge/steering message
      // (drives another turn) or ends the stream (we complete). If workers.ts
      // has already `break`ed its consuming loop, the runtime calls this
      // generator's `.return()` and execution unwinds from this await — it does
      // NOT resume past it — so no `complete` leaks out after an early break.
      const next = await it.next();
      if (next.done) {
        break;
      }
      // Aborted while parked.
      if (signal?.aborted) {
        return;
      }
      prompt_ = this.extractPromptText(next.value);
    }

    // Final completion: emit the synthetic `result` exactly once (R4) with
    // aggregate usage, then yield `complete` (the only place we do so).
    await opts.onProgress?.(this.resultEvent('success', modelUsage, turnCount, totalCostUsd));
    yield {
      type: 'complete',
      summary: lastSummary,
      ...(lastStructuredOutput !== undefined ? { structuredOutput: lastStructuredOutput } : {}),
    };
  }

  /**
   * Extract plain text from an input-stream message. workers.ts enqueues
   * Claude-shaped SDKUserMessages (`{ type:'user', message:{ content:[{type:'text',text}] } }`);
   * Codex `Input` is a plain string, so we flatten text blocks. Falls back to
   * common shapes and finally to `String(value)` so an unexpected payload still
   * drives a turn rather than throwing.
   */
  private extractPromptText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return String(value ?? '');
    const v = value as any;
    const content = v.message?.content ?? v.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b: any) => String(b.text ?? ''))
        .join('\n')
        .trim();
      if (text) return text;
    }
    if (typeof v.text === 'string') return v.text;
    return '';
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

  private mapSandboxMode(mode?: 'read-only' | 'workspace-write', bwrapSupported = true): string {
    if (mode === 'read-only') return 'read-only';
    if (!bwrapSupported) {
      console.warn(
        '[CodexBackend] bwrap user namespaces unavailable — workspace-write sandbox cannot start. ' +
        'Falling back to danger-full-access (write isolation reduced). ' +
        'To restore full sandboxing, run the runner container with: --security-opt seccomp=unconfined',
      );
      return 'danger-full-access';
    }
    return 'workspace-write';
  }

  private async resolvePrompt(prompt: string | AsyncIterable<unknown>): Promise<string> {
    if (typeof prompt === 'string') return prompt;
    // Phase 3B — images/multimodal are unsupported by design: the Codex SDK's
    // turn input is `Input = string` (codex-sdk 0.44, no image/content-block
    // input). Tasks with image attachments arrive here as a non-text prompt;
    // route them to the Claude backend instead. This is a non-goal until the
    // Codex SDK adds multimodal input.
    throw new Error(
      'Codex backend does not support image or other non-text prompts (codex-sdk 0.44 accepts only a text string). Route image-attachment tasks to the Claude backend.',
    );
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Tolerate prose around the JSON (e.g. ```json fences) by extracting the
      // first balanced object/array, then re-parsing.
      const extracted = this.extractJsonCandidate(text);
      if (extracted === undefined) return undefined;
      try {
        parsed = JSON.parse(extracted);
      } catch {
        return undefined;
      }
    }
    // Lightweight schema validation (Phase 3A): the SDK gives us a JSON Schema,
    // not a zod schema, and a full JSON-Schema→zod conversion is out of scope.
    // We check the load-bearing constraints (top-level `type` + `required`) so a
    // syntactically-valid-but-wrong-shape payload still triggers a repair turn.
    if (!this.validateAgainstSchema(parsed, outputSchema)) return undefined;
    return parsed;
  }

  /** Extract the first balanced top-level {…} or […] from free-form text. */
  private extractJsonCandidate(text: string): string | undefined {
    for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
      const start = text.indexOf(open);
      if (start === -1) continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    return undefined;
  }

  /** Minimal JSON-Schema check: top-level `type` and `required` keys only. */
  private validateAgainstSchema(value: unknown, schema: Record<string, unknown>): boolean {
    const type = schema.type;
    if (type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const required = schema.required;
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === 'string' && !(key in (value as Record<string, unknown>))) return false;
        }
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) return false;
    }
    return true;
  }

  /** Build the one-shot repair nudge sent when structured output fails (3A). */
  private buildRepairPrompt(outputSchema: Record<string, unknown>): string {
    return [
      'Your previous response did not contain valid JSON matching the required output schema.',
      'Respond now with ONLY the JSON value (no prose, no code fences) that conforms to this JSON Schema:',
      JSON.stringify(outputSchema),
    ].join('\n');
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
    try {
      const first = await this.withEnv(env, () => iterator.next());
      if (first.done) return;
      yield first.value;

      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
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
