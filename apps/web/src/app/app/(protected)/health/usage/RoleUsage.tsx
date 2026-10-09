'use client';
import { useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import Segmented from '@/components/ui/Segmented';
import { usageByRole, type UsageRow } from '@/components/insights/usage-model';
import { formatHours } from '@/components/insights/flow-chart-model';

export interface RoleUsageData { rows: UsageRow[]; truncated: boolean }

export function RoleUsage({ rows, truncated, window }: RoleUsageData & { window: '7d' | '30d' }) {
  const [measure, setMeasure] = useState<'tokens' | 'hours'>('tokens');
  const roles = usageByRole(rows).sort((a, b) => b[measure] - a[measure] || a.role.localeCompare(b.role));
  const maxRole = Math.max(1, ...roles.map(r => r[measure]));
  const formatTokens = (n: number) => n.toLocaleString();
  return <>
      {roles.length > 0 && (
        <section className="mb-6" data-testid="usage-roles">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-title font-semibold">Usage by role</h2>
            <Segmented label="Usage measure" items={[{ value: 'tokens', label: 'Tokens' }, { value: 'hours', label: 'Time' }]} value={measure} onChange={setMeasure} />
          </div>
          <p className="mt-2 text-meta text-text-muted">Run totals · last {window === '30d' ? '30 days' : '7 days'}</p>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2 text-meta text-text-muted"><span>Role / tier</span><span className="text-right">{measure === 'tokens' ? 'Tokens' : 'Time'}</span><span className="text-right">Real ($)</span><span className="text-right">Plan ($)</span></div>
          <ul className="mt-2 divide-y divide-border-default border-y border-border-default">
            {roles.map(r => (
              <li key={r.role} className="text-meta py-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2 font-semibold"><span className="break-words">{r.role}</span><span className="text-right">{measure === 'tokens' ? formatTokens(r.tokens) : formatHours(r.hours)}</span><span className="text-right">${r.realUsd.toFixed(2)}</span><span className="text-right">${r.virtualUsd.toFixed(2)}</span></div>
                <div className="mt-1 h-2 bg-surface-3" aria-hidden><span className="block h-2" style={{ width: `${r[measure] / maxRole * 100}%`, background: 'var(--flow-running)' }} /></div>
                <Disclosure summary="Tiers"><ul className="space-y-1 text-text-secondary pb-2">
                  {r.tiers.map(t => <li key={t.tier} className="grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2"><span className="break-words">{t.tier}</span><span className="text-right">{measure === 'tokens' ? formatTokens(t.tokens) : formatHours(t.hours)}</span><span className="text-right">${t.realUsd.toFixed(2)}</span><span className="text-right">${t.virtualUsd.toFixed(2)}</span></li>)}
                </ul></Disclosure>
              </li>
            ))}
          </ul>
          {truncated && <p className="text-meta text-text-muted mt-2">Partial window</p>}
        </section>
      )}
  </>;
}
