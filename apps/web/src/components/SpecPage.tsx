'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
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
import SpecDelivery from '@/components/SpecDelivery';
import SpecRetire from '@/components/SpecRetire';
import { useHideAskButton } from '@/lib/ask-button-hidden';
import type { SpecPageView } from '@/lib/specs/page-view';

type Ok = Extract<SpecPageView, { state: 'ok' }>;

/**
 * The one sentence that says which revision this is and what waits, or null
 * when the header already says it all (reading the approved revision with
 * nothing waiting: "approved at revision N" is right above).
 */
export function readingLine(v: Pick<Ok, 'reading' | 'waiting' | 'spec'> & { canApprove?: boolean }): string | null {
  const n = v.reading.revision;
  const approved = v.spec.approvedRevision;
  const other = v.waiting && v.waiting !== n ? v.waiting : null;
  const waits = other ? `Revision ${other} waits for ${v.canApprove ? 'your ' : ''}approval.` : '';
  if (v.reading.approved) return waits || null;
  if (approved == null) return `Nothing is approved yet.${waits ? ` ${waits}` : ''}`;
  return `This is revision ${n}. Revision ${approved} is the approved one.${waits ? ` ${waits}` : ''}`;
}

/** The body without a first heading that only repeats the page title. */
export function withoutRepeatedTitle(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!m) return body;
  const norm = (t: string) => t.replace(/[*_`]/g, '').trim().toLowerCase();
  return norm(m[1]) === norm(title) ? body.slice(m[0].length).replace(/^\s*\n/, '') : body;
}

/**
 * Where the page's one primary action sits: inline on a phone, and on desktop
 * in the bottom-right corner the Ask button otherwise holds, which hides
 * while this is on screen. The approval is the thing to find; Ask is ⌘K away.
 */
function ActionDock({ children }: { children: ReactNode }) {
  useHideAskButton(true);
  return (
    <div className="md:fixed md:bottom-6 md:right-6 md:z-30 md:max-w-sm" data-testid="spec-page-action-dock">
      {children}
    </div>
  );
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

/** Slice 14, R-68: publish a revision the policy kept private. A person's call, recorded as an override. */
function PublishAnyway({ specId }: { specId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const publish = async () => {
    setBusy(true);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/publish`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (res.ok) { setResult({ tone: 'ok', text: 'Publishing it: the repo copy is on its way.' }); router.refresh(); return; }
    setResult({ tone: res.status === 409 ? 'warn' : 'err', text: body.error ?? 'Could not publish it. Try again.' });
  };
  return (
    <div className="flex flex-col gap-2">
      {result ? <Notice tone={result.tone} data-testid="spec-page-publish-result">{result.text}</Notice> : null}
      {result?.tone === 'ok' ? null : (
        <div>
          <button type="button" className="btn btn-sm h-11 md:h-8" onClick={publish} disabled={busy} data-testid="spec-page-publish-anyway">
            Publish anyway
          </button>
        </div>
      )}
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

/** A small heading inside Related, so a screen reader can jump between its parts. */
function Sub({ children }: { children: ReactNode }) {
  return <h3 className="text-meta font-semibold text-text-secondary">{children}</h3>;
}

/**
 * One spec (living-specs.md §9): the revision in force rendered, its history,
 * the changes between any two revisions and, for a person who may approve,
 * the waiting revision with one Approve action (§6's route; nothing new).
 *
 * Desktop reads as a document with a rail: the text, Related and Comments in
 * the main column; Revisions and Files beside it. A phone stacks them, the
 * text first, with jump links to the rest.
 */
export default function SpecPage({ view }: { view: Ok }) {
  const { spec } = view;
  const base = `/app/specs/${spec.id}`;
  const numbers = view.revisions.map((r) => r.revision);
  const defaultFrom = spec.approvedRevision && spec.approvedRevision !== spec.headRevision ? spec.approvedRevision : Math.max(1, spec.headRevision - 1);

  const graph = neighbourGraph({ spec, parent: view.parent, siblings: view.siblings ?? [], nearby: view.nearby });
  const hasGraph = !!(graph.parent || graph.siblings.length || graph.neighbours.length);
  const [relatedView, setRelatedView] = useState<'list' | 'graph'>('list');
  // Related renders only when something sits under it: no empty heading.
  const hasRelated = hasGraph || !!view.filing || view.children.length > 0 || !!view.design || view.repoRefs.length > 0;
  const line = readingLine(view);
  const reviewLink = view.canApprove && view.waiting && !view.review;

  const main = (
    view.review ? (
      <section className="flex flex-col gap-3" data-testid="spec-page-review-panel" aria-labelledby="spec-review-heading">
        <h2 id="spec-review-heading" className="text-title font-semibold text-text-primary">
          {view.review.replaces ? `Revision ${view.review.revision} replaces revision ${view.review.replaces}` : `Revision ${view.review.revision} (nothing approved yet)`}
        </h2>
        {/* Above the text it approves on a phone; in the Ask corner on desktop. */}
        <ActionDock>
          <Approve specId={spec.id} revision={view.review.revision} expectedVersion={spec.version} />
        </ActionDock>
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
            <h2 className="text-title font-semibold text-text-primary">
              Changes from revision {view.compare.from} to revision {view.compare.to}
            </h2>
            <SpecDiffView hunks={view.compare.hunks} omittedLines={view.compare.omittedLines} />
          </>
        )}
      </section>
    ) : (
      <Card as="article" className="md:p-8" data-testid="spec-page-body" aria-label={`Revision ${view.reading.revision} of the spec`}>
        <MarkdownContent content={withoutRepeatedTitle(view.body, spec.title)} images="link" surface="spec" attachments={view.attachmentSources ?? {}} />
      </Card>
    )
  );

  const related = hasRelated ? (
    <Section title="Related" id="related">
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
        <div className="mt-3 hidden md:block" data-testid="spec-page-graph">
          <SpecNeighbourGraph graph={graph} />
        </div>
      ) : null}
      {/* The list is the default, and below md the only view: the graph needs the width (R-29). */}
      <div className={`mt-3 flex flex-col gap-4 ${hasGraph && relatedView === 'graph' ? 'md:hidden' : ''}`} data-testid="spec-page-related-list">
        {view.parent ? (
          <p className="text-body text-text-secondary" data-testid="spec-page-parent">
            Part of <Link href={`/app/specs/${view.parent.id}`} className="text-text-primary underline">{view.parent.title}</Link>
          </p>
        ) : null}
        {view.parent && (view.siblings ?? []).length > 0 ? (
          <div data-testid="spec-page-siblings">
            <Sub>Alongside it under {view.parent.title}</Sub>
            <ul className="mt-1 flex flex-col">
              {(view.siblings ?? []).map((c) => (
                <li key={c.id}>
                  <Link href={`/app/specs/${c.id}`} className="flex min-h-11 items-center text-body text-text-primary underline md:min-h-9 [overflow-wrap:anywhere]">{c.title}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {view.children.length ? (
          <div data-testid="spec-page-children">
            <Sub>Under this spec</Sub>
            <ul className="mt-1 flex flex-col">
              {view.children.map((c) => (
                <li key={c.id}>
                  <Link href={`/app/specs/${c.id}`} className="flex min-h-11 items-center text-body text-text-primary underline md:min-h-9 [overflow-wrap:anywhere]">{c.title}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {view.nearby.length ? (
          <div data-testid="spec-page-nearby">
            <Sub>Nearby, from their text and their work</Sub>
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
      {view.design ? (
        <div className="mt-4" data-testid="spec-page-design">
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
        <div className="mt-4" data-testid="spec-page-repo-refs">
          <Sub>Repo specs revision {view.reading.revision} cites</Sub>
          <ul className="mt-1 flex flex-col font-mono text-meta">
            {view.repoRefs.map((r) => (
              <li key={r.path} className="flex min-h-11 items-center [overflow-wrap:anywhere] md:min-h-9">
                {r.href
                  ? <a href={r.href} className="underline hover:text-text-primary" rel="noreferrer" target="_blank">{r.path} @ {r.sha}</a>
                  : <span>{r.path} @ {r.sha}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  ) : null;

  const comments = (
    <Section title="Comments" id="comments">
      <SpecComments
        specId={spec.id}
        revision={view.reading.revision}
        comments={view.comments}
        anchors={view.commentAnchors}
        canComment={view.canComment}
        canResolve={view.canComment}
      />
    </Section>
  );

  const revisions = (
    <Section title="Revisions" id="revisions">
      {numbers.length > 1 ? <Compare specId={spec.id} revisions={numbers} from={defaultFrom} to={spec.headRevision} /> : null}
      <ol className="mt-2 flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-page-revisions">
        {view.revisions.map((r) => {
          const here = r.revision === view.reading.revision && !view.review && !view.compare;
          return (
            <li key={r.revision} className="flex flex-col gap-0.5 py-2" data-testid="spec-page-revision" data-revision={r.revision}>
              <span className="flex flex-wrap items-baseline gap-x-2 text-body text-text-primary">
                <Link
                  href={`${base}?revision=${r.revision}`}
                  aria-current={here ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center underline md:min-h-0 ${here ? 'font-semibold' : 'font-medium'}`}
                >
                  Revision {r.revision}
                </Link>
                {r.revision === spec.approvedRevision ? <span className="text-meta font-medium text-status-success">in force</span> : null}
                {r.revision === view.waiting ? <span className="text-meta font-medium text-status-warning">waiting</span> : null}
                <span className="text-meta text-text-muted">
                  by {r.author === 'person' ? 'a person' : 'an agent'}, {r.createdAgo}
                </span>
              </span>
              {r.changeSummary ? <span className="text-meta text-text-secondary [overflow-wrap:anywhere]">{r.changeSummary}</span> : null}
              {r.approvedAt ? (
                <span className="text-meta text-text-muted" data-testid="spec-page-approved-by">
                  Approved by {r.approvedBy} {r.approvedAgo}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );

  const files = (
    <Section title="Files" id="files">
      <SpecAttachments
        specId={spec.id}
        revision={view.reading.revision}
        attachments={view.attachments ?? []}
        canAttach={view.canComment}
        isHead={view.reading.isHead}
      />
    </Section>
  );

  const hasDelivery = !!view.delivery?.entries.length;
  const jumps = [
    hasDelivery ? { href: '#delivery', label: 'Delivery' } : null,
    hasRelated ? { href: '#related', label: 'Related' } : null,
    { href: '#comments', label: 'Comments' },
    { href: '#revisions', label: 'Revisions' },
    { href: '#files', label: 'Files' },
  ].filter((j): j is { href: string; label: string } => !!j);

  return (
    <div className="flex flex-col gap-4 md:pb-24">
      <header className="flex flex-col gap-1">
        <Link href={`/app/workspaces/${spec.workspaceId}/specs`} className="inline-flex min-h-11 items-center self-start text-meta text-text-muted hover:text-text-primary md:min-h-0">
          {spec.workspaceName ? `Specs in ${spec.workspaceName}` : 'Specs'}
        </Link>
        <h1 className="font-voice text-2xl text-text-primary [overflow-wrap:anywhere] md:text-3xl" data-testid="spec-page-title">{spec.title}</h1>
        <p className="text-meta text-text-muted">{spec.scope} · {view.standing}</p>
        {view.source ? <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">{view.source.source}</p> : null}
      </header>

      {view.retirement ? <SpecRetire specId={spec.id} retirement={view.retirement} canRetire={!!view.canRetire} /> : null}

      {view.source?.copy ? (
        view.source.behind
          ? <Notice tone="warn" data-testid="spec-page-repo-copy">{view.source.copy}</Notice>
          : <p className="text-meta text-text-muted" data-testid="spec-page-repo-copy">{view.source.copy}</p>
      ) : null}
      {view.canPublishAnyway ? <PublishAnyway specId={spec.id} /> : null}

      {line ? <Lede><span data-testid="spec-page-reading">{line}</span></Lede> : null}

      {reviewLink ? (
        <ActionDock>
          <PrimaryAction href={`${base}?review=1`} fullWidthOnMobile data-testid="spec-page-review">
            Review revision {view.waiting}
          </PrimaryAction>
        </ActionDock>
      ) : null}

      <nav aria-label="On this page" className="flex flex-wrap gap-x-4 text-meta lg:hidden" data-testid="spec-page-jumps">
        {jumps.map((j) => (
          <a key={j.href} href={j.href} className="inline-flex min-h-11 items-center text-text-secondary underline hover:text-text-primary">{j.label}</a>
        ))}
      </nav>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-10">
        <div className="flex min-w-0 flex-col gap-4">
          {main}
          <SpecDelivery specId={spec.id} delivery={view.delivery} />
          {related}
          {comments}
        </div>
        <aside aria-label="Revisions and files" className="flex min-w-0 flex-col lg:border-l lg:border-[var(--line-soft)] lg:pl-6">
          {revisions}
          {files}
          {/* Secondary, never the Approve corner (§22 R-54). */}
          {!view.retirement && view.canRetire ? <SpecRetire specId={spec.id} retirement={null} canRetire targets={view.retireTargets ?? []} /> : null}
        </aside>
      </div>
    </div>
  );
}
