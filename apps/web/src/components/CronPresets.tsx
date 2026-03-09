'use client';

import { useState } from 'react';

interface CronPresetsProps {
  value: string;
  onChange: (cron: string) => void;
  timezone?: string;
}

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Monday', cron: '0 9 * * 1' },
] as const;

export function CronPresets({ value, onChange, timezone }: CronPresetsProps) {
  const [showCustom, setShowCustom] = useState(false);

  const isPreset = PRESETS.some(p => p.cron === value);
  const isCustomMode = showCustom || (value !== '' && !isPreset);

  function handlePresetClick(cron: string) {
    setShowCustom(false);
    onChange(cron);
  }

  function handleCustomClick() {
    setShowCustom(true);
    // Don't clear the value — let the user type in the input
  }

  return (
    <div data-testid="cron-presets">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(preset => (
          <button
            key={preset.cron}
            type="button"
            onClick={() => handlePresetClick(preset.cron)}
            data-testid={`cron-preset-${preset.cron}`}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
              value === preset.cron && !isCustomMode
                ? 'border-primary bg-primary/10 text-primary font-medium'
                : 'border-border-default text-text-secondary hover:border-primary/30'
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustomClick}
          data-testid="cron-preset-custom"
          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
            isCustomMode
              ? 'border-primary bg-primary/10 text-primary font-medium'
              : 'border-border-default text-text-secondary hover:border-primary/30'
          }`}
        >
          Custom...
        </button>
      </div>

      {isCustomMode && (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. 0 9 * * 1 (Mon 9am)"
          data-testid="cron-custom-input"
          className="mt-2 w-full px-3 py-1.5 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
        />
      )}

      {timezone && value && (
        <p className="mt-1 text-xs text-text-muted">
          Times are in {timezone}
        </p>
      )}
    </div>
  );
}

/** Exported for testing */
export { PRESETS };
