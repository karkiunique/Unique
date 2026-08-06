import js from '@eslint/js';
import react from 'eslint-plugin-react';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortController: 'readonly',
  alert: 'readonly'
};

// Test files import describe/it/expect/vi explicitly (vitest `globals: false`),
// but declaring them keeps the config honest if a future test forgets an import.
const testGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  vi: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  afterAll: 'readonly',
  afterEach: 'readonly',
  global: 'readonly',
  process: 'readonly',
  HTMLElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  Event: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    settings: {
      react: { version: '18.3' }
    },
    rules: {
      // marks identifiers used inside JSX as "used" for no-unused-vars
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    files: ['vite.config.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { process: 'readonly', __dirname: 'readonly' }
    }
  },
  {
    // Relaxation is scoped to tests only — src rules above are untouched.
    files: ['tests/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...browserGlobals, ...testGlobals }
    }
  }
];
