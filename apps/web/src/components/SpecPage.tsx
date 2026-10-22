'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import Card from '@/components/ui/Card';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction, { primaryActionClass } from '@/components/ui/PrimaryAction';
import Spinner from '@/components/Spinner';
import Section from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import MarkdownContent from '@/components/MarkdownContent';
import SpecDiffView from '@/components/SpecDiffView';
import SpecReviewChanges from '@/components/SpecReviewChanges';
import SpecCriterionHistory from '@/components/SpecCriterionHistory';
import Disclosure from '@/components/ui/Disclosure';
import SpecComments from '@/components/SpecComments';
import SpecAttachments from '@/components/SpecAttachments';
import SpecNeighbourGraph from '@/components/SpecNeighbourGraph';
import Segmented from '@/components/ui/Segmented';
import { neighbourGraph } from '@/lib/specs/index-view';
import SpecFiling from '@/components/SpecFiling';
import SpecRepoChecksFetch from '@/components/SpecRepoChecksFetch';
import SpecDelivery from '@/components/SpecDelivery';
import SpecRetire from '@/components/SpecRetire';
import { useHideAskButton } from '@/lib/ask-button-hidden';
import type { SpecPageView, SpecPanes } from '@/lib/specs/page-view';
import { nativeHistoryData } from '@/lib/native-history';
import type { CriterionMark } from '@/lib/specs/delivery-words';

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
  // "draft, never approved" is right above; saying it again adds nothing.
  if (approved == null) return waits || null;
  return `You're reading revision ${n}. Revision ${approved} is approved.${waits ? ` ${waits}` : ''}`;
}

/**
 * The work marks shown under each criterion of the revision being read: the
 * work built to it, and, on the revision in force, work built to an older
 * one whose verdict judged words this revision has changed ("Passed an
 * earlier wording", R-13).
 */
export function criterionMarks(v: Pick<Ok, 'delivery' | 'reading'>): Array<{ criterionId: string; mark: CriterionMark; title: string; href: string }> {
  return (v.delivery?.entries ?? []).flatMap((e) => e.criteria
    .filter((c) => e.builtTo === v.reading.revision || (v.reading.approved && (c.mark === 'earlier-pass' || c.mark === 'earlier-fail')))
    .map((c) => ({ criterionId: c.criterionId, mark: c.mark, title: e.title, href: e.href })));
}

