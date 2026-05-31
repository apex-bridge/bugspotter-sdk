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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventType, type eventWithTime } from '@rrweb/types';
import { ReplayPersistence } from '../../src/core/storage/replay-persistence';
import {
  IndexedDbStorage,
  REPLAY_STORE,
} from '../../src/core/storage/replay-store';
import type { AsyncStorage } from '../../src/core/storage/replay-store';
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

    it('destroy() resets hasRestored so a re-bound instance can restore again', async () => {
      // Internal-state contract: a host that reuses a single
      // ReplayPersistence across collector lifecycles (uncommon
      // but possible if the class is exported) shouldn't have its
      // second restore short-circuit silently.
      const dbName = uniqueDbName();
      const seed = new IndexedDbStorage({ dbName });
      await seed.appendBatch(REPLAY_STORE, [makeEvent(1), makeEvent(2)]);
      seed.close();

      const persistence = new ReplayPersistence({ dbName });
      const buf1 = new TestBuffer();
      await persistence.restore(buf1);
      expect(buf1.events).toHaveLength(2);

      // Destroy + re-seed (simulating a fresh prior session).
      persistence.destroy();
      const reseed = new IndexedDbStorage({ dbName });
      await reseed.appendBatch(REPLAY_STORE, [makeEvent(3), makeEvent(4)]);
      reseed.close();

      // Same instance, post-destroy: restore should run again.
      const buf2 = new TestBuffer();
      await persistence.restore(buf2);
      expect(buf2.events).toHaveLength(2);
      expect(buf2.events.map((e) => e.timestamp)).toEqual([3, 4]);
      persistence.destroy();
    });

    it('is idempotent within an instance: second restore is a no-op even when storage has new records', async () => {
      // Rapid restart guard: even if a second startRecording fires
      // a second restore on the SAME persistence instance, the
      // hasRestored flag short-circuits it. This prevents two
      // concurrent restores from each reading the same records
      // (race against deleteUpTo) and doubling them in the buffer.
      const dbName = uniqueDbName();
      const seed = new IndexedDbStorage({ dbName });
      await seed.appendBatch(REPLAY_STORE, [makeEvent(1), makeEvent(2)]);
      seed.close();

      const persistence = new ReplayPersistence({ dbName });
      const buf1 = new TestBuffer();
      await persistence.restore(buf1);
      expect(buf1.events).toHaveLength(2);

      // Re-seed storage as if a flush landed in between.
      const reseed = new IndexedDbStorage({ dbName });
      await reseed.appendBatch(REPLAY_STORE, [makeEvent(10), makeEvent(20)]);
      reseed.close();

      const buf2 = new TestBuffer();
      await persistence.restore(buf2);
      // hasRestored=true short-circuits; second restore is a no-op
      // regardless of what's in storage.
      expect(buf2.events).toHaveLength(0);
      persistence.destroy();
    });

    it('uses readAndClear (single atomic IDB tx) for the cap-hit case', async () => {
      // Slice 3 change: cap-hit used to do readAll + clear as two
      // ops, with a race window between them. Now a single atomic
      // readAndClear handles both. Stub readAndClear to verify it's
      // the one called (not the obsolete readAll → clear two-step).
      let readAndClearCalls = 0;
      let readAndClearLimit: number | undefined;
      let readAllCalls = 0;
      let clearCalls = 0;
      let deleteUpToCalls = 0;
      const capStorage = {
        append: async () => undefined,
        appendBatch: async () => undefined,
        readAll: async () => {
          readAllCalls++;
          return [];
        },
        deleteUpTo: async () => {
          deleteUpToCalls++;
        },
        clear: async () => {
          clearCalls++;
        },
        readAndClear: async (_store: string, limit?: number) => {
          readAndClearCalls++;
          readAndClearLimit = limit;
          const n = limit ?? 5000;
          return Array.from({ length: n }, (_, i) => ({
            key: i + 1,
            value: makeEvent(i),
          }));
        },
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName: 'cap-test',
        storage: capStorage as unknown as AsyncStorage,
      });
      await persistence.restore(new TestBuffer());
      expect(readAndClearCalls).toBe(1);
      expect(readAndClearLimit).toBe(5000);
      // No separate readAll / clear / deleteUpTo — atomicity is the
      // whole point.
      expect(readAllCalls).toBe(0);
      expect(clearCalls).toBe(0);
      expect(deleteUpToCalls).toBe(0);
    });

    it('re-appends records to storage when buffer.isAborted() after readAndClear', async () => {
      // Slice 3 replacement of the slice 2 round 4 phantom-delete
      // fix. readAndClear is atomic, so the records have ALREADY
      // been removed from IDB by the time we check isAborted. To
      // preserve the "destroy-during-restore preserves records"
      // contract, we re-append them so the next live restore picks
      // them up.
      const appendBatchCalls: eventWithTime[][] = [];
      let closeCalls = 0;
      const restoredRecords = [
        { key: 1, value: makeEvent(10) },
        { key: 2, value: makeEvent(20) },
      ];
      const storage = {
        append: async () => undefined,
        appendBatch: async (_store: string, events: eventWithTime[]) => {
          appendBatchCalls.push(events);
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => undefined,
        readAndClear: async () => restoredRecords,
        close: () => {
          closeCalls++;
        },
      };
      const persistence = new ReplayPersistence({
        dbName: 'phantom-delete-test',
        storage: storage as unknown as AsyncStorage,
      });
      let addBatchCalled = false;
      const abortedBuffer: PersistableBuffer = {
        getEvents: () => [],
        addBatch: () => {
          addBatchCalled = true;
        },
        isAborted: () => true, // cancellation observed AFTER readAndClear
      };
      await persistence.restore(abortedBuffer);
      // buffer.addBatch is NOT called — owner is gone.
      expect(addBatchCalled).toBe(false);
      // Records were re-appended to IDB for the next live restore.
      expect(appendBatchCalls).toHaveLength(1);
      expect(appendBatchCalls[0].map((e) => e.timestamp)).toEqual([10, 20]);
      // Storage was closed after the re-append. Without this, a
      // destroy() that ran during the readAndClear await would have
      // closed the original connection, and our re-append would have
      // lazily opened a new one — leaked because nothing else closes
      // it.
      expect(closeCalls).toBe(1);
    });

    it('does NOT re-append when isAborted flips true AFTER addBatch (sync teardown is accepted loss)', async () => {
      // Slice 3 trade-off note: we can't distinguish "addBatch
      // landed and THEN owner died" from "addBatch was dead on
      // arrival." Re-appending in the post-addBatch case would
      // risk duplicates. Accept the loss in this narrow window.
      const appendBatchCalls: eventWithTime[][] = [];
      const storage = {
        append: async () => undefined,
        appendBatch: async (_store: string, events: eventWithTime[]) => {
          appendBatchCalls.push(events);
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => undefined,
        readAndClear: async () => [{ key: 1, value: makeEvent(10) }],
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName: 'post-addbatch-abort-test',
        storage: storage as unknown as AsyncStorage,
      });
      let aborted = false;
      const buffer: PersistableBuffer = {
        getEvents: () => [],
        addBatch: () => {
          aborted = true; // sync teardown happens here
        },
        isAborted: () => aborted,
      };
      await persistence.restore(buffer);
      // No re-append attempt — we can't tell if addBatch already
      // landed the events in a live buffer.
      expect(appendBatchCalls).toHaveLength(0);
    });

    it('also uses readAndClear for the under-cap case (single atomic primitive for both)', async () => {
      // Slice 3 collapsed the two paths. Under-cap concurrent
      // appendBatch is still preserved — via IDB tx serialization
      // (queued either entirely before or entirely after this
      // readAndClear), not via the old deleteUpTo(maxKey) keyed-
      // range delete. Net: a single primitive, simpler restore,
      // same data-preservation guarantee.
      let readAndClearCalls = 0;
      let readAllCalls = 0;
      let clearCalls = 0;
      let deleteUpToCalls = 0;
      const underCapStorage = {
        append: async () => undefined,
        appendBatch: async () => undefined,
        readAll: async () => {
          readAllCalls++;
          return [];
        },
        deleteUpTo: async () => {
          deleteUpToCalls++;
        },
        clear: async () => {
          clearCalls++;
        },
        readAndClear: async () => {
          readAndClearCalls++;
          return [
            { key: 1, value: makeEvent(10) },
            { key: 2, value: makeEvent(20) },
          ];
        },
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName: 'under-cap-test',
        storage: underCapStorage as unknown as AsyncStorage,
      });
      await persistence.restore(new TestBuffer());
      expect(readAndClearCalls).toBe(1);
      expect(readAllCalls).toBe(0);
      expect(deleteUpToCalls).toBe(0);
      expect(clearCalls).toBe(0);
    });

    it('soft-fails when storage.readAndClear throws', async () => {
      // Inject a storage whose readAndClear throws; restore must
      // not re-throw — the capture flow proceeds unaffected.
      const persistence = new ReplayPersistence({
        dbName: 'never-opens',
        storage: {
          append: async () => undefined,
          appendBatch: async () => undefined,
          readAll: async () => [],
          deleteUpTo: async () => undefined,
          clear: async () => undefined,
          readAndClear: async () => {
            throw new Error('storage down');
          },
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
          readAndClear: async () => [],
          close: () => undefined,
        },
      });
      const b = new TestBuffer();
      b.events = [makeEvent(1)];
      failing.bind(b);
      await expect(failing.flush()).resolves.toBeUndefined();
      failing.destroy();
    });

    it('dedups: second flush writes only events newer than the first', async () => {
      // The core of the slice 3 contract — without this, a
      // visibilitychange + pagehide pair on desktop nav would double-
      // write the buffer.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buf = new TestBuffer();
      buf.events = [makeEvent(100), makeEvent(200)];
      persistence.bind(buf);
      await persistence.flush();

      // Same buffer state on second flush → nothing new to write.
      await persistence.flush();

      let probe = new IndexedDbStorage({ dbName });
      let records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(2);

      // Now append newer events and flush again. Only the new ones
      // should hit storage; the original two stay at their original
      // positions.
      buf.events.push(makeEvent(300), makeEvent(400));
      await persistence.flush();

      probe = new IndexedDbStorage({ dbName });
      records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(4);
      expect(records.map((r) => r.value.timestamp)).toEqual([
        100, 200, 300, 400,
      ]);
      persistence.destroy();
    });

    it('does NOT advance the watermark when appendBatch throws', async () => {
      // Failure recovery: the next flush must re-attempt the same
      // delta, not skip it because we already marked it written.
      let appendCalls = 0;
      const flaky = new ReplayPersistence({
        dbName: 'retry-test',
        storage: {
          append: async () => undefined,
          appendBatch: async (
            _store: string,
            events: eventWithTime[]
          ): Promise<void> => {
            appendCalls++;
            if (appendCalls === 1) throw new Error('first call fails');
            // Second call succeeds; capture for assertion below.
            (flaky as unknown as { _written: eventWithTime[] })._written =
              events;
          },
          readAll: async () => [],
          deleteUpTo: async () => undefined,
          clear: async () => undefined,
          close: () => undefined,
        } as unknown as AsyncStorage,
      });
      const b = new TestBuffer();
      b.events = [makeEvent(50), makeEvent(60)];
      flaky.bind(b);

      await flaky.flush(); // first call throws — watermark not advanced
      await flaky.flush(); // second call retries the SAME events

      const written = (flaky as unknown as { _written: eventWithTime[] })
        ._written;
      expect(written.map((e) => e.timestamp)).toEqual([50, 60]);
      expect(appendCalls).toBe(2);
      flaky.destroy();
    });

    it('uses max() of timestamps, not last array element, for the watermark', async () => {
      // rrweb does not strictly guarantee monotonic emit ordering.
      // If the buffer ever contains out-of-order events (e.g. an
      // older event added after a newer one), trusting the last
      // element's timestamp would yield an under-set watermark and
      // re-write events on the next flush.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buf = new TestBuffer();
      // Last element has the SMALLER timestamp — trusting `last`
      // would set watermark=200, and an event at 300 would later
      // pass the cutoff and double-write events at 500.
      buf.events = [makeEvent(500), makeEvent(200)];
      persistence.bind(buf);
      await persistence.flush();

      // Add an event at 300. After max()-based watermark, watermark
      // is 500, so 300 is BELOW it and skipped (correct — it's
      // older than what we already wrote).
      buf.events.push(makeEvent(300));
      await persistence.flush();

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      // Only the first two events landed; the 300 was below the
      // max-based watermark of 500.
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.value.timestamp).sort()).toEqual([200, 500]);
      persistence.destroy();
    });

    it('serializes re-entrant flushes via flushPromise chain (no double-write, no data loss)', async () => {
      // visibilitychange and pagehide can fire microseconds apart.
      // The chain serializes them: the second flush waits for the
      // first to complete, re-reads the buffer + watermark, and
      // only writes the delta (empty here, so no second append).
      // This is the watermark+chain replacement of the older
      // flushInFlight boolean.
      const dbName = uniqueDbName();
      let appendCalls = 0;
      const slowAppendStorage = {
        append: async () => undefined,
        appendBatch: async (
          store: string,
          events: eventWithTime[]
        ): Promise<void> => {
          appendCalls++;
          // Delay so a concurrent flush() call enqueues onto chain.
          await new Promise((r) => setTimeout(r, 30));
          // Pass through to a real storage so we can probe afterwards.
          const real = new IndexedDbStorage({ dbName });
          await real.appendBatch(store, events);
          real.close();
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => undefined,
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName,
        storage: slowAppendStorage as unknown as AsyncStorage,
      });
      const buf = new TestBuffer();
      buf.events = [makeEvent(700), makeEvent(800)];
      persistence.bind(buf);

      // Fire two flushes back-to-back. The second runs after the
      // first via the chain; with no new events, its delta is
      // empty so appendBatch is only called once.
      const p1 = persistence.flush();
      const p2 = persistence.flush();
      await Promise.all([p1, p2]);

      expect(appendCalls).toBe(1);
      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(2);
      persistence.destroy();
    });

    it('chained flushes pick up events added between the two triggers (no data loss on unload)', async () => {
      // The reason the chain replaces the boolean flag: a second
      // flush triggered between the first's read and resolve must
      // not be dropped — any events that landed in the buffer in
      // that window need to be written too.
      const dbName = uniqueDbName();
      const slowAppendStorage = {
        append: async () => undefined,
        appendBatch: async (
          store: string,
          events: eventWithTime[]
        ): Promise<void> => {
          // Delay the first batch enough that the test can add new
          // events to the buffer before the chain processes the
          // second flush.
          await new Promise((r) => setTimeout(r, 40));
          const real = new IndexedDbStorage({ dbName });
          await real.appendBatch(store, events);
          real.close();
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => undefined,
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName,
        storage: slowAppendStorage as unknown as AsyncStorage,
      });
      const buf = new TestBuffer();
      buf.events = [makeEvent(100), makeEvent(200)];
      persistence.bind(buf);

      // First flush in flight (slow), add new events, then second
      // flush. Second waits for first via the chain, sees the new
      // events, writes them.
      const p1 = persistence.flush();
      await new Promise((r) => setTimeout(r, 5));
      buf.events.push(makeEvent(300), makeEvent(400));
      const p2 = persistence.flush();
      await Promise.all([p1, p2]);

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      // All four events landed — the late additions would have been
      // lost under the older flushInFlight-bool design.
      expect(
        records.map((r) => r.value.timestamp).sort((a, b) => a - b)
      ).toEqual([100, 200, 300, 400]);
      persistence.destroy();
    });

    it('generation guard: watermark NOT overwritten if destroy bumps generation mid-flush', async () => {
      // The race the bot called out: a slow flush is in-flight when
      // destroy() resets the watermark + bumps generation. Without
      // the generation guard, the flush's resolve would write the
      // stale high-watermark value, breaking the re-used instance.
      const dbName = uniqueDbName();
      let appendCalls = 0;
      let releaseFirstAppend: () => void = () => undefined;
      let signalFirstAppendStarted: () => void = () => undefined;
      const firstAppendStarted = new Promise<void>((r) => {
        signalFirstAppendStarted = r;
      });
      const stagedStorage = {
        append: async () => undefined,
        appendBatch: async (
          store: string,
          events: eventWithTime[]
        ): Promise<void> => {
          appendCalls++;
          if (appendCalls === 1) {
            // Signal that we're past the start of the block so the
            // test can call destroy() + release the gate. Without
            // this, the test's release call would race ahead of
            // appendBatch (the chain has a microtask boundary
            // before runFlush starts) and hit a stale no-op
            // releaser.
            signalFirstAppendStarted();
            await new Promise<void>((r) => {
              releaseFirstAppend = r;
            });
          }
          const real = new IndexedDbStorage({ dbName });
          await real.appendBatch(store, events);
          real.close();
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => undefined,
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName,
        storage: stagedStorage as unknown as AsyncStorage,
      });
      const buf = new TestBuffer();
      buf.events = [makeEvent(9000)];
      persistence.bind(buf);

      const flushPromise = persistence.flush();
      // Wait until the first appendBatch is actually inside the
      // block before bumping the generation.
      await firstAppendStarted;
      persistence.destroy();
      releaseFirstAppend();
      await flushPromise;

      // After destroy + bump, the previous instance's watermark must
      // still be 0. Behavioral check: re-bind a fresh buffer with
      // SMALL timestamps. If the watermark had been clobbered to
      // 9000 by the in-flight flush, these would be silently
      // skipped. Second appendBatch is non-blocking.
      const buf2 = new TestBuffer();
      buf2.events = [makeEvent(50), makeEvent(100)];
      persistence.bind(buf2); // re-use the destroyed instance
      await persistence.flush();

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      const timestamps = records
        .map((r) => r.value.timestamp)
        .sort((a, b) => a - b);
      // The 9000 was written by the (now-detached) first flush; the
      // 50 and 100 land only if the watermark wasn't clobbered to
      // 9000 by that flush's late watermark update.
      expect(timestamps).toContain(50);
      expect(timestamps).toContain(100);
      persistence.destroy();
    });
  });

  describe('bfcache handling', () => {
    it('clears storage on pageshow.persisted (memory buffer is authoritative)', async () => {
      // bfcache scenario: pagehide flushed events to IDB while the
      // page went into the back-forward cache. Then the user
      // navigated back — pageshow fires with persisted=true, and
      // the memory buffer is still intact. The IDB copy is now
      // obsolete; clearing it prevents duplicates the next time
      // pagehide flushes the (still-intact) memory buffer.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(100), makeEvent(200)];
      persistence.bind(buffer);

      // Simulate pagehide-to-bfcache (flush happens).
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 50));

      // Confirm flush landed.
      let probe = new IndexedDbStorage({ dbName });
      expect(await probe.readAll(REPLAY_STORE)).toHaveLength(2);
      probe.close();

      // Now dispatch pageshow with persisted=true (bfcache restore).
      const pageshowEvent = new Event('pageshow') as Event & {
        persisted: boolean;
      };
      Object.defineProperty(pageshowEvent, 'persisted', { value: true });
      window.dispatchEvent(pageshowEvent);
      await new Promise((r) => setTimeout(r, 50));

      // IDB should be empty.
      probe = new IndexedDbStorage({ dbName });
      expect(await probe.readAll(REPLAY_STORE)).toHaveLength(0);
      probe.close();

      persistence.destroy();
    });

    it('does NOT clear storage on a normal pageshow (persisted=false)', async () => {
      // Normal page load (not from bfcache): pageshow fires with
      // persisted=false. We should NOT touch IDB — this is the
      // path where restore is supposed to read prior events.
      const dbName = uniqueDbName();
      const seedStorage = new IndexedDbStorage({ dbName });
      await seedStorage.appendBatch(REPLAY_STORE, [makeEvent(1), makeEvent(2)]);
      seedStorage.close();

      const persistence = new ReplayPersistence({ dbName });
      persistence.bind(new TestBuffer());

      const pageshowEvent = new Event('pageshow') as Event & {
        persisted: boolean;
      };
      Object.defineProperty(pageshowEvent, 'persisted', { value: false });
      window.dispatchEvent(pageshowEvent);
      await new Promise((r) => setTimeout(r, 50));

      // Seeded events still there.
      const probe = new IndexedDbStorage({ dbName });
      expect(await probe.readAll(REPLAY_STORE)).toHaveLength(2);
      probe.close();
      persistence.destroy();
    });

    it('destroy removes the pageshow listener', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      removeSpy.mockClear();
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      persistence.bind(new TestBuffer());
      persistence.destroy();
      const pageshowRemoves = removeSpy.mock.calls.filter(
        (c) => c[0] === 'pageshow'
      );
      expect(pageshowRemoves.length).toBe(1);
      removeSpy.mockRestore();
    });

    it('resets lastFlushedTimestamp on pageshow.persisted so next flush re-writes the buffer', async () => {
      // The trap: after pagehide flush, watermark = highest event
      // timestamp. bfcache pageshow clears IDB but the memory
      // buffer is still intact. Without resetting the watermark,
      // the next pagehide flush would skip every event (timestamp
      // <= watermark), leaving IDB empty for the next restore —
      // the user would lose ALL prior activity.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(1000), makeEvent(2000)];
      persistence.bind(buffer);

      // First pagehide: flush writes events, watermark = 2000.
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 50));

      // bfcache return: clears IDB AND resets watermark.
      const pageshowEvent = new Event('pageshow') as Event & {
        persisted: boolean;
      };
      Object.defineProperty(pageshowEvent, 'persisted', { value: true });
      window.dispatchEvent(pageshowEvent);
      await new Promise((r) => setTimeout(r, 50));

      // Second pagehide: SAME buffer events. Without the reset they
      // would all be below the 2000 watermark and skipped. With the
      // reset, they re-land in IDB.
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 50));

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.value.timestamp)).toEqual([1000, 2000]);
      persistence.destroy();
    });

    it('chains the bfcache clear into flushPromise so a pagehide-after-pageshow waits for it', async () => {
      // The race Claude bot called out: pageshow's clear() is
      // fire-and-forget. If pagehide fires in between, its
      // appendBatch could race ahead of clear in IDB's transaction
      // queue and have its events wiped. The chain forces ordering:
      // pagehide's flush enqueues onto flushPromise AFTER the clear
      // that pageshow already chained.
      const dbName = uniqueDbName();
      const opOrder: string[] = [];
      const orderedStorage = {
        append: async () => undefined,
        appendBatch: async (
          store: string,
          events: eventWithTime[]
        ): Promise<void> => {
          // Brief delay to ensure ordering is observable.
          await new Promise((r) => setTimeout(r, 10));
          opOrder.push('appendBatch');
          const real = new IndexedDbStorage({ dbName });
          await real.appendBatch(store, events);
          real.close();
        },
        readAll: async () => [],
        deleteUpTo: async () => undefined,
        clear: async () => {
          await new Promise((r) => setTimeout(r, 10));
          opOrder.push('clear');
          const real = new IndexedDbStorage({ dbName });
          await real.clear(REPLAY_STORE);
          real.close();
        },
        close: () => undefined,
      };
      const persistence = new ReplayPersistence({
        dbName,
        storage: orderedStorage as unknown as AsyncStorage,
      });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(7000), makeEvent(8000)];
      persistence.bind(buffer);

      // Trigger bfcache pageshow first (queues clear onto chain),
      // then pagehide (queues flush onto chain right after).
      const pageshowEvent = new Event('pageshow') as Event & {
        persisted: boolean;
      };
      Object.defineProperty(pageshowEvent, 'persisted', { value: true });
      window.dispatchEvent(pageshowEvent);
      window.dispatchEvent(new Event('pagehide'));
      // Wait for the chain to drain.
      await new Promise((r) => setTimeout(r, 100));

      // Clear must have run before appendBatch. If it ran after, the
      // appendBatch's events would have been wiped.
      expect(opOrder).toEqual(['clear', 'appendBatch']);
      // Final state: the two events from the buffer are in IDB.
      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(2);
      persistence.destroy();
    });
  });

  describe('visibilitychange handling', () => {
    function setVisibility(state: 'visible' | 'hidden'): void {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
    }

    afterEach(() => {
      setVisibility('visible');
    });

    it('flushes when document.visibilityState becomes hidden', async () => {
      // The whole point of slice 3: on mobile, the OS may kill the
      // background process WITHOUT firing pagehide. visibilitychange
      // fires when the tab goes hidden, giving IDB the largest
      // possible window to complete the write.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(10), makeEvent(20)];
      persistence.bind(buffer);

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 50));

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(2);
      persistence.destroy();
    });

    it('does NOT flush when visibilityState is visible', async () => {
      // Negative case: a 'visible' transition (e.g. tab focus
      // restored) must NOT trigger a flush. Otherwise every focus
      // event would write the buffer.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(10)];
      persistence.bind(buffer);

      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 50));

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(0);
      persistence.destroy();
    });

    it('mobile-kill scenario: visibility→hidden alone (no pagehide) still flushes', async () => {
      // The whole point: a mobile-killed process never fires
      // pagehide. visibilitychange alone has to be sufficient.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(500)];
      persistence.bind(buffer);

      // ONLY visibility hidden — no pagehide event.
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 50));

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      expect(records).toHaveLength(1);
      expect(records[0].value.timestamp).toBe(500);
      persistence.destroy();
    });

    it('visibility+pagehide together produce exactly one effective write (dedup)', async () => {
      // The desktop-nav case the bot worried about: both events fire,
      // but the watermark + flushInFlight combo prevents double-write.
      const dbName = uniqueDbName();
      const persistence = new ReplayPersistence({ dbName });
      const buffer = new TestBuffer();
      buffer.events = [makeEvent(11), makeEvent(22)];
      persistence.bind(buffer);

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 80));

      const probe = new IndexedDbStorage({ dbName });
      const records = await probe.readAll<eventWithTime>(REPLAY_STORE);
      probe.close();
      // Exactly the two original events — not four.
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.value.timestamp)).toEqual([11, 22]);
      persistence.destroy();
    });

    it('destroy removes the visibilitychange listener', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      removeSpy.mockClear();
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      persistence.bind(new TestBuffer());
      persistence.destroy();
      const visibilityRemoves = removeSpy.mock.calls.filter(
        (c) => c[0] === 'visibilitychange'
      );
      expect(visibilityRemoves.length).toBe(1);
      removeSpy.mockRestore();
    });

    it('binds the visibilitychange listener exactly once across multiple bind() calls', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      addSpy.mockClear();
      const persistence = new ReplayPersistence({ dbName: uniqueDbName() });
      persistence.bind(new TestBuffer());
      persistence.bind(new TestBuffer());
      persistence.bind(new TestBuffer());

      const visibilityAdds = addSpy.mock.calls.filter(
        (c) => c[0] === 'visibilitychange'
      );
      expect(visibilityAdds.length).toBe(1);
      persistence.destroy();
      addSpy.mockRestore();
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
