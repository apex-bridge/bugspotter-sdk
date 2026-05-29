/**
 * Async, append-stream storage for cross-navigation persistence.
 *
 * The existing `StorageAdapter` in `offline-queue.ts` is sync + key-
 * value (localStorage) — fine for small structured records like a
 * failed-submission retry queue, but the wrong shape for rrweb
 * replay event streams which can grow into the MB-range during a
 * single session. IndexedDB is the right primitive for that:
 *
 *  - Async (won't block the main thread on flush)
 *  - Quota typically 100MB+ per origin (vs ~5MB sessionStorage)
 *  - Native to every browser BugSpotter ships into
 *
 * This module gives the SDK a thin abstraction over IndexedDB so
 * tests can mock it (via fake-indexeddb) and we have one place to
 * harden the quota / availability soft-fail behavior.
 */
import { getLogger } from '../../utils/logger';

const logger = getLogger();

/** Default version — increment when migrating the schema. */
const DB_VERSION = 1;

/** Object store names. Constants so callers can't drift. */
export const REPLAY_STORE = 'replay-events';
export const LOG_STORE = 'logs';

export interface AsyncStorageOptions {
  /**
   * IndexedDB database name. Required — there is no sensible default
   * because IDB databases are scoped per-origin, and a shared default
   * would mix data across tenants in a multi-tenant SPA. Slice 2 (the
   * capture wiring) should derive a name from a stable identifier
   * (API key prefix, endpoint hash) so different SDK configs land in
   * separate stores.
   */
  dbName: string;
}

/**
 * `(string & {})` keeps the literal types visible to IDE tooling so
 * REPLAY_STORE / LOG_STORE auto-complete, while still accepting any
 * string at runtime (we want soft-fail behavior on schema drift,
 * not a hard reject).
 */
export type StorageStore =
  | typeof REPLAY_STORE
  | typeof LOG_STORE
  | (string & {});

/**
 * Append-only stream of objects, keyed by an autoincrement integer.
 * Reads are FIFO. Each entry is a single record (e.g., one rrweb
 * event or one batched chunk — caller's choice).
 *
 * Soft-fail contract: every method returns null / empty on
 * IndexedDB-unavailable or quota-exceeded conditions. Errors are
 * logged at warn level. The SDK's capture flow must never break
 * because storage broke.
 */
/**
 * Read result that exposes the auto-increment key alongside the
 * value. Slice 2 will use the key to call `deleteUpTo` rather than
 * `clear()` — that lets concurrent appends (e.g. a late rrweb event
 * arriving while we're flushing) survive the cleanup. Without keys,
 * a wholesale `clear()` after a successful flush would race-delete
 * anything appended between `readAll` and `clear`.
 */
export interface ReadResult<T> {
  key: number;
  value: T;
}

export interface AsyncStorage {
  /** Append a single record. */
  append<T>(store: StorageStore, value: T): Promise<void>;
  /** Append many records in a single transaction. */
  appendBatch<T>(store: StorageStore, values: T[]): Promise<void>;
  /**
   * Read records with their auto-increment keys, FIFO. Optional
   * `limit` caps the number returned — defense against unbounded
   * memory use when storage has accumulated (e.g. a long-lived SPA
   * where pagehide flushed many sessions but no init ever ran to
   * drain them). FIFO order means a limited read returns the
   * OLDEST N records, which is the right shape for a GC-and-drop
   * flow but NOT for "show me the latest session" — that's a
   * consumer-side concern.
   */
  readAll<T>(store: StorageStore, limit?: number): Promise<ReadResult<T>[]>;
  /**
   * Delete every record whose key is ≤ maxKey. The race-safe
   * alternative to `clear()` for read-then-delete flows.
   */
  deleteUpTo(store: StorageStore, maxKey: number): Promise<void>;
  /** Drop everything in the store. */
  clear(store: StorageStore): Promise<void>;
  /** Close any underlying connection. */
  close(): void;
}

/**
 * IndexedDB-backed implementation. Lazily opens the DB on first
 * write; reuses the connection across calls. Soft-fails to no-op
 * if IndexedDB is unavailable (private-browsing in some browsers,
 * SSR contexts, or genuinely-broken environments).
 */
export class IndexedDbStorage implements AsyncStorage {
  private dbName: string;
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  // Synchronous handle on the resolved db so close() can close it
  // without a microtask hop. Stays in sync with dbPromise: set on
  // successful open, cleared on versionchange / close.
  private db: IDBDatabase | null = null;

  constructor(options: AsyncStorageOptions) {
    this.dbName = options.dbName;
  }

