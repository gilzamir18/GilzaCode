// Used to find dangling references while the interface is cut down from GilzaBots:
// JavaScript only reports an undefined name when the line runs, never at build time.
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'test/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: { react: { version: '18' } },
    rules: {
      'no-undef': 'error',
      'react-hooks/exhaustive-deps': 'off',
      'react/jsx-no-undef': 'error',
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
    },
  },
];