/** The body without a first heading that only repeats the page title. */
export function withoutRepeatedTitle(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!m) return body;
  const norm = (t: string) => t.replace(/[*_`]/g, '').trim().toLowerCase();
  return norm(m[1]) === norm(title) ? body.slice(m[0].length).replace(/^\s*\n/, '') : body;
}

/**
 * Where the page's one decision sits. On a phone a bar stuck to the bottom of
 * the screen: it renders last in its block, so it stays in view while the
 * reader scrolls the text above it. The layout's <main> already pads for the
 * bottom nav, so `bottom` adds only the home-indicator inset (MobileSaveBar).
 * On desktop the bottom-right corner the Ask button otherwise holds, which
 * hides while this is on screen. The decision is the thing to find; Ask is ⌘K away.
 */
function ActionDock({ label, children }: { label: string; children: ReactNode }) {
  useHideAskButton(true);
  return (
    <div
      role="region"
      aria-label={label}
      className="sticky bottom-[env(safe-area-inset-bottom,0px)] z-10 -mx-4 border-t border-border-default bg-surface-1/95 px-4 py-3 backdrop-blur md:fixed md:bottom-6 md:left-auto md:right-6 md:z-30 md:mx-0 md:max-w-sm md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none"
      data-testid="spec-page-action-dock"
    >
      {children}
    </div>
  );
}

type ConfirmReply = { error?: string; confirmed?: Array<{ specId: string }>; skipped?: Array<{ specId: string; reason: string; message: string }>; pending?: unknown };
const sentence = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;

/**
 * What a press of Confirm import says (§18, R-19): approved, or why not. The
 * route re-checks the repo file and the revision read; a stale file or a newer
 * import comes back skipped, and nothing is approved.
 */
export function confirmImportResult(status: number, body: ConfirmReply, revision: number): { tone: 'ok' | 'warn' | 'err'; text: string } {
  if (status === 200 && body.confirmed?.length) return { tone: 'ok', text: `Confirmed. Revision ${revision} is approved, and buildd is its source now.` };
  const skip = body.skipped?.[0];
  if (status === 200 && skip) return { tone: 'warn', text: skip.reason === 'not_imported' ? 'This import was already confirmed. Reload to see it.' : sentence(skip.message) };
  if (status === 202) return { tone: 'warn', text: 'Confirm it from your own buildd session on the specs page.' };
  return { tone: status === 409 ? 'warn' : 'err', text: body.error ?? 'Could not confirm the import. Try again.' };
}

/** The one act on an unconfirmed import: a person confirms the revision they read. */
function ConfirmImport({ specId, workspaceId, revision }: { specId: string; workspaceId: string; revision: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const confirm = async () => {
    setBusy(true);
    const res = await fetch('/api/specs/import/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specIds: [specId], expectedRevisions: { [specId]: revision } }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as ConfirmReply | undefined;
    const r = res ? confirmImportResult(res.status, body ?? {}, revision) : { tone: 'err' as const, text: 'Could not reach buildd. Try again.' };
    setBusy(false);
    setResult(r);
    if (r.tone === 'ok') router.refresh();
  };
  return (
    <div className="flex flex-col gap-2">
      {result ? <Notice tone={result.tone} data-testid="spec-page-confirm-import-result">{result.text}</Notice> : null}
      {result?.tone === 'ok' ? null : (
        <div>
          <PrimaryAction onClick={confirm} pending={busy} fullWidthOnMobile data-testid="spec-page-confirm-import">
            Confirm import
          </PrimaryAction>
        </div>
      )}
    </div>
  );
}

/**
 * An import waiting for confirmation (§18, R-19): what revision N is, that it
 * is a baseline and not a proposed change, and who confirms it. Approve and
 * Review are not offered: the server refuses both until it is confirmed.
 */
function ImportPanel({ specId, c }: { specId: string; c: NonNullable<Ok['importConfirmation']> }) {
  return (
    <section className="flex flex-col gap-1.5" data-testid="spec-page-import" aria-labelledby="spec-import-heading">
      <h2 id="spec-import-heading" className="text-title font-semibold text-text-primary">
        {c.canConfirm ? 'Confirm the import' : 'Imported, waiting for confirmation'}
      </h2>
      <p className="text-body text-text-secondary [overflow-wrap:anywhere]">
        Revision {c.revision} is{' '}
        {c.href ? <a href={c.href} className="font-mono text-meta underline" rel="noreferrer" target="_blank">{c.path}</a> : <span className="font-mono text-meta">{c.path}</span>}{' '}
        at {c.commit}, as the repo has it. Until it is confirmed the repo file is its source: nothing here can be revised or approved.
        {c.canConfirm ? ' Confirming approves it as the baseline.' : ' A person who approves specs here confirms it.'}
      </p>
      <p className="text-body text-text-secondary" data-testid="spec-page-import-no-changes">
        No proposed changes. A change is a new revision after confirming, reviewed against this one.
      </p>
      <p className="flex flex-wrap gap-x-4 text-meta">
        {c.previous ? (
          <Link href={`/app/specs/${specId}?from=${c.previous}&to=${c.revision}`} className="inline-flex min-h-11 items-center text-text-secondary underline hover:text-text-primary md:min-h-0" data-testid="spec-page-import-repo-change">
            What the repo file changed since revision {c.previous}
          </Link>
        ) : null}
        {c.canConfirm ? (
          <Link href={c.batchHref} className="inline-flex min-h-11 items-center text-text-secondary underline hover:text-text-primary md:min-h-0" data-testid="spec-page-import-batch">
            Confirm with the other imports
          </Link>
        ) : null}
      </p>
    </section>
  );
}

function Approve({ specId, revision, expectedVersion }: { specId: string; revision: number; expectedVersion: number }) {
  const router = useRouter();
  const approvedText = `Approved revision ${revision}.`;
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
    <div className="flex flex-col gap-2">
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
    if (res.ok) { setResult({ tone: 'ok', text: 'Adding it to the repo.' }); router.refresh(); return; }
    setResult({ tone: res.status === 409 ? 'warn' : 'err', text: body.error ?? 'Could not publish it. Try again.' });
  };
  return (
    <div className="flex flex-col gap-2">
      {result ? <Notice tone={result.tone} data-testid="spec-page-publish-result">{result.text}</Notice> : null}
      {result?.tone === 'ok' ? null : (
        <div>
          <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={publish} disabled={busy} data-testid="spec-page-publish-anyway">
            Add to repo
          </button>
        </div>
      )}
    </div>
  );
}

/** Living Specs D-43: an owner or admin marks the spec a standard of its workspace, or clears the mark. */
function StandardMark({ specId, standard }: { specId: string; standard: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: { standard: !standard }, reason: standard ? 'Standard mark cleared on the spec page' : 'Marked a standard on the spec page' }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (res.ok) { router.refresh(); return; }
    setError(body.error ?? 'Standard mark not changed. Retry.');
  };
  return (
    <div className="flex flex-col gap-2">
      {error ? <Notice tone="err" data-testid="spec-page-standard-error">{error}</Notice> : null}
      <div>
        <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={toggle} disabled={busy} data-testid="spec-page-standard-toggle">
          {standard ? 'Stop applying to every change' : 'Apply to every change'}
        </button>
      </div>
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

type ReviewPanes = SpecPanes & { version?: number };
const REVIEW_UNREAD = 'The changes could not be read. Reload to try again.';

/**
 * What approving the waiting revision puts in force (R-1 to R-8): from the
 * server when the page was loaded with ?review=1, else fetched on the press,
 * with the heading and a loading line shown at once (focus moves to it).
 *
 * A change to an approved revision leads with the change summary and the
 * per-criterion change list; the line diff is behind "Show line diff", never
 * the default. With nothing approved, approving puts the whole spec in force,
 * so it shows the spec itself, rendered (a diff against nothing is every line
 * added), led by what this revision changed from the one before, if any.
 */
function ReviewPanel({ spec, waiting, initial, repoChecks }: { spec: Ok['spec']; waiting: number; initial: SpecPanes | null; repoChecks: boolean }) {
  const [panes, setPanes] = useState<ReviewPanes | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Opened by the Review press, not a page load: take the reader to it.
  const pressed = useRef(!initial);
  useEffect(() => { if (pressed.current) heading.current?.focus(); }, []);
  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch(`/api/specs/${encodeURIComponent(spec.id)}/diff?review=1`)
      .then(async (res) => {
        const b = (await res.json().catch(() => ({}))) as { review?: ReviewPanes; error?: string };
        if (!live) return;
        if (res.ok && b.review) setPanes(b.review);
        else setError(b.error ?? REVIEW_UNREAD);
      })
      .catch(() => { if (live) setError(REVIEW_UNREAD); });
    return () => { live = false; };
  }, [spec.id, initial]);
  const revision = panes?.revision ?? waiting;
  const replaces = panes ? panes.replaces : spec.approvedRevision;
  const summary = panes?.changes?.summary?.trim();
  return (
    <section className="flex flex-col gap-3" data-testid="spec-page-review-panel" aria-labelledby="spec-review-heading" aria-busy={!panes && !error}>
      <h2 id="spec-review-heading" ref={heading} tabIndex={-1} className="text-title font-semibold text-text-primary focus:outline-none">
        {replaces ? `Revision ${revision} replaces revision ${replaces}` : `Review revision ${revision}`}
      </h2>
      {error ? (
        <Notice tone="warn" data-testid="spec-page-review-error">{error}</Notice>
      ) : panes ? (
        <>
          {panes.replaces ? (
            <>
              {panes.changes ? <SpecReviewChanges {...panes.changes} /> : null}
              {repoChecks ? <SpecRepoChecksFetch specId={spec.id} /> : null}
              <Disclosure
                summary={<span data-testid="spec-page-full-diff">Show line diff <span className="font-mono text-meta"><span className="text-status-success">+{panes.linesAdded}</span> <span className="text-status-error">−{panes.linesRemoved}</span></span></span>}
                defaultOpen={!panes.changes}
              >
                <div className="mt-2"><SpecDiffView hunks={panes.hunks} omittedLines={panes.omittedLines} /></div>
              </Disclosure>
            </>
          ) : (
            <>
              <p className="text-body text-text-secondary" data-testid="spec-page-review-first">First approval. Approving puts the whole spec in force.</p>
              {panes.since ? (
                <section className="flex flex-col gap-2" aria-labelledby="spec-review-since-heading" data-testid="spec-page-review-since">
                  <h3 id="spec-review-since-heading" className="text-body font-semibold text-text-primary">Changed since revision {panes.since.revision}</h3>
                  <SpecReviewChanges {...panes.since.changes} />
                </section>
              ) : summary ? <p className="whitespace-pre-line text-lede text-text-primary [overflow-wrap:anywhere]" data-testid="spec-review-summary">{summary}</p> : null}
              {repoChecks ? <SpecRepoChecksFetch specId={spec.id} /> : null}
              {panes.since ? <h3 className="text-body font-semibold text-text-primary">The whole spec</h3> : null}
              <Card as="article" className="md:p-8" data-testid="spec-page-review-body" aria-label={`Revision ${panes.revision} of the spec`}>
                <MarkdownContent content={withoutRepeatedTitle(panes.body, spec.title)} images="link" surface="spec" attachments={panes.attachmentSources ?? {}} criterionSpecId={spec.id} />
              </Card>
            </>
          )}
          {/* Last in the panel, so on a phone it stays in view while the reader scrolls it; in the Ask corner on desktop. */}
          <ActionDock label="Decision">
            <Approve specId={spec.id} revision={panes.revision} expectedVersion={panes.version ?? spec.version} />
          </ActionDock>
        </>
      ) : (
        <>
          {repoChecks ? <SpecRepoChecksFetch specId={spec.id} /> : null}
          <p className="flex items-center gap-2 text-meta text-text-muted" data-testid="spec-page-review-loading">
            <Spinner size="sm" aria-label="Reading the changes" /> Reading what changed…
          </p>
        </>
      )}
    </section>
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
  const importing = view.importConfirmation ?? null;
  // An unconfirmed import has its own panel; the reading line would only repeat it.
  const line = importing ? null : readingLine(view);
  // Review is the address (?review=1), but pressing it is not a navigation: the
  // URL changes in place (no server render, R-7) and the panel fetches itself.
  const params = useSearchParams();
  const reviewing = !!view.canApprove && !!view.waiting && (!!view.review || params.get('review') === '1');
  const reviewLink = view.canApprove && view.waiting && !reviewing;
  const openReview = (e: MouseEvent<HTMLAnchorElement>) => {
    // A new tab or window still opens the link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.history.pushState(nativeHistoryData(window.history.state), '', `${base}?review=1`);
  };

  const main = (
    reviewing && view.waiting ? (
      <ReviewPanel spec={spec} waiting={view.waiting} initial={view.review} repoChecks={!!view.repoChecks} />
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
      <>
        {view.criterionHistory ? (
          <SpecCriterionHistory specId={spec.id} criterionId={view.criterionHistory.criterionId} history={view.criterionHistory.history} />
        ) : null}
        <Card as="article" className="md:p-8" data-testid="spec-page-body" aria-label={`Revision ${view.reading.revision} of the spec`}>
          <MarkdownContent content={withoutRepeatedTitle(view.body, spec.title)} images="link" surface="spec" attachments={view.attachmentSources ?? {}}
            criterionVerdicts={criterionMarks(view)} criterionSpecId={spec.id} />
        </Card>
      </>
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
            <Sub>Also under {view.parent.title}</Sub>
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
            <Sub>Related</Sub>
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
          const here = r.revision === view.reading.revision && !reviewing && !view.compare;
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
                {r.revision === spec.approvedRevision ? <span className="text-meta font-medium text-status-success">approved</span> : null}
                {r.revision === view.waiting ? <span className="text-meta font-medium text-status-warning">waiting</span> : null}
                {importing && r.revision === importing.revision ? <span className="text-meta font-medium text-status-info">imported</span> : null}
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
        <p className="text-meta text-text-muted">
          {spec.scope} · {view.standing}
          {view.standard ? <> · <span className="font-medium text-text-secondary" data-testid="spec-page-standard">standard, applies to every change</span></> : null}
        </p>
        {/* An unconfirmed import names its file and commit in its own panel, below. */}
        {importing ? null : view.source?.path ? (
          <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">
            {view.source.href ? <a href={view.source.href} className="font-mono underline">{view.source.path}</a> : <span className="font-mono">{view.source.path}</span>}
          </p>
        ) : view.source?.source ? <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">{view.source.source}</p> : null}
      </header>

      {view.retirement ? <SpecRetire specId={spec.id} retirement={view.retirement} canRetire={!!view.canRetire} /> : null}

      {view.source?.copy ? (
        view.source.behind
          ? <Notice tone="warn" data-testid="spec-page-repo-copy">{view.source.copy}</Notice>
          : <p className="text-meta text-text-muted" data-testid="spec-page-repo-copy">{view.source.copy}</p>
      ) : null}
      {view.canPublishAnyway ? <PublishAnyway specId={spec.id} /> : null}
      {view.canMarkStandard ? <StandardMark specId={spec.id} standard={!!view.standard} /> : null}
      {view.criteriaUnread ? <Notice tone="warn" data-testid="spec-page-criteria-unread">{view.criteriaUnread}</Notice> : null}

      {line ? <Lede><span data-testid="spec-page-reading">{line}</span></Lede> : null}
      {importing ? <ImportPanel specId={spec.id} c={importing} /> : null}

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

      {/* Last on the page, so on a phone it stays in view the whole way down. */}
      {importing?.canConfirm ? (
        <ActionDock label="Decision">
          <ConfirmImport specId={spec.id} workspaceId={spec.workspaceId} revision={importing.revision} />
        </ActionDock>
      ) : reviewLink ? (
        <ActionDock label="Decision">
          <a href={`${base}?review=1`} onClick={openReview} className={primaryActionClass({ fullWidthOnMobile: true })} data-testid="spec-page-review">
            Review revision {view.waiting}
          </a>
        </ActionDock>
      ) : null}
    </div>
  );
}
