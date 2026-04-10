/**
 * PII Detection and Sanitization Utility - REFACTORED
 * Follows SOLID, DRY, and KISS principles
 */

import {
  PIIPatternName,
  DEFAULT_PATTERNS,
  getPatternsByPriority,
  PATTERN_PRESETS,
} from './sanitize-patterns';

export type PIIPattern = PIIPatternName | 'custom';

export interface CustomPattern {
  name: string;
  regex: RegExp;
  description?: string;
  examples?: string[];
  priority?: number;
}

export interface SanitizeConfig {
  enabled: boolean;
  patterns?: PIIPattern[] | keyof typeof PATTERN_PRESETS;
  customPatterns?: CustomPattern[];
  excludeSelectors?: string[];
}

// Re-export pattern utilities for convenience
export type { PIIPatternName, PatternDefinition } from './sanitize-patterns';
export {
  DEFAULT_PATTERNS,
  PATTERN_PRESETS,
  PATTERN_CATEGORIES,
  PatternBuilder,
  createPatternConfig,
  getPattern,
  getPatternsByCategory,
  validatePattern,
} from './sanitize-patterns';

/**
 * Pattern Manager - SRP: Handles pattern initialization and storage
 */
class PatternManager {
  private patterns: Map<string, RegExp> = new Map();

  constructor(
    selectedPatterns: PIIPattern[] | keyof typeof PATTERN_PRESETS,
    customPatterns: CustomPattern[]
  ) {
    this.initializePatterns(selectedPatterns, customPatterns);
  }

  private initializePatterns(
    selectedPatterns: PIIPattern[] | keyof typeof PATTERN_PRESETS,
    customPatterns: CustomPattern[]
  ): void {
    // Resolve preset to pattern names
    let patternNames: PIIPatternName[];

    if (typeof selectedPatterns === 'string') {
      // It's a preset name like 'all', 'minimal', etc.
      patternNames = PATTERN_PRESETS[selectedPatterns] as PIIPatternName[];
    } else {
      // It's an array of pattern names
      patternNames = selectedPatterns.filter((p): p is PIIPatternName => {
        return p !== 'custom';
      });
    }

    // Get pattern definitions and sort by priority
    const patternDefs = patternNames.map((name) => {
      return DEFAULT_PATTERNS[name];
    });
    const sortedPatterns = getPatternsByPriority(patternDefs);

    // Add built-in patterns in priority order
    sortedPatterns.forEach((patternDef) => {
      this.patterns.set(patternDef.name, patternDef.regex);
    });

    // Add custom patterns (convert to PatternDefinition format)
    customPatterns.forEach((custom) => {
      this.patterns.set(custom.name, custom.regex);
    });
  }

  getPatterns(): Map<string, RegExp> {
    return this.patterns;
  }
}

/**
 * String Sanitizer - SRP: Handles string-level PII detection and replacement
 */
class StringSanitizer {
  constructor(private patterns: Map<string, RegExp>) {}

  sanitize(value: string): string {
    if (typeof value !== 'string') {
      return value;
    }

    let sanitized = value;

    this.patterns.forEach((regex, name) => {
      const patternType = name.toUpperCase();
      sanitized = sanitized.replace(regex, `[REDACTED-${patternType}]`);
    });

    return sanitized;
  }
}

/**
 * Value Sanitizer - SRP: Handles recursive object/array traversal
 */
class ValueSanitizer {
  private seen = new WeakSet();

  constructor(private stringSanitizer: StringSanitizer) {}

  sanitize(value: unknown): unknown {
    // Handle null/undefined
    if (value == null) {
      return value;
    }

    // Handle strings
    if (typeof value === 'string') {
      return this.stringSanitizer.sanitize(value);
    }

    // Handle arrays (with circular reference protection)
    if (Array.isArray(value)) {
      if (this.seen.has(value)) return '[Circular]';
      this.seen.add(value);
      try {
        return value.map((item) => this.sanitize(item));
      } finally {
        this.seen.delete(value);
      }
    }

    // Handle objects (with circular reference protection)
    if (typeof value === 'object') {
      if (this.seen.has(value as object)) return '[Circular]';
      return this.sanitizeObject(value);
    }

    // Return primitives as-is
    return value;
  }

  private sanitizeObject(obj: object): Record<string, unknown> {
    this.seen.add(obj);
    try {
      const sanitized: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        const sanitizedKey = this.stringSanitizer.sanitize(key);
        sanitized[sanitizedKey] = this.sanitize(val);
      }
      return sanitized;
    } finally {
      this.seen.delete(obj);
    }
  }
}

