import type { BrowserMetadata } from './capture/metadata';
import { FloatingButton, type FloatingButtonOptions } from './widget/button';
import { BugReportModal } from './widget/modal';
import type { eventWithTime } from '@rrweb/types';
import { createSanitizer, type Sanitizer } from './utils/sanitize';
import { getLogger } from './utils/logger';
import type { RetryConfig } from './core/transport';
import type { OfflineConfig } from './core/offline-queue';
import { DEFAULT_REPLAY_DURATION_SECONDS } from './constants';
import { getApiBaseUrl } from './utils/url-helpers';
import { VERSION } from './version';
import { type DeduplicationConfig } from './utils/deduplicator';
import { validateDeduplicationConfig } from './utils/config-validator';
import { CaptureManager } from './core/capture-manager';
import { BugReporter } from './core/bug-reporter';

const logger = getLogger();

// Re-export VERSION for public API
export { VERSION };

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_MOUSEMOVE_SAMPLING = 50;
const DEFAULT_SCROLL_SAMPLING = 100;

// ============================================================================
// TYPE GUARDS
// ============================================================================

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Merge replay configuration from user config and backend settings
 * User config takes precedence over backend settings
 */
function mergeReplayConfig(
  userConfig: BugSpotterConfig['replay'],
  backendSettings: ReplayQualitySettings | null
): BugSpotterConfig['replay'] {
  return {
    ...userConfig,
    duration:
      userConfig?.duration ??
      backendSettings?.duration ??
      DEFAULT_REPLAY_DURATION_SECONDS,
    inlineStylesheet:
      userConfig?.inlineStylesheet ??
      backendSettings?.inline_stylesheets ??
      true,
    inlineImages:
      userConfig?.inlineImages ?? backendSettings?.inline_images ?? false,
    collectFonts:
      userConfig?.collectFonts ?? backendSettings?.collect_fonts ?? false,
    recordCanvas:
      userConfig?.recordCanvas ?? backendSettings?.record_canvas ?? false,
    recordCrossOriginIframes:
      userConfig?.recordCrossOriginIframes ??
      backendSettings?.record_cross_origin_iframes ??
      false,
    sampling: {
      mousemove:
        userConfig?.sampling?.mousemove ??
        backendSettings?.sampling_mousemove ??
        DEFAULT_MOUSEMOVE_SAMPLING,
      scroll:
        userConfig?.sampling?.scroll ??
        backendSettings?.sampling_scroll ??
        DEFAULT_SCROLL_SAMPLING,
    },
  };
}

// ============================================================================
// BACKEND INTEGRATION
// ============================================================================

/**
 * Replay quality settings fetched from backend
 */
interface ReplayQualitySettings {
  duration: number;
  inline_stylesheets: boolean;
  inline_images: boolean;
  collect_fonts: boolean;
  record_canvas: boolean;
  record_cross_origin_iframes: boolean;
  sampling_mousemove: number;
  sampling_scroll: number;
}

/**
 * Fetch replay quality settings from backend
 * Falls back to hardcoded defaults if fetch fails or settings not available
 *
 * @param endpoint - API endpoint URL
 * @param apiKey - Optional API key for authentication
 * @returns Replay quality settings with defaults applied
 */
async function fetchReplaySettings(
  endpoint: string,
  apiKey?: string
): Promise<ReplayQualitySettings> {
  const defaults: ReplayQualitySettings = {
    duration: DEFAULT_REPLAY_DURATION_SECONDS,
    inline_stylesheets: true,
    inline_images: false,
    collect_fonts: true,
    record_canvas: false,
    record_cross_origin_iframes: false,
    sampling_mousemove: DEFAULT_MOUSEMOVE_SAMPLING,
    sampling_scroll: DEFAULT_SCROLL_SAMPLING,
  };

  try {
    const apiBaseUrl = getApiBaseUrl(endpoint);
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const response = await fetch(`${apiBaseUrl}/api/v1/settings/replay`, {
      headers,
    });

    if (!response.ok) {
      logger.warn(
        `Failed to fetch replay settings: ${response.status}. Using defaults.`
      );
      return defaults;
    }

    const result = await response.json();

    if (!result.success || !result.data) {
      logger.warn('Invalid replay settings response. Using defaults.');
      return defaults;
    }

    return {
      duration: result.data.duration ?? defaults.duration,
      inline_stylesheets:
        result.data.inline_stylesheets ?? defaults.inline_stylesheets,
      inline_images: result.data.inline_images ?? defaults.inline_images,
      collect_fonts: result.data.collect_fonts ?? defaults.collect_fonts,
      record_canvas: result.data.record_canvas ?? defaults.record_canvas,
      record_cross_origin_iframes:
        result.data.record_cross_origin_iframes ??
        defaults.record_cross_origin_iframes,
      sampling_mousemove:
        result.data.sampling_mousemove ?? defaults.sampling_mousemove,
      sampling_scroll: result.data.sampling_scroll ?? defaults.sampling_scroll,
    };
  } catch (error) {
    logger.warn(
      'Failed to fetch replay settings from backend. Using defaults.',
      error
    );
    return defaults;
  }
}

