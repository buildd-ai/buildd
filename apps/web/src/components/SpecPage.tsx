'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import Card from '@/components/ui/Card';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Notice from '@/components/ui/Notice';
import PrimaryAction, { primaryActionClass } from '@/components/ui/PrimaryAction';
import Sheet from '@/components/ui/Sheet';
import SideSheet from '@/components/SideSheet';
import Spinner from '@/components/Spinner';
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
 * The page's one status line ("Spec page layout", R-92, R-97, R-100): a badge
 * and a few words. It says nothing about which revision is read when that is
 * the approved one and nothing waits (R-91): the badge already says Approved.
 */
export function statusLine(v: Pick<Ok, 'spec' | 'reading' | 'waiting' | 'canApprove' | 'importConfirmation' | 'retirement'>): { badge: string; tone: ChipTone; words: string | null } {
  if (v.retirement || v.spec.status === 'retired' || v.spec.status === 'superseded') {
    const r = v.retirement;
    // "Replaced by <spec>" carries a link, so the page writes it, not this string.
    return { badge: 'Retired', tone: 'muted', words: r ? (r.supersededBy ? null : `Retired: ${r.reason}`) : null };
  }
  const imp = v.importConfirmation;
  if (imp) {
    return { badge: 'Imported', tone: 'info', words: imp.canConfirm ? 'Repo file is the source until you confirm' : 'Repo file is the source until an approver confirms it' };
  }
  const n = v.reading.revision;
  const approved = v.spec.approvedRevision;
  const yours = v.waiting && v.canApprove ? ' Waits for your approval.' : '';
  const words = approved == null
    ? `${v.reading.isHead ? '' : `You're reading revision ${n}. `}Never approved.${yours}`
    : v.reading.approved
      ? (v.waiting ? `Approved at revision ${approved}.${yours}` : null)
      : `You're reading revision ${n}. Revision ${approved} is approved.${yours}`;
  if (v.waiting) return { badge: `Revision ${v.waiting} waiting`, tone: 'warning', words };
  if (approved != null) return { badge: 'Approved', tone: 'success', words };
  return { badge: 'Draft', tone: 'muted', words };
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

const plain = (t: string) => t.replace(/[*_`]/g, '').trim();

/**
 * The body's own leading level-one heading and the body without it (R-94):
 * the page shows one title, so that heading is never rendered again.
 */
export function splitLeadingTitle(body: string): { heading: string | null; rest: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!m) return { heading: null, rest: body };
  return { heading: plain(m[1]), rest: body.slice(m[0].length).replace(/^\s*\n/, '') };
}

/** The text's own title when it is not the spec's, for "Titled in the text: …" (R-94). */
export function textTitle(body: string, title: string): string | null {
  const { heading } = splitLeadingTitle(body);
  return heading && heading.toLowerCase() !== plain(title).toLowerCase() ? heading : null;
}

/**
 * The body's sections (level-two headings, outside code fences) and the
 * criteria in each (R-95). The page lists them in Contents when there are at
 * least three; the n-th entry is the n-th `h2` of the rendered body.
 */
export function specContents(body: string): Array<{ title: string; criteria: number }> {
  const out: Array<{ title: string; criteria: number }> = [];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { out.push({ title: plain(h[1]), criteria: 0 }); continue; }
    if (out.length && /^\s*[-*+]\s+(?:\*\*)?(?:R|AC)-\d+\b/.test(line)) out[out.length - 1].criteria++;
  }
  return out;
}

/**
 * Where the page's one primary action sits (R-96, R-99). Below lg a bar stuck
 * to the bottom of the scroll area: it is last in the page's flow, so at the
 * end of the text it sits under the last line instead of over it, and the
 * layout's <main> already pads for the bottom nav (sticky insets are measured
 * inside that padding), so `bottom` adds only the home-indicator inset
 * (MobileSaveBar). From lg it is the top of the rail. Ask hides while it shows:
 * on a phone it would sit on the bar; it is ⌘K away.
 */
function ActionDock({ children }: { children: ReactNode }) {
  useHideAskButton(true);
  return (
    <div
      role="region"
      aria-label="Decision"
      className="sticky bottom-[env(safe-area-inset-bottom,0px)] z-10 -mx-4 border-t border-border-default bg-surface-1/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8 lg:static lg:col-start-2 lg:row-start-1 lg:mx-0 lg:mb-6 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
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
        <PrimaryAction onClick={confirm} pending={busy} fullWidthOnMobile data-testid="spec-page-confirm-import">
          Confirm import
        </PrimaryAction>
      )}
    </div>
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
        <PrimaryAction onClick={approve} fullWidthOnMobile data-testid="spec-page-approve">
          Approve revision {revision}
        </PrimaryAction>
      ) : null}
    </div>
  );
}

/** A retired spec's one action for a person who may (§22, R-54): put it back in force. */
function Restore({ specId }: { specId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/retire`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (res?.ok) router.refresh();
    else setError(body?.error ?? 'Could not restore the spec. Try again.');
  };
  return (
    <div className="flex flex-col gap-2">
      {error ? <Notice tone="err">{error}</Notice> : null}
      <PrimaryAction onClick={restore} pending={busy} fullWidthOnMobile data-testid="spec-restore">Restore</PrimaryAction>
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
        <button type="button" className={MORE_ROW} onClick={publish} disabled={busy} data-testid="spec-page-publish-anyway">
          Add to repo
        </button>
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
      <button type="button" className={MORE_ROW} onClick={toggle} disabled={busy} data-testid="spec-page-standard-toggle">
        {standard ? 'Stop applying to every change' : 'Apply to every change'}
      </button>
    </div>
  );
}

type ReviewPanes = SpecPanes & { version?: number };
const REVIEW_UNREAD = 'The changes could not be read. Reload to try again.';

/**
 * What approving the waiting revision puts in force (R-1 to R-8): from the
 * server when the page was loaded with ?review=1, else fetched on the press,
 * with the heading and a loading line shown at once (focus moves to it).
 * Once read, the panes go up to the page, whose action slot holds Approve.
 *
 * A change to an approved revision leads with the change summary and the
 * per-criterion change list; the line diff is behind "Show line diff", never
 * the default. With nothing approved, approving puts the whole spec in force,
 * so it shows the spec itself, rendered (a diff against nothing is every line
 * added), led by what this revision changed from the one before, if any.
 */
function ReviewPanel({ spec, waiting, initial, repoChecks, onRead }: { spec: Ok['spec']; waiting: number; initial: SpecPanes | null; repoChecks: boolean; onRead: (p: ReviewPanes | null) => void }) {
  const [panes, setPanes] = useState<ReviewPanes | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Opened by the Review press, not a page load: take the reader to it.
  const pressed = useRef(!initial);
  useEffect(() => { if (pressed.current) heading.current?.focus(); }, []);
  useEffect(() => { onRead(panes); return () => onRead(null); }, [panes, onRead]);
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
        panes.replaces ? (
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
              <MarkdownContent content={splitLeadingTitle(panes.body).rest} images="link" surface="spec" attachments={panes.attachmentSources ?? {}} criterionSpecId={spec.id} />
            </Card>
          </>
        )
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

const MORE_ROW = 'flex min-h-11 w-full items-center border-t border-border-default text-left text-body text-text-primary hover:bg-card-hover disabled:opacity-50';

type Tab = 'spec' | 'history' | 'related' | 'comments' | 'files';
const TAB_LABEL: Record<Tab, string> = { spec: 'Spec', history: 'History', related: 'Related', comments: 'Comments', files: 'Files' };
const tabId = (t: Tab) => `spec-tab-${t}`;
const panelId = (t: Tab) => `spec-panel-${t}`;

/**
 * Spec · History · Related, and Comments and Files when they have something
 * (R-93). Underlined tabs on a hairline, as on the mission page: one tab stop,
 * ← → / Home / End move between them.
 */
function Tabs({ tabs, counts, active, onPick }: { tabs: Tab[]; counts: Partial<Record<Tab, number>>; active: Tab; onPick: (t: Tab) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.indexOf(active);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : null;
    if (to == null) return;
    e.preventDefault();
    onPick(tabs[to]);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  }
  return (
    <div role="tablist" aria-label="Spec page" onKeyDown={onKeyDown} data-testid="spec-page-tabs" className="flex min-w-0 gap-5 overflow-x-auto border-b border-border-default">
      {tabs.map((t) => {
        const on = t === active;
        return (
          <button
            key={t}
            id={tabId(t)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId(t)}
            tabIndex={on ? 0 : -1}
            data-tab={t}
            onClick={() => onPick(t)}
            className={`-mb-px inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 text-body md:min-h-10 ${on ? 'border-text-primary font-semibold text-text-primary' : 'border-transparent font-medium text-text-muted hover:text-text-primary'}`}
          >
            {TAB_LABEL[t]}
            {counts[t] ? <span className="font-mono text-meta tabular-nums text-text-muted">{counts[t]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** One revision's mark on History (R-98). */
function revisionBadge(r: { revision: number }, view: Ok): { label: string; tone: ChipTone } | null {
  if (r.revision === view.spec.approvedRevision) return { label: 'Approved', tone: 'success' };
  if (view.importConfirmation && r.revision === view.importConfirmation.revision) return { label: 'Imported', tone: 'info' };
  if (r.revision === view.waiting) return { label: 'Waiting', tone: 'warning' };
  return null;
}

/**
 * What the address asks the page to show: a comparison (`?from=&to=`) or one
 * revision's text (`?revision=`). Next.js keeps SpecPage mounted when only the
 * search params change, so state set from the address resets when this does.
 */
function addressKey(view: Pick<Ok, 'compare' | 'reading'>, asked: string | null): string {
  if (!view.compare) return `revision:${view.reading.revision}:${asked ?? ''}`;
  return 'error' in view.compare ? `compare:error:${view.compare.error}` : `compare:${view.compare.from}:${view.compare.to}`;
}

/**
 * History (R-98): every revision newest first, one row each. Picking two
 * enables "Compare N → M", which opens their diff (`?from=N&to=M`, read with
 * `diffSpecRevisions`); a third pick lets go of the oldest one.
 */
function History({ view, base, reviewing, at }: { view: Ok; base: string; reviewing: boolean; at: string }) {
  const initial = view.compare && !('error' in view.compare) ? [view.compare.from, view.compare.to] : [];
  const [picked, setPicked] = useState<number[]>(initial);
  // The page stays mounted across ?from=&to= and ?revision= links: the picks follow the address.
  const [pickedAt, setPickedAt] = useState(at);
  if (pickedAt !== at) {
    setPickedAt(at);
    setPicked(initial);
  }
  const toggle = (n: number) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].slice(-2)));
  const [from, to] = [...picked].sort((a, b) => a - b);
  const ready = picked.length === 2;
  return (
    <div className="flex flex-col gap-3">
      {view.compare ? (
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
      ) : null}
      {view.revisions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="spec-page-compare">
          {ready ? (
            <Link href={`${base}?from=${from}&to=${to}`} className="btn btn-sm h-11 md:h-8" data-testid="spec-page-compare-go">
              Compare {from} → {to}
            </Link>
          ) : (
            <button type="button" disabled className="btn btn-sm h-11 opacity-50 md:h-8" data-testid="spec-page-compare-go">
              Compare
            </button>
          )}
          <span className="text-meta text-text-muted">{ready ? null : picked.length ? 'Pick one more revision.' : 'Pick two revisions to compare.'}</span>
        </div>
      ) : null}
      <ol className="flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-page-revisions">
        {view.revisions.map((r) => {
          const here = r.revision === view.reading.revision && !reviewing && !view.compare;
          const badge = revisionBadge(r, view);
          const on = picked.includes(r.revision);
          return (
            <li key={r.revision} className="flex items-start gap-2 py-2" data-testid="spec-page-revision" data-revision={r.revision}>
              <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center md:min-h-8 md:min-w-8">
                <input type="checkbox" checked={on} onChange={() => toggle(r.revision)} aria-label={`Pick revision ${r.revision} to compare`} data-testid="spec-page-revision-pick" className="h-4 w-4 accent-[var(--color-accent,currentColor)]" />
              </label>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 text-body text-text-primary">
                  <Link
                    href={`${base}?revision=${r.revision}`}
                    aria-current={here ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center underline md:min-h-0 ${here ? 'font-semibold' : 'font-medium'}`}
                  >
                    Revision {r.revision}
                  </Link>
                  {badge ? <Chip tone={badge.tone} variant="soft" dot={false}>{badge.label}</Chip> : null}
                  <span className="text-meta text-text-muted">
                    by {r.author === 'person' ? 'a person' : 'an agent'}, {r.createdAgo}
                  </span>
                </span>
                {r.changeSummary ? <span className="truncate text-meta text-text-secondary" title={r.changeSummary}>{r.changeSummary}</span> : null}
                {r.approvedAt ? (
                  <span className="text-meta text-text-muted" data-testid="spec-page-approved-by">
                    Approved by {r.approvedBy} {r.approvedAgo}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Contents (R-95): the sections and the criteria in each; picking one scrolls to it. */
function ContentsList({ sections, onPick }: { sections: Array<{ title: string; criteria: number }>; onPick: (i: number) => void }) {
  return (
    <ol className="flex flex-col" data-testid="spec-page-contents-list">
      {sections.map((s, i) => (
        <li key={`${i}:${s.title}`}>
          <button type="button" onClick={() => onPick(i)} className="flex min-h-11 w-full items-center gap-2 text-left text-body text-text-primary hover:underline md:min-h-9" data-testid="spec-page-contents-item">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.title}</span>
            {s.criteria ? <span className="shrink-0 font-mono text-meta tabular-nums text-text-muted">{s.criteria}</span> : null}
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * One spec (living-specs.md §9, "Spec page layout" R-92 to R-100): back, one
 * title, one status line, the tabs, then the text. Related specs, History,
 * Comments and Files are tabs, never sections under the text. The page has at
 * most one primary action, in the rail on desktop and in a bottom bar on a
 * phone; everything else is in More.
 */
export default function SpecPage({ view }: { view: Ok }) {
  const { spec } = view;
  const base = `/app/specs/${spec.id}`;

  const graph = neighbourGraph({ spec, parent: view.parent, siblings: view.siblings ?? [], nearby: view.nearby });
  const hasGraph = !!(graph.parent || graph.siblings.length || graph.neighbours.length);
  const [relatedView, setRelatedView] = useState<'list' | 'graph'>('list');
  // Related is a tab only when something sits under it: no empty tab.
  const hasRelated = hasGraph || !!view.filing || view.children.length > 0 || !!view.design || view.repoRefs.length > 0;
  const relatedCount = (view.parent ? 1 : 0) + (view.siblings ?? []).length + view.children.length + view.nearby.length;
  const importing = view.importConfirmation ?? null;
  const status = statusLine(view);
  const { rest: body } = splitLeadingTitle(view.body);
  const titledInText = textTitle(view.body, spec.title);

  // Review is the address (?review=1), but pressing it is not a navigation: the
  // URL changes in place (no server render, R-7) and the panel fetches itself.
  const params = useSearchParams();
  const reviewing = !!view.canApprove && !!view.waiting && (!!view.review || params.get('review') === '1');
  const reviewLink = view.canApprove && view.waiting && !reviewing;
  const [reviewPanes, setReviewPanes] = useState<ReviewPanes | null>(null);
  const openReview = (e: MouseEvent<HTMLAnchorElement>) => {
    // A new tab or window still opens the link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setTab('spec');
    window.history.pushState(nativeHistoryData(window.history.state), '', `${base}?review=1`);
  };

  // Comments and Files are tabs only with something in them, or once asked for from More.
  const [asked, setAsked] = useState<{ comments: boolean; files: boolean }>({ comments: false, files: false });
  const showComments = view.comments.length > 0 || asked.comments;
  const showFiles = (view.attachments ?? []).length > 0 || asked.files;
  const tabs: Tab[] = ['spec', 'history', ...(hasRelated ? ['related' as const] : []), ...(showComments ? ['comments' as const] : []), ...(showFiles ? ['files' as const] : [])];
  const [tab, setTab] = useState<Tab>(view.compare ? 'history' : 'spec');
  // Following "Changed since revision N" or "Revision N" re-renders this same
  // page: a comparison opens History, a revision opens Spec. A tab picked by
  // hand stays put until the address asks for something else.
  const at = addressKey(view, params.get('revision'));
  const [tabAt, setTabAt] = useState(at);
  if (tabAt !== at) {
    setTabAt(at);
    setTab(view.compare ? 'history' : 'spec');
  }
  // An old jump link (#comments, #revisions) still lands on its tab.
  useEffect(() => {
    const h = window.location.hash.slice(1);
    const t = h === 'revisions' ? 'history' : h;
    if (t === 'history' || t === 'related' || t === 'comments' || t === 'files') {
      if (t === 'comments') setAsked((a) => ({ ...a, comments: true }));
      if (t === 'files') setAsked((a) => ({ ...a, files: true }));
      setTab(t);
    }
  }, []);
  const [moreOpen, setMoreOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const openFromMore = (t: 'comments' | 'files') => {
    setAsked((a) => ({ ...a, [t]: true }));
    setTab(t);
    setMoreOpen(false);
  };
  const copyLink = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}${base}`).then(() => setCopied(true), () => setCopied(false));
  };

  const showsBody = !(reviewing && view.waiting);
  const sections = showsBody ? specContents(body) : [];
  const article = useRef<HTMLDivElement>(null);
  // After the sheet has closed and handed focus back to its trigger (which
  // scrolls to it), and after the Spec tab shows: then scroll to the section.
  const pickSection = (i: number) => {
    setContentsOpen(false);
    setTab('spec');
    setTimeout(() => article.current?.querySelectorAll('h2')[i]?.scrollIntoView({ block: 'start' }), 0);
  };
  const marks = criterionMarks(view);
  const marksKey = JSON.stringify(marks);
  // The same element across the page's own state (tab, sheets, Related view),
  // so the rendered text and any criterion history opened in it stay put.
  const rendered = useMemo(
    () => <MarkdownContent content={body} images="link" surface="spec" attachments={view.attachmentSources ?? {}} criterionVerdicts={marks} criterionSpecId={spec.id} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [body, view.attachmentSources, marksKey, spec.id],
  );

  const specPanel = reviewing && view.waiting ? (
    <ReviewPanel spec={spec} waiting={view.waiting} initial={view.review} repoChecks={!!view.repoChecks} onRead={setReviewPanes} />
  ) : (
    <>
      {sections.length >= 3 ? (
        <button type="button" onClick={() => setContentsOpen(true)} aria-haspopup="dialog" className="inline-flex min-h-11 items-center gap-2 self-start text-meta text-text-secondary underline hover:text-text-primary lg:hidden" data-testid="spec-page-contents">
          Contents · {sections.length} sections
        </button>
      ) : null}
      {view.criterionHistory ? (
        <SpecCriterionHistory specId={spec.id} criterionId={view.criterionHistory.criterionId} history={view.criterionHistory.history} />
      ) : null}
      <div ref={article} className="[&_h2]:scroll-mt-20 md:[&_h2]:scroll-mt-6">
        <Card as="article" className="md:p-8" data-testid="spec-page-body" aria-label={`Revision ${view.reading.revision} of the spec`}>
          {rendered}
        </Card>
      </div>
    </>
  );

  const related = hasRelated ? (
    <>
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
    </>
  ) : null;

  const panels: Record<Tab, ReactNode> = {
    spec: specPanel,
    history: <History view={view} base={base} reviewing={reviewing} at={at} />,
    related,
    comments: (
      <SpecComments specId={spec.id} revision={view.reading.revision} comments={view.comments} anchors={view.commentAnchors} canComment={view.canComment} canResolve={view.canComment} />
    ),
    files: (
      <SpecAttachments specId={spec.id} revision={view.reading.revision} attachments={view.attachments ?? []} canAttach={view.canComment} isHead={view.reading.isHead} />
    ),
  };

  // The one primary action (R-96), in this order; null when none is the reader's.
  const action: ReactNode = importing?.canConfirm ? (
    <div className="flex items-center gap-3 lg:flex-col lg:items-stretch">
      {importing.previous ? (
        <Link href={`${base}?from=${importing.previous}&to=${importing.revision}`} className="inline-flex min-h-11 shrink-0 items-center text-meta text-text-secondary underline hover:text-text-primary lg:order-last lg:min-h-0" data-testid="spec-page-import-repo-change">
          Changed since revision {importing.previous}
        </Link>
      ) : null}
      <div className="min-w-0 flex-1">
        <ConfirmImport specId={spec.id} workspaceId={spec.workspaceId} revision={importing.revision} />
      </div>
    </div>
  ) : reviewing ? (
    reviewPanes ? <Approve key={reviewPanes.revision} specId={spec.id} revision={reviewPanes.revision} expectedVersion={reviewPanes.version ?? spec.version} /> : null
  ) : reviewLink ? (
    <a href={`${base}?review=1`} onClick={openReview} className={primaryActionClass({ fullWidthOnMobile: true })} data-testid="spec-page-review">
      Review revision {view.waiting}
    </a>
  ) : view.retirement && view.canRetire ? (
    <Restore specId={spec.id} />
  ) : null;

  const repoState = (
    <>
      {view.source?.path ? (
        <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">
          {view.source.href ? <a href={view.source.href} className="font-mono underline">{view.source.path}</a> : <span className="font-mono">{view.source.path}</span>}
        </p>
      ) : view.source?.source ? <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-source">{view.source.source}</p> : null}
      {view.source?.copy ? (
        view.source.behind
          ? <Notice tone="warn" data-testid="spec-page-repo-copy">{view.source.copy}</Notice>
          : <p className="text-meta text-text-muted" data-testid="spec-page-repo-copy">{view.source.copy}</p>
      ) : null}
      {view.criteriaUnread ? <Notice tone="warn" data-testid="spec-page-criteria-unread">{view.criteriaUnread}</Notice> : null}
    </>
  );
  const hasRepoState = !!(view.source?.path || view.source?.source || view.source?.copy || view.criteriaUnread);
  // Below lg the rail's parts follow the text, on the Spec tab only.
  const specOnly = tab === 'spec' ? '' : 'hidden lg:flex';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <Link href={`/app/workspaces/${spec.workspaceId}/specs`} className="inline-flex min-h-11 items-center text-meta text-text-muted hover:text-text-primary md:min-h-0">
            {spec.workspaceName ? `Specs in ${spec.workspaceName}` : 'Specs'}
          </Link>
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More"
            aria-haspopup="dialog"
            data-testid="spec-page-more"
            className="-mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="9" r="1.5" />
              <circle cx="9" cy="9" r="1.5" />
              <circle cx="14.5" cy="9" r="1.5" />
            </svg>
          </button>
        </div>
        <h1 className="font-voice text-2xl text-text-primary [overflow-wrap:anywhere] md:text-3xl" data-testid="spec-page-title">{spec.title}</h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-page-status">
          <Chip tone={status.tone} variant="soft" dot={false} data-testid="spec-page-status-badge">{status.badge}</Chip>
          {view.retirement?.supersededBy ? (
            <span data-testid="spec-retired-line">
              Replaced by <Link href={`/app/specs/${view.retirement.supersededBy.id}`} className="text-text-secondary underline">{view.retirement.supersededBy.title}</Link>
            </span>
          ) : status.words ? (
            <span data-testid={view.retirement ? 'spec-retired-line' : 'spec-page-reading'}>{status.words}</span>
          ) : null}
          {view.standard ? <span className="font-medium text-text-secondary" data-testid="spec-page-standard">Standard, applies to every change</span> : null}
          {titledInText ? <span data-testid="spec-page-text-title">Titled in the text: {titledInText}</span> : null}
        </p>
      </header>

      <Tabs tabs={tabs} counts={{ history: view.revisions.length, related: relatedCount, comments: view.comments.length, files: (view.attachments ?? []).length }} active={tab} onPick={setTab} />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,45rem)_20rem] lg:grid-rows-[auto_auto_auto_1fr] lg:items-start lg:gap-x-10 lg:gap-y-0">
        <div className="flex min-w-0 flex-col lg:col-start-1 lg:row-span-4 lg:row-start-1">
          {tabs.map((t) => (
            <div key={t} role="tabpanel" id={panelId(t)} aria-labelledby={tabId(t)} hidden={t !== tab} className="flex flex-col gap-4" data-testid={`spec-page-panel-${t}`}>
              {panels[t]}
            </div>
          ))}
        </div>

        {sections.length >= 3 ? (
          <nav aria-label="Contents" className="hidden flex-col gap-1 lg:col-start-2 lg:row-start-2 lg:mb-6 lg:flex" data-testid="spec-page-rail-contents">
            <h2 className="text-meta font-semibold text-text-secondary">Contents</h2>
            <ContentsList sections={sections} onPick={pickSection} />
          </nav>
        ) : null}
        <div className={`min-w-0 flex-col lg:col-start-2 lg:row-start-3 ${specOnly || 'flex'}`} data-testid="spec-page-rail-work">
          <SpecDelivery specId={spec.id} delivery={view.delivery} />
        </div>
        {hasRepoState ? (
          <aside aria-label="Repo" className={`min-w-0 flex-col gap-2 lg:col-start-2 lg:row-start-4 lg:mb-6 ${specOnly || 'flex'}`} data-testid="spec-page-repo-state">
            {repoState}
          </aside>
        ) : null}

        {/* Last in the flow, so on a phone it stays in view and never ends over the text. */}
        {action ? <ActionDock>{action}</ActionDock> : null}
      </div>

      <Sheet open={contentsOpen} onClose={() => setContentsOpen(false)} title="Contents" testId="spec-page-contents-sheet">
        <ContentsList sections={sections} onPick={pickSection} />
      </Sheet>

      <SideSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More" testId="spec-page-more-sheet">
        <div className="flex flex-col">
          {importing?.canConfirm ? (
            <Link href={importing.batchHref} className={MORE_ROW} data-testid="spec-page-import-batch">Confirm with the other imports</Link>
          ) : null}
          {view.canComment ? (
            <button type="button" className={MORE_ROW} onClick={() => openFromMore('comments')} data-testid="spec-page-more-comment">Add a comment</button>
          ) : null}
          {view.canComment && view.reading.isHead ? (
            <button type="button" className={MORE_ROW} onClick={() => openFromMore('files')} data-testid="spec-page-more-attach">Attach a file</button>
          ) : null}
          <button type="button" className={MORE_ROW} onClick={copyLink} data-testid="spec-page-more-copy-link">{copied ? 'Link copied' : 'Copy link'}</button>
          {view.canPublishAnyway ? <PublishAnyway specId={spec.id} /> : null}
          {view.canMarkStandard ? <StandardMark specId={spec.id} standard={!!view.standard} /> : null}
          {!view.retirement && view.canRetire ? <SpecRetire specId={spec.id} retirement={null} canRetire targets={view.retireTargets ?? []} /> : null}
        </div>
      </SideSheet>
    </div>
  );
}
