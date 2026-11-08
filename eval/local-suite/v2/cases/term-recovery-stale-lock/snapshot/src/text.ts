export function shout(s: string): string {
  return s.toUpperCase() + '!';
}

export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
