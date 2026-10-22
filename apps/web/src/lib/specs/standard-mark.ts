/**
 * The standard mark (Living Specs D-43): who may set or clear a spec's
 * metadata `standard`. Kept apart from ./mission-standards.ts, which snapshots
 * standards onto missions, so the spec metadata path does not import the
 * missions module.
 */

export const STANDARD_MARK_REFUSAL = 'Marking a spec a standard is a person\'s decision: an owner or admin of this team, from their own session. An agent run or API key cannot set or clear it.';

/**
 * Who may set or clear `standard` (pure): a dashboard session (`user`) of an
 * owner or admin of the workspace's team. Every other caller is refused.
 */
export function standardMarkRefusal(input: { callerKind: 'user' | 'account' | 'system'; ownerOrAdmin: boolean }): string | null {
  return input.callerKind === 'user' && input.ownerOrAdmin ? null : STANDARD_MARK_REFUSAL;
}
