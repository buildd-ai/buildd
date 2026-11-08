import { invoiceLine } from './invoice';
import { receiptLine } from './receipt';
import { reportRow } from './report';

export interface Item {
  label: string;
  amount: number;
}

export function summary(items: Item[], currency = 'USD'): string[] {
  return items.map((i) =>
    [
      invoiceLine(i.label, i.amount, currency),
      receiptLine(i.label, i.amount, currency),
      reportRow(i.label, i.amount, currency),
    ].join(' | '),
  );
}
