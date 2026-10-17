'use client';

import { createContext, useContext, type ReactNode } from 'react';
import Disclosure from './Disclosure';

/**
 * The one place layer-3 diagnostics render: gate reason codes, runner
 * scheduling and availability, override flags, exact timings
 * (docs/design/design-system.md §5 rule 18). The headline and the one-sentence
 * reason stay outside it, for everyone.
 *
 * A page decides once who is looking (`canSeeDiagnostics`,
 * lib/diagnostics-audience.ts) and wraps its body in
 * `DiagnosticsAudienceProvider`. Without a provider nothing renders: a surface
 * that has not decided its audience shows no diagnostics.
 */
const DiagnosticsAudience = createContext(false);

export function DiagnosticsAudienceProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <DiagnosticsAudience.Provider value={visible}>{children}</DiagnosticsAudience.Provider>;
}

export function useDiagnosticsVisible(): boolean {
  return useContext(DiagnosticsAudience);
}

export default function DiagnosticsDisclosure({
  summary = 'Diagnostics',
  children,
  className,
}: {
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  if (!useDiagnosticsVisible()) return null;
  return (
    <div data-testid="diagnostics-disclosure" className={className}>
      <Disclosure summary={summary}>
        <div className="space-y-1 pt-1 font-mono text-eyebrow text-text-muted [overflow-wrap:anywhere]">{children}</div>
      </Disclosure>
    </div>
  );
}

export { DiagnosticsDisclosure };
