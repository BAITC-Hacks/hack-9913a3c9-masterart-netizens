import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// Отдельный запуск проверок наблюдений: общий vitest.config.ts берёт только tests/**/*.test.ts.
// Из каталога web: npx vitest run --config src/features/insights/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  esbuild: {jsx: 'automatic'},
  test: {environment: 'node', include: ['src/features/insights/**/*.test.{ts,tsx}']},
});
