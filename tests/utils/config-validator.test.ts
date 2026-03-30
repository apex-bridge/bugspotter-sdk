import { describe, it, expect } from 'vitest';
import { validateAuthConfig, validateDeduplicationConfig } from '../../src/utils/config-validator';

describe('validateAuthConfig', () => {
  it('should throw error when endpoint is missing', () => {
    expect(() => {
      validateAuthConfig({ auth: { apiKey: 'test' } });
    }).toThrow('No endpoint configured for bug report submission');
  });

  it('should throw error when auth is missing', () => {
    expect(() => {
      validateAuthConfig({ endpoint: 'https://api.example.com' });
    }).toThrow('API key authentication is required');
  });

  it('should throw error when apiKey is missing', () => {
    expect(() => {
      validateAuthConfig({
        endpoint: 'https://api.example.com',
        auth: { apiKey: '' } as any,
      });
    }).toThrow('API key is required in auth configuration');
  });

  it('should not throw error for valid config', () => {
    expect(() => {
      validateAuthConfig({
        endpoint: 'https://api.example.com',
        auth: { apiKey: 'test-key' },
      });
    }).not.toThrow();
  });
});

describe('validateDeduplicationConfig', () => {
  it('should allow undefined config (uses defaults)', () => {
    expect(() => {
      validateDeduplicationConfig(undefined);
    }).not.toThrow();
  });

  it('should validate enabled property', () => {
    expect(() => {
      validateDeduplicationConfig({ enabled: 'yes' } as any);
    }).toThrow('deduplication.enabled must be a boolean');
  });

  it('should validate windowMs property', () => {
    expect(() => {
      validateDeduplicationConfig({ windowMs: -1 });
    }).toThrow('deduplication.windowMs must be greater than 0');
  });

  it('should validate maxCacheSize property', () => {
    expect(() => {
      validateDeduplicationConfig({ maxCacheSize: 0 });
    }).toThrow('deduplication.maxCacheSize must be greater than 0');
  });

  it('should accept valid config', () => {
    expect(() => {
      validateDeduplicationConfig({ enabled: true, windowMs: 5000, maxCacheSize: 100 });
    }).not.toThrow();
  });
});
