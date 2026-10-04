import { record, EventType, IncrementalSource } from 'rrweb';
import { NodeType } from '@rrweb/types';
import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import { CircularBuffer } from '../core/buffer';
import type { Sanitizer } from '../utils/sanitize';
import type {
  ReplayPersistence,
  PersistableBuffer,
} from '../core/storage/replay-persistence';
import { DEFAULT_REPLAY_DURATION_SECONDS } from '../constants';

export interface DOMCollectorConfig {
  /** Duration in seconds to keep replay events (default: 15) */
  duration?: number;
  /** Sampling configuration for performance optimization */
  sampling?: {
    /** Throttle mousemove events (ms, default: 50) */
    mousemove?: number;
    /** Throttle scroll events (ms, default: 100) */
    scroll?: number;
  };
  /** Whether to inline stylesheets in recordings (default: true) */
  inlineStylesheet?: boolean;
  /** Whether to inline images in recordings (default: false) */
  inlineImages?: boolean;
  /** Whether to collect fonts for replay (default: false) */
  collectFonts?: boolean;
  /** Whether to record canvas elements (default: false) */
  recordCanvas?: boolean;
  /** Whether to record cross-origin iframes (default: false) */
  recordCrossOriginIframes?: boolean;
  /** CSS selectors for elements to block from recording */
  blockSelectors?: string[];
  /** CSS class name to block elements from recording */
  blockClass?: string;
  /** Sanitizer for PII protection */
  sanitizer?: Sanitizer;
  /**
   * Optional cross-navigation persistence. When set, the collector
   * restores any prior session's events into the buffer before
   * starting rrweb, and the persistence layer flushes the buffer
   * to storage on pagehide. Soft-fails completely independent of
   * recording — if persistence is broken, capture proceeds normally.
   */
  persistence?: ReplayPersistence;
}

/**
 * DOM Collector - Records user interactions and DOM mutations
 * @packageDocumentation
 */

import { getLogger } from '../utils/logger';

const logger = getLogger();

// Same shape as rrweb's input masking: one asterisk per character.
const maskFormText = (text: string): string => '*'.repeat(text.length);

const isTextarea = (node: Node | null | undefined): boolean =>
  node?.nodeName === 'TEXTAREA';

type ReplayMirror = typeof record.mirror;

/**
 * Textarea ancestry for replay nodes record.mirror doesn't hold. A recorded
 * cross-origin iframe posts its events to rrweb in the parent, which remaps
 * their ids, and restored events carry a previous page's ids. Those nodes
 * get parent links so a removal drops the whole subtree (rrweb emits one
 * remove per subtree root). Mirror nodes resolve through the mirror and are
 * never stored, so same-page mounts cost nothing here.
 */
class ReplayNodeTracker {
  private readonly parents = new Map<number, number>();
  private readonly children = new Map<number, Set<number>>();
  private readonly textareas = new Set<number>();
  private readonly textareaTexts = new Set<number>();
  // Mirror nodes (iframe elements) that tracked subtrees hang off.
  private readonly hosts = new Set<number>();

  /** Without a mirror (restored events), every node is tracked. */
  constructor(private readonly mirror?: ReplayMirror) {}

  /** Restored events never went through this page's maskTextFn. */
  get restored(): boolean {
    return !this.mirror;
  }

  /** Entries held across all maps; read by tests. */
  get size(): number {
    return (
      this.parents.size +
      this.children.size +
      this.textareas.size +
      this.textareaTexts.size +
      this.hosts.size
    );
  }

  getNode(id: number): Node | null {
    return this.mirror?.getNode(id) ?? null;
  }

  isTextarea(id: number): boolean {
    return this.textareas.has(id) || isTextarea(this.getNode(id));
  }

  isTextareaText(id: number, node: Node | null): boolean {
    return this.textareaTexts.has(id) || isTextarea(node?.parentNode);
  }

  track(
    id: number,
    parentId: number | undefined,
    kind?: 'textarea' | 'textareaText'
  ): void {
    if (this.mirror?.has(id)) return;
    if (parentId !== undefined) {
      const previous = this.parents.get(id);
      if (previous !== undefined) this.children.get(previous)?.delete(id);
      this.parents.set(id, parentId);
      let siblings = this.children.get(parentId);
      if (!siblings) {
        siblings = new Set();
        this.children.set(parentId, siblings);
      }
      siblings.add(id);
      if (this.mirror?.has(parentId)) this.hosts.add(parentId);
    }
    if (kind === 'textarea') this.textareas.add(id);
    if (kind === 'textareaText') this.textareaTexts.add(id);
  }

  remove(id: number): void {
    const parentId = this.parents.get(id);
    if (parentId !== undefined) this.children.get(parentId)?.delete(id);
    this.drop(id);
  }

