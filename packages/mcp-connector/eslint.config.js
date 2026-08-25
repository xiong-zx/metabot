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
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../../../src/*',
                '../../*/src/*',
                '@xvirobotics/*',
                '@modelcontextprotocol/*',
                '@anthropic-ai/*',
                'better-sqlite3',
                'zod',
              ],
              message:
                'The MCP connector owns endpoint, protected credential file, redaction and bounded transport primitives only. It must not learn any product package, tool schema, database, or MCP server framework.',
            },
          ],
        },
      ],
    },
  },
);
