/**
 * The completed task's "What shipped" header, built only from the
 * `components/ui` primitives. Two halves, because the title sits in the page's
 * own header row (beside ⋯ and Ask) while the rest leads the main column:
 *
 *   TaskShippedTitle    eyebrow · plain title
 *   TaskShippedBody     the lede card (what changed, hero shots, off plan)
 *   TaskShippedDetails  Technical summary and Run details, both collapsed
 *
 * Where the task stands and what to do next is the verdict block's
 * (TaskVerdictBlock), rendered once above the body: no status chip, action
 * or "already handled" row here can contradict it.
 *
 * Every branch is decided by `buildTaskShippedView`. Mobile-first: nothing
 * here is ever side by side below md.
 */
import type { ReactNode } from 'react';
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import Eyebrow from '@/components/ui/Eyebrow';
import Lede from '@/components/ui/Lede';
import MarkdownContent from '@/components/MarkdownContent';
import ShotImage, { VIEWPORT_LABEL, viewportAspect } from '@/components/visual-review/ShotImage';
import { thumbSrc } from '@/lib/mission-visual-review';
import { TASK_SHIPPED_HEADER_ID, type TaskShippedView } from './task-shipped-header';

const THUMB_WIDTH = { mobile: 'w-24', desktop: 'w-44' } as const;

export function TaskShippedTitle({ view, title }: { view: TaskShippedView; title: string }) {
  return (
    <div data-testid="task-shipped-title">
      <Eyebrow as="p" tone="muted">{view.eyebrow}</Eyebrow>
      <h1 className="mt-1.5 text-heading font-semibold tracking-[-0.2px] break-words max-w-[760px]">{title}</h1>
    </div>
  );
}

export interface RunDetail {
  label: string;
  value: ReactNode;
}

export function TaskShippedBody({
  view,
  artifactHref = id => `?artifact=${encodeURIComponent(id)}`,
  shotSrc = thumbSrc,
}: {
  view: TaskShippedView;
  artifactHref?: (artifactId: string) => string;
  /** Fixtures pass inline SVG sketches; real shots load through the download route. */
  shotSrc?: (artifactId: string) => string;
}) {
  const hasLedeCard = !!view.lede || view.heroShots.length > 0;
  return (
    <div id={TASK_SHIPPED_HEADER_ID} data-testid="task-shipped" data-variant={view.lede ? 'lede' : 'title-only'} className="mb-8 flex scroll-mt-4 flex-col gap-4 empty:hidden">
      {hasLedeCard && (
        <section
          data-testid="task-shipped-lede-card"
          aria-label="What changed"
          className="card flex flex-col gap-3 px-4 py-4 md:px-5"
        >
          {view.lede && <Lede className="font-medium">{view.lede}</Lede>}
          {view.changeTypeLabel && (
            <p className="text-meta text-text-muted" data-testid="task-shipped-change-type">{view.changeTypeLabel}</p>
          )}
          {view.heroShots.length > 0 && (
            <ul data-testid="task-shipped-hero-shots" className="flex flex-wrap items-end gap-3">
              {view.heroShots.map(s => {
                const label = `${VIEWPORT_LABEL[s.viewport]} · ${s.route}`;
                return (
                  <li key={s.artifactId}>
                    <a
                      href={artifactHref(s.artifactId)}
                      aria-label={`Open ${label}`}
                      data-testid="task-shipped-hero-shot"
                      className="flex min-h-11 flex-col items-start gap-1.5"
                    >
                      <span className={`relative block overflow-hidden border-2 border-border-strong bg-surface-2 ${THUMB_WIDTH[s.viewport]} ${viewportAspect(s.viewport)}`}>
                        <ShotImage shot={{ id: s.artifactId, src: shotSrc(s.artifactId) }} alt={label} className="block h-full w-full object-cover object-top" />
                      </span>
                      <span className="font-mono text-meta text-text-muted">{VIEWPORT_LABEL[s.viewport]}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {view.offPlan.length > 0 && (
            <div data-testid="task-shipped-off-plan" className="border-t border-border-default pt-3">
              <Eyebrow as="p" tone="muted">Off plan</Eyebrow>
              <ul className="mt-1.5 flex flex-col gap-1">
                {view.offPlan.map(line => <li key={line} className="text-body text-text-secondary">{line}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

/**
 * The completed page's tail: the raw handoff and the run's details, each
 * behind its own collapsed disclosure. `children` render inside Run details
 * after the facts (workers, scope, evidence files, plan), so nothing the run
 * produced is listed twice on the page.
 */
export function TaskShippedDetails({
  view,
  runDetails = [],
  structuredOutput = null,
  children,
}: {
  view: TaskShippedView;
  runDetails?: RunDetail[];
  /** Shown under the handoff text in Technical summary, as it was. */
  structuredOutput?: Record<string, unknown> | null;
  children?: ReactNode;
}) {
  const hasRunDetails = runDetails.length > 0 || !!children;
  if (!view.technicalSummary && !structuredOutput && !hasRunDetails) return null;
  return (
    <div className="flex flex-col border-b border-border-default">
      {(view.technicalSummary || structuredOutput) && (
        <div className="border-t border-border-default" data-testid="task-shipped-technical">
          <Disclosure summary="Technical summary">
            <div className="pb-4 pt-1">
              {view.technicalSummaryIsFallback && (
                <div className="mb-2"><Chip tone="muted" dot={false}>unauthored · last message</Chip></div>
              )}
              {view.technicalSummary && <MarkdownContent content={view.technicalSummary} />}
              {structuredOutput && (
                <pre className="mt-3 overflow-x-auto border border-border-default bg-surface-2 p-3 font-mono text-meta text-text-primary">
                  {JSON.stringify(structuredOutput, null, 2)}
                </pre>
              )}
            </div>
          </Disclosure>
        </div>
      )}
      {hasRunDetails && (
        <div className="border-t border-border-default" data-testid="task-shipped-run-details">
          <Disclosure summary="Run details">
            {runDetails.length > 0 && (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 pb-4 pt-1 text-body">
                {runDetails.map(r => (
                  <div key={r.label} className="contents">
                    <dt className="font-mono text-meta text-text-muted">{r.label}</dt>
                    <dd className="min-w-0 break-words text-text-primary">{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {children && <div data-testid="task-shipped-run-details-more" className="flex flex-col gap-6 pb-4">{children}</div>}
          </Disclosure>
        </div>
      )}
    </div>
  );
}
