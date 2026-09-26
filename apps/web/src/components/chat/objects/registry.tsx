'use client';

/**
 * `objectRenderers[kind]`: the one registry the feed, the docked pane and the
 * phone sheet render refs through. A ref with no renderer yet (schedule,
 * artifact, directive arrive in P2) shows its `fallbackText`.
 */
import type { ComponentType } from 'react';
import type { BuilddObjectRef } from '../chat-contract';
import { MissionCard, MissionPane } from './MissionObject';
import { PrPane, PrRow } from './PrObject';
import { QuestionCard } from './QuestionObject';
import { TaskCard, TaskPane } from './TaskObject';
import { useObjectEntry } from './ObjectStoreProvider';
import { isRenderableKind, type ObjectView, type RenderableKind } from './object-views';
import { ObjectPlaceholder } from './parts';

type ViewOf<K extends RenderableKind> = Extract<ObjectView, { kind: K }>;

interface Renderer<K extends RenderableKind> {
  Card: ComponentType<{ objRef: BuilddObjectRef; view: ViewOf<K> }>;
  Pane: ComponentType<{ objRef: BuilddObjectRef; view: ViewOf<K>; variant?: 'pane' | 'sheet' }>;
}

export const objectRenderers: { [K in RenderableKind]: Renderer<K> } = {
  mission: { Card: MissionCard, Pane: MissionPane },
  task: { Card: TaskCard, Pane: ({ view, variant }) => <TaskPane view={view} variant={variant} /> },
  pr: { Card: PrRow, Pane: ({ view, variant }) => <PrPane view={view} variant={variant} /> },
  question: {
    Card: QuestionCard,
    Pane: ({ objRef, view, variant }) => (
      <div className={variant === 'sheet' ? 'pb-6' : 'px-6 pb-10 pt-5'} data-testid="object-pane" data-kind="question">
        <QuestionCard objRef={objRef} view={view} variant="pane" />
      </div>
    ),
  },
};

export function ObjectCard({ objRef }: { objRef: BuilddObjectRef }) {
  const renderable = isRenderableKind(objRef.kind);
  if (!renderable) return <ObjectPlaceholder objRef={objRef} />;
  return <LiveCard objRef={objRef} />;
}

function LiveCard({ objRef }: { objRef: BuilddObjectRef }) {
  const { view, error } = useObjectEntry(objRef);
  if (!view || view.kind !== objRef.kind) return <ObjectPlaceholder objRef={objRef} error={error} />;
  const R = objectRenderers[view.kind] as Renderer<typeof view.kind>;
  return <R.Card objRef={objRef} view={view as never} />;
}

export function ObjectPane({ objRef, variant = 'pane' }: { objRef: BuilddObjectRef; variant?: 'pane' | 'sheet' }) {
  if (!isRenderableKind(objRef.kind)) return <div className="p-6"><ObjectPlaceholder objRef={objRef} /></div>;
  return <LivePane objRef={objRef} variant={variant} />;
}

function LivePane({ objRef, variant }: { objRef: BuilddObjectRef; variant: 'pane' | 'sheet' }) {
  const { view, error } = useObjectEntry(objRef);
  if (!view || view.kind !== objRef.kind) {
    return <div className={variant === 'pane' ? 'p-6' : ''}><ObjectPlaceholder objRef={objRef} error={error} /></div>;
  }
  const R = objectRenderers[view.kind] as Renderer<typeof view.kind>;
  return <R.Pane objRef={objRef} view={view as never} variant={variant} />;
}

/** A PR in a run of PRs renders as a list row; everything else is its own card. */
function PrListItem({ objRef }: { objRef: BuilddObjectRef }) {
  const { view, error } = useObjectEntry(objRef);
  if (!view || view.kind !== 'pr') {
    return <div className="px-4 py-2 font-mono text-[12.5px] text-text-muted">{error ? `${objRef.fallbackText} · unavailable` : objRef.fallbackText}</div>;
  }
  return <PrRow objRef={objRef} view={view} flush />;
}

/** Split refs into runs: consecutive PRs stack as one list, as in "what shipped today". */
export function objectRuns(refs: readonly BuilddObjectRef[]): Array<{ kind: 'prs' | 'one'; refs: BuilddObjectRef[] }> {
  const runs: Array<{ kind: 'prs' | 'one'; refs: BuilddObjectRef[] }> = [];
  for (const r of refs) {
    const last = runs[runs.length - 1];
    if (r.kind === 'pr' && last?.kind === 'prs') last.refs.push(r);
    else runs.push({ kind: r.kind === 'pr' ? 'prs' : 'one', refs: [r] });
  }
  return runs.map(run => (run.kind === 'prs' && run.refs.length === 1 ? { kind: 'one', refs: run.refs } : run));
}

export function ObjectsSegment({ refs }: { refs: readonly BuilddObjectRef[] }) {
  return (
    <div data-testid="feed-objects" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {objectRuns(refs).map(run => run.kind === 'prs' ? (
        <div key={`prs-${run.refs[0].id}`} data-testid="pr-list" className="border-2 border-border-strong bg-card divide-y divide-border-default">
          <div className="flex items-center gap-2 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[2px] text-text-muted">
            <span aria-hidden="true" className="h-2.5 w-2.5 bg-accent" />
            {`${run.refs.length} pull requests`}
          </div>
          {run.refs.map(r => <PrListItem key={r.id} objRef={r} />)}
        </div>
      ) : (
        <ObjectCard key={`${run.refs[0].kind}-${run.refs[0].id}`} objRef={run.refs[0]} />
      ))}
    </div>
  );
}
