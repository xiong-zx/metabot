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
          paths: [
            {
              name: 'node:child_process',
              message:
                'MetaClaw MCP never starts, stops, restarts, or repairs the official service. Owning a process handle is how a read-only client quietly becomes a lifecycle manager.',
            },
            {
              name: 'child_process',
              message: 'MetaClaw MCP never spawns a process; the official service lifecycle belongs to the operator.',
            },
          ],
          patterns: [
            {
              group: [
                '../../../src/*',
                '../../server/*',
                '../../metamemory/*',
                '../../skill-hub/*',
                '../../cli/*',
                '../../arc-mcp/*',
                '../../worker-runner-mcp/*',
                '@xvirobotics/arc-mcp',
                '@xvirobotics/arc-mcp/*',
                '@xvirobotics/arc-researchclaw-adapter',
                '@xvirobotics/arc-worker-runner-adapter',
                '@xvirobotics/worker-runner-mcp',
                '@xvirobotics/worker-runner-mcp/*',
                '@xvirobotics/metabot-core-server',
                '@xvirobotics/metabot-core-server/*',
                '@xvirobotics/metamemory',
                '@xvirobotics/metamemory/*',
                '@xvirobotics/skill-hub',
                '@xvirobotics/skill-hub/*',
                '@anthropic-ai/*',
                'better-sqlite3',
              ],
              message:
                'MetaClaw MCP must stay independent of ARC, Worker Runner, Bridge, Memory/Wiki, and any database. It talks only to the official MetaClaw HTTP surface and its own bounded local reads.',
            },
          ],
        },
      ],
    },
  },
);
