// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Architecture guard: HTTP controllers must go through a per-capability service and
    // never reach for the raw WhatsApp engine. This keeps the "session not started" guard,
    // error mapping, and business rules behind the service boundary instead of leaking into
    // controllers. `.getEngine(` (not `.getEngines()`) and the `IWhatsAppEngine` type are banned.
    files: ['**/*.controller.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='getEngine']",
          message:
            'Controllers must not call getEngine(). Add a method to the capability service (e.g. GroupService) and call that instead.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Only the engine abstraction itself is banned — data shapes (e.g. ChatSummary)
              // that happen to live in the same file remain importable by controllers.
              group: ['**/engine/interfaces/whatsapp-engine.interface'],
              importNames: ['IWhatsAppEngine'],
              message:
                'Controllers must not import IWhatsAppEngine. Keep engine types behind a capability service.',
            },
          ],
        },
      ],
    },
  },
);
