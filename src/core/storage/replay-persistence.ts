/**
 * Cross-navigation replay persistence wiring.
 *
 * Sits between the storage primitive (`IndexedDbStorage`) and the
 * DOM collector. Responsibilities:
 *
 *  - Lazily open the IDB connection on first use (cost-free when
 *    opted out — caller can construct this and never call flush /
 *    restore, no DB is opened).
 *  - `pagehide` listener that flushes the buffer's events on
 *    navigate-away. Bound once per instance; cleaned up via
 *    `destroy()`.
 *  - `restore` reads the prior session's events from IDB, seeds
 *    the buffer, and deletes the consumed records via deleteUpTo
 *    (race-safe alternative to clear() — concurrent appends from
 *    a re-entrant pagehide would survive).
 *
 * Soft-fail contract is the whole point: storage failures must
 * NEVER break the capture flow. Every method swallows errors and
 * logs at warn level. A caller that opts in can rely on persistence
 * being best-effort, not load-bearing.
 *
 * Limitation noted in slice 2 v1: `CircularBuffer.prune()` uses
 * `Date.now() - duration` as the cutoff, so restored events from
 * before the reload are pruned almost immediately unless the user
 * reloads within the duration window. The buffer's "always preserve
 * the most recent FullSnapshot" rule keeps a snapshot intact, but
 * fine-grained pre-reload activity past the window is lost. A
 * follow-up could either adjust the prune cutoff to be relative to
 * the latest event's timestamp or stamp restored events with a
 * monotonic flag the prune skips.
 */
import type { eventWithTime } from '@rrweb/types';
import { getLogger } from '../../utils/logger';
import { IndexedDbStorage, REPLAY_STORE } from './replay-store';
import type { AsyncStorage, ReadResult } from './replay-store';

const logger = getLogger();

/**
 * Hard upper bound on how many events we restore per page load.
 * If a long-lived SPA stacked many pagehide flushes without an init
 * ever draining them, we'd otherwise read every accumulated record
 * into memory. 5000 is comfortable: a normal 180s session is
 * typically <1500 events.
 */
const RESTORE_LIMIT = 5000;

export interface ReplayPersistenceOptions {
  /** Required — see AsyncStorageOptions in replay-store.ts. */
  dbName: string;
  /**
   * Storage override for tests. Default is a lazy IndexedDbStorage
   * constructed from `dbName`.
   */
  storage?: AsyncStorage;
}

/**
 * Interface the persistence layer needs from the event buffer. Kept
 * narrow on purpose — `CircularBuffer` satisfies it, but tests can
 * supply a minimal stub.
 */
export interface PersistableBuffer {
  getEvents(): eventWithTime[];
  addBatch(events: eventWithTime[]): void;
  /**
   * Optional cancellation signal. Implementers return true once the
   * owner of this buffer (typically the DOMCollector session) has
   * been destroyed or superseded by a restart. When true, restore
   * MUST skip both addBatch and deleteUpTo — the records being
   * restored have no live owner, and deleting them from IDB would
   * lose them forever. Defaults to "never aborted" when absent.
   */
  isAborted?(): boolean;
}

export class ReplayPersistence {
  private readonly storage: AsyncStorage;
  private pagehideHandler: ((event: PageTransitionEvent) => void) | null = null;
  private pageshowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private boundBuffer: PersistableBuffer | null = null;
  // Tracks whether we've ever attached the lifecycle listeners.
  // We bind once per instance — repeated `bind` calls are no-ops.
  private listenerAttached = false;
  // Idempotency guard: restore reads + deletes the prior session's
  // events. On a rapid start→stop→start (React 18 StrictMode
  // double-mount), the second restore would race the first's
  // deleteUpTo and could re-read + re-add the same records,
  // doubling them in the buffer. Set synchronously at restore
  // entry — any subsequent call short-circuits before its readAll.
  private hasRestored = false;

  constructor(options: ReplayPersistenceOptions) {
    this.storage =
      options.storage ?? new IndexedDbStorage({ dbName: options.dbName });
  }

