import { describe, it, expect, beforeEach } from 'vitest';
import { Sanitizer, createSanitizer } from '../../src/utils/sanitize';

describe('Sanitizer', () => {
  let sanitizer: Sanitizer;

  beforeEach(() => {
    sanitizer = createSanitizer({ enabled: true });
  });

  describe('Email Detection', () => {
    it('should sanitize email addresses', () => {
      const input = 'Contact us at support@bugspotter.com for help';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Contact us at [REDACTED-EMAIL] for help');
    });

    it('should sanitize multiple email addresses', () => {
      const input = 'Emails: user@test.com and admin@example.org';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Emails: [REDACTED-EMAIL] and [REDACTED-EMAIL]');
    });

    it('should handle email addresses with special characters', () => {
      const input = 'Email: user+tag@sub.domain.com';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Email: [REDACTED-EMAIL]');
    });
  });

  describe('Phone Number Detection', () => {
    it('should sanitize US phone numbers', () => {
      const input = 'Call us at +1-555-123-4567';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Call us at [REDACTED-PHONE]');
    });

    it('should sanitize international phone numbers', () => {
      const input = 'Numbers: +7 777 123 4567 or +44 20 1234 5678';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-PHONE]');
    });

    it('should sanitize Kazakhstan phone numbers', () => {
      const input = 'Call +7 777 999 8877 in Kazakhstan';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-PHONE]');
    });

    it('should sanitize phone numbers with parentheses', () => {
      const input = 'Phone: (555) 123-4567';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-PHONE]');
    });
  });

  describe('Credit Card Detection', () => {
    it('should sanitize Visa card numbers', () => {
      const input = 'Card: 4532-1488-0343-6467';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Card: [REDACTED-CREDITCARD]');
    });

    it('should sanitize card numbers without dashes', () => {
      const input = 'Card: 4532148803436467';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Card: [REDACTED-CREDITCARD]');
    });

    it('should sanitize Mastercard numbers', () => {
      const input = 'MC: 5425 2334 3010 9903';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('MC: [REDACTED-CREDITCARD]');
    });

    it('should sanitize American Express numbers', () => {
      const input = 'Amex: 3782 822463 10005';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Amex: [REDACTED-CREDITCARD]');
    });
  });

  describe('SSN Detection', () => {
    it('should sanitize SSN with dashes', () => {
      const input = 'SSN: 123-45-6789';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('SSN: [REDACTED-SSN]');
    });

    it('should sanitize SSN without dashes', () => {
      const input = 'SSN: 987654321';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('SSN: [REDACTED-SSN]');
    });
  });

  describe('Kazakhstan IIN/BIN Detection', () => {
    it('should sanitize valid IIN numbers', () => {
      const input = 'IIN: 950315300123'; // Valid date format: 95-03-15
      const output = sanitizer.sanitize(input);
      expect(output).toBe('IIN: [REDACTED-IIN]');
    });

    it('should sanitize IIN with birth date pattern', () => {
      const input = 'Citizen IIN: 890520401234'; // 89-05-20
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Citizen IIN: [REDACTED-IIN]');
    });

    it('should not sanitize invalid IIN (invalid date)', () => {
      const input = 'Invalid: 201301123456'; // 20-13-01 (invalid month - month 13 doesn't exist)
      const output = sanitizer.sanitize(input);
      expect(output).toBe(input); // Should not match IIN pattern
    });

    it('should sanitize multiple IINs', () => {
      const input = 'IINs: 950315300123 and 880612500456';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('IINs: [REDACTED-IIN] and [REDACTED-IIN]');
    });
  });

  describe('IP Address Detection', () => {
    it('should sanitize IPv4 addresses', () => {
      const input = 'Server IP: 192.168.1.100';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Server IP: [REDACTED-IP]');
    });

    it('should sanitize localhost addresses', () => {
      const input = 'Local: 127.0.0.1';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('Local: [REDACTED-IP]');
    });

    it('should sanitize IPv6 addresses', () => {
      const input = 'IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      const output = sanitizer.sanitize(input);
      expect(output).toBe('IPv6: [REDACTED-IP]');
    });
  });

  describe('Custom Patterns', () => {
    it('should support custom regex patterns', () => {
      const customSanitizer = createSanitizer({
        enabled: true,
        patterns: ['custom'],
        customPatterns: [
          { name: 'api-key', regex: /(?:API[-_]?KEY[-_:]?\s*[\w-]{20,})/gi },
        ],
      });

      const input = 'API_KEY: abcd1234efgh5678ijkl';
      const output = customSanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-API-KEY]');
    });

    it('should support multiple custom patterns', () => {
      const customSanitizer = createSanitizer({
        enabled: true,
        patterns: ['custom'],
        customPatterns: [
          { name: 'token', regex: /TOKEN[-_:]?\s*[\w-]{16,}/gi },
          { name: 'secret', regex: /SECRET[-_:]?\s*[\w-]{16,}/gi },
        ],
      });

      const input = 'TOKEN: abc123def456ghi7 and SECRET: xyz789uvw123rst4';
      const output = customSanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-TOKEN]');
      expect(output).toContain('[REDACTED-SECRET]');
    });
  });

  describe('Cyrillic Text Support', () => {
    it('should handle Russian text correctly', () => {
      const input = 'Email: user@example.com в России';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('в России'); // Cyrillic text preserved
    });

    it('should handle Kazakh text correctly', () => {
      const input = 'Қазақстан телефон: +7 777 123 4567';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-PHONE]');
      expect(output).toContain('Қазақстан'); // Kazakh text preserved
    });

    it('should sanitize PII in mixed Cyrillic content', () => {
      const input = 'Адрес эл. почты: admin@test.kz и телефон +7-701-555-1234';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('[REDACTED-PHONE]');
    });
  });

  describe('Nested Object Sanitization', () => {
    it('should sanitize nested objects', () => {
      const input = {
        user: {
          email: 'user@example.com',
          phone: '+1-555-123-4567',
        },
        metadata: {
          ip: '192.168.1.1',
        },
      };

      const output = sanitizer.sanitize(input) as typeof input;
      expect(output.user.email).toBe('[REDACTED-EMAIL]');
      expect(output.user.phone).toContain('[REDACTED-PHONE]');
      expect(output.metadata.ip).toBe('[REDACTED-IP]');
    });

    it('should sanitize arrays of objects', () => {
      const input = [{ email: 'user1@test.com' }, { email: 'user2@test.com' }];

      const output = sanitizer.sanitize(input) as typeof input;
      expect(output[0].email).toBe('[REDACTED-EMAIL]');
      expect(output[1].email).toBe('[REDACTED-EMAIL]');
    });

    it('should handle deeply nested structures', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              ssn: '123-45-6789',
              data: ['email@test.com', 'text'],
            },
          },
        },
      };

      const output = sanitizer.sanitize(input) as typeof input;
      expect(output.level1.level2.level3.ssn).toBe('[REDACTED-SSN]');
      expect(output.level1.level2.level3.data[0]).toBe('[REDACTED-EMAIL]');
      expect(output.level1.level2.level3.data[1]).toBe('text');
    });
  });

  describe('Console Args Sanitization', () => {
    it('should sanitize console arguments', () => {
      const args = ['User email:', 'admin@test.com', { phone: '+1-555-0000' }];
      const output = sanitizer.sanitizeConsoleArgs(args);

      expect(output[0]).toBe('User email:');
      expect(output[1]).toBe('[REDACTED-EMAIL]');
      expect((output[2] as { phone: string }).phone).toContain(
        '[REDACTED-PHONE]'
      );
    });

    it('should handle mixed argument types', () => {
      const args = [123, 'email@test.com', true, null, undefined];
      const output = sanitizer.sanitizeConsoleArgs(args);

      expect(output[0]).toBe(123);
      expect(output[1]).toBe('[REDACTED-EMAIL]');
      expect(output[2]).toBe(true);
      expect(output[3]).toBe(null);
      expect(output[4]).toBe(undefined);
    });
  });

  describe('Network Data Sanitization', () => {
    it('should sanitize network request data', () => {
      const data = {
        url: 'https://api.example.com/users/user@test.com',
        method: 'POST',
        body: { email: 'admin@test.com', phone: '+1-555-1234' },
        status: 200,
      };

      const output = sanitizer.sanitizeNetworkData(data);
      expect(output.url).toContain('[REDACTED-EMAIL]');
      expect((output.body as typeof data.body).email).toBe('[REDACTED-EMAIL]');
      expect((output.body as typeof data.body).phone).toContain(
        '[REDACTED-PHONE]'
      );
    });

    it('should sanitize headers with sensitive data', () => {
      const data = {
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer token-with-email@test.com',
        },
      };

      const output = sanitizer.sanitizeNetworkData(data);
      expect(output.headers?.['Authorization']).toContain('[REDACTED-EMAIL]');
    });

    it('should sanitize error messages', () => {
      const data = {
        url: 'https://api.example.com',
        error: 'Failed to send to user@test.com',
      };

      const output = sanitizer.sanitizeNetworkData(data);
      expect(output.error).toBe('Failed to send to [REDACTED-EMAIL]');
    });
  });

  describe('Error Sanitization', () => {
    it('should sanitize error messages', () => {
      const error = {
        message: 'Invalid email: user@test.com',
        stack: 'Error at processUser (user@test.com)',
      };

      const output = sanitizer.sanitizeError(error);
      expect(output.message).toBe('Invalid email: [REDACTED-EMAIL]');
      expect(output.stack).toContain('[REDACTED-EMAIL]');
    });

    it('should sanitize custom error properties', () => {
      const error = {
        message: 'Error',
        details: {
          user: { email: 'admin@test.com', ssn: '123-45-6789' },
        },
      };

      const output = sanitizer.sanitizeError(error);
      expect((output.details as typeof error.details).user.email).toBe(
        '[REDACTED-EMAIL]'
      );
      expect((output.details as typeof error.details).user.ssn).toBe(
        '[REDACTED-SSN]'
      );
    });
  });

  describe('DOM Text Node Sanitization', () => {
    it('should sanitize text nodes', () => {
      const text = 'Contact: user@test.com or call +1-555-1234';
      const output = sanitizer.sanitizeTextNode(text);

      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('[REDACTED-PHONE]');
    });

    it('should respect exclude selectors', () => {
      const excludeSanitizer = createSanitizer({
        enabled: true,
        excludeSelectors: ['.public-email'],
      });

      // Create a mock element
      const div = document.createElement('div');
      div.className = 'public-email';

      const text = 'public@test.com';
      const output = excludeSanitizer.sanitizeTextNode(text, div);

      expect(output).toBe(text); // Should not sanitize
    });

    it('should sanitize non-excluded elements', () => {
      const excludeSanitizer = createSanitizer({
        enabled: true,
        excludeSelectors: ['.public-email'],
      });

      const div = document.createElement('div');
      div.className = 'private-data';

      const text = 'private@test.com';
      const output = excludeSanitizer.sanitizeTextNode(text, div);

      expect(output).toBe('[REDACTED-EMAIL]');
    });
  });

  describe('Pattern Selection', () => {
    it('should only apply selected patterns', () => {
      const emailOnlySanitizer = createSanitizer({
        enabled: true,
        patterns: ['email'],
      });

      const input = 'Email: user@test.com Phone: +1-555-1234';
      const output = emailOnlySanitizer.sanitize(input);

      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('+1-555-1234'); // Phone should not be sanitized
    });

    it('should apply multiple selected patterns', () => {
      const multiSanitizer = createSanitizer({
        enabled: true,
        patterns: ['email', 'ssn'],
      });

      const input = 'Email: user@test.com SSN: 123-45-6789 Phone: +1-555-1234';
      const output = multiSanitizer.sanitize(input);

      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('[REDACTED-SSN]');
      expect(output).toContain('+1-555-1234'); // Phone should not be sanitized
    });
  });

  describe('Disabled Sanitization', () => {
    it('should not sanitize when disabled', () => {
      const disabledSanitizer = createSanitizer({ enabled: false });

      const input = 'Email: user@test.com Phone: +1-555-1234';
      const output = disabledSanitizer.sanitize(input);

      expect(output).toBe(input); // No changes
    });
  });

  describe('Performance', () => {
    it('should sanitize large objects efficiently', () => {
      const largeObject = {
        users: Array.from({ length: 100 }, (_, i) => {
          return {
            id: i,
            email: `user${i}@test.com`,
            phone: `+1-555-${String(i).padStart(4, '0')}`,
          };
        }),
      };

      const startTime = performance.now();
      const output = sanitizer.sanitize(largeObject);
      const duration = performance.now() - startTime;

      expect(duration).toBeLessThan(50); // Should complete in <50ms

      const users = (output as typeof largeObject).users;
      expect(users[0].email).toBe('[REDACTED-EMAIL]');
      expect(users[50].email).toBe('[REDACTED-EMAIL]');
    });

    it('should sanitize long strings efficiently', () => {
      const longString =
        'Contact info: ' +
        Array.from({ length: 100 }, (_, i) => {
          return `user${i}@test.com`;
        }).join(', ');

      const startTime = performance.now();
      const output = sanitizer.sanitize(longString);
      const duration = performance.now() - startTime;

      expect(duration).toBeLessThan(10); // Should complete in <10ms
      expect(output).toContain('[REDACTED-EMAIL]');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined', () => {
      expect(sanitizer.sanitize(null)).toBe(null);
      expect(sanitizer.sanitize(undefined)).toBe(undefined);
    });

    it('should handle empty strings', () => {
      expect(sanitizer.sanitize('')).toBe('');
    });

    it('should handle numbers', () => {
      expect(sanitizer.sanitize(123)).toBe(123);
      expect(sanitizer.sanitize(45.67)).toBe(45.67);
    });

    it('should handle booleans', () => {
      expect(sanitizer.sanitize(true)).toBe(true);
      expect(sanitizer.sanitize(false)).toBe(false);
    });

    it('should handle empty objects', () => {
      expect(sanitizer.sanitize({})).toEqual({});
    });

    it('should handle empty arrays', () => {
      expect(sanitizer.sanitize([])).toEqual([]);
    });

    it('should handle special characters in text', () => {
      const input = 'Email: <user@test.com> & phone: "+1-555-1234"';
      const output = sanitizer.sanitize(input);
      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('[REDACTED-PHONE]');
    });
  });

  describe('Multiple PII in Same String', () => {
    it('should sanitize multiple PII types in one string', () => {
      const input =
        'User: email@test.com, SSN: 123-45-6789, Card: 4532-1488-0343-6467, IP: 192.168.1.1';
      const output = sanitizer.sanitize(input);

      expect(output).toContain('[REDACTED-EMAIL]');
      expect(output).toContain('[REDACTED-SSN]');
      expect(output).toContain('[REDACTED-CREDITCARD]');
      expect(output).toContain('[REDACTED-IP]');
    });

    it('should preserve context around sanitized data', () => {
      const input = 'Please contact admin@test.com for access';
      const output = sanitizer.sanitize(input);

      expect(output).toBe('Please contact [REDACTED-EMAIL] for access');
    });
  });

  describe('Circular Reference Protection', () => {
    it('should handle circular object references without throwing', () => {
      const obj: Record<string, unknown> = { name: 'test@example.com' };
      obj.self = obj;

      const result = sanitizer.sanitize(obj) as Record<string, unknown>;
      expect(result.name).toBe('[REDACTED-EMAIL]');
      expect(result.self).toBe('[Circular]');
    });

    it('should handle circular array references without throwing', () => {
      const arr: unknown[] = ['test@example.com'];
      arr.push(arr);

      const result = sanitizer.sanitize(arr) as unknown[];
      expect(result[0]).toBe('[REDACTED-EMAIL]');
      expect(result[1]).toBe('[Circular]');
    });

    it('should sanitize correctly after encountering circular reference', () => {
      // First call with circular ref
      const circular: Record<string, unknown> = { email: 'a@b.com' };
      circular.self = circular;
      sanitizer.sanitize(circular);

      // Second call should still work (seen set cleaned up)
      const normal = { email: 'c@d.com' };
      const result = sanitizer.sanitize(normal) as Record<string, unknown>;
      expect(result.email).toBe('[REDACTED-EMAIL]');
    });
  });
});
