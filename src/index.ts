import type { BrowserMetadata } from './capture/metadata';
import { FloatingButton, type FloatingButtonOptions } from './widget/button';
import { BugReportModal } from './widget/modal';
import type { eventWithTime } from '@rrweb/types';
import { createSanitizer, type Sanitizer } from './utils/sanitize';
import { getLogger } from './utils/logger';
import type { RetryConfig } from './core/transport';
import type { OfflineConfig } from './core/offline-queue';
import { DEFAULT_REPLAY_DURATION_SECONDS } from './constants';
import { getApiBaseUrl, isSecureEndpoint } from './utils/url-helpers';
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
  private captureManager?: CaptureManager;
  private bugReporter: BugReporter;
  private _sampled: boolean;

  constructor(config: BugSpotterConfig, sampled = true) {
    // Validate deduplication configuration if provided
    if (config.deduplication) {
      validateDeduplicationConfig(config.deduplication);
    }

    this.config = config;
    this._sampled = sampled;
    this.bugReporter = new BugReporter(config);

    // If not sampled, skip all capture initialization — true zero overhead
    // No console/network interception, no DOM recording, no widget
    if (!sampled) {
      return;
    }

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
    // Check sampling rate — if this session is not sampled, disable all capture
    if (config.sampleRate !== undefined) {
      if (
        typeof config.sampleRate !== 'number' ||
        !Number.isFinite(config.sampleRate) ||
        config.sampleRate < 0 ||
        config.sampleRate > 1
      ) {
        throw new Error('sampleRate must be a finite number between 0 and 1');
      }
      if (Math.random() >= config.sampleRate) {
        // Create a lightweight no-op instance — zero overhead (no console/network interception)
        return new BugSpotter(config, /* sampled */ false);
      }
    }

    // Fetch replay quality settings from backend if replay is enabled
    let backendSettings: ReplayQualitySettings | null = null;
    const replayEnabled = config.replay?.enabled ?? true;
    if (replayEnabled && config.endpoint) {
      // SECURITY: Don't send API key over insecure connection
      if (!isSecureEndpoint(config.endpoint)) {
        logger.warn(
          'Insecure endpoint — skipping backend settings fetch to protect API key.'
        );
      } else if (!config.apiKey) {
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
  /** Whether this session was sampled for capture */
  get isSampled(): boolean {
    return this._sampled;
  }

  async capture(): Promise<BugReport> {
    if (!this.captureManager) {
      // Unsampled session — return minimal valid report
      return {
        console: [],
        network: [],
        metadata: {
          userAgent:
            typeof navigator !== 'undefined' ? navigator.userAgent : '',
          url: typeof window !== 'undefined' ? window.location.href : '',
          timestamp: Date.now(),
          viewport:
            typeof window !== 'undefined'
              ? { width: window.innerWidth, height: window.innerHeight }
              : { width: 0, height: 0 },
          browser: 'unknown',
          os: 'unknown',
        },
      };
    }
    return await this.captureManager.captureAll();
  }

  private async handleBugReport(): Promise<void> {
    const report = await this.capture();

    // Deflection requires both endpoint + apiKey to call the
    // similarity probe. Opt-in via `config.deflection.enabled`.
    const deflectionEnabled =
      this.config.deflection?.enabled === true &&
      !!this.config.endpoint &&
      !!this.config.apiKey;

    const modal = new BugReportModal({
      onSubmit: async (data) => {
        // Translate widget camelCase → backend snake_case at the
        // bridge. Keeps the modal API JS-idiomatic without leaking
        // the backend's field-naming convention into the widget.
        const { deflectedToCanonicalId, ...rest } = data;
        const payload: BugReportPayload = {
          ...rest,
          report,
          deflected_to_canonical_id: deflectedToCanonicalId ?? null,
        };
        logger.log('Submitting bug:', payload);

        // Send to endpoint if configured
        if (this.config.endpoint) {
          try {
            await this.submit(payload);
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
      ...(deflectionEnabled
        ? {
            deflection: {
              endpoint: this.config.endpoint!,
              apiKey: this.config.apiKey,
              debounceMs: this.config.deflection?.debounceMs,
              maxMatches: this.config.deflection?.maxMatches,
            },
          }
        : {}),
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
    this.captureManager?.destroy();
    this.widget?.destroy();
    this.bugReporter.destroy();
    BugSpotter.instance = undefined;
    BugSpotter.initPromise = undefined;
  }
}

export interface BugSpotterConfig {
  /** Base URL of BugSpotter API (e.g., https://api.example.com). SDK appends paths internally. */
  endpoint?: string;

  /** API key for authentication (starts with 'bgs_'). Required. */
  apiKey: string;

  /**
   * Session sampling rate (0 to 1). Controls what fraction of sessions activate capture.
   * - 1 = capture all sessions (default)
   * - 0.1 = capture 10% of sessions
   * - 0 = capture nothing (SDK initializes but is inactive)
   */
  sampleRate?: number;

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
    /**
     * CSS selectors for DOM elements to exclude from session replay.
     * Matched elements are replaced with a placeholder in the recording.
     * Use for sensitive content that isn't PII (e.g., financial data, portfolios).
     * Example: ['.portfolio-table', '#balance-widget', '[data-sensitive]']
     */
    blockSelectors?: string[];
    /**
     * CSS class name to mark elements for blocking. Any element with this class
     * will be excluded from replay. Alternative to blockSelectors.
     * Example: 'bugspotter-block'
     */
    blockClass?: string;
  };
  /**
   * In-widget deflection — before the user submits, show similar
   * existing bugs inline so they can confirm "yes, this is the same
   * as #44 (Fixed in v2.3)" and skip the duplicate submission. Opt-in;
   * defaults to disabled to preserve existing widget UX.
   *
   * When enabled, the widget calls `/api/v1/sdk/similar` with a
   * debounced title query and renders the top matches between the
   * title field and the description field. The form's input values
   * are never touched by this flow — failures (network, intelligence
   * disabled, timeout) silently render zero matches and normal
   * submission continues.
   */
  deflection?: {
    /** Enable in-widget deflection. Default: false. */
    enabled?: boolean;
    /**
     * Debounce delay in ms between title-input keystrokes and the
     * similarity probe. Default: 400. Lower values feel snappier
     * but spam the backend on every character; the backend rate-
     * limits per API key so going below ~200 is asking for 429s.
     */
    debounceMs?: number;
    /**
     * Max matches the widget will render. Hard-capped at 5 server-
     * side; this clamps below that ceiling. Default: 3.
     */
    maxMatches?: number;
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
      | 'credentials'
      | 'kazakhstan'
      | 'gdpr'
      | 'pci'
      | Array<
          | 'email'
          | 'phone'
          | 'creditcard'
          | 'ssn'
          | 'iin'
          | 'ip'
          | 'apikey'
          | 'token'
          | 'password'
          | 'custom'
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
  /**
   * Set by the widget when the user confirmed a deflection chip
   * ("yes, this is the same as #X"). Sent to the backend which
   * writes it to `bug_reports.duplicate_of` directly — bypasses the
   * intelligence pipeline's pre-file dedup grace. Backend validates
   * the canonical belongs to the same project.
   */
  deflected_to_canonical_id?: string | null;
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
export type { TransportOptions, RetryConfig } from './core/transport';
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
