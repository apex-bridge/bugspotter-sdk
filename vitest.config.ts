import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Exclude only the Playwright E2E specs (which use
    // @playwright/test's test.describe and would crash vitest on the
    // mismatched runtime). Scoped to tests/e2e/ so a future
    // unit-test *.spec.ts elsewhere isn't silently skipped.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**/*.spec.ts'],
    environmentOptions: {
      jsdom: {
        resources: 'usable',
      },
    },
    server: {
      deps: {
        inline: ['rrweb', 'rrweb-snapshot', '@rrweb/types'],
      },
    },
  },
});
