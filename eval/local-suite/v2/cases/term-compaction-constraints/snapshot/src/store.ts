export interface Entry {
  description: string;
  cents: number;
}

const balances = new Map<string, number>();
const history = new Map<string, Entry[]>();

export function reset(): void {
  balances.clear();
  history.clear();
}

export function balanceOf(account: string): number {
  return balances.get(account) ?? 0;
}

export function apply(account: string, cents: number, description: string): void {
  balances.set(account, balanceOf(account) + cents);
  history.set(account, [...entries(account), { description, cents }]);
}

export function entries(account: string): Entry[] {
  return history.get(account) ?? [];
}
