"""«Граф денег»: объяснимый анализ графа внутрибанковских переводов.

Точка входа — `python -m backend --data <каталог> --out <каталог>`. Модули:
`io` (чтение и проверка parquet), `metrics` (наблюдаемые метрики), `roles`
(правила ролей), `priority` (очередь проверки), `clusters` (Louvain),
`analysis` (сборка фактов), `exports` (CSV и analysis.json), `policy` (все пороги).
"""
