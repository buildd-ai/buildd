function fmt(x: number): string {
  const r = Math.round(x * 100) / 100;
  const s = Math.abs(r).toFixed(2);
  return (r < 0 ? '-$' : '$') + s;
}

export function invoiceLine(label: string, amount: number): string {
  return `${label}: ${fmt(amount)}`;
}
