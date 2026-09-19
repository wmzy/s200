import base from 'tools-config/eslint';
import globals from 'globals';

// tools-config enables type-checked rules (strictTypeChecked) but does not
// enable the parser's project service, which those rules require. This
// greenfield codebase runs with type information on: enable the project
// service and keep the strict rule set (fetch-fun had to downgrade for
// legacy code; s200 starts clean).
export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,cjs,mjs,ts,cts,mts}'],
    // No React code here. tools-config applies react-hooks rules to all
    // files, which misfires on the exported `use()` registration function
    // (flagged as a Hook called outside a component).
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // Node-side scripts and config files: tools-config only applies
    // browser/serviceworker globals (to jsx/tsx), so node builtins and the
    // undici fetch globals need declaring for no-undef.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // The repo's test idiom (inherited from fetch-fun) is chai should()
      // chains — `value.should.equal(x)` is an expression statement by
      // design; the type-checked rule set of tools-config 0.5 flags it.
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
];
