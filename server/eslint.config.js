import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly'
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**']
  },
  js.configs.recommended,
  {
    // .mjs too: the one-off scripts in scripts/ are ESM-by-extension and get the
    // same Node globals as src/ — without this they lint as if `process` and
    // `console` did not exist.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error'
    }
  }
];
