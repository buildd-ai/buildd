/**
 * The completed task's "What shipped" header, built only from the
 * `components/ui` primitives. Two halves, because the title sits in the page's
 * own header row (beside ⋯ and Ask) while the rest leads the main column:
 *
 *   TaskShippedTitle  eyebrow · plain title · status chips
 *   TaskShippedBody   lede card · Your move · hiccup row · disclosures
 *
 * Every branch is decided by `buildTaskShippedView`. Mobile-first: nothing
 * here is ever side by side below md.
 */
import type { ReactNode } from 'react';
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import Eyebrow from '@/components/ui/Eyebrow';
import Lede from '@/components/ui/Lede';
import PrimaryAction from '@/components/ui/PrimaryAction';
import Section from '@/components/ui/Section';
import MarkdownContent from '@/components/MarkdownContent';
import ShotImage, { VIEWPORT_LABEL, viewportAspect } from '@/components/visual-review/ShotImage';
import { thumbSrc } from '@/lib/mission-visual-review';
import { TASK_SHIPPED_HEADER_ID, type TaskShippedView } from './task-shipped-header';

const THUMB_WIDTH = { mobile: 'w-24', desktop: 'w-44' } as const;

export function TaskShippedTitle({ view, title, status }: { view: TaskShippedView; title: string; status: string }) {
  return (
    <div data-testid="task-shipped-title">
      <Eyebrow as="p" tone="accent">{view.eyebrow}</Eyebrow>
      <h1 className="mt-1.5 text-heading font-semibold tracking-[-0.2px] break-words max-w-[760px]">{title}</h1>
      <div data-testid="task-header-status" data-status={status} className="mt-2.5 flex flex-wrap items-center gap-2">
        {view.chips.map(c => (
          <Chip key={c.label} tone={c.tone} variant="soft">{c.label}</Chip>
        ))}
      </div>
    </div>
  );
}

export interface RunDetail {
  label: string;
  value: ReactNode;
}

export function TaskShippedBody({
  view,
  runDetails = [],
  structuredOutput = null,
  artifactHref = id => `?artifact=${encodeURIComponent(id)}`,
  shotSrc = thumbSrc,
}: {
  view: TaskShippedView;
  runDetails?: RunDetail[];
  /** Shown under the handoff text in Technical summary, as it was. */
  structuredOutput?: Record<string, unknown> | null;
  artifactHref?: (artifactId: string) => string;
  /** Fixtures pass inline SVG sketches; real shots load through the download route. */
  shotSrc?: (artifactId: string) => string;
}) {
  const hasLedeCard = !!view.lede || view.heroShots.length > 0;
  return (
    <div id={TASK_SHIPPED_HEADER_ID} data-testid="task-shipped" data-variant={view.lede ? 'lede' : 'title-only'} className="mb-8 flex scroll-mt-4 flex-col gap-4">
      {hasLedeCard && (
        <section
          data-testid="task-shipped-lede-card"
          aria-label="What changed"
          className="flex flex-col gap-3 border-2 border-border-strong bg-card px-4 py-4 shadow-[var(--card-shadow)] md:px-5"
        >
          {view.lede && <Lede className="font-medium">{view.lede}</Lede>}
          {view.changeTypeLabel && (
            <div><Chip tone="muted" dot={false} data-testid="task-shipped-change-type">{view.changeTypeLabel}</Chip></div>
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
                      <span className="font-mono text-meta uppercase tracking-[1px] text-text-muted">{VIEWPORT_LABEL[s.viewport]}</span>
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

      {view.action && (
        <Section title="Your move" className="!py-0">
          <div data-testid="task-shipped-your-move" className="flex flex-col gap-2">
            <PrimaryAction href={view.action.href} tone={view.action.tone} fullWidthOnMobile data-testid="task-shipped-action">
              {view.action.label}
            </PrimaryAction>
            {view.actionMeta && (
              <p data-testid="task-shipped-action-meta" className="font-mono text-meta text-text-muted">{view.actionMeta}</p>
            )}
          </div>
        </Section>
      )}

      {view.mergedLine && (
        <a
          href={view.mergedLine.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="task-shipped-merged"
          className="flex min-h-11 items-center font-mono text-meta text-status-success hover:underline md:min-h-0"
        >
          {view.mergedLine.label} ↗
        </a>
      )}

      {view.hiccup && (
        <a
          href={view.hiccup.href}
          data-testid="task-shipped-hiccup"
          className="flex min-h-11 items-center gap-2 border-y border-border-default text-body text-text-secondary hover:text-text-primary"
        >
          <span aria-hidden="true" className="text-text-muted">↺</span>
          <span className="flex-1">{view.hiccup.label}</span>
          <span aria-hidden="true" className="text-text-muted">→</span>
        </a>
      )}

      {(view.technicalSummary || structuredOutput || runDetails.length > 0) && (
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
          {runDetails.length > 0 && (
            <div className="border-t border-border-default" data-testid="task-shipped-run-details">
              <Disclosure summary="Run details">
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 pb-4 pt-1 text-body">
                  {runDetails.map(r => (
                    <div key={r.label} className="contents">
                      <dt className="font-mono text-meta uppercase tracking-[1px] text-text-muted">{r.label}</dt>
                      <dd className="min-w-0 break-words text-text-primary">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </Disclosure>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
