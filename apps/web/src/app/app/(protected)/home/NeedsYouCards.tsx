'use client';

/**
 * Home's one-tap Needs-you cards: a parked worker's question (answer with one
 * tap, or a note — POSTs the existing /api/workers/[id]/respond route) and a
 * held mission (Arm).
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArmButton } from '@/components/missions/MissionListCards';

export interface HomeQuestion {
  workerId: string;
  taskId: string | null;
  href: string | null;
  label: string;
  runnerName: string | null;
  askedAt: string | null;
  prompt: string;
  options: string[];
}

/** "Per line — match Stripe" → { main: "Per line", sub: "match Stripe" }. */
export function splitOption(opt: string): { main: string; sub: string | null } {
  const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(opt);
  return m ? { main: m[1], sub: m[2] } : { main: opt, sub: null };
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export function QuestionCard({ q }: { q: HomeQuestion }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function send(message: string) {
    if (!message.trim() || sent) return;
    setSent(message);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(q.workerId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not send the answer');
      }
      startTransition(() => router.refresh());
    } catch (e: any) {
      setSent(null);
      setError(e?.message || 'Could not send the answer');
    }
  }

  return (
    <article data-testid="needs-you-card" data-kind="question" className="card border-l-[6px] border-l-status-warning px-4 py-4 md:px-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-status-warning">
          <span aria-hidden="true" className="grid h-[18px] w-[18px] place-items-center border border-status-warning text-[11px]">?</span>
          Question
        </span>
        <span className="truncate font-mono text-[11px] text-text-muted">
          {[q.label, q.runnerName, ago(q.askedAt)].filter(Boolean).join(' · ')}
        </span>
      </div>
      <p className="mb-3.5 font-mono text-[13px] leading-relaxed text-text-primary">{q.prompt}</p>
      {q.options.length > 0 && (
        <div className="mb-2.5 grid grid-cols-2 gap-2.5">
          {q.options.slice(0, 4).map((opt, i) => {
            const { main, sub } = splitOption(opt);
            return (
              <button
                key={opt}
                type="button"
                data-testid="needs-you-answer"
                disabled={!!sent || pending}
                onClick={() => send(opt)}
                className={`flex min-h-12 flex-col items-center justify-center border-2 px-2 py-1.5 font-mono disabled:opacity-60 ${
                  i === 0 ? 'border-primary bg-primary text-white shadow-sm' : 'border-border-strong bg-surface-3 text-text-primary'
                }`}
              >
                <span className="text-[13px] font-semibold">{sent === opt ? 'Sent…' : main}</span>
                {sub && <span className={`text-[11px] ${i === 0 ? 'text-white/85' : 'text-text-muted'}`}>{sub}</span>}
              </button>
            );
          })}
        </div>
      )}
      <form
        className="flex gap-2.5"
        onSubmit={(e) => { e.preventDefault(); send(note); }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reply with a note…"
          aria-label="Reply with a note"
          disabled={!!sent}
          className="min-h-11 min-w-0 flex-1 border-2 border-border-default bg-surface-1 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none"
        />
        {q.href && (
          <Link href={q.href} className="inline-flex min-h-11 items-center border-2 border-border-default px-3 font-mono text-[12.5px] text-text-primary hover:bg-surface-3">
            Open task
          </Link>
        )}
      </form>
      {error && <p role="alert" className="mt-2 font-mono text-[11px] text-status-error">{error}</p>}
    </article>
  );
}

export interface HomeHeldMission {
  id: string;
  title: string;
  href: string;
  ready: number;
  roles: string[];
  done: number;
  total: number;
  heldFor: string | null;
}

export function HeldMissionCard({ m }: { m: HomeHeldMission }) {
  const role = m.roles.length === 1 ? `${m.roles[0]} ` : '';
  return (
    <article data-testid="needs-you-card" data-kind="held" className="card px-4 py-4 md:px-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-text-secondary">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 border-2 border-text-secondary" />
          Held mission
        </span>
        {m.heldFor && <span className="font-mono text-[11px] text-text-muted">held {m.heldFor}</span>}
      </div>
      <h3 className="truncate font-mono text-[15px] font-semibold text-text-primary">{m.title}</h3>
      <p className="mt-1 font-mono text-[12px] text-text-muted">
        {m.ready} {role}task{m.ready === 1 ? '' : 's'} ready · {m.done}/{m.total}
      </p>
      <div className="mt-3.5 flex gap-2.5">
        <ArmButton missionId={m.id} />
        <Link href={m.href} className="inline-flex min-h-11 items-center border-2 border-border-default px-3.5 font-mono text-[12.5px] text-text-primary hover:bg-surface-3 md:min-h-9">
          Open
        </Link>
      </div>
    </article>
  );
}
