# Импорт данных — панель интерфейса

`ImportPanel` даёт выбрать три файла (`nodes.parquet`, `edges.parquet`, `transactions.parquet`),
заранее проверяет имена и размеры, отправляет их на `POST /api/import` и показывает ход, успех
или русское сообщение об ошибке. Схема, пределы и серверная часть описаны в `imports/README.md`.

```tsx
import {ImportPanel} from '../features/import';

<ImportPanel onImported={(dataset) => { /* dataset.input_sha256, dataset.n_nodes, … */ }}
             onReload={() => window.location.reload()} />
```

- `onImported` вызывается сразу после успешного импорта.
- `onReload` вызывает кнопка «Открыть новый анализ»; по умолчанию страница перезагружается и
  читает новый `out/analysis.json`.

Проверка: `npx vitest run --config src/features/import/vitest.config.ts` в каталоге `web`.
