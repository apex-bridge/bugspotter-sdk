/**
 * Tests for DOMCollector's persistence integration. Specifically
 * the two contracts whose lack of coverage was flagged on PR #129:
 *
 *  1. startRecording → stopRecording → startRecording while the
 *     first restore is still in flight does NOT have the first
 *     restore's .finally drain the second session's emitQueue
 *     (the identity guard on `this.emitQueue === currentQueue`).
 *  2. destroy() while a restore is in flight does NOT have the
 *     restore's .finally repopulate the cleared buffer (the
 *     emitQueue null-out in destroy()).
 *
 * Both are exercised through a controllable persistence stub —
 * `restore()` returns a Promise the test can resolve at will. rrweb
 * itself is also mocked so the test doesn't depend on jsdom DOM
 * event timing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { eventWithTime } from '@rrweb/types';

// Capture the emit callback rrweb is given so the test can fire
// synthetic events through it.
const recordControl = vi.hoisted(() => ({
  capturedEmit: null as ((event: eventWithTime) => void) | null,
  stopFn: vi.fn(),
}));

vi.mock('rrweb', () => ({
  record: (config: { emit: (event: eventWithTime) => void }) => {
    recordControl.capturedEmit = config.emit;
    return recordControl.stopFn;
  },
}));

import { DOMCollector } from '../../src/collectors/dom';
import type { ReplayPersistence } from '../../src/core/storage/replay-persistence';

interface DeferredRestore {
  promise: Promise<void>;
  resolve: () => void;
}

function makeDeferred(): DeferredRestore {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeStubPersistence(restorePromise: Promise<void>): ReplayPersistence {
  return {
    bind: vi.fn(),
    restore: vi.fn().mockReturnValue(restorePromise),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  } as unknown as ReplayPersistence;
}

function makeEvent(tag: number): eventWithTime {
  // Real-ish timestamps so CircularBuffer's prune (Date.now() -
  // duration cutoff) doesn't immediately drop them. The tag is
  // encoded in the millisecond offset so we can identify events
  // in assertions without depending on absolute time.
  return {
    type: 3,
    data: { tag },
    timestamp: Date.now() + tag,
  } as unknown as eventWithTime;
}

function tagOf(event: eventWithTime): number {
  return (event as unknown as { data: { tag: number } }).data.tag;
}

describe('DOMCollector with persistence', () => {
  beforeEach(() => {
    recordControl.capturedEmit = null;
    recordControl.stopFn.mockClear();
  });

  it('start → stop → start while first restore pending does not have first restore drain second session queue', async () => {
    // The race we're guarding against is on the SAME DOMCollector
    // instance: startRecording sets this.emitQueue to a new queue.
    // If stop then start fires another restore, the second
    // startRecording replaces this.emitQueue with queue2. When
    // restore1 eventually settles, its .finally would (without
    // the identity guard) read this.emitQueue, find queue2, and
    // drain it prematurely.
    //
    // We can't easily inspect the queue's drain timing from the
    // outside, so we assert the consequence: after restore1
    // settles (but BEFORE restore2 settles), event 2 has NOT yet
    // been added to the buffer. Then after restore2 settles, it
    // appears.
    const persistence = {
      bind: vi.fn(),
      restore: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    } as unknown as ReplayPersistence;
    const restore1 = makeDeferred();
    const restore2 = makeDeferred();
    (persistence.restore as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(restore1.promise)
      .mockReturnValueOnce(restore2.promise);

    const collector = new DOMCollector({ persistence });
    collector.startRecording(); // restore1 fires, emitQueue = q1
    recordControl.capturedEmit?.(makeEvent(1)); // → q1

    collector.stopRecording();
    collector.startRecording(); // restore2 fires, emitQueue = q2
    recordControl.capturedEmit?.(makeEvent(2)); // → q2

    // Resolve restore1. Its finally should bail out (identity
    // guard: this.emitQueue is q2, but currentQueue captured by
    // restore1 was q1).
    restore1.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // q2 should still hold event 2 — buffer should NOT have it yet.
    expect(collector.getEvents().map(tagOf)).not.toContain(2);

    // Now restore2 settles and drains q2 properly.
    restore2.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(collector.getEvents().map(tagOf)).toContain(2);
    collector.destroy();
  });

  it('destroy() while restore is in flight does not repopulate the cleared buffer', async () => {
    const restore = makeDeferred();
    const persistence = makeStubPersistence(restore.promise);
    const collector = new DOMCollector({ persistence });
    collector.startRecording();

    // Simulate events being queued during restore.
    recordControl.capturedEmit?.(makeEvent(10));
    recordControl.capturedEmit?.(makeEvent(20));

    // Destroy BEFORE the restore resolves. Buffer is cleared;
    // emitQueue must be nulled so the late finally doesn't
    // repopulate.
    collector.destroy();

    // Now let restore resolve. Without the destroy-time null,
    // the queued events would be added to the buffer via
    // addBatch. With the null, the identity check fails and
    // nothing happens.
    restore.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Buffer should remain empty (was cleared by destroy(); not
    // repopulated by the late finally).
    expect(collector.getEvents()).toHaveLength(0);
  });

  it('destroy() while restore is in flight calls persistence.destroy() exactly once', () => {
    const restore = makeDeferred();
    const persistence = makeStubPersistence(restore.promise);
    const collector = new DOMCollector({ persistence });
    collector.startRecording();
    collector.destroy();
    expect(persistence.destroy).toHaveBeenCalledTimes(1);
    restore.resolve();
  });
});
