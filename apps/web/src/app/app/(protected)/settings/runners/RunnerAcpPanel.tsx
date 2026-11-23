/**
 * One runner's ACP bridge: whether it can serve `buildd acp` (as the runner
 * itself reported it) and copyable T3 Code provider commands. A native
 * <details> keeps the row quiet until someone wants the snippets.
 */
import type { RunnerAcpCapability } from '@buildd/shared';
import CopyBlock from '@/components/CopyBlock';
import { acpSnippets, acpStatus } from '@/lib/acp-config';

const TONE = { ready: 'text-status-success', elsewhere: 'text-status-warning', unknown: 'text-text-muted' } as const;

export default function RunnerAcpPanel({ name, acp }: { name: string; acp?: RunnerAcpCapability | null }) {
  const status = acpStatus(acp);
  return (
    <details data-testid="runner-acp" data-acp-state={status.state} className="w-full basis-full text-xs">
      <summary className="cursor-pointer list-none text-text-secondary hover:text-text-primary">
        T3 Code (ACP): <span data-testid="runner-acp-status" className={TONE[status.state]}>{status.label}</span>
      </summary>
      <div className="mt-2 space-y-3">
        {status.detail && <p data-testid="runner-acp-detail" className="text-text-muted">{status.detail}</p>}
        <p data-testid="runner-acp-nosecret" className="text-text-muted">These commands hold no secret. The bridge talks to the runner&apos;s owner-only socket and needs no token.</p>
        {acpSnippets(acp, name).map(s => (
          <div key={s.id} data-testid={`runner-acp-snippet-${s.id}`} className="space-y-1">
            <div className="font-semibold text-text-primary">{s.title}</div>
            <div className="text-text-muted">{s.where}</div>
            <CopyBlock text={s.text} />
            <p className="text-text-muted">{s.note}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
