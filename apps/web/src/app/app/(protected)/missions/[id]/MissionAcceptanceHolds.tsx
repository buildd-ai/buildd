'use client';

import { useEffect, useState } from 'react';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import type { AcceptanceHold } from '@/lib/acceptance-edit-holds';
import { diffAnchor } from '@/lib/diff-anchor';

/**
 * The owner decision behind "Goal criteria escalated" (spec 1dc6cc39 R-80, AC-126):
 * one row per building task whose PR edits acceptance tests. Until a person
 * accepts, that task's test results do not count. Session only: the route refuses a key.
 */
export default function MissionAcceptanceHolds({ holds, readonly }: { holds: readonly AcceptanceHold[]; readonly?: boolean }) {
  const [anchors, setAnchors] = useState<Map<string, string>>(new Map());
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const loadAnchors = async () => {
      const newAnchors = new Map<string, string>();
      for (const hold of holds) {
        for (const path of hold.paths) {
          const anchor = await diffAnchor(path);
          newAnchors.set(path, anchor);
        }
      }
      setAnchors(newAnchors);
    };
    loadAnchors();
  }, [holds]);

  function buildDiffUrl(baseUrl: string, path: string): string {
    const anchor = anchors.get(path) || '';
    return `${baseUrl}${anchor}`;
  }

  if (holds.length === 0) return null;

  return (
    <section data-testid="mission-acceptance-holds" className="text-body text-text-secondary">
      <h3 className="font-semibold text-text-primary">Test changes waiting for you</h3>
      <p className="mt-0.5 text-meta text-text-muted">Until you accept, results from these tests do not count.</p>
      <ul className="mt-2 space-y-3">
        {holds.map((h) => (
          <AcceptanceHoldRow
            key={h.taskId}
            hold={h}
            readonly={readonly}
            isAccepted={accepted.has(h.taskId)}
            onAccepted={() => setAccepted((s) => new Set([...s, h.taskId]))}
            buildDiffUrl={buildDiffUrl}
          />
        ))}
      </ul>
    </section>
  );
}

function AcceptanceHoldRow({
  hold,
  readonly,
  isAccepted,
  onAccepted,
  buildDiffUrl,
}: {
  hold: AcceptanceHold;
  readonly?: boolean;
  isAccepted: boolean;
  onAccepted: () => void;
  buildDiffUrl: (baseUrl: string, path: string) => string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { shown: result, retry, approve } = useOptimisticApprove(
    async () => {
      const res = await fetch(`/api/tasks/${hold.taskId}/accept-acceptance-edit`, { method: 'POST' });
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        const error = typeof body.error === 'string' ? body.error : 'Could not accept. Try again.';
        setError(error);
        return { tone: 'err' as const, text: error };
      }
      setError(null);
      onAccepted();
      return { tone: 'ok' as const, text: 'Accepted.' };
    },
    'Accepted.',
  );

  const getFileName = (path: string) => path.split('/').pop() || path;

  return (
    <li data-testid="acceptance-hold" className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-start md:justify-between md:gap-4">
      <div className="min-w-0">
        <p className="text-text-primary">{hold.prNumber != null ? `PR #${hold.prNumber}` : 'A pull request'} changes {hold.paths.length === 1 ? 'a test' : `${hold.paths.length} tests`}</p>
        <ul className="font-mono text-meta text-text-muted">
          {hold.paths.map((p) => <li key={p} className="[overflow-wrap:anywhere]">{p}</li>)}
        </ul>
        {hold.diffUrl && (
          <div className="mt-1 flex flex-col gap-1">
            {hold.paths.map((path) => {
              const url = buildDiffUrl(hold.diffUrl, path);
              const fileName = getFileName(path);
              return (
                <a
                  key={path}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="acceptance-hold-diff"
                  className="inline-flex min-h-11 md:min-h-0 items-center text-meta underline underline-offset-2 w-fit"
                >
                  See changes in {fileName}
                </a>
              );
            })}
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-meta text-status-error">{error}</p>}
      </div>
      {!readonly && (
        <div className="flex flex-col items-start md:items-end gap-2">
          {!result || retry ? (
            <PrimaryAction
              onClick={approve}
              disabled={result?.tone === 'err'}
              data-testid="acceptance-hold-accept"
              className="min-h-11 md:min-h-0"
            >
              {result?.tone === 'err' ? 'Try again' : 'Accept'}
            </PrimaryAction>
          ) : (
            <Notice tone={result.tone} data-testid="acceptance-hold-confirmed">
              {result.text}
            </Notice>
          )}
        </div>
      )}
    </li>
  );
}
