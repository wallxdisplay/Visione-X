import { defineConfig } from 'vitest/config';

// Tests that need the Firestore/Auth emulators. Run with `npm run test:emulator`.
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.ts', 'tests/services/**/*.test.ts'],
    environment: 'node',
    // All files share one emulator; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
