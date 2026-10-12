import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Tests share the module-level encryption key; run files one at a time.
    fileParallelism: false,
  },
});
