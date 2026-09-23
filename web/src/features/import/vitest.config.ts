import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// Собственная конфигурация позволяет проверить импорт, не меняя набор проверок просмотрщика.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {environment: 'node', include: ['import.test.ts']},
});
