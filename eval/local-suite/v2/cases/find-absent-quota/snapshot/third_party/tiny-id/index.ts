// Vendored copy of tiny-id 2.1.0 (MIT). Unmodified.
let n = 0;
export function nextId(prefix = 'id'): string {
  n += 1;
  return `${prefix}_${n.toString(36)}`;
}
