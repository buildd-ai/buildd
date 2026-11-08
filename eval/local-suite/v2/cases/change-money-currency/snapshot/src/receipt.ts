function fmt(x: number): string {
  return 'USD ' + x.toFixed(2);
}

export function receiptLine(label: string, amount: number): string {
  return `${label.toUpperCase()} ${fmt(amount)}`;
}
