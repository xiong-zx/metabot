import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.js', '**/*.mjs'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../../../src/*',
                '../../server/*',
                '../../metamemory/*',
                '../../skill-hub/*',
                '../../cli/*',
                '@xvirobotics/metabot-core-server',
                '@xvirobotics/metabot-core-server/*',
                '@xvirobotics/metamemory',
                '@xvirobotics/metamemory/*',
                '@xvirobotics/skill-hub',
                '@xvirobotics/skill-hub/*',
                '@anthropic-ai/*',
              ],
              message:
                'ARC MCP must remain independent of Bridge, Memory/Wiki, WorkerManager, Agent Team, and Claude-specific code. Use a narrow adapter contract.',
            },
          ],
        },
      ],
    },
  },
);
