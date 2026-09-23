import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// Отдельный запуск проверок списка: общий vitest.config.ts берёт только tests/**/*.test.ts.
// Из каталога web: npx vitest run --config src/features/shortlist/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  esbuild: {jsx: 'automatic'},
  test: {environment: 'node', include: ['src/features/shortlist/**/*.test.{ts,tsx}']},
});
