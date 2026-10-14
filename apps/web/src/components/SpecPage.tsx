'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import Card from '@/components/ui/Card';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import Section from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import MarkdownContent from '@/components/MarkdownContent';
import SpecDiffView from '@/components/SpecDiffView';
import SpecRevisionPanes from '@/components/SpecRevisionPanes';
import SpecComments from '@/components/SpecComments';
import SpecAttachments from '@/components/SpecAttachments';
import SpecNeighbourGraph from '@/components/SpecNeighbourGraph';
import Segmented from '@/components/ui/Segmented';
import { neighbourGraph } from '@/lib/specs/index-view';
import SpecFiling from '@/components/SpecFiling';
import SpecRepoChecks from '@/components/SpecRepoChecks';
import type { SpecPageView } from '@/lib/specs/page-view';

type Ok = Extract<SpecPageView, { state: 'ok' }>;

/** The one sentence that says which revision this is and what waits. */
export function readingLine(v: Pick<Ok, 'reading' | 'waiting' | 'spec'>): string {
  const n = v.reading.revision;
  const approved = v.spec.approvedRevision;
  const waits = v.waiting && v.waiting !== n ? ` Revision ${v.waiting} is waiting for approval.` : '';
  if (v.reading.approved) return `You're reading revision ${n}, the approved one.${waits}`;
  if (approved == null) return `You're reading revision ${n}, a draft. Nothing is approved yet.${waits}`;
  return `You're reading revision ${n}, which is not approved. Revision ${approved} is in force.${waits}`;
}

function Approve({ specId, revision, expectedVersion }: { specId: string; revision: number; expectedVersion: number }) {
  const router = useRouter();
  const approvedText = `Approved. Revision ${revision} is in force.`;
  const { shown, retry, approve } = useOptimisticApprove(async () => {
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, expectedVersion }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return { tone: 'ok', text: approvedText };
    return { tone: res.status === 409 ? 'warn' : 'err', text: body.error ?? 'Approval failed. Try again.' };
  }, approvedText, () => router.refresh());
  return (
    <div className="flex flex-col gap-3">
      {shown ? <Notice tone={shown.tone} data-testid="spec-page-approve-result">{shown.text}</Notice> : null}
      {!shown || retry ? (
        <div>
          <PrimaryAction onClick={approve} fullWidthOnMobile data-testid="spec-page-approve">
            Approve revision {revision}
          </PrimaryAction>
        </div>
      ) : null}
    </div>
  );
}

function Compare({ specId, revisions, from, to }: { specId: string; revisions: number[]; from: number; to: number }) {
  const [a, setA] = useState(String(from));
  const [b, setB] = useState(String(to));
  const options = revisions.map((n) => ({ value: String(n), label: `Revision ${n}` }));
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="spec-page-compare">
      <Select value={a} onChange={setA} options={options} aria-label="Compare from" size="sm" />
      <span className="text-meta text-text-muted">to</span>
      <Select value={b} onChange={setB} options={options} aria-label="Compare to" size="sm" />
      <Link
        href={`/app/specs/${specId}?from=${a}&to=${b}`}
        className="btn btn-sm h-11 md:h-8"
        data-testid="spec-page-compare-go"
      >
        Show changes
      </Link>
    </div>
  );
}

/**
 * One spec (living-specs.md §9): the revision in force rendered, its history,
 * the changes between any two revisions and, for a person who may approve,
 * the waiting revision with one Approve action (§6's route; nothing new).
 */
