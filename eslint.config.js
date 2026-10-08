// eslint.config.js — ESLint v9 flat config for the Loom cartridge.
//
// A cartridge is a public artifact: it is read by people deciding whether to
// trust Mnemosyne OS with their memory. The rules below are the ones that
// caught real bugs in this codebase, not a style opinion:
//
//  • no-floating-promises  — an un-awaited ingest is how an import silently half-runs
//  • no-empty              — a silent catch is the project's cardinal sin (CLAUDE rule 7)
//  • exhaustive-deps       — a stale closure is how a scene keeps reading
//                            a range the user has since scrolled away from
//  • no-explicit-any       — untyped bridge payloads are how a contract drifts
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', 'vite.config.ts'],
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // Tests are excluded from tsconfig.json on purpose (the app build must
        // not depend on the test runner being installed), so the project
        // service cannot type them — allowDefaultProject lets it lint them
        // anyway instead of reporting a parsing error on the whole file.
        projectService: {
          allowDefaultProject: ['src/*.test.tsx', 'src/lib/*.test.ts', 'src/i18n/*.test.ts', 'src/components/*.test.tsx', 'src/test-setup.ts'],
          // The default cap is 8 files and this cartridge has more test files
          // than that. Raising it costs lint time; the alternative — putting
          // the tests in tsconfig.json — would make `pnpm build` depend on
          // vitest being installed, which is the thing that tsconfig comment
          // exists to prevent.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 40,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ── Correctness ────────────────────────────────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      // An async JSX handler is idiomatic React and safe here: every one of
      // them owns its try/catch and reports into the surface's error state.
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // A catch that does nothing must SAY it does nothing on purpose — an
      // empty block with a comment inside is allowed, a bare `{}` is not.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // ── Honesty about async ────────────────────────────────────────────────
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ── Noise this codebase deliberately allows ────────────────────────────
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Tests reach into shapes on purpose to reproduce real bad data.
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
