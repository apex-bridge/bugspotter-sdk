import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { CircularBuffer } from '../core/buffer';
import type { Sanitizer } from '../utils/sanitize';
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
  }

  /**
   * Start recording DOM events
   */
  startRecording(): void {
    if (this.isRecording) {
      getLogger().warn('DOMCollector: Recording already in progress');
      return;
    }

    try {
      const recordConfig = {
        emit: (event: eventWithTime) => {
          this.buffer.add(event);
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
  }
}
