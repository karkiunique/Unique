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
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { process: 'readonly', __dirname: 'readonly' }
    }
  }
];
