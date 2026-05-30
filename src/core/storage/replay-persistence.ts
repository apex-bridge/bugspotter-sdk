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
}

export class ReplayPersistence {
  private storage: AsyncStorage;
  private pagehideHandler: ((event: PageTransitionEvent) => void) | null = null;
  private boundBuffer: PersistableBuffer | null = null;
  // Tracks whether we've ever attached the pagehide listener.
  // We bind once per instance — repeated `bind` calls are no-ops.
  private listenerAttached = false;

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
    try {
      window.addEventListener('pagehide', this.pagehideHandler);
      this.listenerAttached = true;
    } catch (err) {
      logger.warn('ReplayPersistence: pagehide bind failed:', err);
    }
  }

  /**
   * Read the prior session's events, seed the buffer, and delete
   * the consumed records. Idempotent — calling restore twice on the
   * same session returns [] the second time (records are deleted
   * after read).
   */
  async restore(buffer: PersistableBuffer): Promise<void> {
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
    try {
      buffer.addBatch(results.map((r) => r.value));
    } catch (err) {
      // CircularBuffer.addBatch shouldn't throw, but if it does
      // we still want to clean up storage so the next session
      // doesn't replay the same events.
      logger.warn('ReplayPersistence: addBatch threw:', err);
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
    if (
      this.pagehideHandler &&
      typeof window !== 'undefined' &&
      window.removeEventListener
    ) {
      try {
        window.removeEventListener('pagehide', this.pagehideHandler);
      } catch (err) {
        logger.warn('ReplayPersistence: pagehide unbind failed:', err);
      }
    }
    this.pagehideHandler = null;
    this.listenerAttached = false;
    this.boundBuffer = null;
    this.storage.close();
  }
}
