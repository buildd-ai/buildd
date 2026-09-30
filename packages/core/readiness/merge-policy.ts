import { detectAllRiskClasses } from '../risk-class-detect';
import { detector } from './context';

export const detectMergePolicy = detector(
  { id: 'merge-policy', label: 'Merge policy (risk classes)', importance: 'core' },
  (ctx) => {
    // The same detector `manage_workspaces action=init` runs: one implementation.
    const classes = detectAllRiskClasses(ctx.files);
    const hit = classes.filter((c) => c.detectedPaths.length > 0);
    const confirmed = ctx.configStatus === 'admin_confirmed';
    const proposal = {
      kind: 'apply-config' as const,
      summary: 'Review the detected risk classes and apply a merge-policy preset (default: balanced).',
      configPatch: { policyConfig: { preset: 'balanced', riskClasses: classes } },
    };

    if (confirmed) {
      return {
        status: 'detected',
        evidence: [{ kind: 'signal', note: 'Merge policy confirmed by an owner.' }],
        fix: null,
      };
    }
    if (hit.length > 0) {
      return {
        status: 'detected',
        value: hit.map((c) => c.name).join(', '),
        evidence: hit.map((c) => ({
          kind: 'path' as const,
          paths: c.detectedPaths.slice(0, 5),
          note: `Risk class ${c.name} has matching paths; not yet applied to the workspace.`,
        })),
        fix: proposal,
      };
    }
    const status = ctx.absentStatus();
    return {
      status,
      evidence: [ctx.absentNote('Paths for any risk class')],
      fix: status === 'unknown' ? null : proposal,
    };
  },
);
