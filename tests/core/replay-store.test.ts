/**
 * Tests for `IndexedDbStorage` — the async storage primitive that
 * backs the upcoming cross-navigation replay/log persistence.
 *
 * Pins the contracts the capture layer will lean on:
 *  - append / appendBatch / readAll / clear round-trip cleanly
 *  - readAll returns FIFO (the order replay events were recorded)
 *  - missing IndexedDB doesn't throw — soft-fails to no-op / empty
 *  - a brand-new DB returns an empty array (no leftover from prior
 *    instances in the same test file)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  IndexedDbStorage,
  REPLAY_STORE,
  LOG_STORE,
} from '../../src/core/storage/replay-store';

// Each test gets its own DB name to avoid leaking state between tests
// when fake-indexeddb persists across the test run.
let dbCounter = 0;
function makeStorage(): IndexedDbStorage {
  return new IndexedDbStorage({ dbName: `bugspotter-test-${++dbCounter}` });
}

describe('IndexedDbStorage', () => {
  let storage: IndexedDbStorage;

  beforeEach(() => {
    storage = makeStorage();
  });

  afterEach(() => {
    storage.close();
  });

  describe('append + readAll', () => {
    it('round-trips a single record', async () => {
      await storage.append(REPLAY_STORE, { ts: 1, type: 'click' });
      const all = await storage.readAll<{ ts: number; type: string }>(
        REPLAY_STORE
      );
      expect(all).toEqual([{ ts: 1, type: 'click' }]);
    });

    it('returns records in FIFO order', async () => {
      await storage.append(REPLAY_STORE, { ts: 1 });
      await storage.append(REPLAY_STORE, { ts: 2 });
      await storage.append(REPLAY_STORE, { ts: 3 });
      const all = await storage.readAll<{ ts: number }>(REPLAY_STORE);
      expect(all.map((r) => r.ts)).toEqual([1, 2, 3]);
    });

    it('isolates writes by store', async () => {
      await storage.append(REPLAY_STORE, { kind: 'replay' });
      await storage.append(LOG_STORE, { kind: 'log' });
      expect(await storage.readAll(REPLAY_STORE)).toEqual([{ kind: 'replay' }]);
      expect(await storage.readAll(LOG_STORE)).toEqual([{ kind: 'log' }]);
    });
  });

  describe('appendBatch', () => {
    it('writes many records in one transaction', async () => {
      const batch = Array.from({ length: 50 }, (_, i) => ({ ts: i }));
      await storage.appendBatch(REPLAY_STORE, batch);
      const all = await storage.readAll<{ ts: number }>(REPLAY_STORE);
      expect(all).toHaveLength(50);
      expect(all[0].ts).toBe(0);
      expect(all[49].ts).toBe(49);
    });

    it('is a no-op for an empty batch', async () => {
      await storage.appendBatch(REPLAY_STORE, []);
      expect(await storage.readAll(REPLAY_STORE)).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes everything in the store', async () => {
      await storage.appendBatch(REPLAY_STORE, [{ a: 1 }, { a: 2 }, { a: 3 }]);
      await storage.clear(REPLAY_STORE);
      expect(await storage.readAll(REPLAY_STORE)).toEqual([]);
    });

    it('does not affect other stores', async () => {
      await storage.append(REPLAY_STORE, { kind: 'replay' });
      await storage.append(LOG_STORE, { kind: 'log' });
      await storage.clear(REPLAY_STORE);
      expect(await storage.readAll(REPLAY_STORE)).toEqual([]);
      expect(await storage.readAll(LOG_STORE)).toEqual([{ kind: 'log' }]);
    });
  });

  describe('persistence across instances (same dbName)', () => {
    it('reads what a prior instance wrote', async () => {
      const dbName = `bugspotter-shared-${++dbCounter}`;
      const writer = new IndexedDbStorage({ dbName });
      await writer.append(REPLAY_STORE, { event: 'one' });
      await writer.append(REPLAY_STORE, { event: 'two' });
      writer.close();

      const reader = new IndexedDbStorage({ dbName });
      const all = await reader.readAll<{ event: string }>(REPLAY_STORE);
      expect(all.map((r) => r.event)).toEqual(['one', 'two']);
      reader.close();
    });

    it('a brand-new dbName starts empty', async () => {
      const fresh = new IndexedDbStorage({
        dbName: `bugspotter-fresh-${++dbCounter}`,
      });
      expect(await fresh.readAll(REPLAY_STORE)).toEqual([]);
      fresh.close();
    });
  });

  describe('soft-fail when IndexedDB is unavailable', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('returns empty array from readAll when IndexedDB is missing', async () => {
      // Simulate SSR / private-browsing env where indexedDB isn't defined.
      Object.defineProperty(globalThis, 'indexedDB', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const offline = new IndexedDbStorage({ dbName: 'never-opens' });
      expect(await offline.readAll(REPLAY_STORE)).toEqual([]);
    });

    it('append is a no-op when IndexedDB is missing (does not throw)', async () => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const offline = new IndexedDbStorage({ dbName: 'never-opens' });
      // The assertion is "does not throw" — soft-fail contract.
      await expect(
        offline.append(REPLAY_STORE, { x: 1 })
      ).resolves.toBeUndefined();
    });
  });

  describe('transient failure recovery', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('retries on the next op after a transient open failure', async () => {
      // Simulate transient unavailability: indexedDB is undefined for
      // the first open attempt. Without nulling dbPromise on failure,
      // the cached resolved-to-null promise would permanently disable
      // storage for the page's lifetime — bad for long-lived SPAs
      // where the blocking condition (e.g. another tab) eventually
      // clears.
      Object.defineProperty(globalThis, 'indexedDB', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const store = new IndexedDbStorage({
        dbName: `bugspotter-recover-${++dbCounter}`,
      });
      // First op fails because indexedDB is missing.
      expect(await store.readAll(REPLAY_STORE)).toEqual([]);

      // Restore indexedDB — simulates the transient condition clearing.
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });

      // Next op must attempt a fresh open and succeed.
      await store.append(REPLAY_STORE, { event: 'after-recovery' });
      const after = await store.readAll<{ event: string }>(REPLAY_STORE);
      expect(after).toEqual([{ event: 'after-recovery' }]);
      store.close();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The next two describes use targeted mocks of the IndexedDB
  // surface rather than fake-indexeddb. The failure modes we're
  // pinning (tx.abort throwing AND no onabort firing, blocked →
  // late onsuccess) aren't deterministic in fake-indexeddb because
  // they depend on real-browser event-loop quirks the simulator
  // intentionally smooths over. Mocking the IDB primitives lets us
  // pin exactly the bad-state sequence we want to prove handled.
  // ───────────────────────────────────────────────────────────────

  describe('Promise settlement when tx.abort itself throws', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('resolves (does not hang) when work throws AND tx.abort throws AND no onabort fires', async () => {
      // The sequence that hangs without the unconditional resolve():
      //   1. work() throws synchronously (e.g. structured-clone error)
      //   2. catch calls tx.abort() — which itself throws
      //   3. No async tx event (onabort / onerror) fires
      // Without `resolve()` in the catch, the Promise never settles
      // and the capture-flow caller hangs forever. This test would
      // time out if the fix regresses.
      const fakeObjectStore = {
        add: () => {
          throw new Error('structured-clone error');
        },
        clear: () => undefined,
      };
      const fakeTx = {
        objectStore: () => fakeObjectStore,
        abort: () => {
          throw new Error('tx already inactive');
        },
        oncomplete: null as ((this: unknown, ev: unknown) => void) | null,
        onerror: null as ((this: unknown, ev: unknown) => void) | null,
        onabort: null as ((this: unknown, ev: unknown) => void) | null,
        error: null,
      };
      const fakeDb = {
        transaction: () => fakeTx,
        close: () => undefined,
        objectStoreNames: { contains: () => true },
      };
      const openCall: { req: { onsuccess?: () => void; result: unknown } } = {
        req: { result: fakeDb },
      };
      const fakeOpen = vi.fn(() => {
        // Fire onsuccess on the next microtask so the caller has
        // a chance to wire up onsuccess.
        queueMicrotask(() => openCall.req.onsuccess?.());
        return openCall.req;
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'hangtest' });
      // If the fix regresses, this hangs forever. The test's
      // timeout (vitest default 5s) is the floor; we assert
      // resolution to make the failure clear.
      await expect(
        storage.append(REPLAY_STORE, { x: 1 })
      ).resolves.toBeUndefined();
      storage.close();
    });
  });

  describe('late-arrival db close after onblocked → onsuccess', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('closes the db when onsuccess fires after onblocked already resolved', async () => {
      // The leak path:
      //   1. onblocked fires → we soft-fail (resolve null) and the
      //      caller walks away
      //   2. The open REQUEST stays queued in the browser
      //   3. The blocking older connection closes — onsuccess fires
      //      with a real IDBDatabase
      //   4. Without the abandoned flag, that db handle leaks open
      //      and holds the older version, blocking future upgrades
      const closeFn = vi.fn();
      const fakeDb = {
        close: closeFn,
        objectStoreNames: { contains: () => true },
      };
      const fakeReq: {
        result: unknown;
        onsuccess?: () => void;
        onerror?: (ev: { preventDefault: () => void }) => void;
        onblocked?: (ev: { preventDefault: () => void }) => void;
        onupgradeneeded?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() =>
          fakeReq.onblocked?.({ preventDefault: () => undefined })
        );
        return fakeReq;
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'leaktest' });
      // First op: onblocked fires → soft-fail to []. abandoned set.
      expect(await storage.readAll(REPLAY_STORE)).toEqual([]);
      expect(closeFn).not.toHaveBeenCalled();

      // Now simulate the late onsuccess that the browser will fire
      // when the blocking connection closes.
      fakeReq.onsuccess?.();

      // The late-arrival db handle must be closed, not leaked.
      expect(closeFn).toHaveBeenCalledTimes(1);
      storage.close();
    });
  });

  describe('store schema drift safety', () => {
    it('soft-fails when reading from a non-existent store', async () => {
      // Schema only declares REPLAY_STORE + LOG_STORE. Asking for
      // an undeclared store would normally throw — must soft-fail
      // since storage drift can happen across SDK versions on the
      // same origin.
      const result = await storage.readAll('nonexistent-store');
      expect(result).toEqual([]);
    });
  });
});