  /** Drops subtrees whose iframe element left the mirror with an ancestor. */
  pruneHosts(): void {
    for (const host of this.hosts) {
      if (!this.mirror?.has(host)) {
        this.hosts.delete(host);
        this.drop(host);
      }
    }
  }

  /** A frame's new snapshot replaces everything under its iframe element. */
  dropChildren(id: number): void {
    for (const child of this.children.get(id) ?? []) {
      this.drop(child);
    }
    this.children.delete(id);
  }

  reset(): void {
    this.parents.clear();
    this.children.clear();
    this.textareas.clear();
    this.textareaTexts.clear();
    this.hosts.clear();
  }

  private drop(id: number): void {
    const stack = [id];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      this.parents.delete(next);
      this.textareas.delete(next);
      this.textareaTexts.delete(next);
      for (const child of this.children.get(next) ?? []) {
        stack.push(child);
      }
      this.children.delete(next);
    }
  }
}

function sanitizeSerializedNode(
  node: serializedNodeWithId,
  sanitizer: Sanitizer,
  nodes: ReplayNodeTracker,
  parentId?: number,
  inTextarea = false
): void {
  if (node.type === NodeType.Text) {
    if (inTextarea) {
      nodes.track(node.id, parentId, 'textareaText');
    }
    if (!node.textContent) return;
    if (inTextarea) {
      node.textContent = maskFormText(node.textContent);
    } else if ((node.isShadow || nodes.restored) && !node.isStyle) {
      node.textContent = sanitizer.sanitizeTextNode(node.textContent);
    }
    return;
  }
  if (node.type !== NodeType.Element && node.type !== NodeType.Document) {
    return;
  }
  const childInTextarea =
    node.type === NodeType.Element && node.tagName === 'textarea';
  nodes.track(node.id, parentId, childInTextarea ? 'textarea' : undefined);
  for (const child of node.childNodes) {
    sanitizeSerializedNode(child, sanitizer, nodes, node.id, childInTextarea);
  }
}

/**
 * Patches rrweb 2.0.0-alpha.4 gaps before the event is buffered or queued
 * (snapshot, added nodes, and text changes alike):
 * - needMaskingText returns false for a text node with no parentElement, so
 *   text directly under a ShadowRoot never reaches maskTextFn. Sanitize it.
 * - A textarea's child text (its default value) is serialized as page text
 *   through maskTextFn, while maskInputOptions only masks `attributes.value`.
 *   Mask it like the value so form values never appear readable.
 * - Meta events carry location.href verbatim. Sanitize it like metadata.url.
 * Restored events may predate all of this, so their page text is sanitized
 * here too. Every step is idempotent: already-sanitized events pass unchanged.
 */
function sanitizeReplayEvent(
  event: eventWithTime,
  sanitizer: Sanitizer,
  nodes: ReplayNodeTracker
): void {
  if (event.type === EventType.FullSnapshot) {
    // A new id space: one per record() call; restored events span page loads.
    nodes.reset();
    sanitizeSerializedNode(event.data.node, sanitizer, nodes);
    return;
  }
  if (event.type === EventType.Meta) {
    event.data.href = sanitizer.sanitize(event.data.href) as string;
    return;
  }
  if (
    event.type !== EventType.IncrementalSnapshot ||
    event.data.source !== IncrementalSource.Mutation
  ) {
    return;
  }
  const { data } = event;
  for (const remove of data.removes) {
    nodes.remove(remove.id);
  }
  if (data.removes.length > 0) {
    nodes.pruneHosts();
  }
  for (const add of data.adds) {
    if (data.isAttachIframe) {
      nodes.dropChildren(add.parentId);
    }
    sanitizeSerializedNode(
      add.node,
      sanitizer,
      nodes,
      add.parentId,
      add.node.type === NodeType.Text && nodes.isTextarea(add.parentId)
    );
  }
  for (const text of data.texts) {
    if (!text.value) continue;
    const node = nodes.getNode(text.id);
    if (nodes.isTextareaText(text.id, node)) {
      text.value = maskFormText(text.value);
    } else if (!node || node.parentElement === null) {
      // Unknown node: sanitize anyway (the sanitizer is idempotent).
      text.value = sanitizer.sanitizeTextNode(text.value);
    }
  }
}

export class DOMCollector {
  private buffer: CircularBuffer;
  private stopRecordingFn?: () => void;
  private isRecording = false;
  private persistence?: ReplayPersistence;
  // When persistence is restoring, rrweb may already be emitting
  // new events. We queue them here so the restored (older) events
  // land in the buffer FIRST, preserving chronological order.
  // After restore settles, queued events are drained in arrival
  // order into the buffer. null means "no active restoration".
  private emitQueue: eventWithTime[] | null = null;
  private config: DOMCollectorConfig & {
    duration: number;
    sampling: Required<DOMCollectorConfig['sampling']>;
    inlineStylesheet: boolean;
    inlineImages: boolean;
    collectFonts: boolean;
    recordCanvas: boolean;
    recordCrossOriginIframes: boolean;
  };
  private sanitizer?: Sanitizer;
  // Live textarea tracking, kept on the instance so tests can bound its size.
  private replayNodes?: ReplayNodeTracker;