  /**
   * Wire the pagehide listener for the given buffer. Subsequent
   * calls with a different buffer rebind to the new one but reuse
   * the same listener. Soft-fails when `addEventListener` isn't
   * available (SSR, very old environments).
   */
  bind(buffer: PersistableBuffer): void {
    this.boundBuffer = buffer;
    if (this.listenerAttached) {
      return;
    }
    if (typeof window === 'undefined' || !window.addEventListener) {
      return;
    }
    this.pagehideHandler = () => {
      // Fire-and-forget. We deliberately don't await — pagehide
      // handlers must return quickly so the browser can dispatch
      // the navigation. The IDB write may not finish before the
      // page is torn down; that's acceptable for v1 (cross-nav
      // persistence is best-effort).
      void this.flush();
    };
    // bfcache handling: when a page enters the back-forward cache,
    // its in-memory state (including the rrweb buffer) is preserved.
    // pagehide fires anyway, so we wrote the events to IDB. On
    // return, pageshow fires with event.persisted === true and the
    // memory buffer is still authoritative — meaning the IDB copy
    // is now obsolete. Clearing it prevents duplicates on the
    // NEXT real pagehide (which would otherwise re-append the same
    // events the memory buffer already holds).
    this.pageshowHandler = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        return;
      }
      void this.storage.clear(REPLAY_STORE).catch((err) => {
        logger.warn('ReplayPersistence: bfcache clear failed:', err);
      });
    };
    try {
      window.addEventListener('pagehide', this.pagehideHandler);
      window.addEventListener('pageshow', this.pageshowHandler);
      this.listenerAttached = true;
    } catch (err) {
      logger.warn('ReplayPersistence: lifecycle bind failed:', err);
    }
  }

  /**
   * Read the prior session's events, seed the buffer, and delete
   * the consumed records. Idempotent — calling restore twice on the
   * same session returns [] the second time (records are deleted
   * after read).
   */
  async restore(buffer: PersistableBuffer): Promise<void> {
    // Set synchronously BEFORE any await so a re-entrant restore
    // (rapid restart) sees the flag and short-circuits.
    if (this.hasRestored) return;
    this.hasRestored = true;

    let results: ReadResult<eventWithTime>[];
    try {
      results = await this.storage.readAll<eventWithTime>(
        REPLAY_STORE,
        RESTORE_LIMIT
      );
    } catch (err) {
      logger.warn('ReplayPersistence: restore read failed:', err);
      return;
    }
    if (results.length === 0) {
      return;
    }
    // Cancellation check before addBatch + delete. If the owner
    // (collector session) was destroyed or replaced while we were
    // awaiting readAll, we must NOT delete records the owner never
    // received. Returning early preserves them for the next live
    // restore. See PersistableBuffer.isAborted.
    if (buffer.isAborted?.()) {
      return;
    }
    try {
      buffer.addBatch(results.map((r) => r.value));
    } catch (err) {
      // CircularBuffer.addBatch shouldn't throw, but if it does
      // we still want to clean up storage so the next session
      // doesn't replay the same events.
      logger.warn('ReplayPersistence: addBatch threw:', err);
    }
    // Second cancellation check: addBatch may have synchronously
    // unwound the owner (e.g. an error handler that destroys the
    // SDK). Skip delete in that case too.
    if (buffer.isAborted?.()) {
      return;
    }
    if (results.length >= RESTORE_LIMIT) {
      // We hit the cap. readAll is FIFO, so records past the limit
      // (newer than maxKey) are still in IDB. deleteUpTo(maxKey)
      // would leave them dangling — they'd be restored in a future
      // session, fused into a different timeline. Clear the whole
      // store instead. Trade-off: a pagehide flush that ran
      // concurrently with this readAll loses its newly-appended
      // records. That's worse than nothing but better than
      // cross-session timeline corruption.
      try {
        await this.storage.clear(REPLAY_STORE);
      } catch (err) {
        logger.warn('ReplayPersistence: restore clear-on-cap failed:', err);
      }
      return;
    }
    // deleteUpTo (not clear) so a pagehide flush that fired
    // CONCURRENTLY with this restore — appending new records
    // after our readAll — survives. The new records have keys
    // > maxKey (our highest read key) and stay in storage.
    const maxKey = results[results.length - 1].key;
    try {
      await this.storage.deleteUpTo(REPLAY_STORE, maxKey);
    } catch (err) {
      logger.warn('ReplayPersistence: restore deleteUpTo failed:', err);
    }
  }

  /**
   * Flush the bound buffer's current events to storage. Called by
   * the pagehide handler and exposed for tests / explicit triggers.
   * Soft-fails on every error path.
   */
  async flush(): Promise<void> {
    if (!this.boundBuffer) {
      return;
    }
    let events: eventWithTime[];
    try {
      events = this.boundBuffer.getEvents();
    } catch (err) {
      logger.warn('ReplayPersistence: flush read-from-buffer failed:', err);
      return;
    }
    if (events.length === 0) {
      return;
    }
    try {
      await this.storage.appendBatch(REPLAY_STORE, events);
    } catch (err) {
      logger.warn('ReplayPersistence: flush appendBatch failed:', err);
    }
  }

  /**
   * Remove the pagehide listener and close the storage handle.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      try {
        if (this.pagehideHandler) {
          window.removeEventListener('pagehide', this.pagehideHandler);
        }
        if (this.pageshowHandler) {
          window.removeEventListener('pageshow', this.pageshowHandler);
        }
      } catch (err) {
        logger.warn('ReplayPersistence: lifecycle unbind failed:', err);
      }
    }
    this.pagehideHandler = null;
    this.pageshowHandler = null;
    this.listenerAttached = false;
    this.boundBuffer = null;
    // Reset the idempotency flag so a host that re-uses this
    // persistence instance with a new collector (uncommon but
    // possible if exported) can still restore.
    this.hasRestored = false;
    this.storage.close();
  }
}
