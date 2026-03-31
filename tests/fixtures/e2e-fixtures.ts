/**
 * E2E Test Fixtures: Extended PII data for comprehensive testing
 * Covers various scenarios for sanitization, compression, and submission
 */

export const E2E_PII_DATA = {
  // Personal Information
  emails: [
    'john.doe@example.com',
    'alice.smith+tag@company.co.uk',
    'support@bugspotter.io',
    'user.name_123@test-domain.com',
  ],
  phones: [
    '+1 (555) 123-4567',
    '+44 20 7123 4567',
    '555-1234',
    '+1-800-HELP-NOW',
    '(800) 555-0199',
  ],
  ssns: ['123-45-6789', '987-65-4321', '111-22-3333'],
  iins: [
    '940825123456', // Kazakhstan IIN
    '820415789012',
    '751230654321',
  ],

  // Financial Information
  creditCards: [
    '4532-1234-5678-9010', // Visa
    '5425-2334-3010-9903', // Mastercard
    '3782-822463-10005', // Amex
    '6011-1111-1111-1117', // Discover
  ],

  // Network & Security
  ipAddresses: ['192.168.1.100', '10.0.0.42', '172.16.0.1', '8.8.8.8'],
  apiKeys: [
    'test_key_fake_1234567890abcdef',
    'test_key_fake_abcdef1234567890',
    'API_KEY_123456789ABCDEF',
    'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
  ],
  authTokens: [
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ],

  // Addresses
  addresses: [
    '123 Main Street, Apt 4B, New York, NY 10001',
    '456 Oak Avenue, San Francisco, CA 94102',
    '789 Elm Road, Austin, TX 78701',
  ],
};

/**
 * Screenshot fixture data (base64 encoded 1x1 pixel images with metadata)
 */
export const SCREENSHOT_FIXTURES = {
  // Simple transparent PNG
  transparent:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',

  // Red pixel (represents PII-containing screenshot)
  withPII:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',

  // Large screenshot representation (repeated pattern to simulate size)
  large:
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='.repeat(
      100
    ),
};

/**
 * Console logs with various PII patterns
 */
export const E2E_CONSOLE_LOGS = [
  {
    level: 'log' as const,
    message: 'User login successful: john.doe@example.com',
    timestamp: Date.now(),
  },
  {
    level: 'error' as const,
    message: 'Payment failed for card 4532-1234-5678-9010',
    timestamp: Date.now() + 100,
    stack:
      'Error: Payment declined\n    at processPayment (checkout.js:42)\n    at submitForm (app.js:156)',
  },
  {
    level: 'warn' as const,
    message: 'Suspicious activity from IP 192.168.1.100',
    timestamp: Date.now() + 200,
  },
  {
    level: 'log' as const,
    message: 'API request with key: test_key_fake_abcdef1234567890',
    timestamp: Date.now() + 300,
  },
  {
    level: 'info' as const,
    message:
      'User data: {"email":"alice.smith@company.com","phone":"+1-555-123-4567","ssn":"123-45-6789"}',
    timestamp: Date.now() + 400,
  },
  {
    level: 'debug' as const,
    message:
      'Token refresh: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123',
    timestamp: Date.now() + 500,
  },
];

/**
 * Network requests with auth tokens and sensitive data
 */
export const E2E_NETWORK_REQUESTS = [
  {
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    duration: 150,
    timestamp: Date.now(),
    headers: {
      Authorization:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
      'X-API-Key': 'test_key_fake_1234567890abcdef',
    },
  },
  {
    url: 'https://api.example.com/payment',
    method: 'POST',
    status: 201,
    duration: 320,
    timestamp: Date.now() + 1000,
    body: {
      card: '4532-1234-5678-9010',
      cvv: '123',
      email: 'customer@example.com',
    },
  },
  {
    url: 'https://api.example.com/profile',
    method: 'PUT',
    status: 200,
    duration: 180,
    timestamp: Date.now() + 2000,
    body: {
      email: 'updated@example.com',
      phone: '+1-555-123-4567',
      ssn: '123-45-6789',
    },
  },
  {
    url: 'https://api.example.com/error',
    method: 'GET',
    status: 500,
    duration: 50,
    timestamp: Date.now() + 3000,
    error:
      'Internal Server Error: Database connection failed for user_id=12345 at IP 10.0.0.42',
  },
];

