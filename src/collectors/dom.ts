import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
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
              ownBuffer.addBatch(currentQueue);
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
      const recordConfig = {
        emit: (event: eventWithTime) => {
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
        // PII sanitization for text content
        maskTextFn: this.sanitizer
          ? (text: string, element?: HTMLElement) => {
              return this.sanitizer!.sanitizeTextNode(text, element);
            }
          : undefined,
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
