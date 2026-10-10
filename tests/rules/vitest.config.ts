import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.ts'],
    environment: 'node',
    // Rules tests share one emulator; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