export class BugSpotter {
  private static instance: BugSpotter | undefined;
  private static initPromise: Promise<BugSpotter> | undefined;

  private config: Readonly<BugSpotterConfig>;
  private widget?: FloatingButton;
  private sanitizer?: Sanitizer;
  private captureManager: CaptureManager;
  private bugReporter: BugReporter;

  constructor(config: BugSpotterConfig) {
    // Validate deduplication configuration if provided
    if (config.deduplication) {
      validateDeduplicationConfig(config.deduplication);
    }

    this.config = config;

    // Initialize sanitizer (enabled by default)
    const sanitizeEnabled = config.sanitize?.enabled ?? true;
    if (sanitizeEnabled) {
      this.sanitizer = createSanitizer({
        enabled: sanitizeEnabled,
        patterns: config.sanitize?.patterns,
        customPatterns: config.sanitize?.customPatterns,
        excludeSelectors: config.sanitize?.excludeSelectors,
      });
    }

    // Initialize capture manager
    this.captureManager = new CaptureManager({
      sanitizer: this.sanitizer,
      ...(config.endpoint && { apiEndpoint: getApiBaseUrl(config.endpoint) }),
      replay: config.replay,
    });

    // Initialize bug reporter
    this.bugReporter = new BugReporter(config);

    // Initialize widget (enabled by default)
    const widgetEnabled = config.showWidget ?? true;
    if (widgetEnabled) {
      this.widget = new FloatingButton(config.widgetOptions);
      this.widget.onClick(async () => {
        await this.handleBugReport();
      });
    }
  }

  static async init(config: BugSpotterConfig): Promise<BugSpotter> {
    // If instance exists, warn about singleton behavior
    if (BugSpotter.instance) {
      logger.warn(
        'BugSpotter.init() called multiple times. Returning existing instance. ' +
          'Call destroy() first to reinitialize with new config.'
      );
      return BugSpotter.instance;
    }

    // If initialization is already in progress, wait for it
    if (BugSpotter.initPromise) {
      logger.warn(
        'BugSpotter.init() called while initialization in progress. Waiting...'
      );
      return BugSpotter.initPromise;
    }

    // Start initialization and cache the promise
    BugSpotter.initPromise = BugSpotter.createInstance(config);

    try {
      BugSpotter.instance = await BugSpotter.initPromise;
      return BugSpotter.instance;
    } finally {
      // Clear the promise once initialization completes (success or failure)
      BugSpotter.initPromise = undefined;
    }
  }

  /**
   * Internal factory method to create a new BugSpotter instance
   * Fetches replay settings from backend before initialization
   */
  private static async createInstance(
    config: BugSpotterConfig
  ): Promise<BugSpotter> {
    // Fetch replay quality settings from backend if replay is enabled
    let backendSettings: ReplayQualitySettings | null = null;
    const replayEnabled = config.replay?.enabled ?? true;
    if (replayEnabled && config.endpoint) {
      // Validate auth is configured before attempting fetch
      if (!config.apiKey) {
        logger.warn(
          'Endpoint provided but no API key configured. Skipping backend settings fetch.'
        );
      } else {
        backendSettings = await fetchReplaySettings(
          config.endpoint,
          config.apiKey
        );
      }
    }

    // Merge backend settings with user config (user config takes precedence)
    const mergedConfig: BugSpotterConfig = {
      ...config,
      replay: mergeReplayConfig(config.replay, backendSettings),
    };

    return new BugSpotter(mergedConfig);
  }

