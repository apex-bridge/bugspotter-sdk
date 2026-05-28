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

/** Default IndexedDB database name. */
const DB_NAME = 'bugspotter';
/** Default version — increment when migrating the schema. */
const DB_VERSION = 1;

/** Object store names. Constants so callers can't drift. */
export const REPLAY_STORE = 'replay-events';
export const LOG_STORE = 'logs';

export interface AsyncStorageOptions {
  /** Override the default database name. */
  dbName?: string;
}

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
export interface AsyncStorage {
  /** Append a single record. */
  append<T>(store: string, value: T): Promise<void>;
  /** Append many records in a single transaction. */
  appendBatch<T>(store: string, values: T[]): Promise<void>;
  /** Read all records, FIFO. */
  readAll<T>(store: string): Promise<T[]>;
  /** Drop everything in the store. */
  clear(store: string): Promise<void>;
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

  constructor(options: AsyncStorageOptions = {}) {
    this.dbName = options.dbName ?? DB_NAME;
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
        const db = request.result;
        if (!db.objectStoreNames.contains(REPLAY_STORE)) {
          db.createObjectStore(REPLAY_STORE, { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(LOG_STORE)) {
          db.createObjectStore(LOG_STORE, { autoIncrement: true });
        }
      };
      request.onsuccess = () => {
        if (abandoned) {
          request.result.close();
          return;
        }
        resolve(request.result);
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
    if (!db) {
      this.dbPromise = null;
    }
    return db;
  }

  async append<T>(store: string, value: T): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      objectStore.add(value);
    });
  }

  async appendBatch<T>(store: string, values: T[]): Promise<void> {
    if (values.length === 0) return;
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      for (const value of values) {
        objectStore.add(value);
      }
    });
  }

  async readAll<T>(store: string): Promise<T[]> {
    const db = await this.openDb();
    if (!db) return [];
    return new Promise<T[]>((resolve) => {
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
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as T[]);
      req.onerror = (event) => {
        logger.warn(`IndexedDB readAll(${store}) request failed:`, req.error);
        event.preventDefault();
        resolve([]);
      };
    });
  }

  async clear(store: string): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await this.runTransaction(db, store, 'readwrite', (objectStore) => {
      objectStore.clear();
    });
  }

  close(): void {
    if (!this.dbPromise) return;
    void this.dbPromise.then((db) => {
      db?.close();
    });
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
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => {
        logger.warn(`IndexedDB tx(${storeName}) error:`, tx.error);
        event.preventDefault();
        // Resolve rather than reject — soft-fail contract.
        resolve();
      };
      tx.onabort = () => {
        logger.warn(`IndexedDB tx(${storeName}) aborted:`, tx.error);
        resolve();
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
        // Resolve unconditionally. If tx.abort threw AND neither
        // onabort nor onerror subsequently fires, the Promise
        // would otherwise hang forever and hang the capture flow.
        // Promise resolve is idempotent — a later onabort call is
        // a no-op.
        resolve();
      }
    });
  }
}
