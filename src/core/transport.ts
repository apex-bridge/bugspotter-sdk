/**
 * Transport layer for bug report submission with flexible authentication,
 * exponential backoff retry, and offline queue support
 */

import { getLogger, type Logger } from '../utils/logger';
import { OfflineQueue, type OfflineConfig } from './offline-queue';
import { isSecureEndpoint, InsecureEndpointError } from '../utils/url-helpers';

// ============================================================================
// CONSTANTS
// ============================================================================

const JITTER_PERCENTAGE = 0.1;

// ============================================================================
// CUSTOM ERROR TYPES
// ============================================================================

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Authentication error - not retryable
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Authentication configuration - API key only.
 * The API key is scoped to specific projects server-side.
 */
export type AuthConfig = {
  apiKey: string;
};

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay?: number;
  /** HTTP status codes to retry on (default: [502, 503, 504, 429]) */
  retryOn?: number[];
}

export interface TransportOptions {
  /** Authentication configuration (required) */
  auth: AuthConfig;
  /** Optional logger for debugging */
  logger?: Logger;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Offline queue configuration */
  offline?: OfflineConfig;
}

// Default configurations
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryOn: [502, 503, 504, 429],
};

const DEFAULT_OFFLINE_CONFIG: Required<OfflineConfig> = {
  enabled: false,
  maxQueueSize: 10,
};

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Generate authentication headers for API key
 */
function generateAuthHeaders(config: AuthConfig): Record<string, string> {
  if (!config || !config.apiKey) {
    throw new AuthenticationError(
      'Authentication is required: API key must be provided'
    );
  }
  return { 'X-API-Key': config.apiKey };
}

// ============================================================================
// RETRY HANDLER - Exponential Backoff Logic
// ============================================================================

class RetryHandler {
  constructor(
    private config: Required<RetryConfig>,
    private logger: Logger
  ) {}

  /**
   * Execute operation with exponential backoff retry
   */
  async executeWithRetry(
    operation: () => Promise<Response>,
    shouldRetryStatus: (status: number) => boolean
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await operation();

        // Check if we should retry based on status code
        if (
          shouldRetryStatus(response.status) &&
          attempt < this.config.maxRetries
        ) {
          const delay = this.calculateDelay(attempt, response);
          this.logger.warn(
            `Request failed with status ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`
          );
          await sleep(delay);
          continue;
        }

        // Success or non-retryable status
        return response;
      } catch (error) {
        lastError = error as Error;

        // Don't retry authentication errors - they won't succeed on retry
        if (error instanceof AuthenticationError) {
          throw error;
        }

        // Retry on network errors
        if (attempt < this.config.maxRetries) {
          const delay = this.calculateDelay(attempt);
          this.logger.warn(
            `Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries}):`,
            error
          );
          await sleep(delay);
          continue;
        }
      }
    }

    // All retries exhausted
    throw lastError || new Error('Request failed after all retry attempts');
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number, response?: Response): number {
    // Check for Retry-After header
    const retryAfter = response?.headers?.get?.('Retry-After');
    if (retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter, 10);

      if (!isNaN(retryAfterSeconds)) {
        return Math.min(retryAfterSeconds * 1000, this.config.maxDelay);
      }
    }

    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = this.config.baseDelay * Math.pow(2, attempt);

    // Add jitter: ±10% randomization
    const jitter =
      exponentialDelay * JITTER_PERCENTAGE * (Math.random() * 2 - 1);
    const delayWithJitter = exponentialDelay + jitter;

    // Cap at maxDelay
    return Math.min(delayWithJitter, this.config.maxDelay);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Process offline queue in background
 */
async function processQueueInBackground(
  offlineConfig: Required<OfflineConfig>,
  retryConfig: Required<RetryConfig>,
  auth: AuthConfig,
  logger: Logger
): Promise<void> {
  if (!offlineConfig.enabled) {
    return;
  }

  const queue = new OfflineQueue(offlineConfig, logger);
  const authHeaders = generateAuthHeaders(auth);
  queue
    .processWithAuth(retryConfig.retryOn, authHeaders)
    .catch((error: unknown) => {
      logger.warn('Failed to process offline queue:', error);
    });
}

