import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The react plugin is what compiles JSX inside tests; without it component tests
// fail to parse. Mirrors server/vitest.config.js otherwise (explicit imports, no globals).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.{js,jsx}'],
    setupFiles: ['./tests/setup.js'],
    restoreMocks: true
  }
});
