import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

// The rules d3-dna lints this code with, less import-x: its rules here only warned,
// and it needs a patched install to clear the minimatch advisory.
export default defineConfig(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/.wrangler/', '**/*.d.ts', 'eslint.config.mjs'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      curly: ['error', 'multi-line'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: 'if', next: 'if' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-extend-native': ['error'],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': ['error'],
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: true, variables: true, allowNamedExports: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-param-reassign': ['error', { props: false }],
    },
  },
  {
    // The generated paste. Still linted, because `no-undef` under the Workers
    // globals is the only check that a bundled module did not reach for an API
    // the runtime lacks — the spec runs it under Node, where such a gap is
    // masked. Style rules are off instead: a bundler's output can only be fixed
    // by hand, and the next build loses the fix.
    files: ['cloudflare-snippet/snippet.js'],
    languageOptions: { globals: { ...globals.serviceworker, CONFIG: 'readonly' } },
    rules: {
      '@stylistic/padding-line-between-statements': 'off',
      // A constant esbuild kept because its module had other live exports; the
      // author cannot delete it here and the next build would bring it back.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'error',
    },
  },
  {
    // CONFIG is what the customer edits and what the generated bundle reads; the
    // block is prepended to that bundle, so nothing in this file uses it.
    files: ['cloudflare-snippet/src/config.js'],
    languageOptions: { globals: globals.serviceworker },
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    files: ['caddy/test/**/*.mjs', 'openresty/test/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: { globals: globals.node },
  }
);
