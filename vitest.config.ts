import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // B-WK1c: coverage runs with every `vitest run`, so CI's `pnpm test` enforces a floor that never drops
    // (the current figures rounded down; raise them when coverage grows, never lower them).
    coverage: {
      enabled: true, provider: 'v8', include: ['src/**/*.ts'], exclude: [], reporter: ['text'],
      thresholds: { statements: 97, branches: 99, functions: 92, lines: 99 },
    },
  },
});
