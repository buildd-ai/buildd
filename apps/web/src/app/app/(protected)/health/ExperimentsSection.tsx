'use client';

/**
 * Experiments on /app/health: each visible experiment's state and readout,
 * plus start/pause/conclude and a create form for team admins.
 *
 * Readouts are intent-to-treat per policy version (see
 * packages/core/experiment-readout.ts). "Insufficient data" is a verdict in
 * its own right and is rendered as one, never as a number that looks final.
 *
 * Visibility is enforced server-side (page.tsx → loadHealthExperiments drops
 * admins-only rows below admin); this component only decides whether to show
 * controls, and hides itself when the viewer has nothing to see or do.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ExperimentReadout, ReadoutVerdict } from '@buildd/core/experiment-readout';
import { shouldShowExperiments, type HealthExperimentItem, type HealthExperiments } from '@/lib/health-experiments-shared';

function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function signedPct(v: number): string {
  const s = (v * 100).toFixed(1);
  return v > 0 ? `+${s}` : s;
}

function dateOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

const STATUS_CLASS: Record<string, string> = {
  running: 'text-status-success',
  paused: 'text-status-warning',
  draft: 'text-text-muted',
  concluded: 'text-text-secondary',
};

const VERDICT_LABEL: Record<ReadoutVerdict, string> = {
  insufficient_n: 'Insufficient data',
  no_detectable_difference: 'No detectable difference',
  treatment_better: 'Treatment better',
  treatment_worse: 'Treatment worse',
};

async function send(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error ?? `Request failed (${res.status})`;
}

function Readout({ readout }: { readout: ExperimentReadout }) {
  const arms = [
    { name: 'Control', a: readout.control },
    { name: 'Treatment', a: readout.treatment },
  ];
  const d = readout.difference;
  const insufficient = readout.verdict === 'insufficient_n';
  return (
    <div className="space-y-2" data-testid="experiment-readout">
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-text-muted text-left">
              <th className="font-normal py-1 pr-3">Arm</th>
              <th className="font-normal py-1 pr-3" title="Resolved tasks (the denominator) / assigned">n</th>
              <th className="font-normal py-1 pr-3" title="Completed, no CI retry, and no PR or a merged PR">Clean completion</th>
              <th className="font-normal py-1 pr-3" title="95% Wilson interval">95% interval</th>
              <th className="font-normal py-1" title="Share of assigned tasks whose arm model actually ran">Served</th>
            </tr>
          </thead>
          <tbody>
            {arms.map(({ name, a }) => (
              <tr key={name} data-testid={`experiment-arm-${name.toLowerCase()}`} className="border-t border-border-default">
                <td className="py-1 pr-3 text-text-secondary">{name}</td>
                <td className="py-1 pr-3">{a.n}<span className="text-text-muted">/{a.assigned}</span></td>
                <td className="py-1 pr-3">{pct(a.cleanRate, 1)}</td>
                <td className="py-1 pr-3 text-text-muted whitespace-nowrap">
                  {a.n > 0 ? `${pct(a.cleanInterval.lower)}–${pct(a.cleanInterval.upper)}` : '—'}
                </td>
                <td className="py-1">{pct(a.servedRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-text-secondary" data-testid="experiment-difference">
          Difference: {d ? `${signedPct(d.difference)} pts (95% ${signedPct(d.lower)} to ${signedPct(d.upper)})` : '—'}
        </span>
        <span
          data-testid="experiment-verdict"
          data-verdict={readout.verdict}
          className={`text-xs font-medium ${insufficient ? 'text-text-muted' : readout.verdict === 'treatment_worse' ? 'text-status-error' : 'text-text-primary'}`}
        >
          {VERDICT_LABEL[readout.verdict]}
          {insufficient && (
            <span className="font-normal"> — needs {readout.minSamplePerArm} resolved per arm</span>
          )}
        </span>
      </div>
    </div>
  );
}

function ExperimentCard({ item, canManage }: { item: HealthExperimentItem; canManage: boolean }) {
  const router = useRouter();
  const { experiment: e, readout } = item;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [concluding, setConcluding] = useState(false);
  const [decision, setDecision] = useState('');

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const err = await send(`/api/experiments/${e.id}`, 'PATCH', body);
    setBusy(false);
    if (err) setError(err);
    else {
      setConcluding(false);
      router.refresh();
    }
  };

  const btn = 'text-xs px-3 h-8 rounded-lg border border-border-default font-medium disabled:opacity-50';

  return (
    <div className="px-4 py-3 space-y-2" data-testid="experiment-card" data-status={e.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-text-primary font-medium min-w-0 break-words">{e.title}</span>
        <span className={`text-xs ${STATUS_CLASS[e.status] ?? 'text-text-muted'}`} data-testid="experiment-status">{e.status}</span>
      </div>
      <p className="text-[11px] text-text-muted">
        <span className="font-mono">{e.key}</span> · treatment {pct(e.treatmentFraction)} of eligible · started {dateOnly(e.startedAt)} · v{e.policyVersion}
        {e.visibility === 'admins' && ' · admins only'}
      </p>
      {e.hypothesis && <p className="text-xs text-text-secondary">{e.hypothesis}</p>}

      {readout ? (
        <Readout readout={readout} />
      ) : (
        <p className="text-xs text-text-muted">
          {e.status === 'draft' ? 'Not started — nothing enrolls until it is started.' : 'Readout unavailable.'}
        </p>
      )}

      {e.decision && <p className="text-xs text-text-secondary"><span className="text-text-muted">Decision:</span> {e.decision}</p>}

      {canManage && e.status !== 'concluded' && (
        <div className="space-y-2" data-testid="experiment-controls">
          <div className="flex flex-wrap gap-2">
            {(e.status === 'draft' || e.status === 'paused') && (
              <button
                data-testid="experiment-start"
                disabled={busy}
                onClick={() => patch({ status: 'running' })}
                className={`${btn} text-status-success border-status-success/40`}
                title="From the next claim, eligible tasks are randomly split between control and treatment"
              >
                {e.status === 'draft' ? 'Start' : 'Resume'}
              </button>
            )}
            {e.status === 'running' && (
              <button data-testid="experiment-pause" disabled={busy} onClick={() => patch({ status: 'paused' })} className={`${btn} text-text-secondary`}>
                Pause
              </button>
            )}
            <button
              data-testid="experiment-conclude"
              disabled={busy}
              onClick={() => setConcluding(c => !c)}
              className={`${btn} text-text-secondary`}
            >
              Conclude…
            </button>
          </div>
          {concluding && (
            <div className="space-y-2" data-testid="experiment-conclude-form">
              <textarea
                value={decision}
                onChange={ev => setDecision(ev.target.value)}
                rows={2}
                placeholder="What was decided, and why. Concluding is final."
                className="w-full px-3 py-2 text-base md:text-sm border border-border-default rounded-md bg-surface-1"
              />
              <button
                data-testid="experiment-conclude-confirm"
                disabled={busy || !decision.trim()}
                onClick={() => patch({ status: 'concluded', decision })}
                className={`${btn} text-status-error border-status-error/40`}
              >
                Conclude experiment
              </button>
            </div>
          )}
          {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function CreateExperimentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [fraction, setFraction] = useState('0.5');
  const [visibility, setVisibility] = useState<'admins' | 'team'>('admins');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = 'w-full px-3 py-2 text-base md:text-sm border border-border-default rounded-md bg-surface-1';

  if (!open) {
    return (
      <button
        data-testid="experiment-create-open"
        onClick={() => setOpen(true)}
        className="inline-flex items-center min-h-11 md:min-h-0 text-xs text-accent-text hover:underline"
      >
        + New experiment
      </button>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const err = await send('/api/experiments', 'POST', {
      key: key.trim(),
      title,
      hypothesis: hypothesis || null,
      treatmentFraction: Number(fraction),
      visibility,
    });
    setBusy(false);
    if (err) setError(err);
    else {
      setOpen(false);
      setKey('');
      setTitle('');
      setHypothesis('');
      router.refresh();
    }
  };

  return (
    <form onSubmit={submit} className="card px-4 py-3 space-y-2" data-testid="experiment-create-form">
      <p className="text-[11px] text-text-muted">
        Model routing: eligible standard-tier tasks are split between the routed model and the premium tier. Created as a draft — nothing enrolls until started.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block text-xs text-text-secondary">
          Key
          <input value={key} onChange={ev => setKey(ev.target.value)} placeholder="premium-vs-standard" className={`${input} font-mono mt-1`} required />
        </label>
        <label className="block text-xs text-text-secondary">
          Title
          <input value={title} onChange={ev => setTitle(ev.target.value)} className={`${input} mt-1`} required />
        </label>
      </div>
      <label className="block text-xs text-text-secondary">
        Hypothesis
        <textarea value={hypothesis} onChange={ev => setHypothesis(ev.target.value)} rows={2} className={`${input} mt-1`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-text-secondary">
          Treatment fraction
          <input type="number" min="0.05" max="0.95" step="0.05" value={fraction} onChange={ev => setFraction(ev.target.value)} className={`${input} mt-1`} />
        </label>
        <label className="block text-xs text-text-secondary">
          Visibility
          <select value={visibility} onChange={ev => setVisibility(ev.target.value as 'admins' | 'team')} className={`${input} mt-1`}>
            <option value="admins">Admins only</option>
            <option value="team">Whole team</option>
          </select>
        </label>
      </div>
      {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="text-xs px-3 h-8 rounded-lg border border-border-default font-medium text-text-primary disabled:opacity-50">
          {busy ? 'Creating…' : 'Create draft'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs px-3 h-8 rounded-lg text-text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ExperimentsSection({ data }: { data: HealthExperiments | null }) {
  if (!shouldShowExperiments(data)) return null;
  const { items, canManage } = data;
  return (
    <div data-testid="health-section-experiments" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Experiments</h3>
        <span className="text-[11px] text-text-muted">intent-to-treat, current policy version</span>
      </div>
      {items.length > 0 ? (
        <div className="card divide-y divide-border-default mb-2">
          {items.map(item => <ExperimentCard key={item.experiment.id} item={item} canManage={canManage} />)}
        </div>
      ) : (
        <p className="text-xs text-text-muted mb-2" data-testid="experiments-empty">No experiments yet.</p>
      )}
      {canManage && <CreateExperimentForm />}
    </div>
  );
}
