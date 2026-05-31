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
 *  - `restore` atomically reads up to RESTORE_LIMIT events AND
 *    clears the IDB store via a single readwrite transaction
 *    (readAndClear). IDB serializes transactions, so a concurrent
 *    pagehide flush is queued either entirely before (we read its
 *    records) or entirely after (its records land in the cleared
 *    store and are restored next session) — no race window.
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
  private visibilityChangeHandler: (() => void) | null = null;
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
  // Flush dedup watermark. Only events with timestamp > this value
  // are written on the next flush. Prevents visibilitychange +
  // pagehide firing in sequence (normal desktop nav) from writing
  // the buffer twice, which would produce duplicate events on the
  // next restore. Reset to 0 on bfcache clear (memory buffer is
  // authoritative there, IDB is wiped) and on destroy().
  private lastFlushedTimestamp = 0;
  // Serialization chain. Concurrent flush() calls (visibilitychange
  // followed by pagehide on the same desktop navigation) are queued
  // onto this promise so they run one after another. The second
  // flush re-reads the buffer + watermark, so it picks up events
  // that landed between the first and second trigger (no data loss
  // on unload), and writes nothing if there's no delta. Async
  // operations that affect IDB state (bfcache clear) are also
  // chained here so subsequent flushes wait for them.
  private flushPromise: Promise<void> = Promise.resolve();
  // Generation counter. Bumped on bfcache reset and destroy so an
  // in-flight flush that resolves AFTER the reset doesn't clobber
  // the just-reset watermark with its stale high-value computation.
  // Each flush captures the generation at start and only updates
  // the watermark if the generation hasn't changed.
  private flushGeneration = 0;

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
      // Bump generation FIRST so any in-flight flush (kicked off by
      // a pagehide that fired just before bfcache entry) sees the
      // new generation when it eventually resolves and skips its
      // watermark update — its high-watermark value is stale once
      // we reset below.
      this.flushGeneration++;
      this.lastFlushedTimestamp = 0;
      // Chain the clear onto flushPromise so any pagehide-triggered
      // flush after the user navigates away again is queued AFTER
      // clear() completes. Without this chain, pagehide's
      // appendBatch could race ahead of clear in the IDB transaction
      // queue and have its events wiped.
      this.flushPromise = this.flushPromise
        .catch(() => undefined)
        .then(() => this.storage.clear(REPLAY_STORE))
        .catch((err) => {
          logger.warn('ReplayPersistence: bfcache clear failed:', err);
        });
    };
    // Mobile reliability: on iOS Safari the OS can kill backgrounded
    // tabs WITHOUT firing pagehide. visibilitychange fires earlier
    // (when the tab transitions to hidden), giving IDB the largest
    // possible window to complete the async write. On normal desktop
    // navigation both fire (visibility first, then pagehide); the
    // lastFlushedTimestamp watermark prevents the second flush from
    // duplicating what the first already wrote.
    this.visibilityChangeHandler = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        void this.flush();
      }
    };
    try {
      window.addEventListener('pagehide', this.pagehideHandler);
      window.addEventListener('pageshow', this.pageshowHandler);
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener(
          'visibilitychange',
          this.visibilityChangeHandler
        );
      }
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

    // Atomic read+clear in a single IDB readwrite transaction. The
    // race the slice 2 readAll → branch → (clear | deleteUpTo) flow
    // had was the gap between the read and the cleanup: a concurrent
    // pagehide flush could append records that the cleanup then
    // wiped (clear path) or that we lost track of (no atomic guard).
    // IDB serializes transactions, so any concurrent appendBatch is
    // queued either entirely BEFORE us (we read its records) or
    // entirely AFTER (its records land in the now-empty store and
    // are restored next session). Neither path loses data.
    let results: ReadResult<eventWithTime>[];
    try {
      results = await this.storage.readAndClear<eventWithTime>(
        REPLAY_STORE,
        RESTORE_LIMIT
      );
    } catch (err) {
      logger.warn('ReplayPersistence: restore readAndClear failed:', err);
      return;
    }
    if (results.length === 0) {
      return;
    }
    // Hoist the unwrap once — `results` can be up to RESTORE_LIMIT
    // (5000) entries and both downstream paths (re-append on abort,
    // addBatch on live owner) need the same value array.
    const events = results.map((r) => r.value);
    // Cancellation check before addBatch. If the owner (collector
    // session) was destroyed or replaced while we were awaiting
    // readAndClear, the records are in memory but IDB was already
    // wiped by the atomic op. Re-append them so the next live
    // restore can pick them up — preserves the slice 2 round 4
    // "destroy-during-restore preserves records" contract under
    // the new atomic primitive.
    if (buffer.isAborted?.()) {
      try {
        await this.storage.appendBatch(REPLAY_STORE, events);
      } catch (err) {
        logger.warn(
          'ReplayPersistence: restore re-append on abort failed:',
          err
        );
      } finally {
        // If destroy() ran during the readAndClear await, it already
        // closed the storage. appendBatch above lazily reopened a
        // new connection — nothing else will close it, so close
        // here. close() is idempotent; if destroy() comes later it's
        // a no-op the second time.
        this.storage.close();
      }
      return;
    }
    try {
      buffer.addBatch(events);
    } catch (err) {
      // CircularBuffer.addBatch shouldn't throw; if it does the
      // records are already gone from IDB (readAndClear was
      // atomic), so there's nothing to clean up — just log.
      logger.warn('ReplayPersistence: addBatch threw:', err);
    }
    // Note: no post-addBatch isAborted re-check. Under slice 2's
    // two-step flow it gated `deleteUpTo`; under readAndClear the
    // delete already happened. The narrow case where addBatch
    // SYNCHRONOUSLY triggers owner teardown is accepted as best-
    // effort loss (re-appending here would risk duplicates if
    // addBatch had actually landed in a live buffer first).
  }

  /**
   * Flush the bound buffer's current events to storage. Called by
   * the pagehide handler and exposed for tests / explicit triggers.
   * Soft-fails on every error path.
   */
  flush(): Promise<void> {
    if (!this.boundBuffer) {
      return Promise.resolve();
    }
    // Chain onto flushPromise so concurrent flushes (visibilitychange
    // followed by pagehide) run sequentially. The second flush re-
    // reads the buffer + watermark, picking up events that landed
    // between the two triggers. Capture generation BEFORE the await
    // so a bfcache reset or destroy mid-flight invalidates this
    // flush's watermark update.
    const generation = this.flushGeneration;
    this.flushPromise = this.flushPromise
      .catch(() => undefined)
      .then(() => this.runFlush(generation));
    return this.flushPromise;
  }

  private async runFlush(generation: number): Promise<void> {
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
    // Dedup: only events strictly newer than the last successful
    // flush. rrweb's timestamps are monotonic in practice but not
    // guaranteed in all orderings, so we use `>` (not `>=`) and
    // recompute the watermark via max() rather than trusting the
    // last array element.
    const cutoff = this.lastFlushedTimestamp;
    const fresh =
      cutoff === 0 ? events : events.filter((e) => e.timestamp > cutoff);
    if (fresh.length === 0) {
      return;
    }
    try {
      await this.storage.appendBatch(REPLAY_STORE, fresh);
      // Only advance the watermark on successful write AND if the
      // generation hasn't changed during the await. A bfcache reset
      // or destroy that fired mid-flush bumped the generation; in
      // that case our high-watermark value is stale state and would
      // silently skip events on the next flush.
      if (generation !== this.flushGeneration) {
        return;
      }
      let maxTs = cutoff;
      for (const e of fresh) {
        if (e.timestamp > maxTs) maxTs = e.timestamp;
      }
      this.lastFlushedTimestamp = maxTs;
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
    if (typeof document !== 'undefined' && document.removeEventListener) {
      try {
        if (this.visibilityChangeHandler) {
          document.removeEventListener(
            'visibilitychange',
            this.visibilityChangeHandler
          );
        }
      } catch (err) {
        logger.warn('ReplayPersistence: visibility unbind failed:', err);
      }
    }
    this.pagehideHandler = null;
    this.pageshowHandler = null;
    this.visibilityChangeHandler = null;
    this.listenerAttached = false;
    this.boundBuffer = null;
    // Reset the idempotency flag so a host that re-uses this
    // persistence instance with a new collector (uncommon but
    // possible if exported) can still restore.
    this.hasRestored = false;
    // Reset the flush watermark too — a re-used instance must not
    // skip writes because of a stale prior session's threshold.
    this.lastFlushedTimestamp = 0;
    // Bump generation + reset the chain so any pending/in-flight
    // flush bails on its watermark update and a re-used instance
    // starts from a clean serial point.
    this.flushGeneration++;
    this.flushPromise = Promise.resolve();
    this.storage.close();
  }
}
