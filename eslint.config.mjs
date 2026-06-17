import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/target/**', '**/node_modules/**', '**/src-tauri/gen/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker runs in a worker scope, not the DOM — give it the
    // globals it relies on so lint doesn't flag them as undefined.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
      },
    },
  },
)
