// bundle v1
// --- math.ts
export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

// --- text.ts
export function shout(s: string): string {
  return s.toUpperCase() + '!';
}

export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
//# end