/**
 * Element Matcher - SRP: Handles DOM element exclusion logic
 */
class ElementMatcher {
  constructor(private excludeSelectors: string[]) {}

  shouldExclude(element?: Element): boolean {
    if (!element || !this.excludeSelectors.length) {
      return false;
    }

    return this.excludeSelectors.some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });
  }
}

/**
 * Main Sanitizer - Facade pattern: Coordinates all sanitization operations
 * SOLID: Open/Closed - easily extensible without modification
 */
export class Sanitizer {
  private enabled: boolean;
  private stringSanitizer: StringSanitizer;
  private valueSanitizer: ValueSanitizer;
  private elementMatcher: ElementMatcher;

  constructor(config: SanitizeConfig) {
    this.enabled = config.enabled ?? true;

    if (!this.enabled) {
      // Create no-op implementations when disabled
      this.stringSanitizer = new StringSanitizer(new Map());
      this.valueSanitizer = new ValueSanitizer(this.stringSanitizer);
      this.elementMatcher = new ElementMatcher([]);
      return;
    }

    // Default to 'all' preset if no patterns specified
    const selectedPatterns = config.patterns ?? 'all';
    const customPatterns = config.customPatterns ?? [];
    const excludeSelectors = config.excludeSelectors ?? [];

    const patternManager = new PatternManager(selectedPatterns, customPatterns);
    this.stringSanitizer = new StringSanitizer(patternManager.getPatterns());
    this.valueSanitizer = new ValueSanitizer(this.stringSanitizer);
    this.elementMatcher = new ElementMatcher(excludeSelectors);
  }

  /**
   * Guard clause helper - DRY principle
   */
  private guardDisabled<T>(value: T): T | undefined {
    return this.enabled ? undefined : value;
  }

  /**
   * Sanitize any value (string, object, array, etc.)
   */
  public sanitize(value: unknown): unknown {
    const guarded = this.guardDisabled(value);
    if (guarded !== undefined) {
      return guarded;
    }

    return this.valueSanitizer.sanitize(value);
  }

  /**
   * Sanitize console arguments - KISS: delegates to generic sanitize
   */
  public sanitizeConsoleArgs(args: unknown[]): unknown[] {
    const guarded = this.guardDisabled(args);
    if (guarded !== undefined) {
      return guarded;
    }

    return args.map((arg) => {
      return this.sanitize(arg);
    });
  }

  /**
   * Sanitize network data - KISS: uses generic sanitize with type safety
   */
  public sanitizeNetworkData<T extends Record<string, unknown>>(data: T): T {
    const guarded = this.guardDisabled(data);
    if (guarded !== undefined) {
      return guarded;
    }

    return this.sanitize(data) as T;
  }

  /**
   * Sanitize error - KISS: uses generic sanitize with type safety
   */
  public sanitizeError<
    T extends { message?: string; stack?: string; [key: string]: unknown },
  >(error: T): T {
    const guarded = this.guardDisabled(error);
    if (guarded !== undefined) {
      return guarded;
    }

    return this.sanitize(error) as T;
  }

  /**
   * Check if element should be excluded
   */
  public shouldExclude(element: Element): boolean {
    if (!this.enabled) {
      return false;
    }
    return this.elementMatcher.shouldExclude(element);
  }

  /**
   * Sanitize DOM text node
   */
  public sanitizeTextNode(text: string, element?: Element): string {
    const guarded = this.guardDisabled(text);
    if (guarded !== undefined) {
      return guarded;
    }

    if (this.elementMatcher.shouldExclude(element)) {
      return text;
    }

    return this.stringSanitizer.sanitize(text);
  }

  /**
   * Detect PII patterns in text without sanitizing
   * Returns a map of pattern names to match counts
   */
  public detectPII(text: string): Map<string, number> {
    const detections = new Map<string, number>();

    if (!this.enabled || !text) {
      return detections;
    }

    for (const [name, regex] of this.stringSanitizer['patterns']) {
      const matches = text.match(new RegExp(regex, 'g'));
      if (matches && matches.length > 0) {
        detections.set(name, matches.length);
      }
    }

    return detections;
  }
}

/**
 * Factory function to create a Sanitizer instance
 */
export function createSanitizer(config: SanitizeConfig): Sanitizer {
  return new Sanitizer(config);
}
