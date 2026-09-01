import { getModelDisplayName, primaryModelFromUsage } from '@buildd/core/model-display';

export interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

interface Props {
  /** `result_meta.modelUsage` — the highest-truth record of what actually ran. */
  modelUsage: Record<string, ModelUsageEntry | null> | null | undefined;
  /** The tier this task was assigned, so assigned and actual can be read together. */
  tierLabel?: string | null;
  durationMs?: number | null;
  durationApiMs?: number | null;
  terminalReason?: string | null;
  stopReason?: string | null;
}

/**
 * Per-model usage for one worker.
 *
 * Empty is a real answer, not a zero: on seat/OAuth auth the SDK attributes no
 * per-model usage at all, so the panel disappears rather than claiming 0 tokens.
 * When several models ran the count is stated — a fallback or a delegated
 * subagent is a real event, and a list of two rows under a singular heading
 * reads like one model.
 */
export default function ModelUsagePanel({
  modelUsage,
  tierLabel,
  durationMs,
  durationApiMs,
  terminalReason,
  stopReason,
}: Props) {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return null;

  const { multiple, all } = primaryModelFromUsage(modelUsage);
  const total = durationMs ?? 0;
  const api = durationApiMs ?? 0;

  return (
    <div className="mt-3 p-3 bg-surface-3 rounded-[8px] border border-border-default/50">
      <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted mb-2">
        {tierLabel ? `${tierLabel} · ` : ''}Model Usage
        {multiple ? ` · ${all.length} models` : ''}
      </div>
      <div className="space-y-1.5">
        {entries.map(([model, usage]) => {
          if (!usage || typeof usage !== 'object') return null;
          const inp = usage.inputTokens || 0;
          const cached = usage.cacheReadInputTokens || 0;
          const out = usage.outputTokens || 0;
          const cost = usage.costUSD || 0;
          return (
            <div key={model} className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-text-secondary">{getModelDisplayName(model)}</span>
              <div className="flex items-center gap-3 text-text-muted">
                <span>{((inp + cached) / 1000).toFixed(0)}k in</span>
                <span>{(out / 1000).toFixed(0)}k out</span>
                {cached > 0 && (
                  <span className="text-status-success">{(cached / 1000).toFixed(0)}k cached</span>
                )}
                {cost > 0 && <span>${cost.toFixed(4)}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {(total > 0 || api > 0) && (
        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border-default/30 font-mono text-[10px] text-text-muted">
          {total > 0 && <span>Total: {(total / 1000).toFixed(0)}s</span>}
          {api > 0 && <span>API: {(api / 1000).toFixed(0)}s</span>}
          {terminalReason && terminalReason !== 'completed' && (
            <span className="text-status-warning">Stop: {terminalReason.replace(/_/g, ' ')}</span>
          )}
          {!terminalReason && stopReason && stopReason !== 'end_turn' && (
            <span className="text-status-warning">Stop: {stopReason}</span>
          )}
        </div>
      )}
    </div>
  );
}
