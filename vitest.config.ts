import { defineConfig } from 'vitest/config'

// Test runner config, kept separate from vite.config.ts so the api-plugin dev
// middleware never loads under test. packages/core is framework-agnostic and
// runs in a plain node environment; the few DOM-touching suites opt in with a
// `// @vitest-environment jsdom` file pragma.
export default defineConfig({
  // Match the dev inject token so the dev-key fallback compiles to a no-op under
  // test (production behavior). Suites that exercise it pass an explicit source.
  define: { __DEV_LLM_KEYS__: 'null' },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/*.{test,spec}.{ts,tsx}',
      'services/**/*.{test,spec}.{ts,tsx}',
      'apps/web/**/*.{test,spec}.{ts,tsx}',
      'server/**/*.{test,spec}.{ts,tsx}'
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/**/*.ts'],
      exclude: ['packages/**/*.{test,spec}.ts', 'packages/**/__mocks__/**']
    }
  }
})
