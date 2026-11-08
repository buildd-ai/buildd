function fmt(x: number): string {
  const r = Math.round(Math.abs(x) * 100) / 100;
  const [i, f] = r.toFixed(2).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = '$' + g + '.' + f;
  return x < 0 ? '(' + body + ')' : body;
}

export function reportRow(label: string, amount: number): string {
  return label.padEnd(12) + fmt(amount).padStart(14);
}
