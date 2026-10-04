/**
 * An in-process snapshot of a runtime record, refreshed in the background.
 *
 * The shape behind policy overrides (`apps/web/src/lib/policy-overrides.ts`)
 * and versioned prompts (`prompts.ts`): sync getters read a value installed in
 * memory, never the database; a server process installs it at boot and keeps it
 * fresh with a rate-limited reload that the getters poke on read.
 *
 * Pure: no DB, no env. The record's reader is injected by a server-only
 * `*-source.ts` module, so a client bundle (or the runner) that imports the
 * snapshot only ever sees what was installed, which is the initial value.
 */

export interface RuntimeSnapshot<T> {
  /** The installed value. Pokes the refresher first, so a server process stays fresh. */
  read(): T;
  /** The installed value without poking the refresher. */
  peek(): T;
  install(value: T): void;
  /** Register a callback `read()` pokes. The loader registers itself and rate-limits the actual reads. */
  setRefresher(fn: (() => void) | null): void;
  /** Back to the initial value with no refresher. For tests. */
  reset(): void;
}

export function createRuntimeSnapshot<T>(initial: T): RuntimeSnapshot<T> {
  let value = initial;
  let refresher: (() => void) | null = null;
  return {
    read() {
      refresher?.();
      return value;
    },
    peek: () => value,
    install(next) {
      value = next;
    },
    setRefresher(fn) {
      refresher = fn;
    },
    reset() {
      value = initial;
      refresher = null;
    },
  };
}

export interface SnapshotLoaderConfig<T> {
  /** Log prefix, e.g. `policy-overrides`. */
  name: string;
  ttlMs: number;
  snapshot: RuntimeSnapshot<T>;
  /** Read the raw record. `undefined`/`null` means there is none. May throw. */
  read: () => Promise<unknown>;
  /** Turn a raw record (null when absent) into the value to install. Must not throw. */
  parse: (raw: unknown) => T;
  /** Logged once while the record stays absent. */
  missingMessage: string;
}

export interface LoadOptions {
  force?: boolean;
  read?: () => Promise<unknown>;
  now?: () => number;
}

export interface SnapshotLoader<T> {
  /** Load (or reuse, within the TTL) the record and install it. Never throws. */
  load(opts?: LoadOptions): Promise<T>;
  /** Load now and keep `snapshot.read()` fresh from here on. Once per server process. */
  start(): Promise<void>;
  /** Forget the TTL, the in-flight read and the missing-record log state. For tests. */
  reset(): void;
}

/**
 * Read at most once per `ttlMs` per process. A failed read keeps whatever was
 * installed before (the initial value on a cold process) and logs; a missing
 * record installs `parse(null)`.
 */
export function createSnapshotLoader<T>(config: SnapshotLoaderConfig<T>): SnapshotLoader<T> {
  let lastLoadAt = 0;
  let inflight: Promise<T> | null = null;
  let loggedMissing = false;

  const load = (opts: LoadOptions = {}): Promise<T> => {
    const now = opts.now ?? Date.now;
    if (!opts.force && lastLoadAt > 0 && now() - lastLoadAt < config.ttlMs) {
      return Promise.resolve(config.snapshot.peek());
    }
    if (inflight && !opts.force) return inflight;

    // Stamp before reading, so a burst of stale reads triggers one query.
    lastLoadAt = now();
    const read = opts.read ?? config.read;
    const run = (async () => {
      try {
        const raw = await read();
        if (raw === undefined || raw === null) {
          if (!loggedMissing) {
            console.info(`[${config.name}] ${config.missingMessage}`);
            loggedMissing = true;
          }
          config.snapshot.install(config.parse(null));
        } else {
          loggedMissing = false;
          config.snapshot.install(config.parse(raw));
        }
      } catch (err) {
        console.warn(
          `[${config.name}] could not read the record; keeping the values in effect:`,
          err instanceof Error ? err.message : err,
        );
      }
      return config.snapshot.peek();
    })();
    inflight = run;
    return run.finally(() => {
      if (inflight === run) inflight = null;
    });
  };

  return {
    load,
    async start() {
      config.snapshot.setRefresher(() => {
        if (lastLoadAt > 0 && Date.now() - lastLoadAt < config.ttlMs) return;
        void load();
      });
      await load({ force: true });
    },
    reset() {
      lastLoadAt = 0;
      inflight = null;
      loggedMissing = false;
    },
  };
}
