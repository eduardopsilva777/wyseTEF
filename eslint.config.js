// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Domínio: sem ponto flutuante para dinheiro e sem I/O.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'parseFloat', 'fetch', 'process'],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Dinheiro é inteiro em centavos.' },
        { property: 'toFixed', message: 'Dinheiro é inteiro em centavos.' },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['pg', 'fastify', 'pino', 'node:fs*', 'node:net', 'node:http*'], message: 'O domínio não faz I/O.' }] },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'packages/providers/contract/src/conformance.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Implementa portas assíncronas sem I/O real.
    files: ['packages/persistence/src/memory/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'packages/persistence/src/cli/**/*.ts', 'apps/api/src/main.ts', 'apps/worker/src/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly' } },
  },
);