  static getInstance(): BugSpotter | null {
    return BugSpotter.instance || null;
  }

  /**
   * Capture bug report data
   * Note: Screenshot is captured for modal preview only (_screenshotPreview)
   * File uploads use presigned URLs returned from the backend
   */
  async capture(): Promise<BugReport> {
    return await this.captureManager.captureAll();
  }

  private async handleBugReport(): Promise<void> {
    const report = await this.capture();

    const modal = new BugReportModal({
      onSubmit: async (data) => {
        logger.log('Submitting bug:', { ...data, report });

        // Send to endpoint if configured
        if (this.config.endpoint) {
          try {
            await this.submit({ ...data, report });
            logger.log('Bug report submitted successfully');
          } catch (error) {
            logger.error('Failed to submit bug report:', error);
            // Re-throw to allow UI to handle errors if needed
            throw error;
          }
        }
      },
      onProgress: (message) => {
        logger.debug('Upload progress:', message);
      },
    });

    modal.show(report._screenshotPreview || '');
  }

  /**
   * Submit a bug report with file uploads via presigned URLs
   * @param payload - Bug report payload with title, description, and report data
   * @public - Exposed for programmatic submission (bypassing modal)
   */
  async submit(payload: BugReportPayload): Promise<void> {
    await this.bugReporter.submit(payload);
  }

  getConfig(): Readonly<BugSpotterConfig> {
    return { ...this.config };
  }

  destroy(): void {
    this.captureManager.destroy();
    this.widget?.destroy();
    this.bugReporter.destroy();
    BugSpotter.instance = undefined;
    BugSpotter.initPromise = undefined;
  }
}

export interface BugSpotterConfig {
  /** Base URL of BugSpotter API (e.g., https://api.example.com). SDK appends paths internally. */
  endpoint?: string;

  /** API key for authentication (starts with 'bgs_') */
  apiKey?: string;

  showWidget?: boolean;
  widgetOptions?: FloatingButtonOptions;

  /** Retry configuration for failed requests */
  retry?: RetryConfig;

  /** Offline queue configuration */
  offline?: OfflineConfig;

  /** Deduplication configuration to prevent duplicate submissions */
  deduplication?: DeduplicationConfig;

  replay?: {
    /** Enable session replay recording (default: true) */
    enabled?: boolean;
    /** Duration in seconds to keep replay events (default: 15, max recommended: 30) */
    duration?: number;
    /** Sampling configuration for performance optimization */
    sampling?: {
      /** Throttle mousemove events in milliseconds (default: 50) */
      mousemove?: number;
      /** Throttle scroll events in milliseconds (default: 100) */
      scroll?: number;
    };
    /** Quality settings (optional, backend controlled by default) */
    /** Whether to inline stylesheets in recordings (default: backend controlled) */
    inlineStylesheet?: boolean;
    /** Whether to inline images in recordings (default: backend controlled) */
    inlineImages?: boolean;
    /** Whether to collect fonts for replay (default: backend controlled) */
    collectFonts?: boolean;
    /** Whether to record canvas elements (default: backend controlled) */
    recordCanvas?: boolean;
    /** Whether to record cross-origin iframes (default: backend controlled) */
    recordCrossOriginIframes?: boolean;
  };
  sanitize?: {
    /** Enable PII sanitization (default: true) */
    enabled?: boolean;
    /**
     * PII patterns to detect and mask
     * - Can be a preset name: 'all', 'minimal', 'financial', 'contact', 'gdpr', 'pci', etc.
     * - Or an array of pattern names: ['email', 'phone', 'ip']
     */
    patterns?:
      | 'all'
      | 'minimal'
      | 'financial'
      | 'contact'
      | 'identification'
      | 'kazakhstan'
      | 'gdpr'
      | 'pci'
      | Array<
          'email' | 'phone' | 'creditcard' | 'ssn' | 'iin' | 'ip' | 'custom'
        >;
    /** Custom regex patterns for PII detection */
    customPatterns?: Array<{
      name: string;
      regex: RegExp;
      description?: string;
      examples?: string[];
      priority?: number;
    }>;
    /** CSS selectors to exclude from sanitization */
    excludeSelectors?: string[];
  };
}

