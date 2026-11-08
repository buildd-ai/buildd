/** Throttle noisy search-box input in the admin page. */
export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
