'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import { withPasskey } from '@/lib/passkeys/client';

interface OwnerQuestion {
  id: string;
  kind: 'import_mismatch' | 'retire_batch';
  specId: string | null;
  text: string;
  recommended: string;
  items?: Array<{ specId: string; title: string; reason: string }>;
}

/**
 * The owner's open questions in this workspace (Living Spec 65ed7fa3 R-371,
 * R-372): an imported spec whose checks fail (one question, with the spec one
 * link away) and one batched proposal to retire several specs. "Retire them"
 * is the owner's own signed-in answer; an agent cannot give it.
 */
export default function SpecOwnerQuestions({ workspaceId, canAnswer }: { workspaceId: string; canAnswer: boolean }) {
  const [questions, setQuestions] = useState<OwnerQuestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/specs/questions?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : { questions: [] }))
      .then((b: { questions?: OwnerQuestion[] }) => { if (live) setQuestions(b.questions ?? []); })
      .catch(() => {});
    return () => { live = false; };
  }, [workspaceId]);

  async function answer(q: OwnerQuestion, keep?: string[]) {
    setBusy(q.id);
    setError(null);
    const { res, body } = await withPasskey((presence) => fetch(`/api/specs/questions/${encodeURIComponent(q.id)}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(keep ? { keep } : {}), ...(presence ? { presence } : {}) }),
    }));
    setBusy(null);
    if (res?.ok) {
      const skipped = (body as { skipped?: Array<{ title: string; error: string }> }).skipped ?? [];
      if (skipped.length) setError(`Not retired: ${skipped.map((s) => `${s.title} (${s.error})`).join('; ')}. The question stays open.`);
      else setQuestions((qs) => qs.filter((x) => x.id !== q.id));
    } else setError((body as { error?: string }).error ?? 'That did not work. Try again.');
  }

  if (!questions.length) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="spec-owner-questions">
      <h2 className="text-body font-semibold text-text-primary">{questions.length} {questions.length === 1 ? 'question' : 'questions'} for you</h2>
      {error ? <p role="alert" className="text-meta text-status-error">{error}</p> : null}
      <ul className="flex flex-col gap-3">
        {questions.map((q) => (
          <li key={q.id}>
            <Card className="flex flex-col gap-2 p-3">
              <p className="text-body text-text-primary" data-testid="spec-owner-question">{q.text}</p>
              <p className="text-meta text-text-secondary">Suggested: {q.recommended}</p>
              {q.items?.length ? (
                <ul className="list-disc pl-5 text-meta text-text-secondary" data-testid="spec-owner-question-items">
                  {q.items.map((i) => (
                    <li key={i.specId}><Link href={`/app/specs/${encodeURIComponent(i.specId)}`} className="underline">{i.title}</Link>: {i.reason}</li>
                  ))}
                </ul>
              ) : null}
              {q.kind === 'import_mismatch' && q.specId ? (
                <Link href={`/app/specs/${encodeURIComponent(q.specId)}`} className="text-meta text-accent-text underline-offset-2 hover:underline">Open the spec</Link>
              ) : null}
              {q.kind === 'retire_batch' && canAnswer ? (
                <div>
                  <button type="button" disabled={busy === q.id} onClick={() => answer(q)} className="min-h-11 rounded-[var(--radius-cell)] px-3 text-body font-medium underline" data-testid="spec-owner-retire-all">
                    Yes, retire these {q.items?.length ?? ''}
                  </button>
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
