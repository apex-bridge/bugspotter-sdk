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
    it('round-trips a single record with its key', async () => {
      await storage.append(REPLAY_STORE, { ts: 1, type: 'click' });
      const all = await storage.readAll<{ ts: number; type: string }>(
        REPLAY_STORE
      );
      expect(all).toHaveLength(1);
      expect(all[0].value).toEqual({ ts: 1, type: 'click' });
      expect(typeof all[0].key).toBe('number');
    });

    it('returns records in FIFO order', async () => {
      await storage.append(REPLAY_STORE, { ts: 1 });
      await storage.append(REPLAY_STORE, { ts: 2 });
      await storage.append(REPLAY_STORE, { ts: 3 });
      const all = await storage.readAll<{ ts: number }>(REPLAY_STORE);
      expect(all.map((r) => r.value.ts)).toEqual([1, 2, 3]);
      // Keys should also be monotonically increasing.
      expect(all[0].key).toBeLessThan(all[1].key);
      expect(all[1].key).toBeLessThan(all[2].key);
    });

    it('isolates writes by store', async () => {
      await storage.append(REPLAY_STORE, { kind: 'replay' });
      await storage.append(LOG_STORE, { kind: 'log' });
      const replays = await storage.readAll(REPLAY_STORE);
      const logs = await storage.readAll(LOG_STORE);
      expect(replays.map((r) => r.value)).toEqual([{ kind: 'replay' }]);
      expect(logs.map((r) => r.value)).toEqual([{ kind: 'log' }]);
    });
  });

  describe('appendBatch', () => {
    it('writes many records in one transaction', async () => {
      const batch = Array.from({ length: 50 }, (_, i) => ({ ts: i }));
      await storage.appendBatch(REPLAY_STORE, batch);
      const all = await storage.readAll<{ ts: number }>(REPLAY_STORE);
      expect(all).toHaveLength(50);
      expect(all[0].value.ts).toBe(0);
      expect(all[49].value.ts).toBe(49);
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
      const logs = await storage.readAll(LOG_STORE);
      expect(logs.map((r) => r.value)).toEqual([{ kind: 'log' }]);
    });
  });

  describe('readAll limit', () => {
    it('caps the result at `limit` and returns the OLDEST records (FIFO)', async () => {
      // Defense against unbounded memory use when storage has
      // accumulated across many sessions. FIFO order means a
      // limited read drains the oldest first — fits the gc-and-
      // delete-up-to pattern slice 2 will use.
      await storage.appendBatch(REPLAY_STORE, [
        { i: 1 },
        { i: 2 },
        { i: 3 },
        { i: 4 },
        { i: 5 },
      ]);
      const limited = await storage.readAll<{ i: number }>(REPLAY_STORE, 2);
      expect(limited).toHaveLength(2);
      // Oldest two, not newest.
      expect(limited.map((r) => r.value.i)).toEqual([1, 2]);
    });

    it('returns all records when limit exceeds count', async () => {
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }]);
      const all = await storage.readAll<{ i: number }>(REPLAY_STORE, 100);
      expect(all).toHaveLength(2);
    });

    it('treats undefined limit as unlimited', async () => {
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }, { i: 3 }]);
      const all = await storage.readAll<{ i: number }>(REPLAY_STORE);
      expect(all).toHaveLength(3);
    });

    it('returns [] for limit=0 (no off-by-one record leak)', async () => {
      // Realistic call site: a caller computing
      // `Math.max(0, capacity - loaded)` hitting the boundary.
      // Without the entry-point short-circuit, the cursor's first
      // onsuccess would push one record BEFORE the in-loop check
      // could veto it.
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }, { i: 3 }]);
      const result = await storage.readAll<{ i: number }>(REPLAY_STORE, 0);
      expect(result).toEqual([]);
    });

    it('returns [] for negative limit', async () => {
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }]);
      const result = await storage.readAll<{ i: number }>(REPLAY_STORE, -5);
      expect(result).toEqual([]);
    });
  });

  describe('deleteUpTo', () => {
    it('deletes records with key ≤ maxKey and preserves later ones', async () => {
      // Real race-safety win — pin the contract: records appended
      // AFTER the readAll that produced maxKey survive.
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }, { i: 3 }]);
      const before = await storage.readAll<{ i: number }>(REPLAY_STORE);
      expect(before.map((r) => r.value.i)).toEqual([1, 2, 3]);

      // Simulate a concurrent append: new event arrives between
      // readAll and the cleanup.
      await storage.append(REPLAY_STORE, { i: 4 });

      // Delete up to what we read (NOT the new record's key).
      const maxKey = before[before.length - 1].key;
      await storage.deleteUpTo(REPLAY_STORE, maxKey);

      const after = await storage.readAll<{ i: number }>(REPLAY_STORE);
      // The concurrent append survives — that's the whole point.
      expect(after.map((r) => r.value.i)).toEqual([4]);
    });

    it('is a no-op when no records match the range', async () => {
      await storage.append(REPLAY_STORE, { x: 1 });
      const before = await storage.readAll(REPLAY_STORE);
      await storage.deleteUpTo(REPLAY_STORE, 0); // maxKey below any real key
      const after = await storage.readAll(REPLAY_STORE);
      expect(after).toHaveLength(before.length);
    });
  });

  describe('readAndClear', () => {
    it('reads records AND empties the store in a single readwrite tx', async () => {
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }, { i: 3 }]);
      const results = await storage.readAndClear<{ i: number }>(REPLAY_STORE);
      expect(results.map((r) => r.value.i)).toEqual([1, 2, 3]);
      // Store is empty afterward — the whole point.
      const after = await storage.readAll(REPLAY_STORE);
      expect(after).toHaveLength(0);
    });

    it('with limit hit, returns first N records AND clears EVERYTHING (incl. past-the-limit)', async () => {
      // The cap-hit semantic: dangling records past the limit
      // would corrupt future sessions, so they MUST go.
      await storage.appendBatch(
        REPLAY_STORE,
        Array.from({ length: 10 }, (_, i) => ({ i }))
      );
      const results = await storage.readAndClear<{ i: number }>(
        REPLAY_STORE,
        3
      );
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.value.i)).toEqual([0, 1, 2]);
      // Records past the limit are also cleared.
      const after = await storage.readAll(REPLAY_STORE);
      expect(after).toHaveLength(0);
    });

    it('returns [] when store is already empty (still a no-op clear)', async () => {
      const results = await storage.readAndClear(REPLAY_STORE);
      expect(results).toEqual([]);
      const after = await storage.readAll(REPLAY_STORE);
      expect(after).toHaveLength(0);
    });

    it('limit=0 short-circuits but still clears the store', async () => {
      // Edge case symmetric with readAll. The atomic-ness doesn't
      // apply at zero limit (nothing to coordinate), but the
      // contract still asks us to clear.
      await storage.appendBatch(REPLAY_STORE, [{ i: 1 }, { i: 2 }]);
      const results = await storage.readAndClear(REPLAY_STORE, 0);
      expect(results).toEqual([]);
      const after = await storage.readAll(REPLAY_STORE);
      // Store IS cleared even though we read nothing.
      expect(after).toHaveLength(0);
    });

    it('atomic ordering: concurrent appendBatch is either fully before or fully after — no data loss', async () => {
      // The slice 2 race that motivated this primitive. fake-
      // indexeddb is spec-compliant on transaction serialization:
      // both ops open readwrite txs on the same store, so they
      // queue.
      await storage.appendBatch(
        REPLAY_STORE,
        Array.from({ length: 5 }, (_, i) => ({ phase: 'before', i }))
      );

      // Fire both at the same microtask tick. The one whose tx is
      // requested first wins the queue.
      const readPromise = storage.readAndClear<{ phase: string; i: number }>(
        REPLAY_STORE
      );
      const writePromise = storage.appendBatch(REPLAY_STORE, [
        { phase: 'concurrent', i: 100 },
        { phase: 'concurrent', i: 101 },
      ]);
      const [results] = await Promise.all([readPromise, writePromise]);

      // Final state probe.
      const after = await storage.readAll<{ phase: string; i: number }>(
        REPLAY_STORE
      );

      // The atomic invariant: NO records lost. The 5 pre-existing
      // 'before' records are either in `results` (read first) or
      // in `after` (the read ran first, then the append landed in
      // the cleared store). Same for the 2 'concurrent' records.
      const allTouched = [
        ...results.map((r) => r.value),
        ...after.map((r) => r.value),
      ];
      // 5 'before' records accounted for.
      expect(allTouched.filter((v) => v.phase === 'before')).toHaveLength(5);
      // 2 'concurrent' records accounted for.
      expect(allTouched.filter((v) => v.phase === 'concurrent')).toHaveLength(
        2
      );
    });

    it('soft-fails to [] on a non-existent store name', async () => {
      const results = await storage.readAndClear('nonexistent-store' as never);
      expect(results).toEqual([]);
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
      expect(all.map((r) => r.value.event)).toEqual(['one', 'two']);
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
      expect(after.map((r) => r.value)).toEqual([{ event: 'after-recovery' }]);
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

  describe('onupgradeneeded throw containment', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('contains createObjectStore throws inside the handler (no leak)', async () => {
      // Realistic case: storage exhaustion → createObjectStore throws
      // synchronously during the upgrade. Without try/catch the
      // throw leaves the handler uncaught; spec auto-aborts the
      // tx and fires onerror with preventDefault, but window.onerror
      // typically fires BEFORE the request's error event and isn't
      // suppressed by it — host monitoring would pick it up.
      const abortFn = vi.fn();
      const fakeDb = {
        objectStoreNames: { contains: () => false },
        createObjectStore: () => {
          throw new Error('storage exhausted');
        },
        close: () => undefined,
      };
      const fakeReq: {
        result: unknown;
        transaction?: { abort: () => void };
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: (ev: { preventDefault: () => void }) => void;
        onblocked?: (ev: { preventDefault: () => void }) => void;
      } = {
        result: fakeDb,
        transaction: { abort: abortFn },
      };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => {
          // Spec ordering: onupgradeneeded fires first.
          fakeReq.onupgradeneeded?.();
          // The aborted upgrade tx surfaces as onerror on the request.
          fakeReq.onerror?.({ preventDefault: () => undefined });
        });
        return fakeReq;
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'upgrade-throw' });
      // If the throw escaped the handler, this op would reject /
      // hang. It must resolve cleanly (soft-fail).
      await expect(storage.readAll(REPLAY_STORE)).resolves.toEqual([]);
      // The handler must have explicitly aborted the upgrade tx.
      expect(abortFn).toHaveBeenCalledTimes(1);
      storage.close();
    });
  });

  describe('tx failure log dedup', () => {
    it('does not log both onerror and onabort for a single tx failure', async () => {
      // For a tx failing due to a request error, the spec fires
      // both onerror and onabort sequentially. Without the
      // settled flag, host monitoring sees two warnings for one
      // underlying failure.
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const storage = makeStorage();
        await storage.append(REPLAY_STORE, { x: 1 });

        // Trigger a work-throw path: a function isn't structured-
        // cloneable. The work callback's add() throws, the catch
        // calls tx.abort() which fires onabort (and onerror).
        warnSpy.mockClear();

        await storage.appendBatch(REPLAY_STORE, [(() => {}) as any]);

        // Count the two tx-handler logs specifically. If dedup
        // works, at most one fires for this single failure.
        const txWarns = warnSpy.mock.calls.filter((call) => {
          const first = call[0];
          return (
            typeof first === 'string' &&
            first.includes('tx(') &&
            (first.includes('error:') || first.includes('aborted:'))
          );
        });
        expect(txWarns.length).toBeLessThanOrEqual(1);
        storage.close();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('openCursor throw containment', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('resolves [] when tx.objectStore(store).openCursor() throws synchronously', async () => {
      // openCursor can throw TransactionInactiveError, DataError,
      // InvalidStateError synchronously. Without the inner try/
      // catch, the throw rejects readAll's Promise — soft-fail
      // contract violation. This test pins it.
      const fakeStore = {
        openCursor: () => {
          throw new DOMException('tx finished', 'InvalidStateError');
        },
      };
      const fakeTx = {
        objectStore: () => fakeStore,
        oncomplete: undefined,
        onerror: undefined,
        onabort: undefined,
        error: null,
        abort: () => undefined,
      };
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        transaction: () => fakeTx,
      };
      const successReq: { result: typeof fakeDb; onsuccess?: () => void } = {
        result: fakeDb,
      };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'opencursor-throw' });
      // Without the try/catch around openCursor, the sync throw
      // would reject this — soft-fail contract demands resolve [].
      await expect(storage.readAll(REPLAY_STORE)).resolves.toEqual([]);
      storage.close();
    });
  });

  describe('cursor read throw containment', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('resolves [] (does not hang) when cursor.value throws', async () => {
      // cursor.value is a getter that does structured-clone
      // deserialization — corrupted stored data can throw
      // DataCloneError. Without try/catch in onsuccess, the throw
      // crashes the handler and the Promise hangs forever.
      // Targeted mock: cursor whose .value getter throws.
      const cursor = {
        key: 1,
        get value(): unknown {
          throw new DOMException('Could not deserialize', 'DataCloneError');
        },
        continue: () => undefined,
      };
      let req: {
        result: typeof cursor | null;
        onsuccess?: () => void;
        onerror?: (ev: { preventDefault: () => void }) => void;
      };
      const fakeStore = {
        openCursor: () => {
          req = { result: cursor };
          queueMicrotask(() => req.onsuccess?.());
          return req as unknown as IDBRequest;
        },
      };
      const fakeTx = {
        objectStore: () => fakeStore,
        oncomplete: undefined,
        onerror: undefined,
        onabort: undefined,
        error: null,
        abort: () => undefined,
      };
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        transaction: () => fakeTx,
      };
      const successReq: { result: typeof fakeDb; onsuccess?: () => void } = {
        result: fakeDb,
      };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'cursor-throw' });
      // Without the try/catch, this would hang at the 5s timeout.
      await expect(storage.readAll(REPLAY_STORE)).resolves.toEqual([]);
      storage.close();
    });
  });

  describe('self-heal on InvalidStateError', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('clears cache when db.transaction throws InvalidStateError', async () => {
      // Browser onclose support is variable; in the gap where
      // onclose doesn't fire but the db is silently evicted,
      // db.transaction throws InvalidStateError. Without
      // clearing the cache, every subsequent op hits the same
      // dead handle. Self-heal: clear cache on this specific
      // error, next op opens fresh.
      let openCallNum = 0;
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        onversionchange: undefined,
        onclose: undefined,
        transaction: () => {
          // Throw the way a closed connection would.
          throw new DOMException('Connection is closing', 'InvalidStateError');
        },
      };
      const successReq: {
        result: typeof fakeDb;
        onsuccess?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        openCallNum++;
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'self-heal' });
      // First op: triggers open, then throws on transaction.
      // Cache should be cleared by the catch.
      await storage.readAll(REPLAY_STORE);
      expect(openCallNum).toBe(1);

      // Second op: cache was cleared → fresh open attempt.
      await storage.readAll(REPLAY_STORE);
      expect(openCallNum).toBeGreaterThan(1);
      storage.close();
    });

    it('does not clear cache for unrelated errors (e.g. NotFoundError)', async () => {
      // The cache should only be cleared on InvalidStateError. A
      // NotFoundError (e.g. asking for a non-existent store) is
      // a schema/usage issue, not a dead connection — the cache
      // is still valid, subsequent ops on other stores should
      // hit the cached db, not open a new one.
      let openCallNum = 0;
      let txCallNum = 0;
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        onversionchange: undefined,
        onclose: undefined,
        transaction: () => {
          txCallNum++;
          throw new DOMException('Store not found', 'NotFoundError');
        },
      };
      const successReq: {
        result: typeof fakeDb;
        onsuccess?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        openCallNum++;
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'no-heal' });
      await storage.readAll(REPLAY_STORE);
      await storage.readAll(REPLAY_STORE);
      // Two readAlls but only ONE open — cache stayed valid
      // even though tx threw. Both readAlls saw the NotFoundError.
      expect(openCallNum).toBe(1);
      expect(txCallNum).toBe(2);
      storage.close();
    });
  });

  describe('onclose handler', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('clears cached refs when the browser fires onclose unexpectedly', async () => {
      // Browsers fire IDBDatabase.onclose when the connection drops
      // outside our control (storage pressure, user clearing site
      // data, disk eviction). Without clearing this.db /
      // this.dbPromise, the openDb cache returns a dead handle on
      // every subsequent op. Next op should attempt a fresh open.
      const fakeDb: {
        objectStoreNames: { contains: () => boolean };
        close: () => void;
        onversionchange?: () => void;
        onclose?: () => void;
      } = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
      };
      const successReq: {
        result: typeof fakeDb;
        onsuccess?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'onclose-test' });
      // Drive one op to populate the cache. (readAll will fail
      // against the bare fakeDb, but we only care about the cache.)
      await storage.readAll(REPLAY_STORE).catch(() => undefined);
      expect(fakeDb.onclose).toBeDefined();
      const opCountBefore = fakeOpen.mock.calls.length;

      // Simulate the browser firing onclose. Cache must be cleared.
      fakeDb.onclose?.();

      // Subsequent op should trigger a fresh open instead of
      // returning the dead-handle cached promise.
      await storage.readAll(REPLAY_STORE).catch(() => undefined);
      expect(fakeOpen.mock.calls.length).toBeGreaterThan(opCountBefore);
      storage.close();
    });
  });

  describe('versionchange handler', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('closes the connection when another tab triggers versionchange', async () => {
      // Multi-tab upgrade: Tab B opens at DB_VERSION+1 → the
      // browser fires versionchange on Tab A's connection. Without
      // a handler, Tab A's connection stays open and Tab B's
      // upgrade is blocked forever. With the handler we install in
      // onsuccess, Tab A voluntarily closes and Tab B can proceed.
      const closeFn = vi.fn();
      const fakeDb: {
        objectStoreNames: { contains: () => boolean };
        close: () => void;
        onversionchange?: () => void;
      } = {
        objectStoreNames: { contains: () => true },
        close: closeFn,
      };
      const successReq: {
        result: typeof fakeDb;
        onsuccess?: () => void;
        onerror?: (ev: { preventDefault: () => void }) => void;
        onblocked?: (ev: { preventDefault: () => void }) => void;
        onupgradeneeded?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => successReq.onsuccess?.());
        return successReq;
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'versionchange' });
      // Drive an open so onsuccess installs the versionchange handler.
      // readAll's tx will fail against our fakeDb, but we only care
      // about the open path here.
      await storage.readAll(REPLAY_STORE).catch(() => undefined);

      // Now fire versionchange the way the browser would when
      // another tab upgrades the DB. The handler should close
      // this connection.
      expect(fakeDb.onversionchange).toBeDefined();
      fakeDb.onversionchange?.();
      expect(closeFn).toHaveBeenCalledTimes(1);
      storage.close();
    });
  });

  describe('work-throws path log dedup', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('does not log "tx aborted" after a sync work throw + tx.abort()', async () => {
      // When work() throws synchronously, our catch logs "work
      // threw" and calls tx.abort(). The abort fires tx.onabort
      // asynchronously — without settle() in the catch (just
      // resolve()), the onabort handler doesn't see the settled
      // flag and logs a duplicate "tx aborted" warning. settle()
      // sets the flag immediately, suppressing the redundant log.
      //
      // The existing `appendBatch` dedup test exercises the tx
      // .onerror path (structured-clone failure surfaces as a
      // request error). This one exercises the sync-throw path
      // via a targeted mock whose objectStore.add throws.
      const fakeObjectStore = {
        add: () => {
          throw new Error('sync work throw');
        },
        clear: () => undefined,
      };
      let onabortHandler: (() => void) | null = null;
      const fakeTx = {
        objectStore: () => fakeObjectStore,
        abort: () => {
          // The browser fires onabort asynchronously after abort();
          // simulate by queuing a microtask.
          queueMicrotask(() => onabortHandler?.());
        },
        get oncomplete(): null {
          return null;
        },
        set oncomplete(_) {
          // ignored
        },
        get onerror(): null {
          return null;
        },
        set onerror(_) {
          // ignored
        },
        set onabort(handler: () => void) {
          onabortHandler = handler;
        },
        error: null,
      };
      const fakeDb = {
        transaction: () => fakeTx,
        close: () => undefined,
        objectStoreNames: { contains: () => true },
      };
      const fakeReq: { result: unknown; onsuccess?: () => void } = {
        result: fakeDb,
      };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => fakeReq.onsuccess?.());
        return fakeReq;
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const storage = new IndexedDbStorage({ dbName: 'sync-throw-dedup' });
        await storage.append(REPLAY_STORE, { x: 1 });

        // The work-throws catch should log "work threw" exactly
        // once, NOT also "tx aborted" from the subsequent
        // onabort handler.
        const workThrewWarns = warnSpy.mock.calls.filter((call) => {
          const first = call[0];
          return typeof first === 'string' && first.includes('work threw');
        });
        const abortedWarns = warnSpy.mock.calls.filter((call) => {
          const first = call[0];
          return typeof first === 'string' && first.includes('aborted:');
        });
        expect(workThrewWarns.length).toBe(1);
        expect(abortedWarns.length).toBe(0);
        storage.close();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('close() synchronous semantics', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('closes the db synchronously when already opened (no microtask delay)', async () => {
      // Previously close() always went through `dbPromise.then(db
      // => db.close())`, introducing a microtask gap during which
      // user code could try another op against a still-open
      // connection. With this.db cached synchronously, close()
      // can close immediately when the db is already resolved.
      const closeFn = vi.fn();
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: closeFn,
      };
      const fakeReq: {
        result: typeof fakeDb;
        onsuccess?: () => void;
      } = { result: fakeDb };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => fakeReq.onsuccess?.());
        return fakeReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'sync-close' });
      // Force the open to complete and the db to be cached.
      await storage.readAll(REPLAY_STORE).catch(() => undefined);
      expect(closeFn).not.toHaveBeenCalled();

      // close() must fire db.close() immediately, BEFORE any
      // awaited microtask runs.
      storage.close();
      expect(closeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('readAll hang containment', () => {
    const originalIndexedDB = globalThis.indexedDB;

    afterEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      });
    });

    it('resolves [] when the tx aborts without the request firing onerror', async () => {
      // Defense-in-depth: per spec, an aborting tx should always
      // error its pending requests. But weird browser termination
      // (db handle revoked mid-tx, etc.) could leave the request
      // hanging. Without tx-level handlers, readAll would never
      // resolve.
      const fakeStore = {
        openCursor: () => ({}) as unknown as IDBRequest,
      };
      const txHandlers: { onabort: (() => void) | null } = { onabort: null };
      const fakeTx = {
        objectStore: () => fakeStore,
        set oncomplete(_: () => void) {
          // ignored
        },
        set onerror(_: (ev: { preventDefault: () => void }) => void) {
          // ignored
        },
        set onabort(handler: () => void) {
          txHandlers.onabort = handler;
        },
        error: null,
        abort: () => undefined,
      };
      // The req we return from openCursor has no onsuccess/onerror set
      // by the test mock — so the only way the readAll Promise can
      // resolve is via the tx-level handler we added.
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        transaction: () => fakeTx,
      };
      const fakeReq: { result: typeof fakeDb; onsuccess?: () => void } = {
        result: fakeDb,
      };
      const fakeOpen = vi.fn(() => {
        queueMicrotask(() => fakeReq.onsuccess?.());
        return fakeReq;
      });
      Object.defineProperty(globalThis, 'indexedDB', {
        value: { open: fakeOpen },
        configurable: true,
        writable: true,
      });

      const storage = new IndexedDbStorage({ dbName: 'tx-hang' });
      const readPromise = storage.readAll(REPLAY_STORE);
      // Wait for the tx to be created — readAll yields at openDb.
      await new Promise((r) => setTimeout(r, 0));
      // Fire the tx-level abort. With the fix, readAll resolves
      // to []. Without it, readAll hangs.
      txHandlers.onabort?.();
      await expect(readPromise).resolves.toEqual([]);
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
