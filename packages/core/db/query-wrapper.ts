/**
 * Wrap a neon client's `.query` so a failing query is recorded on the active
 * span, WITHOUT running it early.
 *
 * `.query()` returns a lazy NeonQueryPromise: it runs only when awaited, and
 * `db.batch()` relies on that — it collects the un-run promises and hands
 * their `queryData` to `sql.transaction([...])`, which runs them as one
 * transaction. Calling `.catch()` on one (as this wrapper once did) runs it
 * immediately and returns a plain Promise; batch then executed every
 * statement standalone, outside the transaction and any advisory lock in it,
 * and threw "transaction() expects an array of queries" — so every
 * `db.batch` in the app failed after half-running.
 *
 * The hook therefore goes on the promise's own `execute`, which is what
 * then/catch/finally call when it is awaited. `transaction()` never calls it,
 * so a batch stays one transaction (its errors are not captured here; the
 * caller sees them).
 */
export function wrapNeonQuery<T extends { query: (...args: any[]) => any }>(
  client: T,
  onError: (error: unknown) => void,
): T {
  const originalQuery = client.query.bind(client);
  client.query = ((...args: unknown[]) => {
    const pending = originalQuery(...args);
    const execute = pending?.execute;
    if (typeof execute === 'function') {
      pending.execute = (...execArgs: unknown[]) =>
        execute.apply(pending, execArgs).catch((error: unknown) => {
          onError(error);
          throw error;
        });
    }
    return pending;
  }) as T['query'];
  return client;
}
