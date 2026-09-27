import type { PersonSpend, Split, SpendSummary } from '@/lib/spend-summary';

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Your own spend: Interactive vs Agent runs, today and this month. */
export function MySpend({ me }: { me: SpendSummary['me'] }) {
  const row = (label: string, s: Split, id: string) => (
    <tr key={id} className="border-t border-border-default" data-testid={`my-spend-${id}`}>
      <th scope="row" className="px-4 py-2.5 text-left font-normal text-text-primary">{label}</th>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{usd(s.today)}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{usd(s.month)}</td>
    </tr>
  );
  return (
    <div className="card overflow-hidden"><table className="w-full text-sm" data-testid="my-spend">
      <thead>
        <tr className="text-xs text-text-muted">
          <th scope="col" className="px-4 py-2 text-left font-normal"><span className="sr-only">Kind</span></th>
          <th scope="col" className="px-4 py-2 text-right font-normal">Today</th>
          <th scope="col" className="px-4 py-2 text-right font-normal">This month</th>
        </tr>
      </thead>
      <tbody>
        {row('Interactive', me.interactive, 'interactive')}
        {row('Agent runs', me.agent, 'agent')}
      </tbody>
    </table></div>
  );
}

/** Admins: each person's split, this month with today beneath. */
export function PeopleSpend({ people, unattributed }: { people: PersonSpend[]; unattributed: Split }) {
  const cell = (s: Split) => (
    <td className="px-4 py-2.5 text-right align-top">
      <span className="block font-mono tabular-nums text-text-primary">{usd(s.month)}</span>
      <span className="block font-mono tabular-nums text-xs text-text-muted">{usd(s.today)} today</span>
    </td>
  );
  const rows = [...people.map((p) => ({ key: p.userId, label: p.label, interactive: p.interactive, agent: p.agent }))];
  if (unattributed.month > 0) rows.push({ key: 'none', label: 'No mission', interactive: { today: 0, month: 0 }, agent: unattributed });
  return (
    <div className="card overflow-hidden"><table className="w-full text-sm table-fixed" data-testid="people-spend">
      <thead>
        <tr className="text-xs text-text-muted">
          <th scope="col" className="px-4 py-2 text-left font-normal w-[40%]">Person</th>
          <th scope="col" className="px-4 py-2 text-right font-normal">Interactive</th>
          <th scope="col" className="px-4 py-2 text-right font-normal">Agent runs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-border-default" data-testid="people-spend-row">
            <th scope="row" className="px-4 py-2.5 text-left font-normal text-text-primary align-top truncate">{r.label}</th>
            {cell(r.interactive)}
            {cell(r.agent)}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}
