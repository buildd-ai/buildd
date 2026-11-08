/** Display only; not used by price(). */
export function formatPrice(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}