  constructor(config: DOMCollectorConfig = {}) {
    this.sanitizer = config.sanitizer;
    this.config = {
      duration: config.duration ?? DEFAULT_REPLAY_DURATION_SECONDS,
      sampling: {
        mousemove: config.sampling?.mousemove ?? 50,
        scroll: config.sampling?.scroll ?? 100,
      },
      inlineStylesheet: config.inlineStylesheet ?? true,
      inlineImages: config.inlineImages ?? false,
      collectFonts: config.collectFonts ?? false,
      recordCanvas: config.recordCanvas ?? false,
      recordCrossOriginIframes: config.recordCrossOriginIframes ?? false,
      blockSelectors: config.blockSelectors,
      blockClass: config.blockClass,
      sanitizer: config.sanitizer,
    };

    this.buffer = new CircularBuffer({
      duration: this.config.duration,
    });

    this.persistence = config.persistence;
  }

  /**
   * Start recording DOM events
   */
  startRecording(): void {
    if (this.isRecording) {
      getLogger().warn('DOMCollector: Recording already in progress');
      return;
    }

    const sanitizer = this.sanitizer?.isEnabled() ? this.sanitizer : undefined;

    // Persistence opt-in: kick off the async restore now. While
    // it's in flight, rrweb's emit handler routes new events into
    // `emitQueue` instead of the buffer. After restore settles,
    // we drain the queue so the timeline reads as
    //   restored events → events emitted during restore → live
    // events, preserving chronological order.
    if (this.persistence) {
      // Identity-guarded queue: hold a closure-local reference so
      // if startRecording is called → stopped → restarted while
      // THIS restore is still in flight (React 18 StrictMode
      // double-mount; rapid restart), the second session's queue
      // (queue2) isn't clobbered by this restore's finally. Only
      // drain when this.emitQueue still matches OUR queue.
      const currentQueue: eventWithTime[] = [];
      this.emitQueue = currentQueue;
      const persistence = this.persistence;
      const ownBuffer = this.buffer;
      // Guarded buffer wrapper: ReplayPersistence.restore calls
      // buffer.addBatch(restoredEvents) INLINE before its caller
      // sees the resolved promise. Without a guard, a destroy()
      // (which clears the buffer + nulls emitQueue) that fires
      // between readAll and addBatch would have its just-cleared
      // buffer repopulated with stale prior-session events. The
      // identity check on emitQueue == currentQueue doubles as a
      // "this owner is still alive" signal — same identity
      // discipline as the .finally drain below.
      const guardedBuffer: PersistableBuffer = {
        getEvents: () => ownBuffer.getEvents(),
        addBatch: (events: eventWithTime[]) => {
          if (this.emitQueue !== currentQueue) return;
          if (sanitizer) {
            // Restored events may predate sanitizing. Their ids are a
            // previous page's, so they get a tracker without the live mirror.
            const restoredNodes = new ReplayNodeTracker();
            for (const event of events) {
              sanitizeReplayEvent(event, sanitizer, restoredNodes);
            }
          }
          ownBuffer.addBatch(events);
        },
        // Signal cancellation to ReplayPersistence so it skips the
        // deleteUpTo / clear step too. Without this the addBatch
        // would no-op (correct) but the records would still be
        // wiped from IDB — phantom delete, prior session's events
        // lost. Same identity check as addBatch.
        isAborted: () => this.emitQueue !== currentQueue,
      };
      void persistence
        .restore(guardedBuffer)
        .catch((err) => {
          getLogger().warn('DOMCollector: persistence restore threw:', err);
        })
        .finally(() => {
          if (this.emitQueue === currentQueue) {
            this.emitQueue = null;
            if (currentQueue.length > 0) {
              // Symmetric with ReplayPersistence.restore's addBatch
              // try/catch. Without this, a CircularBuffer.addBatch
              // throw inside .finally becomes an unhandledRejection
              // (the chain is wrapped in `void`).
              try {
                ownBuffer.addBatch(currentQueue);
              } catch (err) {
                getLogger().warn(
                  'DOMCollector: error draining emitQueue:',
                  err
                );
              }
            }
          }
        });
      // Bind the pagehide listener synchronously — we want flushes
      // wired before any user interaction, not after the async
      // restore completes. Pass the OWN buffer (not guarded) so
      // pagehide flushes get the live event list.
      try {
        persistence.bind(ownBuffer);
      } catch (err) {
        getLogger().warn('DOMCollector: persistence bind threw:', err);
      }
    }

    try {
      const nodes = sanitizer && new ReplayNodeTracker(record.mirror);
      this.replayNodes = nodes;
      const recordConfig = {
        emit: (event: eventWithTime) => {
          if (sanitizer && nodes) {
            sanitizeReplayEvent(event, sanitizer, nodes);
          }
          if (this.emitQueue) {
            this.emitQueue.push(event);
          } else {
            this.buffer.add(event);
          }
        },
        sampling: {
          mousemove: this.config.sampling?.mousemove ?? 50,
          scroll: this.config.sampling?.scroll ?? 100,
          // Record all mouse interactions for replay visibility
          mouseInteraction: true,
        },
        recordCanvas: this.config.recordCanvas,
        recordCrossOriginIframes: this.config.recordCrossOriginIframes,
        // rrweb only calls maskTextFn on nodes matched by maskTextSelector,
        // so '*' routes every text node through the sanitizer. Input values
        // are masked by tag name: in alpha.4 maskAllInputs skips hidden and
        // untyped inputs, and maskInputFn gets no element to spot passwords.
        // Radio/checkbox/submit/button values (author-defined) stay readable.
        ...(sanitizer && {
          maskTextSelector: '*',
          maskTextFn: (text: string, element?: HTMLElement) =>
            sanitizer.sanitizeTextNode(text, element),
          maskInputOptions: { input: true, textarea: true, select: true },
        }),
        // Performance optimizations
        slimDOMOptions: {
          script: true, // Don't record script tags
          comment: true, // Don't record comments
          headFavicon: true, // Don't record favicon
          headWhitespace: true, // Don't record whitespace in head
          headMetaSocial: true, // Don't record social media meta tags
          headMetaRobots: true, // Don't record robots meta tags
          headMetaHttpEquiv: true, // Don't record http-equiv meta tags
          headMetaAuthorship: true, // Don't record authorship meta tags
          headMetaVerification: true, // Don't record verification meta tags
        },
        // Quality settings (controlled by backend or user config)
        inlineStylesheet: this.config.inlineStylesheet,
        inlineImages: this.config.inlineImages,
        collectFonts: this.config.collectFonts,
        // Block sensitive elements from recording
        ...(this.config.blockSelectors?.length && {
          blockSelector: this.config.blockSelectors.join(','),
        }),
        ...(this.config.blockClass && {
          blockClass: this.config.blockClass,
        }),
      };

      this.stopRecordingFn = record(recordConfig);
      this.isRecording = true;
      getLogger().debug('DOMCollector: Started recording');
    } catch (error) {
      getLogger().error('DOMCollector: Failed to start recording', error);
      this.isRecording = false;
    }
  }

