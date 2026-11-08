/** Statuses worth another attempt. */
export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}
