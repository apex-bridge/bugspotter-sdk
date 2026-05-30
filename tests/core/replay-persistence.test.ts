/**
 * Tests for `ReplayPersistence` — the wiring between the IDB
 * storage primitive and the DOM collector.
 *
 * Contracts under guard:
 *  - restore: reads from storage, seeds the buffer, deletes the
 *    consumed records via deleteUpTo (not clear, so concurrent
 *    appends survive)
 *  - flush: writes the bound buffer's events to storage
 *  - bind: attaches a pagehide listener exactly once; destroy
 *    detaches it
 *  - Soft-fail: storage failures never throw; the capture flow
 *    proceeds unaffected
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventType, type eventWithTime } from '@rrweb/types';
import { ReplayPersistence } from '../../src/core/storage/replay-persistence';
import {
  IndexedDbStorage,
  REPLAY_STORE,
} from '../../src/core/storage/replay-store';
import type { PersistableBuffer } from '../../src/core/storage/replay-persistence';

let dbCounter = 0;
function uniqueDbName(): string {
  return `bugspotter-persistence-test-${++dbCounter}`;
}

// Minimal PersistableBuffer the persistence layer can drive against.
class TestBuffer implements PersistableBuffer {
  events: eventWithTime[] = [];
  getEvents(): eventWithTime[] {
    return [...this.events];
  }
  addBatch(events: eventWithTime[]): void {
    this.events.push(...events);
  }
}

function makeEvent(
  timestamp: number,
  type = EventType.IncrementalSnapshot
): eventWithTime {
  return { type, data: {}, timestamp } as unknown as eventWithTime;
}

describe('ReplayPersistence', () => {
  describe('restore', () => {
    it('seeds the buffer with prior-session events and deletes them from storage', async () => {
      // Set up a storage instance, write some "prior session" events
      // to it, then construct a fresh persistence on the same
      // dbName and restore. The buffer should receive those events,
      // and storage should be empty afterward.
      const dbName = uniqueDbName();
      const seedStorage = new IndexedDbStorage({ dbName });
      await seedStorage.appendBatch(REPLAY_STORE, [
        makeEvent(1000),
        makeEvent(2000),
        makeEvent(3000),
      ]);
      seedStorage.close();

      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      await persistence.restore(buffer);

      expect(buffer.events).toHaveLength(3);
      expect(buffer.events.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);

      // Calling restore again should be idempotent — the records
      // were deleted by the first call.
      const buffer2 = new TestBuffer();
      await persistence.restore(buffer2);
      expect(buffer2.events).toHaveLength(0);

      persistence.destroy();
    });

    it('uses deleteUpTo so a concurrent flush would survive cleanup', async () => {
      // The race-safe contract: deleteUpTo(maxKey) only deletes up
      // to the highest key we READ. If something appended AFTER
      // our readAll (e.g. a pagehide flush firing during init),
      // those records have keys > maxKey and survive.
      const dbName = uniqueDbName();
      const storage = new IndexedDbStorage({ dbName });
      await storage.appendBatch(REPLAY_STORE, [
        makeEvent(1000),
        makeEvent(2000),
      ]);
      storage.close();

      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      await persistence.restore(buffer);
      expect(buffer.events).toHaveLength(2);

      // Now append a "concurrent" record. With the deleteUpTo
      // contract, this survives.
      const probe = new IndexedDbStorage({ dbName });
      await probe.append(REPLAY_STORE, makeEvent(4000));
      const remaining = await probe.readAll<eventWithTime>(REPLAY_STORE);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].value.timestamp).toBe(4000);
      probe.close();

      persistence.destroy();
    });

    it('does nothing when storage is empty', async () => {
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      const buffer = new TestBuffer();
      await persistence.restore(buffer);
      expect(buffer.events).toHaveLength(0);
      persistence.destroy();
    });

    it('soft-fails when storage.readAll throws', async () => {
      // Inject a storage whose readAll throws; restore must not
      // re-throw — the capture flow proceeds unaffected.
      const persistence = new ReplayPersistence({
        dbName: 'never-opens',
        storage: {
          append: async () => undefined,
          appendBatch: async () => undefined,
          readAll: async () => {
            throw new Error('storage down');
          },
          deleteUpTo: async () => undefined,
          clear: async () => undefined,
          close: () => undefined,
        },
      });
      const buffer = new TestBuffer();
      await expect(persistence.restore(buffer)).resolves.toBeUndefined();
      expect(buffer.events).toHaveLength(0);
      persistence.destroy();
    });
  });

  describe('flush', () => {
    let persistence: ReplayPersistence;
    let buffer: TestBuffer;

    beforeEach(() => {
      persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      buffer = new TestBuffer();
    });

    it('writes the bound buffer events to storage', async () => {
      // Use an explicit dbName so we can probe storage independently
      // after flush — the previous version only asserted the dbName
      // field existed, which didn't verify any data actually landed.
      const dbName = uniqueDbName();
      const owned = new ReplayPersistence({ dbName });
      const buf = new TestBuffer();
      buf.events = [makeEvent(100), makeEvent(200)];
      owned.bind(buf);
      await owned.flush();

      // Probe: read back through a fresh storage instance on the
      // same dbName. The flushed events must be present.
      const probe = new IndexedDbStorage({ dbName });
      const remaining = await probe.readAll<eventWithTime>(REPLAY_STORE);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((r) => r.value.timestamp)).toEqual([100, 200]);
      probe.close();
      owned.destroy();
    });

    it('is a no-op when no buffer is bound', async () => {
      await expect(persistence.flush()).resolves.toBeUndefined();
      persistence.destroy();
    });

    it('is a no-op when buffer is empty', async () => {
      persistence.bind(buffer);
      await expect(persistence.flush()).resolves.toBeUndefined();
      persistence.destroy();
    });

    it('soft-fails when storage.appendBatch throws', async () => {
      const failing = new ReplayPersistence({
        dbName: 'no-op',
        storage: {
          append: async () => undefined,
          appendBatch: async () => {
            throw new Error('disk full');
          },
          readAll: async () => [],
          deleteUpTo: async () => undefined,
          clear: async () => undefined,
          close: () => undefined,
        },
      });
      const b = new TestBuffer();
      b.events = [makeEvent(1)];
      failing.bind(b);
      await expect(failing.flush()).resolves.toBeUndefined();
      failing.destroy();
    });
  });

  describe('pagehide listener', () => {
    it('binds exactly once even across multiple bind() calls', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      addSpy.mockClear();
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      const buffer1 = new TestBuffer();
      const buffer2 = new TestBuffer();
      persistence.bind(buffer1);
      persistence.bind(buffer2);
      persistence.bind(buffer1);

      const pagehideAdds = addSpy.mock.calls.filter((c) => c[0] === 'pagehide');
      expect(pagehideAdds.length).toBe(1);
      persistence.destroy();
      addSpy.mockRestore();
    });

    it('destroy removes the pagehide listener', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      addSpy.mockClear();
      removeSpy.mockClear();
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      persistence.bind(new TestBuffer());
      persistence.destroy();
      const pagehideRemoves = removeSpy.mock.calls.filter(
        (c) => c[0] === 'pagehide'
      );
      expect(pagehideRemoves.length).toBe(1);
      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('fires flush when pagehide event is dispatched', async () => {
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(50), makeEvent(60)];
      persistence.bind(buffer);

      // Dispatch a synthetic pagehide.
      window.dispatchEvent(new Event('pagehide'));

      // The handler does void this.flush() (fire-and-forget). Give
      // it a microtask to settle.
      await new Promise((r) => setTimeout(r, 50));

      // Confirm storage now holds the events.
      const probe = new IndexedDbStorage({ dbName });
      const all = await probe.readAll<eventWithTime>(REPLAY_STORE);
      expect(all.map((r) => r.value.timestamp)).toEqual([50, 60]);
      probe.close();

      persistence.destroy();
    });
  });
});
