/**
 * Dashboard view rules for workspace onboarding (docs/design/workspace-onboarding.md §1).
 *
 * Pure and client-safe: no db, no fetch, nothing from core's server-only
 * scaffold/template modules. The readiness report is the only source of step
 * state; nothing here remembers which step the owner is on.
 */

import type {
  SpecCapabilityAnswers,
  SpecExample,
  SpecInterviewAnswers,
  WorkspaceReadinessItem,
  WorkspaceReadinessNextStep,
  WorkspaceReadinessReport,
} from '@buildd/shared';

export type RowTone = 'ok' | 'warning' | 'muted' | 'info';

export function rowTone(item: WorkspaceReadinessItem): RowTone {
  if (item.waived) return 'muted';
  if (item.status === 'detected') return 'ok';
  if (item.status === 'unknown') return 'info';
  return item.importance === 'core' ? 'warning' : 'muted';
}

export function statusLabel(item: WorkspaceReadinessItem): string {
  if (item.waived) return 'Waived';
  if (item.status === 'detected') return 'Found';
  if (item.status === 'unknown') return 'Could not tell';
  return 'Missing';
}

/** Rows the owner can tick: missing, not waived, and fixable by a scaffolded file. */
export function isSelectable(item: WorkspaceReadinessItem): boolean {
  return item.status === 'missing' && !item.waived && item.fix?.kind === 'scaffold';
}

export function selectableItemIds(report: Pick<WorkspaceReadinessReport, 'items'>): string[] {
  return report.items.filter(isSelectable).map((i) => i.id);
}

/** Core items first, then recommended; stable within each group. */
export function orderedItems(items: WorkspaceReadinessItem[]): WorkspaceReadinessItem[] {
  const core = items.filter((i) => i.importance === 'core');
  const rest = items.filter((i) => i.importance !== 'core');
  return [...core, ...rest];
}

export const NEXT_STEP_COPY: Record<WorkspaceReadinessNextStep, { title: string; body: string }> = {
  'link-repo': {
    title: 'Link a repository',
    body: 'Workers need a repo to work in. Link an existing one or create a new one.',
  },
  'review-policy': {
    title: 'Review the merge policy',
    body: 'Buildd detected which paths are risky. Confirm the proposed policy before workers open PRs.',
  },
  'propose-fixes': {
    title: 'Propose changes',
    body: 'Tick what you want added. Nothing is written until you confirm, and you merge the resulting PR.',
  },
  'author-spec': {
    title: 'Write your first spec',
    body: 'A short interview that turns what you want built into a draft spec buildd can check work against.',
  },
  'first-mission': {
    title: 'Plan your first mission',
    body: 'The repo is ready. Describe a goal and buildd will break it into tasks.',
  },
  done: {
    title: 'Ready',
    body: 'Everything buildd can check is in place.',
  },
};

export function missionHref(workspaceId: string): string {
  return `/app/missions/new?workspace=${encodeURIComponent(workspaceId)}`;
}

/**
 * Which workspace the new-mission form opens on. A `?workspace=` link wins over
 * the last-used one, but only when it names a workspace the viewer can see.
 */
export function initialWorkspaceId(
  workspaces: ReadonlyArray<{ id: string }>,
  requested: string | null,
  stored: string | null,
): string {
  const has = (id: string | null): id is string => !!id && workspaces.some((w) => w.id === id);
  if (has(requested)) return requested;
  if (has(stored)) return stored;
  return workspaces.length === 1 ? workspaces[0].id : '';
}

// ── Spec wizard drafts ──────────────────────────────────────────────────────

export interface ExampleDraft {
  given: string;
  when: string;
  then: string;
}

export interface CapabilityDraft {
  name: string;
  /** One invariant per line. */
  invariants: string;
  accepted: ExampleDraft;
  rejected: ExampleDraft;
  /** One path per line. */
  codePaths: string;
}

export interface SpecDraft {
  title: string;
  description: string;
  capabilities: CapabilityDraft[];
  outOfScope: string;
  verification: string;
  protectedAreas: string;
}

export const emptyExampleDraft = (): ExampleDraft => ({ given: '', when: '', then: '' });

export const emptyCapabilityDraft = (): CapabilityDraft => ({
  name: '',
  invariants: '',
  accepted: emptyExampleDraft(),
  rejected: emptyExampleDraft(),
  codePaths: '',
});

export const emptySpecDraft = (): SpecDraft => ({
  title: '',
  description: '',
  capabilities: [emptyCapabilityDraft()],
  outOfScope: '',
  verification: '',
  protectedAreas: '',
});

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function exampleFromDraft(d: ExampleDraft): SpecExample {
  const given = d.given.trim();
  return { ...(given ? { given } : {}), when: d.when.trim(), then: d.then.trim() };
}

/**
 * The route validates; this only reshapes text boxes into the answer shape, and
 * leaves optional lists out when empty so the route sees "not answered".
 */
export function draftToAnswers(draft: SpecDraft): SpecInterviewAnswers {
  const capabilities: SpecCapabilityAnswers[] = draft.capabilities.map((c) => {
    const codePaths = lines(c.codePaths);
    return {
      name: c.name.trim(),
      invariants: lines(c.invariants),
      accepted: exampleFromDraft(c.accepted),
      rejected: exampleFromDraft(c.rejected),
      ...(codePaths.length > 0 ? { codePaths } : {}),
    };
  });
  const outOfScope = lines(draft.outOfScope);
  const verification = lines(draft.verification);
  const protectedAreas = lines(draft.protectedAreas);
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    capabilities,
    ...(outOfScope.length > 0 ? { outOfScope } : {}),
    ...(verification.length > 0 ? { verification } : {}),
    ...(protectedAreas.length > 0 ? { protectedAreas } : {}),
  };
}