/**
 * Large payload for compression testing
 */
export function generateLargePayload(sizeInKB: number = 500): string {
  const chunk = JSON.stringify({
    id: Math.random(),
    email: 'user@example.com',
    phone: '+1-555-123-4567',
    data: 'x'.repeat(100),
    timestamp: Date.now(),
  });

  const repetitions = Math.ceil((sizeInKB * 1024) / chunk.length);
  const items = Array(repetitions).fill(chunk);

  return JSON.stringify(items);
}

/**
 * Mock backend response templates
 */
export const MOCK_BACKEND_RESPONSES = {
  success: {
    status: 200,
    body: {
      success: true,
      data: {
        id: 'bug-123',
        title: 'Test Bug',
        status: 'open',
        created_at: new Date().toISOString(),
        presignedUrls: {
          screenshot: {
            uploadUrl: 'https://s3.example.com/presigned-screenshot',
            storageKey: 'screenshots/test-key',
          },
          replay: {
            uploadUrl: 'https://s3.example.com/presigned-replay',
            storageKey: 'replays/test-key',
          },
        },
      },
      message: 'Bug report submitted successfully',
      timestamp: Date.now(),
    },
  },
  created: {
    status: 201,
    body: {
      success: true,
      data: {
        id: 'bug-456',
        title: 'Test Bug',
        status: 'open',
        created_at: new Date().toISOString(),
        presignedUrls: {
          screenshot: {
            uploadUrl: 'https://s3.example.com/presigned-screenshot',
            storageKey: 'screenshots/test-key',
          },
          replay: {
            uploadUrl: 'https://s3.example.com/presigned-replay',
            storageKey: 'replays/test-key',
          },
        },
      },
      timestamp: Date.now(),
    },
  },
  unauthorized: {
    status: 401,
    body: {
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired API key',
    },
  },
  badRequest: {
    status: 400,
    body: {
      success: false,
      error: 'Bad Request',
      message: 'Invalid payload structure',
      errors: ['title is required', 'description is required'],
    },
  },
  serverError: {
    status: 500,
    body: {
      success: false,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    },
  },
  serviceUnavailable: {
    status: 503,
    body: {
      success: false,
      error: 'Service Unavailable',
      message: 'Service temporarily unavailable',
    },
  },
  rateLimited: {
    status: 429,
    body: {
      success: false,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    },
    headers: {
      'Retry-After': '60',
    },
  },
};

/**
 * Test configuration presets
 */
export const CONFIG_PRESETS = {
  minimal: {
    apiKey: 'test-api-key-12345',
    showWidget: false,
    replay: { enabled: false },
    sanitize: { enabled: false },
  },
  full: {
    apiKey: 'test-api-key-12345',
    endpoint: 'https://api.example.com',
    showWidget: true,
    replay: {
      enabled: true,
      duration: 30,
      sampling: { mousemove: 50, scroll: 100 },
    },
    sanitize: {
      enabled: true,
      patterns: 'all' as const,
    },
    retry: {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
    },
    offline: {
      enabled: true,
      maxQueueSize: 10,
    },
  },
  selfHosted: {
    apiKey: 'test-api-key-12345',
    endpoint: 'https://localhost:4000',
    showWidget: false,
    sanitize: {
      enabled: true,
      patterns: ['email', 'phone', 'creditcard'] as Array<
        'email' | 'phone' | 'creditcard'
      >,
    },
  },
  default: {
    apiKey: 'test-api-key-12345',
    endpoint: 'https://api.example.com',
    showWidget: false,
    replay: { enabled: true },
    sanitize: { enabled: true },
  },
};
