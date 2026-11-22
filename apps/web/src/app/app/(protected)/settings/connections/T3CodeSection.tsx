import Link from 'next/link';
import Section from '@/components/ui/Section';
import { StatusChip, type ChipTone } from '../_components/ConnectionRow';
import type { AcpLineState } from '../_lib/t3-runner-line';

export interface T3Runner { id: string; name: string; state: AcpLineState; label: string }

const TONE: Record<AcpLineState, ChipTone> = { ready: 'ok', 'not-ready': 'warn', unknown: 'idle' };
const RUNNERS_HREF = '/app/settings/runners';

/**
 * Settings › Connected apps › T3 Code: the two ways to use buildd from T3 Code,
 * in short steps. The copyable config and each runner's ACP status live on the
 * runner page; this card only points there. The per-runner lines are the
 * runner's own report (../_lib/t3-runner-line.ts): buildd's server cannot see
 * T3, so there is no check of T3 itself.
 */
export default function T3CodeSection({ runners }: { runners: T3Runner[] }) {
  return (
    <Section title="T3 Code" id="t3-code">
      <div data-testid="t3-code-card" className="space-y-5 border-y border-border-default py-4 text-sm text-text-secondary">
        <div>
          <h3 className="font-semibold text-text-primary">buildd provider</h3>
          <p className="mt-1">Every new T3 thread becomes a buildd task on your runner.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Start the buildd runner on the machine that runs T3.</li>
            <li>In T3: Settings → Providers → add a Local ACP command and enter <code className="font-mono text-text-primary">buildd-acp</code>.</li>
            <li>Open a thread in a project folder and send your request.</li>
          </ol>
        </div>
        <div>
          <h3 className="font-semibold text-text-primary">Orchestrator</h3>
          <p className="mt-1">T3&apos;s built-in Claude provider plans missions and tasks through buildd. Work you want to watch is handed to a buildd-provider thread; background work is filed as tasks.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>In T3, add the buildd MCP server at <code className="font-mono text-text-primary break-all">https://buildd.dev/api/mcp</code>, pinned to a workspace with <code className="font-mono text-text-primary">?workspace=&lt;id&gt;</code>.</li>
            <li>Sign in when T3 asks.</li>
          </ol>
        </div>
        <p>
          Your runner&apos;s status and the copyable config are on the{' '}
          <Link href={RUNNERS_HREF} className="text-text-primary underline">runner page</Link>.
        </p>
        {runners.length > 0 && (
          <ul className="divide-y divide-border-default border-t border-border-default">
            {runners.map((r) => (
              <li key={r.id} data-testid="t3-runner-row" className="flex min-h-11 items-center justify-between gap-3 py-2">
                <Link href={RUNNERS_HREF} className="min-w-0 truncate text-text-primary">{r.name}</Link>
                <StatusChip tone={TONE[r.state]}>{r.label}</StatusChip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
