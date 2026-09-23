import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Собственная конфигурация позволяет проверить панель, не меняя набор проверок просмотрщика.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { environment: 'node', include: ['assistant.test.tsx', 'api-context.test.ts'] },
});