  /**
   * Stop recording DOM events
   */
  stopRecording(): void {
    if (!this.isRecording || !this.stopRecordingFn) {
      logger.warn('DOMCollector: No recording in progress');
      return;
    }

    try {
      this.stopRecordingFn();
      this.isRecording = false;
      this.stopRecordingFn = undefined;
      this.replayNodes?.reset();
      logger.debug('DOMCollector: Stopped recording');
    } catch (error) {
      logger.error('DOMCollector: Failed to stop recording', error);
    }
  }

  /**
   * Get all events from the buffer
   */
  getEvents(): eventWithTime[] {
    return this.buffer.getEvents();
  }

  /**
   * Get compressed events from the buffer
   */
  getCompressedEvents(): eventWithTime[] {
    return this.buffer.getCompressedEvents();
  }

  /**
   * Clear all events from the buffer
   */
  clearBuffer(): void {
    this.buffer.clear();
  }

  /**
   * Check if currently recording
   */
  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get the current buffer size
   */
  getBufferSize(): number {
    return this.buffer.size();
  }

  /**
   * Update the buffer duration
   */
  setDuration(seconds: number): void {
    this.config.duration = seconds;
    this.buffer.setDuration(seconds);
  }

  /**
   * Get the buffer duration
   */
  getDuration(): number {
    return this.config.duration;
  }

  /**
   * Destroy the collector and clean up resources
   */
  destroy(): void {
    this.stopRecording();
    this.clearBuffer();
    // Null the emitQueue so any in-flight restore's finally fails
    // its `this.emitQueue === currentQueue` identity check and
    // doesn't repopulate the just-cleared buffer.
    this.emitQueue = null;
    if (this.persistence) {
      // Flush the (now-empty after clearBuffer) buffer is a no-op,
      // so we don't bother. We DO unbind the pagehide listener so
      // a re-instantiated SDK doesn't leak handlers.
      try {
        this.persistence.destroy();
      } catch (err) {
        getLogger().warn('DOMCollector: persistence destroy threw:', err);
      }
      this.persistence = undefined;
    }
  }
}
