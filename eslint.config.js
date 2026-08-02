import pluginVue from 'eslint-plugin-vue'
import importX from 'eslint-plugin-import-x'
import promise from 'eslint-plugin-promise'
import tseslint from 'typescript-eslint'

const sourceFiles = ['**/*.{js,mjs,ts,vue}']

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'server/build-info.js',
      'test-results/**',
    ],
  },
  ...pluginVue.configs['flat/base'],
  {
    files: sourceFiles,
    plugins: {
      'import-x': importX,
      promise,
    },
    rules: {
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'no-duplicate-imports': 'error',
      'promise/param-names': 'error',
      'vue/no-duplicate-attributes': 'error',
      'vue/no-parsing-error': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
