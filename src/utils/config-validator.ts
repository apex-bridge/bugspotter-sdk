/**
 * Configuration Validation Utilities
 * Validates BugSpotter configuration before use
 */

import { isSecureEndpoint, InsecureEndpointError } from './url-helpers';
import type { DeduplicationConfig } from './deduplicator';

export interface ValidationContext {
  endpoint?: string;
  apiKey?: string;
}

/**
 * Validate configuration before submitting a bug report
 * @throws Error if configuration is invalid
 */
export function validateAuthConfig(context: ValidationContext): void {
  if (!context.endpoint) {
    throw new Error('No endpoint configured for bug report submission');
  }

  // SECURITY: Ensure endpoint uses HTTPS
  if (!isSecureEndpoint(context.endpoint)) {
    throw new InsecureEndpointError(context.endpoint);
  }

  if (!context.apiKey) {
    throw new Error('API key is required');
  }
}

/**
 * Validate deduplication configuration
 * @throws Error if configuration is invalid
 */
export function validateDeduplicationConfig(
  config?: DeduplicationConfig
): void {
  if (!config) {
    return; // undefined config is allowed (uses defaults)
  }

  // Validate enabled property if present
  if ('enabled' in config && typeof config.enabled !== 'boolean') {
    throw new Error('deduplication.enabled must be a boolean');
  }

  // Validate windowMs property if present
  if ('windowMs' in config) {
    if (typeof config.windowMs !== 'number') {
      throw new Error('deduplication.windowMs must be a number');
    }
    if (!Number.isFinite(config.windowMs)) {
      throw new Error('deduplication.windowMs must be a finite number');
    }
    if (config.windowMs <= 0) {
      throw new Error('deduplication.windowMs must be greater than 0');
    }
  }

  // Validate maxCacheSize property if present
  if ('maxCacheSize' in config) {
    if (typeof config.maxCacheSize !== 'number') {
      throw new Error('deduplication.maxCacheSize must be a number');
    }
    if (!Number.isFinite(config.maxCacheSize)) {
      throw new Error('deduplication.maxCacheSize must be a finite number');
    }
    if (config.maxCacheSize <= 0) {
      throw new Error('deduplication.maxCacheSize must be greater than 0');
    }
    if (!Number.isInteger(config.maxCacheSize)) {
      throw new Error('deduplication.maxCacheSize must be an integer');
    }
  }
}
