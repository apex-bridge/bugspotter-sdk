import { describe, it, expect } from 'vitest';
import { validateAuthConfig, validateDeduplicationConfig } from '../../src/utils/config-validator';

describe('validateAuthConfig', () => {
  it('should throw error when endpoint is missing', () => {
    expect(() => {
      validateAuthConfig({ apiKey: 'test'  });
    }).toThrow('No endpoint configured for bug report submission');
  });

  it('should throw error when apiKey is missing', () => {
    expect(() => {
      validateAuthConfig({ endpoint: 'https://api.example.com' });
    }).toThrow('API key is required');
  });

  it('should throw error when apiKey is missing', () => {
    expect(() => {
      validateAuthConfig({
        endpoint: 'https://api.example.com',
        apiKey: '' ,
      });
    }).toThrow('API key is required');
  });

  it('should not throw error for valid config', () => {
    expect(() => {
      validateAuthConfig({
        endpoint: 'https://api.example.com',
        apiKey: 'test-key' ,
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

  it('should allow empty config (uses defaults)', () => {
    expect(() => {
      validateDeduplicationConfig({});
    }).not.toThrow();
  });

  it('should allow valid config with all properties', () => {
    expect(() => {
      validateDeduplicationConfig({
        enabled: true,
        windowMs: 60000,
        maxCacheSize: 100,
      });
    }).not.toThrow();
  });

  describe('enabled validation', () => {
    it('should throw error when enabled is not a boolean', () => {
      expect(() => {
        validateDeduplicationConfig({ enabled: 'true' as any });
      }).toThrow('deduplication.enabled must be a boolean');
    });

    it('should accept boolean true', () => {
      expect(() => {
        validateDeduplicationConfig({ enabled: true });
      }).not.toThrow();
    });

    it('should accept boolean false', () => {
      expect(() => {
        validateDeduplicationConfig({ enabled: false });
      }).not.toThrow();
    });
  });

  describe('windowMs validation', () => {
    it('should throw error when windowMs is not a number', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: '60000' as any });
      }).toThrow('deduplication.windowMs must be a number');
    });

    it('should throw error when windowMs is zero', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: 0 });
      }).toThrow('deduplication.windowMs must be greater than 0');
    });

    it('should throw error when windowMs is negative', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: -1000 });
      }).toThrow('deduplication.windowMs must be greater than 0');
    });

    it('should throw error when windowMs is Infinity', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: Infinity });
      }).toThrow('deduplication.windowMs must be a finite number');
    });

    it('should throw error when windowMs is NaN', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: NaN });
      }).toThrow('deduplication.windowMs must be a finite number');
    });

    it('should accept valid positive windowMs', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: 30000 });
      }).not.toThrow();
    });

    it('should accept decimal windowMs', () => {
      expect(() => {
        validateDeduplicationConfig({ windowMs: 1500.5 });
      }).not.toThrow();
    });
  });

  describe('maxCacheSize validation', () => {
    it('should throw error when maxCacheSize is not a number', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: '100' as any });
      }).toThrow('deduplication.maxCacheSize must be a number');
    });

    it('should throw error when maxCacheSize is zero', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: 0 });
      }).toThrow('deduplication.maxCacheSize must be greater than 0');
    });

    it('should throw error when maxCacheSize is negative', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: -50 });
      }).toThrow('deduplication.maxCacheSize must be greater than 0');
    });

    it('should throw error when maxCacheSize is not an integer', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: 100.5 });
      }).toThrow('deduplication.maxCacheSize must be an integer');
    });

    it('should throw error when maxCacheSize is Infinity', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: Infinity });
      }).toThrow('deduplication.maxCacheSize must be a finite number');
    });

    it('should throw error when maxCacheSize is NaN', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: NaN });
      }).toThrow('deduplication.maxCacheSize must be a finite number');
    });

    it('should accept valid positive maxCacheSize', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: 50 });
      }).not.toThrow();
    });

    it('should accept maxCacheSize of 1', () => {
      expect(() => {
        validateDeduplicationConfig({ maxCacheSize: 1 });
      }).not.toThrow();
    });
  });

  describe('combined validation', () => {
    it('should validate all properties together', () => {
      expect(() => {
        validateDeduplicationConfig({
          enabled: true,
          windowMs: 45000,
          maxCacheSize: 75,
        });
      }).not.toThrow();
    });

    it('should throw first encountered error', () => {
      expect(() => {
        validateDeduplicationConfig({
          enabled: 'yes' as any,
          windowMs: -100,
          maxCacheSize: 0,
        });
      }).toThrow('deduplication.enabled must be a boolean');
    });
  });
});
