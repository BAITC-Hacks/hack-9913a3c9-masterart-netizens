import {defineConfig, type Connect, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Во время разработки отдаёт по адресу /out/ только результаты анализа из каталога WORKBENCH_OUT
 * (по умолчанию ../out). Другие пути не обслуживаются, поэтому файлы проекта наружу не попадают.
 * В рабочем режиме тот же адрес обслуживает serve.py.
 */
const OUT_FILES = new Set(['analysis.json', 'nodes_roles.csv', 'clusters.csv', 'top_nodes.csv']);

function workbenchData(): Plugin {
  const dir = path.resolve(here, process.env.WORKBENCH_OUT ?? '../out');
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/out/')) return next();
    const name = url.slice('/out/'.length);
    const file = path.join(dir, name);
    if (!OUT_FILES.has(name) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Файл не найден');
      return;
    }
    res.setHeader('content-type', name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'workbench-data',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), workbenchData()],
  base: '/',
  build: {outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false},
  server: {host: '127.0.0.1', port: 5173},
  preview: {host: '127.0.0.1', port: 4173},
});
