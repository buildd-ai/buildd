import Notice from '@/components/ui/Notice';
import type { RepoCopyPreflight } from '@/lib/specs/repo-copy';

/**
 * The repo checks on the would-be repo copy, before approval (living-specs.md
 * §18, R-34). Each result is shown; a failure warns and never blocks Approve.
 */
export default function SpecRepoChecks({ preflight }: { preflight: RepoCopyPreflight | null }) {
  if (!preflight || preflight.state === 'off') return null;
  if (preflight.state === 'not_generated') {
    return <Notice tone="warn" data-testid="spec-repo-checks">No repo copy will be written: {preflight.message}.</Notice>;
  }
  const failing = preflight.checks.filter((c) => !c.ok);
  return (
    <section className="flex flex-col gap-2" data-testid="spec-repo-checks">
      <p className="text-body text-text-secondary">
        {failing.length
          ? `The repo copy at ${preflight.path} fails ${failing.map((c) => c.name).join(', ')}. You can still approve; the copy's PR stays open until it passes.`
          : `The repo copy at ${preflight.path} passes the repo checks.`}
      </p>
      <ul className="flex flex-col gap-1">
        {preflight.checks.map((c) => (
          <li key={c.name} className="text-meta text-text-muted" data-testid="spec-repo-check" data-check={c.name} data-ok={c.ok ? 'true' : 'false'}>
            <span className={c.ok ? 'text-text-secondary' : 'text-text-primary'}>{c.name}: {c.ok ? 'passes' : 'fails'}</span>
            {c.messages.length ? (
              <ul className="ml-4 list-disc">
                {c.messages.slice(0, 10).map((m) => <li key={m} className="[overflow-wrap:anywhere]">{m}</li>)}
              </ul>
            ) : null}
            {c.note ? <p className="ml-4">{c.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