/**
 * Handle offline failure by queueing request
 * SECURITY: Does not pass auth headers to queue - they will be regenerated when processing
 */
async function handleOfflineFailure(
  error: unknown,
  endpoint: string,
  body: BodyInit,
  contentHeaders: Record<string, string>,
  _auth: AuthConfig,
  offlineConfig: Required<OfflineConfig>,
  logger: Logger
): Promise<void> {
  if (!offlineConfig.enabled || !isNetworkError(error)) {
    return;
  }

  logger.warn('Network error detected, queueing request for offline retry');
  const queue = new OfflineQueue(offlineConfig, logger);
  // SECURITY: Only pass content headers, not auth headers - auth will be regenerated when processing
  await queue.enqueue(endpoint, body, contentHeaders);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get authentication headers based on configuration
 * @param auth - Authentication configuration
 * @returns HTTP headers for authentication
 */
export function getAuthHeaders(auth: AuthConfig): Record<string, string> {
  return generateAuthHeaders(auth);
}

/**
 * Submit request with authentication, exponential backoff retry, and offline queue support
 *
 * @param endpoint - API endpoint URL
 * @param body - Request body (must be serializable for retry)
 * @param contentHeaders - Content-related headers (Content-Type, etc.)
 * @param authOrOptions - Auth config or TransportOptions
 * @returns Response from the server
 */
export async function submitWithAuth(
  endpoint: string,
  body: BodyInit,
  contentHeaders: Record<string, string> = {},
  options: TransportOptions
): Promise<Response> {
  const logger = options.logger || getLogger();
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retry };
  const offlineConfig = { ...DEFAULT_OFFLINE_CONFIG, ...options.offline };

  // Security: Enforce HTTPS
  if (!isSecureEndpoint(endpoint)) {
    throw new InsecureEndpointError(endpoint);
  }

  // Process offline queue on each request (run in background without awaiting)
  processQueueInBackground(offlineConfig, retryConfig, options.auth, logger);

  try {
    // Send with retry logic
    const response = await sendWithRetry(
      endpoint,
      body,
      contentHeaders,
      options.auth,
      retryConfig,
      logger
    );

    return response;
  } catch (error) {
    // Queue for offline retry if enabled
    await handleOfflineFailure(
      error,
      endpoint,
      body,
      contentHeaders,
      options.auth,
      offlineConfig,
      logger
    );
    throw error;
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Make HTTP request with auth headers
 */
async function makeRequest(
  endpoint: string,
  body: BodyInit,
  contentHeaders: Record<string, string>,
  auth: AuthConfig
): Promise<Response> {
  if (!isSecureEndpoint(endpoint)) {
    throw new InsecureEndpointError(endpoint);
  }

  const authHeaders = generateAuthHeaders(auth);
  const headers = { ...contentHeaders, ...authHeaders };

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body,
  });
}

/**
 * Send request with exponential backoff retry
 */
async function sendWithRetry(
  endpoint: string,
  body: BodyInit,
  contentHeaders: Record<string, string>,
  auth: AuthConfig,
  retryConfig: Required<RetryConfig>,
  logger: Logger
): Promise<Response> {
  const retryHandler = new RetryHandler(retryConfig, logger);

  return retryHandler.executeWithRetry(
    async () => makeRequest(endpoint, body, contentHeaders, auth),
    (status) => retryConfig.retryOn.includes(status)
  );
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is a network error (more specific to avoid false positives)
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Check for specific network error patterns
  return (
    // Standard fetch network errors
    message.includes('failed to fetch') ||
    message.includes('network request failed') ||
    message.includes('networkerror') ||
    // Connection issues
    message.includes('network error') ||
    message.includes('connection') ||
    // Timeout errors
    message.includes('timeout') ||
    // Standard error names
    error.name === 'NetworkError' ||
    error.name === 'AbortError' ||
    // TypeError only if it mentions fetch or network
    (error.name === 'TypeError' &&
      (message.includes('fetch') || message.includes('network')))
  );
}

// Re-export offline queue utilities
export { clearOfflineQueue, type OfflineConfig } from './offline-queue';
