import type { FeatureMode } from '@buildd/core/inference-policy';

/**
 * Wording for Settings → AI features. Labels, not paragraphs: each line names a
 * state or an action. The billing model is stated once, in the section meta.
 */

export type OverrideValue = 'default' | FeatureMode;

export const OVERRIDE_OPTIONS: { value: OverrideValue; label: string }[] = [
  { value: 'default', label: 'Auto' },
  { value: 'server', label: 'Server' },
  { value: 'runner', label: 'Runner' },
];

/** What Auto resolves to for every feature, from the team's billing model. */
export function defaultLine(hasTeamKey: boolean): string {
  return hasTeamKey ? 'Auto: server (team key)' : 'Auto: runner (no team key)';
}

export function modeLabel(mode: FeatureMode): string {
  return mode === 'server' ? 'Server' : 'Runner';
}

/** The state shown on a feature row. */
export function featureState(r: { mode: FeatureMode; source: 'default' | 'override'; needsKey: boolean }): string {
  if (r.needsKey) return 'Server · needs a team key';
  return r.source === 'override' ? `${modeLabel(r.mode)} · override` : modeLabel(r.mode);
}
