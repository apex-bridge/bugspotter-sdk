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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
