import {defineConfig} from 'vitest/config';

// Логика данных проверяется без браузера: схема, точные идентификаторы, поиск, окрестность, справка.
export default defineConfig({
  test: {environment: 'node', include: ['tests/**/*.test.ts']},
});
