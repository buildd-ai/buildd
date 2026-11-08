/** Memoize fn; keyOf decides which calls share an entry. */
export function memoize<A extends unknown[], R>(
  fn: (...args: A) => R,
  keyOf: (...args: A) => string,
): (...args: A) => R {
  const seen = new Map<string, R>();
  return (...args: A) => {
    const k = keyOf(...args);
    if (!seen.has(k)) seen.set(k, fn(...args));
    return seen.get(k) as R;
  };
}
