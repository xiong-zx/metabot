import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**', 'node_modules/**', '*.js', '**/*.mjs', 'python/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../src/*', '@xvirobotics/worker-runner-mcp', '@xvirobotics/worker-runner-mcp/*'],
              message: 'The official ARC adapter must stay isolated from Bridge and Worker Runner internals.',
            },
          ],
        },
      ],
    },
  },
);
