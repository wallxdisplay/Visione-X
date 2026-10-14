import { defineConfig } from 'vitest/config';

// Unit tests only. Security-rules tests need the emulator: see tests/rules and `npm run test:rules`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'functions/src/**/*.test.ts', 'apps/web/src/locales/*.test.ts'],
    environment: 'node',
  },
});
