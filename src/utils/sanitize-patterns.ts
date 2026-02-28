/**
 * PII Pattern Definitions
 * Re-exports from @bugspotter/common + SDK-specific extensions
 */

// Re-export everything from @bugspotter/common
export {
  type PIIPatternName,
  type PatternDefinition,
  type PatternPresetName,
  DEFAULT_PATTERNS,
  PATTERN_CATEGORIES,
  PATTERN_PRESETS,
  getAllPatternNames,
  getPatternsByPriority,
  getPatternsByPreset,
  createPatternConfig,
  validatePattern,
} from '@bugspotter/common';

import {
  type PIIPatternName,
  type PatternDefinition,
  DEFAULT_PATTERNS,
  PATTERN_CATEGORIES,
  getPatternsByPriority,
} from '@bugspotter/common';

// SDK-specific extensions

/**
 * Get pattern by name
 */
export function getPattern(name: PIIPatternName): PatternDefinition {
  return DEFAULT_PATTERNS[name];
}

/**
 * Get patterns by category
 */
export function getPatternsByCategory(
  category: keyof typeof PATTERN_CATEGORIES
): PatternDefinition[] {
  return PATTERN_CATEGORIES[category].map((name) => {
    return DEFAULT_PATTERNS[name];
  });
}

/**
 * Custom pattern builder for advanced use cases
 */
export class PatternBuilder {
  private pattern: Partial<PatternDefinition> = {};

  name(name: string): this {
    this.pattern.name = name as PIIPatternName;
    return this;
  }

  regex(regex: RegExp): this {
    if (!regex.global) {
      const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
      this.pattern.regex = new RegExp(regex.source, flags);
    } else {
      this.pattern.regex = regex;
    }
    return this;
  }

  description(description: string): this {
    this.pattern.description = description;
    return this;
  }

  examples(examples: string[]): this {
    this.pattern.examples = examples;
    return this;
  }

  priority(priority: number): this {
    this.pattern.priority = priority;
    return this;
  }

  build(): PatternDefinition {
    if (!this.pattern.name || !this.pattern.regex) {
      throw new Error('Pattern must have at least name and regex');
    }

    return {
      name: this.pattern.name,
      regex: this.pattern.regex,
      description: this.pattern.description || this.pattern.name,
      examples: this.pattern.examples || [],
      priority: this.pattern.priority ?? 99,
    };
  }
}

/**
 * Merge pattern configurations
 */
export function mergePatternConfigs(
  ...configs: PatternDefinition[][]
): PatternDefinition[] {
  const merged = new Map<string, PatternDefinition>();

  configs.forEach((config) => {
    config.forEach((pattern) => {
      merged.set(pattern.name, pattern);
    });
  });

  return getPatternsByPriority([...merged.values()]);
}
