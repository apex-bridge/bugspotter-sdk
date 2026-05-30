/**
 * Capture Manager - Coordinates all data capture modules
 * @module core/capture-manager
 */

import type { BugReport } from '../index';
import { ScreenshotCapture } from '../capture/screenshot';
import { ConsoleCapture } from '../capture/console';
import { NetworkCapture } from '../capture/network';
import { MetadataCapture } from '../capture/metadata';
import { DOMCollector } from '../collectors/dom';
import { ReplayPersistence } from './storage/replay-persistence';
import type { Sanitizer } from '../utils/sanitize';

import { DEFAULT_REPLAY_DURATION_SECONDS } from '../constants';

/**
 * Configuration for capture manager
 */
export interface CaptureManagerConfig {
  sanitizer?: Sanitizer;
  apiEndpoint?: string; // API endpoint URL for filtering SDK network calls
  replay?: {
    enabled?: boolean;
    duration?: number;
    sampling?: {
      mousemove?: number;
      scroll?: number;
    };
    inlineStylesheet?: boolean;
    inlineImages?: boolean;
    collectFonts?: boolean;
    recordCanvas?: boolean;
    recordCrossOriginIframes?: boolean;
    blockSelectors?: string[];
    blockClass?: string;
    /**
     * Opt-in: persist rrweb events to IndexedDB on pagehide and
     * restore them on init. Lets a bug reported AFTER a page
     * reload still include pre-reload activity. Default off.
     */
    persistAcrossNavigation?: boolean;
    /**
     * IndexedDB database name used by the persistence layer.
     * REQUIRED when `persistAcrossNavigation` is true — pick a
     * stable identifier (apiKey prefix, endpoint hash, tenant id)
     * so multi-tenant SPAs on the same origin don't share storage.
     */
    dbName?: string;
  };
}

/**
 * Manages all data capture modules (screenshot, console, network, metadata, DOM)
 * Follows Single Responsibility Principle - only handles data capture coordination
 */
export class CaptureManager {
  private screenshot: ScreenshotCapture;
  private console: ConsoleCapture;
  private network: NetworkCapture;
  private metadata: MetadataCapture;
  private domCollector?: DOMCollector;
  private replayPersistence?: ReplayPersistence;

  constructor(config: CaptureManagerConfig) {
    // Initialize core capture modules
    this.screenshot = new ScreenshotCapture();
    this.console = new ConsoleCapture({ sanitizer: config.sanitizer });

    // Configure network capture to filter SDK API calls
    const networkOptions: {
      sanitizer?: Sanitizer;
      filterUrls?: (url: string) => boolean;
    } = {
      sanitizer: config.sanitizer,
    };
    if (config.apiEndpoint) {
      const endpoint = config.apiEndpoint;
      networkOptions.filterUrls = (url: string) => !url.startsWith(endpoint);
    }
    this.network = new NetworkCapture(networkOptions);

    this.metadata = new MetadataCapture({ sanitizer: config.sanitizer });

    // Initialize optional replay/DOM collector
    const replayEnabled = config.replay?.enabled ?? true;
    if (replayEnabled) {
      // Cross-navigation persistence is opt-in. We refuse to enable
      // it without a dbName because the IDB primitive (slice 1)
      // rejects empty names and a default would mix tenants on a
      // shared origin. Better to log + skip than misfire silently.
      if (config.replay?.persistAcrossNavigation) {
        const dbName = config.replay?.dbName;
        if (dbName) {
          try {
            this.replayPersistence = new ReplayPersistence({ dbName });
          } catch (err) {
            // Constructor shouldn't throw, but soft-fail if it
            // ever does — replay capture proceeds without
            // persistence.
            this.replayPersistence = undefined;
            // eslint-disable-next-line no-console
            console.warn('[BugSpotter] Replay persistence init failed:', err);
          }
        } else {
          // The host opted in but didn't provide dbName. Surface
          // this loudly — otherwise they'd assume replay persists
          // across navigations and silently get nothing.
          // eslint-disable-next-line no-console
          console.warn(
            '[BugSpotter] persistAcrossNavigation enabled but dbName not set; cross-navigation replay will not persist'
          );
        }
      }

      this.domCollector = new DOMCollector({
        duration: config.replay?.duration ?? DEFAULT_REPLAY_DURATION_SECONDS,
        sampling: config.replay?.sampling,
        inlineStylesheet: config.replay?.inlineStylesheet,
        inlineImages: config.replay?.inlineImages,
        collectFonts: config.replay?.collectFonts,
        recordCanvas: config.replay?.recordCanvas,
        recordCrossOriginIframes: config.replay?.recordCrossOriginIframes,
        blockSelectors: config.replay?.blockSelectors,
        blockClass: config.replay?.blockClass,
        sanitizer: config.sanitizer,
        persistence: this.replayPersistence,
      });
      this.domCollector.startRecording();
    }
  }

  /**
   * Capture all data for bug report
   */
  async captureAll(): Promise<BugReport> {
    // Call synchronous methods directly
    const consoleLogs = this.console.getLogs();
    const networkRequests = this.network.getRequests();
    const metadata = this.metadata.capture();
    const replay = this.domCollector?.getEvents() ?? [];

    // Await async screenshot capture
    const screenshotPreview = await this.screenshot.capture();

    return {
      console: consoleLogs,
      network: networkRequests,
      metadata,
      replay,
      _screenshotPreview: screenshotPreview,
    };
  }

  /**
   * Get screenshot only
   */
  async captureScreenshot(): Promise<string | undefined> {
    return await this.screenshot.capture();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.console.destroy();
    this.network.destroy();
    this.domCollector?.destroy();
  }
}
