import { invoiceLine } from './invoice';
import { receiptLine } from './receipt';
import { reportRow } from './report';

export interface Item {
  label: string;
  amount: number;
}

export function summary(items: Item[]): string[] {
  return items.map((i) =>
    [
      invoiceLine(i.label, i.amount),
      receiptLine(i.label, i.amount),
      reportRow(i.label, i.amount),
    ].join(' | '),
  );
}
