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
    // Pasted as plain JS into Cloudflare Snippets, which run on the Workers runtime.
    files: ['cloudflare-snippet/snippet.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['caddy/test/**/*.mjs'],
    languageOptions: { globals: globals.node },
  }
);
