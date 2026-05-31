import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Exclude all `*.spec.ts` so Playwright specs (which use
    // @playwright/test's test.describe) don't get picked up by
    // vitest and crash on the mismatched runtime.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts'],
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
