import { invoiceLine } from './invoice';
import { receiptLine } from './receipt';
import { reportRow } from './report';
import { assertCurrency, type Currency } from './money';

export interface Item {
  label: string;
  amount: number;
}

export function summary(items: Item[], currency: Currency = 'USD'): string[] {
  const c = assertCurrency(currency);
  return items.map((i) =>
    [
      invoiceLine(i.label, i.amount, c),
      receiptLine(i.label, i.amount, c),
      reportRow(i.label, i.amount, c),
    ].join(' | '),
  );
}
