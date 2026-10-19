/**
 * Kernel on /app/health/operator: what the workflow kernel's durable log says it
 * did. Platform operators only (the page gates it). Pure render over
 * `loadKernelOperatorView`: no hooks, no fetches, so it imports nothing that
 * touches the DB. The filters are a plain GET form, so the page stays a server
 * component and a filtered view is a link.
 */
import { WindowSelect } from './KernelWindowSelect';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import type { FloorRun, KernelOperatorView, PrTimeline, TransitionRow } from '@/lib/workflow/operator-view';
import { KERNEL_WINDOW_LABEL, TRANSITION_LIMIT } from '@/lib/kernel-windows';

/** "5m", "3h", "2d": how long before `now`. */
export function ageOf(at: string | null, now: number): string {
  if (!at) return 'never';
  const ms = Math.max(0, now - Date.parse(at));
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
const label = (s: string) => s.replace(/_/g, ' ');
const when = (at: string) => at.replace('T', ' ').slice(0, 16);

function hostLabel(host: string | null): string {
  return host === 'control-plane' ? 'control plane' : host === 'web' ? 'web host' : 'unrecorded host';
}

function prLabel(t: Pick<TransitionRow, 'prNumber' | 'repo'>): string {
  return t.prNumber == null ? 'no PR' : `${t.repo ? `${t.repo}` : ''}#${t.prNumber}`;
}

function TransitionList({ items, now, testid }: { items: TransitionRow[]; now: number; testid: string }) {
  return (
    <ul data-testid={testid} className="divide-y divide-border-default">
      {items.map((t) => (
        <li key={t.id} className="py-2 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-text-primary">{label(t.command)}</span>
            <span className="text-text-secondary">{t.fromState ? `${t.fromState} to ${t.toState}` : `started at ${t.toState}`}</span>
            <span className="text-text-muted ml-auto">{ageOf(t.at, now)}</span>
          </div>
          <div className="text-text-muted">
            {prLabel(t)} in {t.workspaceName}, by {t.actor}, written by the {hostLabel(t.host)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Filters({ view }: { view: KernelOperatorView }) {
  const q = view.query;
  const input = 'w-full h-8 px-2 bg-surface text-xs border border-border-default';
  return (
    <form method="get" data-testid="kernel-filters" className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
      <div className="col-span-1">
        <label className="field-label" htmlFor="kwindow">Window</label>
        <WindowSelect value={q.window} />
      </div>
      <div className="col-span-1">
        <label className="field-label" htmlFor="kworkspace">Workspace</label>
        <input id="kworkspace" name="kworkspace" defaultValue={q.workspace ?? ''} placeholder="name or id" className={input} />
      </div>
      <div className="col-span-1">
        <label className="field-label" htmlFor="kteam">Team</label>
        <input id="kteam" name="kteam" defaultValue={q.team ?? ''} placeholder="slug or id" className={input} />
      </div>
      <div className="col-span-1">
        <label className="field-label" htmlFor="kcommand">Command</label>
        <input id="kcommand" name="kcommand" defaultValue={q.command ?? ''} placeholder="e.g. open_delivery" className={input} />
      </div>
      <div className="col-span-1">
        <label className="field-label" htmlFor="kpr">PR number</label>
        <input id="kpr" name="kpr" inputMode="numeric" defaultValue={q.pr ?? ''} placeholder="needs a workspace" className={input} />
      </div>
      <div className="col-span-1">
        <button type="submit" className="btn btn-sm">Show</button>
      </div>
    </form>
  );
}

function WebHost({ view }: { view: KernelOperatorView }) {
  const { count, recent } = view.web;
  const windowLabel = KERNEL_WINDOW_LABEL[view.query.window];
  return (
    <div data-testid="kernel-web-host" data-count={count} className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className={`text-display font-mono ${count === 0 ? 'text-status-success' : 'text-status-error'}`}>{count}</span>
        <div>
          <div className="text-sm font-medium text-text-primary">
            {count === 0
              ? `The web host wrote no transitions in the ${windowLabel}`
              : `The web host wrote ${plural(count, 'transition', 'transitions')} in the ${windowLabel}`}
          </div>
          <div className="text-xs text-text-muted">
            {count === 0
              ? 'Expected. The control plane writes every transition.'
              : 'Should be 0. The control plane writes every transition. Newest below.'}
          </div>
        </div>
      </div>
      {recent.length > 0 && <TransitionList items={recent} now={view.now} testid="kernel-web-host-recent" />}
    </div>
  );
}

function Parked({ view }: { view: KernelOperatorView }) {
  const p = view.parked;
  const gaveUp = p.gaveUp > 0 && <span className="text-status-error"> The floor gave up on {plural(p.gaveUp, 'command', 'commands')} in the {KERNEL_WINDOW_LABEL[view.query.window]}.</span>;
  if (p.total === 0) {
    return (
      <div data-testid="kernel-parked" data-total={0} className="text-sm text-text-secondary">
        No parked commands.
        {gaveUp}
      </div>
    );
  }
  const failing = p.byOp.reduce((a, o) => a + o.failing, 0);
  return (
    <div data-testid="kernel-parked" data-total={p.total} className="space-y-2">
      <div className="text-sm text-text-primary">
        {plural(p.total, 'command is', 'commands are')} parked, the oldest {ageOf(p.oldestAt, view.now).replace(' ago', '')} old.{' '}
        <span data-testid="kernel-replay" className={failing > 0 ? 'text-status-error' : 'text-text-secondary'}>
          {failing > 0 ? `Sending them again is failing for ${failing}.` : 'No resend failures.'}
        </span>
        {gaveUp}
      </div>
      <ul className="divide-y divide-border-default">
        {p.byOp.map((o) => (
          <li key={o.op} className="py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-text-primary">{label(o.op)}</span>
              <span className="text-text-secondary">{o.count} waiting, oldest {ageOf(o.oldestAt, view.now).replace(' ago', '')}</span>
              {o.failing > 0 && <span className="text-status-error">{o.failing} resends failing</span>}
            </div>
            {o.lastError && <div className="text-text-muted break-words">Last error: {o.lastError}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeadEffects({ view }: { view: KernelOperatorView }) {
  const d = view.deadEffects;
  if (d.total === 0) return <div data-testid="kernel-dead-effects" data-total={0} className="text-sm text-text-secondary">No dead effects.</div>;
  return (
    <div data-testid="kernel-dead-effects" data-total={d.total} className="space-y-2">
      <div className="text-sm text-status-error">
        {plural(d.total, 'effect is', 'effects are')} dead on a live delivery. The floor closes dead effects once their delivery is over or their head has moved on; these need an operator.
      </div>
      <ul className="divide-y divide-border-default">
        {d.rows.map((e) => (
          <li key={e.id} className="py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-text-primary">{label(e.kind)}</span>
              <span className="text-text-secondary">{e.repo && e.prNumber ? `${e.repo}#${e.prNumber}` : 'mission epoch'}{e.deliveryState ? `, ${label(e.deliveryState)}` : ''}</span>
              <span className="text-text-muted">dead {ageOf(e.deadAt, view.now)} after {e.attempts} tries</span>
            </div>
            {e.lastError && <div className="text-text-muted break-words">Last error: {e.lastError}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FloorRuns({ runs, now }: { runs: FloorRun[]; now: number }) {
  if (runs.length === 0) return <div data-testid="kernel-floor" className="text-sm text-text-secondary">No floor runs.</div>;
  return (
    <ul data-testid="kernel-floor" className="divide-y divide-border-default">
      {runs.map((r) => {
        const tone: ChipTone = !r.ok || r.problems.length ? 'error' : 'muted';
        return (
          <li key={r.id} className="py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-text-primary">{ageOf(r.startedAt, now)}</span>
              <Chip tone={tone}>{r.host}</Chip>
              <span className="text-text-muted">{r.durationMs == null ? '' : `${(r.durationMs / 1000).toFixed(1)}s`}</span>
            </div>
            <div className="text-text-secondary">
              {r.repaired.length ? `Repaired: ${r.repaired.join(', ')}.` : 'Nothing needed repair.'}
            </div>
            {r.problems.length > 0 && <div className="text-status-error">Could not: {r.problems.join('; ')}.</div>}
          </li>
        );
      })}
    </ul>
  );
}

const APPROVAL_TONE: Record<'success' | 'failure' | 'pending', ChipTone> = { success: 'success', failure: 'error', pending: 'warning' };

function Timeline({ t, now }: { t: PrTimeline; now: number }) {
  return (
    <div data-testid="kernel-timeline" className="space-y-3">
      <div className="text-sm text-text-primary">
        {t.repo ?? 'PR'}#{t.prNumber} in {t.workspaceName}: {label(t.state.toLowerCase())}{t.stateReason ? ` (${label(t.stateReason)})` : ''}
      </div>
      <div data-testid="kernel-approval" className="text-xs flex flex-wrap items-center gap-2">
        <span className="text-text-muted">{t.approvalContext}</span>
        {t.approval
          ? <><Chip tone={APPROVAL_TONE[t.approval.state]}>{t.approval.state === 'success' ? 'approved' : t.approval.state === 'failure' ? 'not approved' : 'waiting'}</Chip><span className="text-text-secondary">{t.approval.description}</span></>
          : <span className="text-text-secondary">PR closed. Last check unchanged.</span>}
      </div>
      <div data-testid="kernel-findings" className="text-xs">
        {t.openFindings.length === 0
          ? <span className="text-text-secondary">No open review findings.</span>
          : <>
              <div className="text-text-muted">{plural(t.openFindings.length, 'open review finding', 'open review findings')}</div>
              <ul className="list-disc pl-4 text-text-secondary">{t.openFindings.map((f, i) => <li key={i} className="break-words">{f}</li>)}</ul>
            </>}
      </div>
      <ol data-testid="kernel-steps" className="divide-y divide-border-default">
        {t.steps.map((s) => (
          <li key={s.version} className="py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-text-muted font-mono">{s.version}</span>
              <span className="font-mono text-text-primary">{label(s.command)}</span>
              <span className="text-text-secondary">{s.fromState ? `${s.fromState} to ${s.toState}` : `started at ${s.toState}`}</span>
              <span className="text-text-muted ml-auto" title={when(s.at)}>{ageOf(s.at, now)}</span>
            </div>
            <div className="text-text-muted">by {s.actor}, written by the {hostLabel(s.host)}{s.bypassed ? ', with a bypass recorded' : ''}</div>
            {s.evidence && <div className="text-text-muted break-words">{s.evidence}</div>}
          </li>
        ))}
      </ol>
      {t.stepsOmitted > 0 && <div className="text-xs text-text-muted">{t.stepsOmitted} later transitions hidden.</div>}
    </div>
  );
}

function TimelineBody({ view }: { view: KernelOperatorView }) {
  const tl = view.timeline;
  switch (tl.kind) {
    case 'idle': return <p className="text-xs text-text-muted">Enter a PR number and workspace.</p>;
    case 'needs_workspace': return <p data-testid="kernel-timeline-note" className="text-xs text-text-secondary">Add a workspace. PR numbers repeat across workspaces.</p>;
    case 'no_workspace': return <p data-testid="kernel-timeline-note" className="text-xs text-text-secondary">No workspace matches {tl.scope}.</p>;
    case 'not_found': return <p data-testid="kernel-timeline-note" className="text-xs text-text-secondary">That workspace has no delivery for PR #{tl.prNumber}.</p>;
    case 'found': return <div className="space-y-6">{tl.timelines.map((t) => <Timeline key={t.deliveryId} t={t} now={view.now} />)}</div>;
  }
}

function Block({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <div data-testid={testid}>
      <h4 className="text-xs font-medium text-text-secondary mb-2">{title}</h4>
      <div className="card p-4">{children}</div>
    </div>
  );
}

export function KernelSection({ view }: { view: KernelOperatorView | null }) {
  if (!view) return null;
  const windowLabel = KERNEL_WINDOW_LABEL[view.query.window];
  const scoped = Boolean(view.query.workspace || view.query.team || view.query.command);
  return (
    <div data-testid="health-section-kernel" className="mb-6 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-text-secondary">Kernel</h3>
        <span className="text-meta text-text-muted">{windowLabel}</span>
      </div>
      <div className="card p-4"><Filters view={view} /></div>

      <Block title="Written by the web host" testid="kernel-block-web"><WebHost view={view} /></Block>
      <Block title="Parked commands" testid="kernel-block-parked"><Parked view={view} /></Block>
      <Block title="Dead effects" testid="kernel-block-dead-effects"><DeadEffects view={view} /></Block>
      <Block title="Last floor runs" testid="kernel-block-floor"><FloorRuns runs={view.floorRuns} now={view.now} /></Block>

      <Block title={scoped ? 'Recent transitions, filtered' : 'Recent transitions'} testid="kernel-block-transitions">
        {view.scopeMissing
          ? <p data-testid="kernel-scope-missing" className="text-sm text-text-secondary">No {view.scopeMissing} matches.</p>
          : view.transitions.length === 0
            ? <p className="text-sm text-text-secondary">No transitions in the {windowLabel}{scoped ? ' for this filter' : ''}.</p>
            : <>
                <TransitionList items={view.transitions} now={view.now} testid="kernel-transitions" />
                {view.transitions.length >= TRANSITION_LIMIT && <p className="text-xs text-text-muted pt-2">Showing the newest {TRANSITION_LIMIT}. Filter by workspace or command to go further back.</p>}
              </>}
      </Block>

      <Block title="One PR" testid="kernel-block-timeline"><TimelineBody view={view} /></Block>
    </div>
  );
}