  private async openDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    // Construct the Promise synchronously so this.dbPromise is set
    // before any concurrent openDb() call returns from the cache
    // check above. The post-settle null-out happens below, after
    // `await promise` — nulling inside the executor doesn't work
    // because the outer `this.dbPromise = promise` hasn't completed
    // yet at that point and would overwrite it.
    const promise = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, DB_VERSION);
      } catch (err) {
        logger.warn('IndexedDB open threw, soft-failing:', err);
        resolve(null);
        return;
      }
      // Flipped on the abandonment paths (blocked / error). If
      // the browser later resolves the request anyway (e.g. the
      // blocking older connection closes), we close the late-
      // arriving db handle so it doesn't leak open and block
      // future upgrades.
      let abandoned = false;
      request.onupgradeneeded = () => {
        // createObjectStore can throw on storage exhaustion or
        // schema corruption. The spec's auto-abort on uncaught
        // exception fires our onerror (with preventDefault), but
        // window.onerror typically fires BEFORE the request's
        // error event and isn't suppressed by it — host monitoring
        // (Sentry, Datadog) would still pick up the throw. Wrap +
        // explicit abort keeps the failure off the global surface.
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(REPLAY_STORE)) {
            db.createObjectStore(REPLAY_STORE, { autoIncrement: true });
          }
          if (!db.objectStoreNames.contains(LOG_STORE)) {
            db.createObjectStore(LOG_STORE, { autoIncrement: true });
          }
        } catch (err) {
          logger.warn('IndexedDB upgrade failed, aborting:', err);
          try {
            request.transaction?.abort();
          } catch {
            // Already aborted / inactive — fine.
          }
        }
      };
      request.onsuccess = () => {
        if (abandoned) {
          request.result.close();
          return;
        }
        const db = request.result;
        // Another tab opening the DB at a higher version triggers
        // versionchange on every existing connection. If we don't
        // close ours, the other tab's upgrade hangs (onblocked
        // forever). Voluntarily closing lets the new version win;
        // we null dbPromise so the next op on THIS instance opens
        // fresh against the new schema.
        db.onversionchange = () => {
          db.close();
          if (this.dbPromise === promise) {
            this.dbPromise = null;
          }
          if (this.db === db) {
            this.db = null;
          }
        };
        // onclose fires when the browser unexpectedly closes the
        // connection — storage pressure, user clearing site data,
        // disk eviction. Without clearing the cache, subsequent
        // ops would soft-fail forever against the dead handle
        // because openDb returns the still-cached promise.
        db.onclose = () => {
          if (this.dbPromise === promise) {
            this.dbPromise = null;
          }
          if (this.db === db) {
            this.db = null;
          }
        };
        resolve(db);
      };
      // preventDefault on error events stops the uncaught-IDB-error
      // console output that host-app monitoring (Sentry, Datadog)
      // often picks up via console interception.
      request.onerror = (event) => {
        logger.warn('IndexedDB open failed, soft-failing:', request.error);
        event.preventDefault();
        abandoned = true;
        resolve(null);
      };
      request.onblocked = (event) => {
        // Another tab holds an older version open. Don't hang the
        // capture flow — soft-fail; the SDK will continue without
        // persistence and try again on next page load or op. The
        // request stays queued in the browser; if the older
        // connection closes later, onsuccess will fire with a db
        // handle that the abandoned flag tells us to close.
        logger.warn('IndexedDB open blocked (other tab holds older version)');
        event.preventDefault();
        abandoned = true;
        resolve(null);
      };
    });
    this.dbPromise = promise;

    const db = await promise;
    // Null the cached promise on failure so a long-lived SPA can
    // retry on the next op once the blocking condition clears
    // (other tab closed, polyfill loaded, etc.). Successful opens
    // stay cached for the page's lifetime.
    //
    // Identity check: only null if dbPromise is STILL this
    // promise. Two concurrent openDb calls that both await a
    // failed promiseA might race — one finishes the cleanup,
    // its caller retries and sets dbPromise = promiseB, then
    // the second one finishes and would otherwise null promiseB
    // out from under the retry.
    if (!db && this.dbPromise === promise) {
      this.dbPromise = null;
    }
    // Cache the resolved db handle synchronously so close() can
    // close it without scheduling a .then. Only update if the open
    // was successful and this is still the active promise.
    if (db && this.dbPromise === promise) {
      this.db = db;
    }
    return db;
  }

  async append<T>(store: StorageStore, value: T): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      objectStore.add(value);
    });
  }

  async appendBatch<T>(store: StorageStore, values: T[]): Promise<void> {
    if (values.length === 0) return;
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      for (const value of values) {
        objectStore.add(value);
      }
    });
  }

  async readAll<T>(
    store: StorageStore,
    limit?: number
  ): Promise<ReadResult<T>[]> {
    // Short-circuit for limit <= 0 (e.g. a caller computing
    // `Math.max(0, capacity - loaded)` and hitting the boundary).
    // Without this, the cursor's first onsuccess would push one
    // record BEFORE the in-loop limit check could veto it.
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const db = await this.openDb();
    if (!db) return [];
    return new Promise<ReadResult<T>[]>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(store, 'readonly');
      } catch (err) {
        logger.warn(
          `IndexedDB readAll(${store}) tx failed, soft-failing:`,
          err
        );
        resolve([]);
        return;
      }
      // Same shape as runTransaction: tx-level events (onabort,
      // onerror) can fire without the request's own events
      // (e.g. db handle revoked mid-tx, unusual browser
      // termination). Without handling them, the Promise would
      // hang forever.
      let settled = false;
      const settle = (result: ReadResult<T>[]) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      // openCursor() instead of getAll() so we can capture the
      // auto-increment key alongside each value. The key is what
      // deleteUpTo will scope the range to.
      const results: ReadResult<T>[] = [];
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push({
            key: cursor.key as number,
            value: cursor.value as T,
          });
          // Check the limit AFTER push but BEFORE continuing —
          // otherwise we'd fetch one extra record from storage
          // only to discard it on the next onsuccess tick.
          if (limit === undefined || results.length < limit) {
            cursor.continue();
            return;
          }
        }
        settle(results);
      };
      req.onerror = (event) => {
        if (!settled) {
          logger.warn(`IndexedDB readAll(${store}) request failed:`, req.error);
        }
        event.preventDefault();
        settle([]);
      };
      tx.onabort = () => settle([]);
      tx.onerror = (event) => {
        event.preventDefault();
        settle([]);
      };
    });
  }

  async deleteUpTo(store: StorageStore, maxKey: number): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      // Inclusive upper bound — delete every record whose key is
      // ≤ maxKey. Records appended AFTER the readAll that produced
      // maxKey survive (their auto-increment keys are > maxKey).
      objectStore.delete(IDBKeyRange.upperBound(maxKey));
    });
  }

  async clear(store: StorageStore): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      objectStore.clear();
    });
  }

  close(): void {
    // Synchronous close when the db is already open — eliminates
    // the microtask gap during which user code could try another
    // op against a "closing" connection. Falls back to the
    // promise-based close only if open is still in flight.
    if (this.db) {
      this.db.close();
      this.db = null;
    } else if (this.dbPromise) {
      void this.dbPromise.then((db) => {
        db?.close();
      });
    }
    this.dbPromise = null;
  }

  private runTransaction(
    db: IDBDatabase,
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => void
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, mode);
      } catch (err) {
        // Most commonly: store doesn't exist (DB schema drift). Soft-fail.
        logger.warn(`IndexedDB tx(${storeName}) failed:`, err);
        resolve();
        return;
      }
      // A failing tx fires BOTH onerror and onabort sequentially —
      // a `settled` flag dedupes the log so host monitoring sees
      // one warning per underlying failure, not two.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.oncomplete = () => settle();
      tx.onerror = (event) => {
        if (!settled) {
          logger.warn(`IndexedDB tx(${storeName}) error:`, tx.error);
        }
        event.preventDefault();
        settle();
      };
      tx.onabort = () => {
        if (!settled) {
          logger.warn(`IndexedDB tx(${storeName}) aborted:`, tx.error);
        }
        settle();
      };
      try {
        work(tx.objectStore(storeName));
      } catch (err) {
        // Catching the sync throw stops the spec's implicit
        // "abort transaction on uncaught exception" behavior, so
        // any successful ops earlier in this tx (e.g. appendBatch
        // items before a non-serializable one) could otherwise
        // still commit. Explicit abort discards them.
        logger.warn(`IndexedDB tx(${storeName}) work threw:`, err);
        try {
          tx.abort();
        } catch {
          // Already aborted / finished — fine.
        }
        // settle() (not resolve()) so the `settled` flag is set
        // immediately. tx.abort() above triggers tx.onabort
        // asynchronously — without the flag set, that handler
        // would log a duplicate "tx aborted" warning. The
        // unconditional call also guards against tx.abort() itself
        // throwing AND no onabort/onerror subsequently firing,
        // which would otherwise hang the capture flow.
        settle();
      }
    });
  }
}
