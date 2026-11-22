import Link from 'next/link';
import Card from '@/components/ui/Card';
import type { InboxQuestion } from '@/lib/specs/intent-check';

/**
 * The owner's open questions about drafts written from a conversation (Living
 * Spec 65ed7fa3 R-363): one sentence each with the answer we suggest, in one
 * list across specs. The spec text is one link away and never required.
 */
export default function SpecIntentQuestions({ questions }: { questions: InboxQuestion[] }) {
  if (!questions.length) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="spec-intent-questions">
      <h2 className="text-body font-semibold text-text-primary">
        {questions.length} {questions.length === 1 ? 'question' : 'questions'} about what you asked for
      </h2>
      <ul className="flex flex-col gap-3">
        {questions.map((q) => (
          <li key={`${q.specId}-${q.revision}-${q.id}`}>
            <Card className="flex flex-col gap-1 p-3">
              <p className="text-body text-text-primary" data-testid="spec-intent-question">{q.text}</p>
              <p className="text-meta text-text-secondary">Suggested: {q.recommended}</p>
              <Link href={`/app/specs/${encodeURIComponent(q.specId)}`} className="text-meta text-accent-text underline-offset-2 hover:underline">
                {q.specTitle} (optional: read the spec)
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
