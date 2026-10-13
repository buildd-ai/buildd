import type { ComposeCheckState, ComposeChecksSummary, ComposeCriteria, FlowStep } from '@buildd/core/release-compose';
import type { StateTone } from '@/components/ui/states';
import type { FlowRecordEntry } from '@/lib/release/compose-source';

/** The four steps, in order, as the page names them. */
export const FLOW_STEPS: Array<{ key: FlowStep | 'cut'; label: string }> = [
  { key: 'compose', label: 'Compose' },
  { key: 'cut', label: 'Cut' },
  { key: 'review', label: 'Review' },
  { key: 'release', label: 'Release' },
];

/** Index of the step the flow is on; Cut is done the moment a candidate exists. */
export function stepIndex(step: FlowStep): number {
  switch (step) {
    case 'compose':
      return 0;
    case 'review':
      return 2;
    case 'release':
      return 3;
    case 'released':
      return 4;
  }
}

export function checkTone(state: ComposeCheckState | ComposeChecksSummary): StateTone {
  switch (state) {
    case 'passing':
      return 'ok';
    case 'failing':
      return 'bad';
    case 'pending':
      return 'run';
    default:
      return 'q';
  }
}

export function checkWord(state: ComposeCheckState | ComposeChecksSummary): string {
  switch (state) {
    case 'passing':
      return 'passed';
    case 'failing':
      return 'failed';
    case 'pending':
      return 'running';
    case 'missing':
      return 'not run on this SHA';
    default:
      return 'no checks';
  }
}

export function criteriaText(c: ComposeCriteria | null): string | null {
  return c ? `${c.met} of ${c.total} criteria` : null;
}

const STEP_VERB: Record<string, Record<string, string>> = {
  include: { succeeded: 'merged', pending: 'started merging', refused: 'tried to merge', failed: 'tried to merge' },
  cut: { succeeded: 'cut', pending: 'cut', refused: 'tried to cut', failed: 'tried to cut' },
  exclude: { succeeded: 'left out', pending: 'left out', refused: 'tried to leave out', failed: 'tried to leave out' },
  release: { succeeded: 'released', pending: 'released', refused: 'tried to release', failed: 'tried to release' },
  confirm_production: { succeeded: 'confirmed production for', pending: 'checked production for', refused: 'checked production for', failed: 'checked production for' },
};

/** One record row as a sentence that names the actor: "Ana cut the candidate from dev at 1a2b3c4d5." */
export function recordSentence(r: FlowRecordEntry): string {
  const verb = STEP_VERB[r.step]?.[r.outcome] ?? r.step;
  const d = (r.detail ?? {}) as Record<string, any>;
  const v = r.version ? `v${r.version}` : null;
  switch (r.step) {
    case 'include':
      return `${r.actor} ${verb} ${d.title ?? 'a mission'}${r.prNumber ? ` (#${r.prNumber})` : ''} into dev${r.outcome === 'refused' && d.reason ? `: ${d.reason}` : '.'}`;
    case 'cut': {
      const left = Array.isArray(d.leftOut) && d.leftOut.length ? `, leaving out ${d.leftOut.map((x: any) => x.label).join(', ')}` : '';
      return `${r.actor} ${verb} the candidate from dev${d.sourceSha ? ` at ${String(d.sourceSha).slice(0, 9)}` : ''}${left}${r.outcome === 'failed' && d.error ? `: ${d.error}` : '.'}`;
    }
    case 'exclude': {
      const labels = Array.isArray(d.leftOut) ? d.leftOut.map((x: any) => x.label).join(', ') : 'changes';
      return `${r.actor} ${verb} ${labels} from ${v ?? 'the candidate'}${r.outcome === 'failed' && d.error ? `: ${d.error}` : '.'}`;
    }
    case 'release':
      return `${r.actor} ${verb} ${v ?? 'the candidate'}${r.outcome === 'refused' && d.reason ? `: ${d.reason}` : r.outcome === 'refused' && d.message ? `: ${d.message}` : '.'}`;
    case 'confirm_production':
      return r.outcome === 'succeeded'
        ? `${r.actor} ${verb} ${v ?? 'the release'}: production runs ${String(d.deployedSha ?? '').slice(0, 9)}.`
        : `${r.actor} ${verb} ${v ?? 'the release'}; production ${d.deployedSha ? `ran ${String(d.deployedSha).slice(0, 9)}` : 'reported no SHA'}, so it was not marked released.`;
    default:
      return `${r.actor} ${verb}.`;
  }
}
