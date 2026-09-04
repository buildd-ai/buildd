'use client';

import { useState, useEffect, useRef } from 'react';

/** Legacy alias → canonical tier */
const ALIAS_MAP: Record<string, string> = {
  opus: 'premium',
  sonnet: 'standard',
  haiku: 'budget',
};

const TIER_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'premium', label: 'Premium' },
  { value: 'standard', label: 'Standard' },
  { value: 'budget', label: 'Budget' },
] as const;

export const KNOWN_TIERS = new Set(['inherit', 'premium-plus', 'premium', 'standard', 'budget']);

/** Converts legacy alias values to their canonical tier. Pass-through for all other values. */
export function normalizeAlias(value: string): string {
  return ALIAS_MAP[value] ?? value;
}

/**
 * Returns true if the value is an exact model ID pin that is NOT found in the
 * live model list. Returns false for tier values and aliases.
 *
 * `catalogComplete` is load-bearing: /api/models returns the team's tier models
 * even with no credential, so a non-empty list is no longer evidence that the list
 * is exhaustive. Warning off a partial list would flag every legitimately pinned
 * release as retired.
 */
export function detectStalePin(
  value: string,
  liveModelIds: string[],
  catalogComplete = true,
): boolean {
  const normalized = normalizeAlias(value);
  if (KNOWN_TIERS.has(normalized)) return false;
  if (!catalogComplete) return false;
  if (liveModelIds.length === 0) return false;
  return !liveModelIds.includes(normalized);
}

interface ModelEntry {
  id: string;
  displayName: string;
}

/**
 * The server's audit of the TEAM's tier config against the live catalog — a
 * different question from `detectStalePin`, which is about a model *this user*
 * pinned. `checked: false` means the catalog was incomplete and nothing was
 * verified, so render nothing rather than a guess.
 */
interface TierAudit {
  checked: boolean;
  unknown: Array<{ tier: string; model: string }>;
  superseded: Array<{ tier: string; model: string; newer: string }>;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Tier-first model picker.
 *
 * Primary UI: Inherit / Premium / Standard / Budget radio buttons.
 * Advanced expander: fetches /api/models and lets users pin an exact model ID.
 * Backward compat: opus → premium, sonnet → standard, haiku → budget on mount.
 */
export function ModelPicker({ value, onChange, disabled = false }: Props) {
  const normalized = normalizeAlias(value);

  // Keep latest onChange in a ref so the effect closure is always fresh.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Normalize aliases on mount and whenever value changes to an alias.
  useEffect(() => {
    if (normalized !== value) {
      onChangeRef.current(normalized);
    }
  }, [value, normalized]);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [catalogComplete, setCatalogComplete] = useState(false);
  const [tierAudit, setTierAudit] = useState<TierAudit | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  useEffect(() => {
    if (!showAdvanced || modelsFetched) return;
    setModelsLoading(true);
    fetch('/api/models')
      .then(r => r.ok
        ? r.json() as Promise<{ models: ModelEntry[]; catalogComplete?: boolean; tierAudit?: TierAudit }>
        : Promise.resolve({ models: [], catalogComplete: false, tierAudit: undefined }))
      .then(data => {
        setModels(data.models ?? []);
        setCatalogComplete(data.catalogComplete === true);
        setTierAudit(data.tierAudit ?? null);
        setModelsFetched(true);
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, [showAdvanced, modelsFetched]);

  const isExactPin = !KNOWN_TIERS.has(normalized);
  const isStalePin = modelsFetched && detectStalePin(value, models.map(m => m.id), catalogComplete);

  return (
    <div className="space-y-1.5">
      {/* Primary: Tier selector */}
      <div className="flex gap-1" data-testid="model-tier-selector">
        {TIER_OPTIONS.map(tier => {
          const isSelected = normalized === tier.value;
          return (
            <button
              key={tier.value}
              type="button"
              disabled={disabled}
              data-tier={tier.value}
              data-selected={isSelected}
              onClick={() => onChange(tier.value)}
              className={`flex-1 px-2 py-1.5 text-[12px] font-medium rounded border transition-colors ${
                isSelected
                  ? 'bg-text-primary text-surface-1 border-text-primary'
                  : 'bg-surface-1 text-text-secondary border-border-default hover:text-text-primary hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {tier.label}
            </button>
          );
        })}
      </div>

      {/* Pinned model display (collapsed view) */}
      {isExactPin && !showAdvanced && (
        <div className="text-[11px] text-text-muted font-mono px-1 truncate" data-testid="pinned-label">
          Pinned: {normalized}
        </div>
      )}

      {/* Stale pin warning */}
      {isStalePin && (
        <div className="flex items-center gap-1.5 text-[11px] text-status-warning" data-testid="stale-pin-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Pinned model may be unavailable — will fall back to tier
        </div>
      )}

      {/* Team tier config vs. the live catalog. Only rendered when the server
          actually verified it (checked), so an unreadable catalog stays silent. */}
      {showAdvanced && tierAudit?.checked && tierAudit.unknown.map(u => (
        <div key={`unknown-${u.tier}`} className="text-[11px] text-status-warning" data-testid="tier-unknown-badge">
          The {u.tier} tier is set to {u.model}, which the models API no longer lists.
        </div>
      ))}
      {showAdvanced && tierAudit?.checked && tierAudit.superseded.map(sup => (
        <div key={`superseded-${sup.tier}`} className="text-[11px] text-text-muted" data-testid="tier-superseded-badge">
          The {sup.tier} tier is on {sup.model}; {sup.newer} is newer.
        </div>
      ))}

      {/* Advanced expander toggle */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
        data-testid="advanced-toggle"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        Pin exact model
      </button>

      {/* Advanced panel */}
      {showAdvanced && (
        <div className="mt-1 space-y-1.5" data-testid="advanced-panel">
          {modelsLoading && (
            <p className="text-[11px] text-text-muted">Loading models…</p>
          )}
          {!modelsLoading && modelsFetched && models.length === 0 && (
            <p className="text-[11px] text-text-muted">
              No models available yet — set this workspace&apos;s model tiers in Settings.
            </p>
          )}
          {models.length > 0 && (
            <div className="border border-border-default rounded-md overflow-hidden max-h-48 overflow-y-auto">
              {models.map(m => (
                <button
                  key={m.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(m.id)}
                  className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors border-b last:border-b-0 border-border-default ${
                    normalized === m.id
                      ? 'bg-surface-3 text-text-primary font-medium'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                >
                  <span className="block truncate">{m.displayName}</span>
                  <span className="block font-mono text-[10px] text-text-muted truncate">{m.id}</span>
                </button>
              ))}
            </div>
          )}
          {!modelsLoading && modelsFetched && models.length > 0 && !catalogComplete && (
            <p className="text-[11px] text-text-muted" data-testid="tier-only-hint">
              Showing your configured tiers. Connect an agent backend in Settings →
              Agent Backends to browse every model release.
            </p>
          )}
          <p className="text-[10px] text-text-muted">
            Pin to a specific model release. Falls back to tier if unavailable.
          </p>
        </div>
      )}
    </div>
  );
}