export default function SpecPage({ view }: { view: Ok }) {
  const { spec } = view;
  const base = `/app/specs/${spec.id}`;
  const numbers = view.revisions.map((r) => r.revision);
  const defaultFrom = spec.approvedRevision && spec.approvedRevision !== spec.headRevision ? spec.approvedRevision : Math.max(1, spec.headRevision - 1);

  const focused = !!(view.review || view.compare);
  const graph = neighbourGraph({ spec, parent: view.parent, siblings: view.siblings ?? [], nearby: view.nearby });
  const hasGraph = !!(graph.parent || graph.siblings.length || graph.neighbours.length);
  const [relatedView, setRelatedView] = useState<'list' | 'graph'>('list');
  // Related renders only when something sits under it: no empty heading.
  const hasRelated = hasGraph || !!view.filing || view.children.length > 0 || !!view.design || view.repoRefs.length > 0;
  const main = (
    view.review ? (
      <section className="flex flex-col gap-3" data-testid="spec-page-review-panel">
        <h2 className="text-body font-semibold text-text-primary">
          {view.review.replaces ? `Revision ${view.review.revision} replaces revision ${view.review.replaces}` : `Revision ${view.review.revision} (nothing approved yet)`}
        </h2>
        {/* The action sits where the reader pressed Review, above the text it approves. */}
        <Approve specId={spec.id} revision={view.review.revision} expectedVersion={spec.version} />
        <SpecRepoChecks preflight={view.preflight ?? null} />
        <SpecRevisionPanes
          body={view.review.body}
          hunks={view.review.hunks}
          omittedLines={view.review.omittedLines}
          sectionCount={view.review.sectionCount}
          linesAdded={view.review.linesAdded}
          linesRemoved={view.review.linesRemoved}
          initial={view.review.replaces ? 'changes' : 'spec'}
          attachments={view.review.attachmentSources}
        />
      </section>
    ) : view.compare ? (
      <section className="flex flex-col gap-3" data-testid="spec-page-compare-panel">
        {'error' in view.compare ? (
          <Notice tone="warn">{view.compare.error}</Notice>
        ) : (
          <>
            <h2 className="text-body font-semibold text-text-primary">
              Changes from revision {view.compare.from} to revision {view.compare.to}
            </h2>
            <SpecDiffView hunks={view.compare.hunks} omittedLines={view.compare.omittedLines} />
          </>
        )}
      </section>
    ) : (
      <Card data-testid="spec-page-body">
        <MarkdownContent content={view.body} images="link" surface="spec" attachments={view.attachmentSources ?? {}} />
      </Card>
    )
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <Link href={`/app/workspaces/${spec.workspaceId}/specs`} className="text-meta text-text-muted hover:text-text-primary">
          {spec.workspaceName ? `${spec.workspaceName} specs` : 'Specs'}
        </Link>
        <h1 className="font-voice text-2xl text-text-primary [overflow-wrap:anywhere]" data-testid="spec-page-title">{spec.title}</h1>
        <p className="text-meta text-text-muted">{spec.scope} · {view.standing}</p>
        {view.source ? <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">{view.source.source}</p> : null}
      </header>

      {view.source?.copy ? (
        view.source.behind
          ? <Notice tone="warn" data-testid="spec-page-repo-copy">{view.source.copy}</Notice>
          : <p className="text-meta text-text-muted" data-testid="spec-page-repo-copy">{view.source.copy}</p>
      ) : null}

      <Lede><span data-testid="spec-page-reading">{readingLine(view)}</span></Lede>

      {view.canApprove && view.waiting && !view.review ? (
        <div>
          <PrimaryAction href={`${base}?review=1`} fullWidthOnMobile data-testid="spec-page-review">
            Review revision {view.waiting}
          </PrimaryAction>
        </div>
      ) : null}

      {focused ? main : null}

      {hasRelated ? <Section title="Related">
        {hasGraph ? (
          <div className="hidden md:block">
            <Segmented
              items={[{ value: 'list', label: 'List' }, { value: 'graph', label: 'Graph' }] as const}
              value={relatedView}
              onChange={setRelatedView}
              label="Show related specs as"
            />
          </div>
        ) : null}
        {hasGraph && relatedView === 'graph' ? (
          <div className="hidden md:block" data-testid="spec-page-graph">
            <SpecNeighbourGraph graph={graph} />
          </div>
        ) : null}
        {/* The list is the default, and below md the only view: the graph needs the width (R-29). */}
        <div className={`flex flex-col gap-3 ${hasGraph && relatedView === 'graph' ? 'md:hidden' : ''}`} data-testid="spec-page-related-list">
          {view.parent ? (
            <p className="text-body text-text-secondary" data-testid="spec-page-parent">
              Part of <Link href={`/app/specs/${view.parent.id}`} className="underline hover:text-text-primary">{view.parent.title}</Link>
            </p>
          ) : null}
          {view.parent && (view.siblings ?? []).length > 0 ? (
            <div data-testid="spec-page-siblings">
              <p className="text-body text-text-secondary">Alongside it under {view.parent.title}:</p>
              <ul className="mt-1 flex flex-col">
                {(view.siblings ?? []).map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/specs/${c.id}`} className="flex min-h-11 items-center text-body text-text-primary underline [overflow-wrap:anywhere]">{c.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.nearby.length ? (
            <div data-testid="spec-page-nearby">
              <p className="text-body text-text-secondary">Nearby specs, found from their text and their work:</p>
              <ul className="mt-1 flex flex-col">
                {view.nearby.map((n) => (
                  <li key={n.specId} className="flex min-h-11 flex-col justify-center py-1" data-testid="spec-page-nearby-item" data-kind={n.kind}>
                    <Link href={`/app/specs/${n.specId}`} className="text-body text-text-primary underline [overflow-wrap:anywhere]">{n.title}</Link>
                    <span className="text-meta text-text-muted">{n.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {view.filing ? <SpecFiling specId={spec.id} filing={view.filing} canAct={view.canComment} /> : null}
        {view.children.length ? (
          <div data-testid="spec-page-children">
            <p className="text-body text-text-secondary">Specs under this one:</p>
            <ul className="mt-1 flex flex-col">
              {view.children.map((c) => (
                <li key={c.id}>
                  <Link href={`/app/specs/${c.id}`} className="flex min-h-11 items-center text-body text-text-primary underline">{c.title}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {view.design ? (
          <div data-testid="spec-page-design">
            <p className="text-body text-text-secondary">
              Built to the design{' '}
              {view.design.href
                ? <a href={view.design.href} className="text-text-primary underline">{view.design.label}</a>
                : <span className="text-text-primary">{view.design.label}</span>}
              , version {view.design.version}.
            </p>
            {view.design.screens.length ? (
              <p className="text-meta text-text-secondary">Screens: {view.design.screens.join(', ')}</p>
            ) : null}
            {view.design.changedSince ? (
              <p className="text-body text-status-warning" data-testid="spec-page-design-changed">
                The design changed since approval: it is at version {view.design.changedSince.current}, and revision {view.reading.revision} was approved with version {view.design.changedSince.pinned}.
              </p>
            ) : null}
          </div>
        ) : null}
        {view.repoRefs.length ? (
          <div data-testid="spec-page-repo-refs">
            <p className="text-body text-text-secondary">Repo specs revision {view.reading.revision} cites:</p>
            <ul className="mt-1 flex flex-col font-mono text-meta">
              {view.repoRefs.map((r) => (
                <li key={r.path} className="flex min-h-11 items-center [overflow-wrap:anywhere]">
                  {r.href
                    ? <a href={r.href} className="underline hover:text-text-primary" rel="noreferrer" target="_blank">{r.path} @ {r.sha}</a>
                    : <span>{r.path} @ {r.sha}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section> : null}

      <Section title="Files">
        <SpecAttachments
          specId={spec.id}
          revision={view.reading.revision}
          attachments={view.attachments ?? []}
          canAttach={view.canComment}
          isHead={view.reading.isHead}
        />
      </Section>

      <Section title="Comments">
        <SpecComments
          specId={spec.id}
          revision={view.reading.revision}
          comments={view.comments}
          anchors={view.commentAnchors}
          canComment={view.canComment}
          canResolve={view.canComment}
        />
      </Section>

      <Section title="Revisions">
        {numbers.length > 1 ? <Compare specId={spec.id} revisions={numbers} from={defaultFrom} to={spec.headRevision} /> : null}
        <ul className="mt-2 flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-page-revisions">
          {view.revisions.map((r) => (
            <li key={r.revision} className="flex flex-col gap-0.5 py-2" data-testid="spec-page-revision" data-revision={r.revision}>
              <span className="flex flex-wrap items-baseline gap-x-2 text-body text-text-primary">
                <Link href={`${base}?revision=${r.revision}`} className="inline-flex min-h-11 items-center font-medium underline md:min-h-0">
                  Revision {r.revision}
                </Link>
                <span className="text-meta text-text-muted">
                  by {r.author === 'person' ? 'a person' : 'an agent'} · {r.createdAgo}
                </span>
              </span>
              {r.changeSummary ? <span className="text-meta text-text-secondary [overflow-wrap:anywhere]">{r.changeSummary}</span> : null}
              {r.approvedAt ? (
                <span className="text-meta text-status-success" data-testid="spec-page-approved-by">
                  Approved by {r.approvedBy} {r.approvedAgo}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      {/* A long spec would push its history out of reach, so the body reads last. */}
      {focused ? null : main}
    </div>
  );
}
