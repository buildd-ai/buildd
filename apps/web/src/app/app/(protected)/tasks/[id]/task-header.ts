import { taskDisplayLabel } from '@buildd/core/task-label';
import { CONVENTIONAL_PREFIX_RE, displayTaskTitle } from '@/lib/task-title';
import type { StateKey } from '@/components/ui/states';
import type { DeliveryView } from '@/lib/workflow/projections';

const BRACKET_RE = /^\s*\[([^\]]*)\]\s*/;

/**
 * The task page header: the conventional-commit type and scope (scope as
 * `taskDisplayLabel` reads it, so chips and the page agree) plus the role move
 * into the eyebrow. The heading is `displayTaskTitle` of the title with its
 * retry bracket peeled off, so it reads the same as every other surface; the
 * bracket ("[builder · after CI #1]") keeps only its qualifier, in the eyebrow.
 */
export function taskHeading(task: { title: string; label?: string | null }, roleName: string | null): { eyebrow: string[]; heading: string } {
  let rest = task.title.trim();
  let qualifier: string | null = null;
  const bracket = BRACKET_RE.exec(rest);
  if (bracket) {
    rest = rest.slice(bracket[0].length);
    const parts = bracket[1].split('·').map(s => s.trim()).filter(Boolean);
    qualifier = parts.length > 1 ? parts.slice(1).join(' · ') : parts[0] ?? null;
  }
  const conv = CONVENTIONAL_PREFIX_RE.exec(rest);
  const type = conv ? conv[1].toLowerCase() : null;
  const scope = conv ? (taskDisplayLabel({ title: rest, label: task.label ?? null }).scope ?? (conv[2]?.trim() || null)) : null;
  const heading = displayTaskTitle(rest) || task.title;
  // "[reviewer] …" under the Reviewer role would name the role twice.
  if (qualifier && roleName && qualifier.trim().toLowerCase() === roleName.trim().toLowerCase()) qualifier = null;
  return {
    eyebrow: [type, scope, roleName, qualifier].filter((x): x is string => !!x),
    heading,
  };
}

export type LifecycleInput = Pick<DeliveryView, 'stage' | 'state' | 'stateReason' | 'prState' | 'headSha' | 'rounds'> & { headline?: string };

/**
 * Where the delivery sits on the one Lifecycle track (Build → Audit → Land),
 * and the short phrase its current step carries, for the header of a task
 * that is not running (a live run's own view leads with the track already).
 * The vocabulary is docs/specs/task-page.md's State mapping, shared with the
 * PR comment's header: "repair" only for an agent changing code, a base
 * refresh is "updating branch", an approval waits on the merge until the
 * merge fact. Superseded work has no track of its own.
 */
export function headerLifecycle(v: LifecycleInput | null | undefined): { state: StateKey; phrase: string | null } | null {
  if (!v) return null;
  const at = (state: StateKey, phrase: string | null = null) => ({ state, phrase });
  switch (v.stage) {
    case 'working': return at('running');
    case 'awaiting_push': return at('running', 'waiting for push');
    case 'review': {
      if (v.state === 'CHANGES_REQUESTED') return at('review', 'changes requested');
      const round = [...v.rounds].reverse().find(r => r.headSha === v.headSha && r.status !== 'superseded');
      return at('review', round?.status === 'reviewing' ? 'in review' : 'awaiting review');
    }
    case 'fixing': return at('fixing', 'fixing review feedback');
    case 'repairing':
      if (v.stateReason === 'behind') return at('review', 'updating branch');
      if (v.stateReason === 'ci') return at('fixing', 'fixing CI');
      // The kernel's own conflict wording (Resolving conflicts, Conflict fix stalled, Merge conflict).
      if (v.stateReason === 'conflict' || v.stateReason === 'migration') return at('fixing', v.headline ? v.headline.charAt(0).toLowerCase() + v.headline.slice(1) : 'resolving conflicts');
      return at('fixing', 'repairing');
    case 'blocked': return at('recovering', 'base branch is red');
    case 'needs_you': return at('needs_you');
    case 'approved': return at('landing', v.prState === 'awaiting_ci' ? 'approved · checking' : 'awaiting merge');
    case 'landing': return at('landing', 'merging');
    case 'merged': return at('landed');
    case 'closed':
    case 'abandoned': return at('not_landed');
    case 'failed': return at('failed');
    case 'superseded': return null;
  }
}