export interface BugReportPayload {
  title: string;
  description?: string;
  report: BugReport;
}

export interface BugReport {
  console: Array<{
    level: string;
    message: string;
    timestamp: number;
    stack?: string;
  }>;
  network: Array<{
    url: string;
    method: string;
    status: number;
    duration: number;
    timestamp: number;
    error?: string;
  }>;
  metadata: BrowserMetadata;
  replay?: eventWithTime[]; // Inline events for immediate preview/processing
  _screenshotPreview?: string; // Internal: screenshot preview for modal (not sent to API)
}

// Export capture module types for advanced usage
export type { BrowserMetadata } from './capture/metadata';
export { ScreenshotCapture } from './capture/screenshot';
export { ConsoleCapture } from './capture/console';
export { NetworkCapture } from './capture/network';
export { MetadataCapture } from './capture/metadata';

// Export collector modules
export { DOMCollector } from './collectors';
export type { DOMCollectorConfig } from './collectors';

// Export core utilities
export { CircularBuffer } from './core/buffer';
export type { CircularBufferConfig } from './core/buffer';

// Export compression utilities
export {
  compressData,
  decompressData,
  compressImage,
  estimateSize,
  getCompressionRatio,
} from './core/compress';

// Export transport and authentication
export {
  submitWithAuth,
  getAuthHeaders,
  clearOfflineQueue,
} from './core/transport';
export type {
  TransportOptions,
  RetryConfig,
} from './core/transport';
export type { OfflineConfig } from './core/offline-queue';
export type { Logger, LogLevel, LoggerConfig } from './utils/logger';
export { getLogger, configureLogger, createLogger } from './utils/logger';

// Export upload utilities
export { DirectUploader } from './core/uploader';
export type { UploadResult } from './core/uploader';
export {
  compressReplayEvents,
  canvasToBlob,
  estimateCompressedReplaySize,
  isWithinSizeLimit,
} from './core/upload-helpers';

// Export sanitization utilities
export { createSanitizer, Sanitizer } from './utils/sanitize';
export type {
  PIIPattern,
  CustomPattern,
  SanitizeConfig,
} from './utils/sanitize';

// Export URL helpers
export {
  getApiBaseUrl,
  stripEndpointSuffix,
  InvalidEndpointError,
} from './utils/url-helpers';

// Export config validation
export { validateAuthConfig } from './utils/config-validator';
export type { ValidationContext } from './utils/config-validator';

// Export pattern configuration utilities
export {
  DEFAULT_PATTERNS,
  PATTERN_PRESETS,
  PATTERN_CATEGORIES,
  PatternBuilder,
  createPatternConfig,
  getPattern,
  getPatternsByCategory,
  validatePattern,
} from './utils/sanitize';
export type { PIIPatternName, PatternDefinition } from './utils/sanitize';

// Export widget components
export { FloatingButton } from './widget/button';
export type { FloatingButtonOptions } from './widget/button';
export { BugReportModal } from './widget/modal';
export type {
  BugReportData,
  BugReportModalOptions,
  PIIDetection,
} from './widget/modal';

// Re-export rrweb types for convenience
export type { eventWithTime } from '@rrweb/types';

// Export constants
export {
  DEFAULT_REPLAY_DURATION_SECONDS,
  MAX_RECOMMENDED_REPLAY_DURATION_SECONDS,
} from './constants';

/**
 * Convenience function to sanitize text with default PII patterns
 * Useful for quick sanitization without creating a Sanitizer instance
 *
 * @param text - Text to sanitize
 * @returns Sanitized text with PII redacted
 *
 * @example
 * ```typescript
 * const sanitized = sanitize('Email: user@example.com');
 * // Returns: 'Email: [REDACTED]'
 * ```
 */
export function sanitize(text: string): string {
  const sanitizer = createSanitizer({
    enabled: true,
    patterns: 'all',
    customPatterns: [],
    excludeSelectors: [],
  });
  return sanitizer.sanitize(text) as string;
}

// Default export for convenience
export default BugSpotter;
