/**
 * Policy suggestions: risk-adjacent paths a PR touched that no risk class
 * covers. The reviewer dispatch records them on the reviewer task
 * (`context.policySuggestions`, from `findUncoveredRiskPaths` over the PR's own
 * file list); the Merge Policy page collects them here and offers to add them.
 *
 * They used to be pasted into the reviewer's escalation text, which put a
 * workspace-config decision on every PR card it touched.
 */
import type { RiskClassName, WorkspacePolicyConfig } from '@buildd/shared';
import { findUncoveredRiskPaths } from './workspace-policy';

export interface PolicySuggestion {
  path: string;
  class: RiskClassName;
}

/**
 * Suggestions from many reviewer task contexts, deduped by path. Re-checked
 * against the current policy so a path covered since drops out, and the class
 * is re-derived rather than read back.
 */
export function collectPolicySuggestions(
  contexts: unknown[],
  policyConfig: WorkspacePolicyConfig | null,
): PolicySuggestion[] {
  if (!policyConfig) return [];
  const paths = new Set<string>();
  for (const ctx of contexts) {
    const raw = ctx && typeof ctx === 'object' ? (ctx as Record<string, unknown>).policySuggestions : null;
    if (!Array.isArray(raw)) continue;
    for (const s of raw) {
      const path = s && typeof s === 'object' ? (s as Record<string, unknown>).path : null;
      if (typeof path === 'string' && path.length > 0) paths.add(path);
    }
  }
  return findUncoveredRiskPaths(policyConfig, [...paths]).map((u) => ({ path: u.file, class: u.suggestedClass }));
}

/** The policy with each suggestion's path added to its class. Pure; the input is not mutated. */
export function applyPolicySuggestions(
  policyConfig: WorkspacePolicyConfig,
  suggestions: PolicySuggestion[],
): WorkspacePolicyConfig {
  const riskClasses = policyConfig.riskClasses.map((c) => ({ ...c, detectedPaths: [...(c.detectedPaths ?? [])] }));
  for (const s of suggestions) {
    let entry = riskClasses.find((c) => c.name === s.class);
    if (!entry) {
      entry = { name: s.class, detectedPaths: [] };
      riskClasses.push(entry);
    }
    if (!entry.detectedPaths.includes(s.path)) entry.detectedPaths.push(s.path);
  }
  return { ...policyConfig, riskClasses };
}
