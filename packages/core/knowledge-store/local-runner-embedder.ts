// An Embedder over the relay queue: the team's own runner computes the vectors
// against its loopback model server and posts them back. Spec:
// docs/specs/local-runner-provider.md (section 7.1).
//
// There is no URL and no key here, and no other provider behind it. Every
// failure (runner offline, model gone, deadline passed, a vector of the wrong
// size) makes `embed` return null: the write stores lexical-only rows and the
// query runs lexical-only, the same contract as a spend-guard denial. It never
// throws and never calls Voyage, OpenRouter, OpenAI or a gateway.

import { isRelayErrorCode, type RelayEmbedResult } from '@buildd/shared';
import type { Embedder, EmbedInputType } from './types';
import { estimateEmbedTokens, planEmbedRequests } from './voyage-embedder';
import { getVoyageGuard, type VoyageCall, type VoyageGuard } from './voyage-guard';
import type { RunRelayJobInput, RunRelayJobOutcome } from '../model-relay/runner';

/** Inputs per relay job: what `planEmbedRequests` produces for an endpoint (spec §3.1). */
export const RELAY_EMBED_MAX_BATCH = 32;
export const RELAY_EMBED_MAX_TOKENS = 16_000;

/** The caller name a re-embed walk embeds under; such jobs queue behind live work. */
export const REEMBED_CALLER = 'reembed';

export interface LocalRunnerEmbedderOptions {
  teamId: string;
  /** The namespace owner's workspace, for attribution. Null for a team-wide namespace. */
  workspaceId: string | null;
  /** The pinned runner at resolution time; named in warnings. The relay re-reads the pick per job. */
  runnerId: string;
  model: string;
  /** The model's size as the runner advertised it: the namespace's column. */
  dimensions: number;
  /** How long each job may wait; absent, the relay's default for the surface. */
  deadlineMs?: number;
  guard?: VoyageGuard;
  /** Test seam; default `runRelayJob`. */
  run?: (input: RunRelayJobInput) => Promise<RunRelayJobOutcome>;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  if (warned.size >= 200) warned.clear();
  warned.add(key);
  console.warn(message);
}

export class LocalRunnerEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly provider = 'local_runner' as const;

  constructor(private readonly opts: LocalRunnerEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
  }

  async embed(texts: string[], inputType: EmbedInputType, call: VoyageCall): Promise<number[][] | null> {
    if (texts.length === 0) return [];

    let permit;
    try {
      permit = await (this.opts.guard ?? getVoyageGuard()).admit({
        ...call, kind: 'embed', model: this.model, inputType,
        estimatedTokens: texts.reduce((sum, t) => sum + estimateEmbedTokens(t), 0),
        provider: 'local_runner', unmetered: true,
      });
    } catch (err) {
      console.warn('[local-runner-embedder] guard failed:', err);
      return null;
    }
    if (!permit) return null;

    const surface = inputType === 'query' ? 'query' : call.caller === REEMBED_CALLER ? 'reembed' : 'ingest';
    let tokens = 0;
    try {
      const run = this.opts.run ?? (await import('../model-relay/runner')).runRelayJob;
      const out: number[][] = new Array(texts.length);
      for (const indexes of planEmbedRequests(texts, RELAY_EMBED_MAX_TOKENS, RELAY_EMBED_MAX_BATCH)) {
        const inputs = indexes.map(i => texts[i]);
        const res = await run({
          teamId: this.opts.teamId, workspaceId: this.opts.workspaceId, kind: 'embed', surface,
          namespace: call.namespace, model: this.model,
          payload: { inputs, inputType, dimensions: this.dimensions },
          ...(this.opts.deadlineMs ? { deadlineMs: this.opts.deadlineMs } : {}),
        });
        if (!res.ok) {
          const code = isRelayErrorCode(res.code) ? res.code : 'runner_offline';
          warnOnce(
            `${res.runnerId ?? this.opts.runnerId}:${this.model}:${code}`,
            `[local-runner-embedder] runner ${res.runnerId ?? this.opts.runnerId} did not embed with ${this.model} (${code}: ${res.message}); ${call.namespace} goes lexical-only. No other provider is used.`,
          );
          return null;
        }
        const result = res.result as RelayEmbedResult;
        const vectors = Array.isArray(result?.vectors) ? result.vectors : [];
        // The store validated the result against the job; checked again here
        // because a vector of another size must never reach a column.
        if (vectors.length !== inputs.length || vectors.some(v => !Array.isArray(v) || v.length !== this.dimensions)) {
          warnOnce(
            `${this.opts.runnerId}:${this.model}:dimension_mismatch`,
            `[local-runner-embedder] dimension_mismatch: ${this.model} did not return ${inputs.length} vectors of ${this.dimensions}; ${call.namespace} goes lexical-only.`,
          );
          return null;
        }
        indexes.forEach((textIndex, j) => { out[textIndex] = vectors[j]; });
        tokens += typeof result.promptTokens === 'number' && result.promptTokens > 0 ? result.promptTokens : 0;
      }
      return out;
    } catch (err) {
      console.warn('[local-runner-embedder] relay failed; going lexical-only:', err instanceof Error ? err.message : err);
      tokens = 0;
      return null;
    } finally {
      permit.settle(tokens);
    }
  }
}
