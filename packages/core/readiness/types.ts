/**
 * Workspace readiness — shapes. See docs/design/workspace-onboarding.md §2.
 * Pure types; no runtime.
 */

export type ItemStatus = 'detected' | 'missing' | 'unknown';

export type FixKind =
  | 'scaffold' // a file the agent can author in a PR from a template
  | 'apply-config' // a detected value the owner applies via the existing config PATCH
  | 'owner-decision' // cannot be inferred; needs a choice (no automated fix)
  | 'none'; // nothing to fix (status detected)

export type ReadinessItemId =
  | 'agent-instructions'
  | 'spec-root'
  | 'spec-format'
  | 'test-command'
  | 'typecheck-command'
  | 'build-command'
  | 'env-manifest'
  | 'migrations-dir'
  | 'merge-policy'
  | 'release-path'
  | 'visual-qa-source';

export interface ReadinessEvidence {
  kind: 'path' | 'manifest' | 'signal' | 'absent';
  paths?: string[];
  note: string;
}

export interface ReadinessFix {
  kind: FixKind;
  summary: string;
  templateId?: string;
  configPatch?: Record<string, unknown>;
}

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  /** `unknown` = could not tell (truncated tree, unreadable manifest, detector not available). */
  status: ItemStatus;
  importance: 'core' | 'recommended';
  evidence: ReadinessEvidence[];
  fix: ReadinessFix | null;
  /** The detected value when there is one: a command, a directory, a source name. */
  value?: string;
  waived?: { reason: string; at: string };
}

export type ReadinessNextStep =
  | 'link-repo'
  | 'review-policy'
  | 'propose-fixes'
  | 'author-spec'
  | 'first-mission'
  | 'done';

export interface ReadinessReport {
  items: ReadinessItem[];
  nextStep: ReadinessNextStep;
  skill: 'workspace-onboarding';
  /** The git tree response was truncated. */
  truncated: boolean;
}

/** One GitHub deployment status, reduced to what detection reads. */
export interface DeploymentSignal {
  environment: string;
  state: string;
  environmentUrl?: string | null;
}

/** The slice of a workspace's gitConfig that detection reads. Structural on purpose. */
export interface ReadinessGitConfig {
  defaultBranch?: string;
  policyConfig?: { preset?: string; riskClasses?: unknown[] } | null;
  specConformance?: { specsRoot?: string; designRoot?: string; migrationsDir?: string } | null;
  onboarding?: { waived?: Record<string, { reason: string; at: string }> } | null;
}

export interface ReadinessReleaseConfig {
  enabled?: boolean;
  strategy?: string;
}

export interface ReadinessInput {
  /** Repo-relative blob paths. `null` = no repository is linked. */
  files: string[] | null;
  /** The git-tree response was truncated: absence of a file proves nothing. */
  truncated?: boolean;
  /**
   * Contents of a bounded allow-list of small files, keyed by repo-relative path.
   * A file that exists in `files` but not here was not read (too large, over the
   * cap, fetch failed): detection that needs it reports `unknown`.
   */
  manifests?: Record<string, string>;
  /** `null` = deployments unavailable (no access); `[]` = none. */
  deployments?: DeploymentSignal[] | null;
  gitConfig?: ReadinessGitConfig | null;
  configStatus?: 'unconfigured' | 'admin_confirmed';
  releaseConfig?: ReadinessReleaseConfig | null;
  /** Remote branch names, when the shell has them. */
  branches?: string[];
  /** The workspace already has at least one mission. */
  hasMissions?: boolean;
}
