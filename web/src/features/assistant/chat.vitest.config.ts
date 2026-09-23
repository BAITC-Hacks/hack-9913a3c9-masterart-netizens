import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// Проверки рабочей области разговоров; панельные проверки остаются в vitest.config.ts рядом.
// Из каталога web: npx vitest run --config src/features/assistant/chat.vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: {jsx: 'automatic'},
  test: {environment: 'node', include: ['conversations.test.tsx', 'workspace.test.tsx', 'model.test.tsx']},
});
