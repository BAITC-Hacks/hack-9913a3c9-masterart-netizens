# Реестр функций

Карта соответствия [заданию кейса](https://docs.google.com/document/d/1JPLU-G6R25Ge2hVaY2J9cqvrx7FGExj87XKwJPaMz3o/edit): каждое требование связано со строками кода, которые его
выполняют, с тестом, который это проверяет, и со способом убедиться вручную. Ссылки ведут на
конкретные строки файлов в этом репозитории. Общая картина простыми словами — в
[экскурсии по коду](docs/code-tour.md): путь одного настоящего счёта через все модули.

**Все проверки одной командой** (после `./run.sh --no-serve`, см. README, раздел 7):

```bash
.venv/bin/python -m pip install pypdf==6.19.0
FINANCE_DATA=data FINANCE_DATA_DIR=data FINANCE_ANALYSIS=out/analysis.json ASSISTANT_ANALYSIS_PATH=out/analysis.json \
  WORKBENCH_VERIFY_BOOTSTRAP=1 .venv/bin/python -m unittest discover -s tests -v
cd web && WORKBENCH_REAL=../out/analysis.json npm test
for part in assistant shortlist import; do npx vitest run --config src/features/$part/vitest.config.ts; done
```

Состояние **готово** означает, что функция есть в этой версии и её тест проходит.

1. [Обязательные требования (раздел 7)](#обязательные-требования-раздел-7)
2. [Правила ролей](#правила-ролей)
3. [Входные и выходные данные (раздел 5)](#входные-и-выходные-данные-раздел-5)
4. [Объявленные ограничения данных (раздел 6)](#объявленные-ограничения-данных-раздел-6)
5. [Дополнительные пункты (раздел 8)](#дополнительные-пункты-раздел-8)
6. [Запреты и обязательные условия (раздел 9)](#запреты-и-обязательные-условия-раздел-9)
7. [Артефакты (раздел 10)](#артефакты-раздел-10)
8. [Надёжность и безопасность](#надёжность-и-безопасность)

## Обязательные требования (раздел 7)

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| **1. Воспроизводимый конвейер:** один запуск от parquet до трёх выгрузок, без ручных шагов, меньше 5 минут | [`run.sh:анализ`](run.sh#L90) (сначала анализ, затем просмотрщик); [`__main__.py · main`](backend/__main__.py#L29-L76) | [`F01_fresh_cli_without_model_key_under_five_minutes`](tests/test_acceptance.py#L585-L587), [`F01_bootstrap_no_serve_from_source_copy`](tests/test_acceptance.py#L689-L707), [`F01_deterministic_rerun_bytes`](tests/test_acceptance.py#L600-L603) | `./run.sh --no-serve` → в `out/` три CSV; время печатается в конце | готово |
| **2. Роль и скор у каждого узла:** 2 248 строк, роль из словаря, `role_score`, `evidence` до 200 символов | [`roles.py · evaluate`](backend/roles.py#L184-L207), [`roles.py · select`](backend/roles.py#L210-L229), [`roles.py · evidence_text`](backend/roles.py#L232-L242); [`exports.py · render_outputs`](backend/exports.py#L44-L69) | [`core_exports_bounds_and_exact_ids`](tests/test_core.py#L320-L331), [`F02_F03_F04_F05_official_output_contract_and_source_totals`](tests/test_acceptance.py#L589-L598), [`no_official_evidence_is_clipped`](tests/test_roles_repair.py#L210-L216) | `wc -l out/nodes_roles.csv` → 2 249 (с заголовком) | готово |
| **3. Критерии ролей задокументированы:** правило или метрика с порогом для каждой роли | Пороги: [`policy.py · THRESHOLDS`](backend/policy.py#L48-L156); тексты правил: [`policy.py · RULE_DESCRIPTIONS_RU`](backend/policy.py#L158-L165); расчёт — таблица «Правила ролей» ниже | [`test_core_roles_*` ×11](tests/test_core.py#L197-L279), [`test_R1–R9` ×15](tests/test_roles_repair.py#L61-L188) | Жюри называет `gid` → поиск в просмотрщике → карточка: факт, порог, альтернатива | готово |
| **4. Кластеризация:** размер, число исходных клиентов, оборот и гипотеза; `cluster_id` у каждого узла | [`clusters.py · assign_clusters`](backend/clusters.py#L19-L33), [`clusters.py · summarize`](backend/clusters.py#L36-L67), [`clusters.py · _hypothesis`](backend/clusters.py#L70-L94) | [`core_exports_clusters_cover_every_node_and_conserve_amounts`](tests/test_core.py#L333-L348), [`F04_clusters_stable_under_input_row_reversal`](tests/test_acceptance.py#L616-L630) | Сумма `n_nodes` в `out/clusters.csv` = 2 248, сумма `n_seed` = 81 | готово |
| **5. Топ-лист и визуализация:** ≥ 20 узлов с обоснованием; схема с направлением потоков и ролями; найти `gid` и показать связи | [`priority.py · compute_priority`](backend/priority.py#L26-L45), [`priority.py · why_text`](backend/priority.py#L53-L70), очередь без исходных клиентов: [`policy.py · TOP_EXCLUDES_SEEDS`](backend/policy.py#L197); [`search.ts · searchAccounts`](web/src/data/search.ts#L32-L48), [`egoLayout.ts · layoutEgo`](web/src/map/egoLayout.ts#L37-L143), [`MapPanel.tsx · MapPanel`](web/src/ui/MapPanel.tsx#L18-L93) | [`core_exports_top_nodes_sorted_with_reasons`](tests/test_core.py#L350-L357), [`top_list_starts_with_accounts_beyond_known_clients`](tests/test_roles_repair.py#L221-L235), [`search.test.ts · WEB-SEARCH` ×5](web/tests/search.test.ts#L9-L37), [`real-data.test.ts · WEB-REAL` ×1](web/tests/real-data.test.ts#L16-L76) | Просмотрщик → поле поиска (клавиша `/`) → точный `gid` → карта: плательщики сверху, получатели снизу | готово |

## Правила ролей

| Роль | Порог в `policy.py` | Расчёт | Положительный и отрицательный пример |
|---|---|---|---|
| `consolidator` | [`THRESHOLDS · consolidator`](backend/policy.py#L49-L60) | [`roles.py · consolidator`](backend/roles.py#L39-L43) | [`core_roles_consolidator_positive_with_terminal_runner_up`](tests/test_core.py#L197-L201), [`core_roles_consolidator_negative_six_payers`](tests/test_core.py#L203-L206) |
| `distributor` | [`THRESHOLDS · distributor`](backend/policy.py#L61-L72) | [`roles.py · distributor`](backend/roles.py#L46-L52) | [`core_roles_distributor_positive_and_negative`](tests/test_core.py#L208-L213) |
| `transit` | [`THRESHOLDS · transit`](backend/policy.py#L73-L94) | [`roles.py · transit`](backend/roles.py#L55-L101); доля после поступлений: [`metrics.py · _forward_tiyn`](backend/metrics.py#L67-L84) | [`core_roles_transit_positive_and_negative`](tests/test_core.py#L215-L219), [`R4_outflow_before_first_inflow_is_not_transit`](tests/test_roles_repair.py#L113-L117) |
| `terminal` | [`THRESHOLDS · terminal`](backend/policy.py#L95-L131) | [`roles.py · terminal`](backend/roles.py#L104-L142); окно наблюдения: [`metrics.py · _value_margin_days`](backend/metrics.py#L87-L98) | [`R1_small_outflow_large_inflow_is_terminal_candidate`](tests/test_roles_repair.py#L61-L73), [`core_roles_terminal_negatives_single_small_payer_and_short_window`](tests/test_core.py#L221-L227) |
| `coordinator` | [`THRESHOLDS · coordinator`](backend/policy.py#L132-L143) | [`roles.py · coordinator`](backend/roles.py#L145-L152) | [`core_roles_coordinator_positive_and_negative`](tests/test_core.py#L229-L233) |
| `peripheral` | [`THRESHOLDS · peripheral`](backend/policy.py#L144-L155) | [`roles.py · select`](backend/roles.py#L210-L229); пробел наблюдения: [`roles.py · observation_gap`](backend/roles.py#L162-L181) | [`R2_missing_observation_does_not_inflate_no_signal_support`](tests/test_roles_repair.py#L83-L94), [`core_roles_isolated_seed_kept`](tests/test_core.py#L247-L254) |
| Выбор роли и альтернативы | [`policy.py · ROLE_TIERS`](backend/policy.py#L28-L31) | [`roles.py · select`](backend/roles.py#L210-L229), [`roles.py · ramp`](backend/roles.py#L30-L36) | [`core_roles_tie_uses_precedence`](tests/test_core.py#L275-L279), [`R9_stronger_alternative_explains_why_it_lost`](tests/test_roles_repair.py#L183-L188) |
| Приоритет | [`policy.py · PRIORITY_WEIGHTS`](backend/policy.py#L175-L181) | [`priority.py · compute_priority`](backend/priority.py#L26-L45), [`priority.py · why_text`](backend/priority.py#L53-L70) | [`core_priority_families_disclosed_and_isolate_zero`](tests/test_core.py#L404-L413), [`core_priority_chronology_family_is_one_bounded_input`](tests/test_core.py#L396-L402) |

## Входные и выходные данные (раздел 5)

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| Три файла parquet: схема, типы, согласованность транзакций с рёбрами по сумме и числу операций | [`io.py · REQUIRED_COLUMNS`](backend/io.py#L20-L24), [`io.py · validate_rows`](backend/io.py#L142-L224), [`io.py · to_tiyn`](backend/io.py#L56-L76) | [`core_validation_sum_and_count_mismatch`](tests/test_core.py#L428-L434), [`core_validation_duplicates_endpoints_and_orphans`](tests/test_core.py#L436-L442), [`F03_backend_rejects_explicit_invalid_inputs`](tests/test_acceptance.py#L632-L681) | Испортить сумму одной транзакции → запуск останавливается с объяснением, прежние выгрузки сохраняются | готово |
| Схемы трёх CSV в точном порядке столбцов | [`exports.py · NODES_COLUMNS`](backend/exports.py#L15), [`exports.py · CLUSTERS_COLUMNS`](backend/exports.py#L16), [`exports.py · TOP_COLUMNS`](backend/exports.py#L17) | [`F02_explicit_valid_fixture_and_csv`](tests/test_acceptance.py#L438-L443), [`F02_csv_rounded_gid_and_corruption_rejected`](tests/test_acceptance.py#L535-L542) | `head -1 out/*.csv` | готово |
| `gid` как `int64` без округления в CSV; строки в JSON и браузере | [`io.py · _gid`](backend/io.py#L79-L84); [`schema.ts · validateAnalysis`](web/src/data/schema.ts#L76-L159); [`search.ts · normalizeGidInput`](web/src/data/search.ts#L21-L30) | [`core_cli_rejects_float_ids_and_nulls`](tests/test_core.py#L511-L524), [`schema.test.ts · WEB-GID-EXACT` ×3](web/tests/schema.test.ts#L25-L42), [`search.test.ts · WEB-SEARCH` ×5](web/tests/search.test.ts#L9-L37) | Поиск `gid + 1` в просмотрщике → «не найден», а не соседний счёт | готово |
| Задержка ≤ 5 минут от сырых parquet до выгрузок | [`__main__.py · main`](backend/__main__.py#L29-L76) печатает время; [`exports.py · write_receipt`](backend/exports.py#L84-L88) пишет его в `run_receipt.json` | [`F01_fresh_cli_without_model_key_under_five_minutes`](tests/test_acceptance.py#L585-L587) | `cat out/run_receipt.json` → `pipeline_seconds` | готово |
| Словарь ролей: шесть обязательных ролей, без расширений | [`policy.py · ROLE_PRECEDENCE`](backend/policy.py#L16-L23), [`policy.py · ROLE_LABELS_RU`](backend/policy.py#L33-L40) | [`core_roles_all_six_labels_and_alternatives_complete`](tests/test_core.py#L256-L260) | `cut -d, -f2 out/nodes_roles.csv | sort | uniq -c` | готово |

## Объявленные ограничения данных (раздел 6)

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| Обрыв на 4-м колене: 444 узла без исходящих — не «сток» | [`policy.py · TRACE_HORIZON_DEPTH`](backend/policy.py#L44); [`roles.py · terminal`](backend/roles.py#L104-L142); [`roles.py · observation_gap`](backend/roles.py#L162-L181) | [`core_roles_boundary_fan_in_allowed_outgoing_claims_blocked`](tests/test_core.py#L235-L245), [`F07_boundary_gaps_never_imply_terminal`](tests/test_assistant.py#L232-L237) | Счёт `100000003037476100`: карточка говорит «исходящие не собирались» | готово |
| Только исходящие; входящие извне не видны; у исходных клиентов занижены | [`metrics.py · pass_through`](backend/metrics.py#L36-L40), [`metrics.py · forward_share`](backend/metrics.py#L43-L48); транзит исключает исходных клиентов: [`roles.py · transit`](backend/roles.py#L55-L101) | [`core_roles_seed_transit_blocked_and_threshold_ramp`](tests/test_core.py#L262-L273), [`R4_date_check_never_creates_transit_from_incomplete_balance`](tests/test_roles_repair.py#L137-L141) | В карточке доли названы «наблюдаемыми» | готово |
| Порог 5 000 ₸: дробление ниже порога невидимо | [`policy.py · LIMITATIONS_RU`](backend/policy.py#L219-L228); поиск дробления выше порога: [`insights.py · _splitting`](backend/insights.py#L696-L754) | [`INS_ANOMALY_splitting_series_vs_spread`](tests/test_insights.py#L259-L267) | Раздел «Ограничения данных» в карточке | готово |
| 19 исходных клиентов без рёбер и 12 только получателей: всех сохранить | [`io.py · validate_rows`](backend/io.py#L142-L224); [`analysis.py · _weak_components`](backend/analysis.py#L72-L85) | [`core_roles_isolated_seed_kept`](tests/test_core.py#L247-L254), [`TEMP_isolated_seed_and_isolated_account_are_kept`](tests/test_temporal.py#L313-L330), [`neighborhood.test.ts · WEB-MAP-ISOLATE` ×1](web/tests/neighborhood.test.ts#L32-L38) | Счёт `100000000456947100`: сохранён, «роль не оценивается» | готово |
| 16 слабосвязных компонент и изолированные узлы: сеть не монолитна | [`analysis.py · _weak_components`](backend/analysis.py#L72-L85) | [`core_official_counts_roles_and_bounds`](tests/test_core.py#L552-L567) | `analysis.json` → `summary` | готово |
| Нет атрибутов клиента и эталонных ролей | Только поля parquet: [`io.py · REQUIRED_COLUMNS`](backend/io.py#L20-L24); оговорки: [`policy.py · SCORE_DESCRIPTION_RU`](backend/policy.py#L208-L211) | [`F06_official_reach_counts_are_queries_not_labels`](tests/test_acceptance.py#L683-L686), [`F07_unsupported_personal_guilt_provenance_code`](tests/test_assistant.py#L239-L247) | Спросить ассистента о личности клиента → отказ с объяснением | готово |
| Даты без времени: порядок внутри дня неизвестен | [`temporal.py · MODES`](backend/temporal.py#L33-L53), [`temporal.py · LIMITATIONS`](backend/temporal.py#L68-L76) | [`TEMP_same_day_chain_is_possible_but_not_strict`](tests/test_temporal.py#L254-L265), [`R4_same_day_order_is_allowed_but_not_assumed`](tests/test_roles_repair.py#L143-L146) | Переключатель режимов дат в просмотрщике | готово |

## Дополнительные пункты (раздел 8)

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| Учёт артефакта обрыва графа | [`roles.py · terminal`](backend/roles.py#L104-L142), [`roles.py · observation_gap`](backend/roles.py#L162-L181), [`roles.py · next_request`](backend/roles.py#L294-L318) | [`core_roles_boundary_fan_in_allowed_outgoing_claims_blocked`](tests/test_core.py#L235-L245), [`neighborhood.test.ts · WEB-MAP-BOUNDARY` ×1](web/tests/neighborhood.test.ts#L39-L44) | Счёт на 4-м колене не «конечный получатель» | готово |
| Временные паттерны: цепочки по датам, сквозной транзит за 0–2 дня, всплески, схождение в один день | [`temporal.py · compute_temporal`](backend/temporal.py#L97-L161); [`insights.py · _pass_through`](backend/insights.py#L229-L309), [`insights.py · _bursts`](backend/insights.py#L395-L479), [`insights.py · _convergence`](backend/insights.py#L312-L381) | [`test_TEMP_*` ×23](tests/test_temporal.py#L223-L581), [`INS_TEMPORAL` ×4](tests/test_insights.py#L128-L183) | Режим «позже по датам» → пример цепочки с датами и суммами | готово |
| Повторяющиеся маршруты и возвратные потоки | [`insights.py · _routes`](backend/insights.py#L500-L561), [`insights.py · _cycles`](backend/insights.py#L621-L690); на карте: [`neighborhood.ts · compileNeighborhood`](web/src/data/neighborhood.ts#L33-L68) | [`INS_ROUTES` ×2](tests/test_insights.py#L187-L206), [`INS_CYCLES` ×3](tests/test_insights.py#L208-L255), [`neighborhood.test.ts · WEB-MAP-CYCLE` ×1](web/tests/neighborhood.test.ts#L10-L20) | Число возвратных потоков на карте открывает их список | готово |
| Детекция аномалий: дробление, профиль, необычный для колена | [`insights.py · _splitting`](backend/insights.py#L696-L754), [`insights.py · _depth_profile`](backend/insights.py#L790-L879) | [`INS_ANOMALY` ×3](tests/test_insights.py#L259-L290) | `analysis.json` → `insights` | готово |
| Устойчивость сети при изъятии топ-N узлов | [`insights.py · _resilience`](backend/insights.py#L967-L1040) | [`INS_RESILIENCE_hub_removal_order_and_conservation`](tests/test_insights.py#L294-L316) | `analysis.json` → `insights` → сценарии удаления | готово |
| AI-ассистент аналитика: вопрос словами → ответ по графу со ссылками на узлы | [`service.py · answer`](assistant/service.py#L187-L235), [`queries.py · GraphQueries`](assistant/queries.py#L65-L291), [`queries.py · TOOL_SCHEMAS`](assistant/queries.py#L300-L318); панель: [`AssistantPanel.tsx · AssistantPanel`](web/src/features/assistant/AssistantPanel.tsx#L11-L150) | [`test_assistant F07` ×30](tests/test_assistant.py#L106-L414), [`F07_optional_assistant_seam`](tests/test_server.py#L166-L172) | Спросить «кто собирает деньги с этих счетов?» — ответ со ссылками на `gid` | готово |
| Автогенерация карточки узла | [`EvidencePanel.tsx · EvidencePanel`](web/src/ui/EvidencePanel.tsx#L28-L183), [`roleFacts.ts · roleFacts`](web/src/data/roleFacts.ts#L49-L160), [`brief.ts · buildReviewBrief`](web/src/data/brief.ts#L32-L115) | [`roleFacts.test.ts · WEB-ROLE-FACTS` ×16](web/tests/roleFacts.test.ts#L15-L138), [`brief.test.ts · WEB-BRIEF` ×5](web/tests/brief.test.ts#L10-L37) | Кнопка справки → файл `spravka-<gid>.md` | готово |
| PDF-справка по одному или нескольким счетам для передачи на проверку | [`facts.py · AnalysisIndex`](reports/facts.py#L169-L187), [`pdf.py · render_pdf`](reports/pdf.py#L428-L455); командная строка: [`__main__.py · main`](reports/__main__.py#L16-L37); маршрут сервера: [`serve.py · make_handler`](serve.py#L112-L342) | [`test_pdf_*` ×13](tests/test_reports.py#L113-L253) | `python -m reports --analysis out/analysis.json --gid 100000004015047100` | готово |
| Сохранённые счета: собрать очередь проверки и выгрузить PDF по отмеченным | [`store.ts · createShortlistStore`](web/src/features/shortlist/store.ts#L119-L218), [`ShortlistPanel.tsx · ShortlistPanel`](web/src/features/shortlist/ShortlistPanel.tsx#L46-L124), [`SaveAccountButton.tsx · SaveAccountButton`](web/src/features/shortlist/SaveAccountButton.tsx#L18-L35) | `web/src/features/shortlist/shortlist.test.tsx` (33 проверки) | Кнопка «Сохранить» в карточке → вкладка «Сохранённые» | готово |
| Загрузка своих данных через интерфейс: parquet или CSV той же схемы | [`ingest.py · _csv_to_parquet`](imports/ingest.py#L166-L200), [`ingest.py · _as_parquet`](imports/ingest.py#L203-L220), [`ingest.py · ingest_files`](imports/ingest.py#L335-L348); окно «О данных»: [`TopBar.tsx · TopBar`](web/src/ui/TopBar.tsx#L15-L81); панель: [`ImportPanel.tsx · ImportPanel`](web/src/features/import/ImportPanel.tsx#L29-L100) | [`test_F10_* (CSV)` ×4](tests/test_imports.py#L244-L285), [`import_same_content_same_identity_as_cli_loader`](tests/test_imports.py#L106-L113), [`import.test.ts · IMPORT-CSV` ×3](web/src/features/import/import.test.ts#L82-L112) | «О данных» → «Новые данные» → три CSV организаторов → тот же `input_sha256` | готово |
| Оценка полноты: чего не хватает и какой запрос сделать | [`roles.py · next_request`](backend/roles.py#L294-L318), [`insights.py · _data_requests`](backend/insights.py#L1065-L1088) | [`R3_short_window_card_asks_for_more_data`](tests/test_roles_repair.py#L106-L111) | Блок «Пробелы данных» в карточке | готово |

## Запреты и обязательные условия (раздел 9)

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| Нельзя хардкодить результат | Роли, кластеры и приоритет вычисляются правилами [`backend/policy.py`](backend/policy.py); списков `gid` в коде нет | [`core_determinism_rerun_and_row_shuffle`](tests/test_core.py#L378-L390), [`F01_deterministic_rerun_bytes`](tests/test_acceptance.py#L600-L603) | `grep -rn 1000000 backend/` — только тестовые данные в `tests/` | готово |
| Нельзя «чёрный ящик» | Правило, порог и факт в каждом основании: [`roles.py · _evidence_body`](backend/roles.py#L245-L272) | [`roleFacts.test.ts · WEB-ROLE-FACTS` ×16](web/tests/roleFacts.test.ts#L15-L138) | Любая строка `evidence` называет число и порог | готово |
| Нельзя обогащать извне и достраивать атрибуты | Читаются только поля задания: [`io.py · REQUIRED_COLUMNS`](backend/io.py#L20-L24) | [`F01_source_has_no_private_runtime_dependency`](tests/test_acceptance.py#L553-L561) | В выгрузках нет полей, кроме заданных | готово |
| Нельзя требовать облако, GPU или платные сервисы | Зависимости: [`requirements.txt`](requirements.txt), [`web/package.json`](web/package.json); ключ модели необязателен: [`service.py · NO_KEY`](assistant/service.py#L15) | [`F01_fresh_cli_without_model_key_under_five_minutes`](tests/test_acceptance.py#L585-L587), [`F07_no_key_exact_large_id_and_alternative`](tests/test_assistant.py#L106-L114) | Запуск без `OPENAI_API_KEY` проходит полностью | готово |
| Объяснимость для аналитика без ML | [`roles.py · evidence_text`](backend/roles.py#L232-L242), [`priority.py · why_text`](backend/priority.py#L53-L70) | [`roleFacts.test.ts · WEB-ROLE-FACTS` ×16](web/tests/roleFacts.test.ts#L15-L138) | Строки `evidence` и `why` читаются без справочника | готово |
| Приватность | Только синтетические `gid`; журнал сервера не пишет запросы: [`serve.py · make_handler`](serve.py#L112-L342) | [`F07_adapter_errors_do_not_disclose_details`](tests/test_server.py#L157-L164) | — | готово |
| Осторожность формулировок | Оговорки в правилах и кластерах: [`policy.py · SCORE_DESCRIPTION_RU`](backend/policy.py#L208-L211), [`clusters.py · _hypothesis`](backend/clusters.py#L70-L94) | [`brief.test.ts · WEB-BRIEF` ×5](web/tests/brief.test.ts#L10-L37), [`F07_unsupported_personal_guilt_provenance_code`](tests/test_assistant.py#L239-L247) | Гипотезы кластеров заканчиваются оговоркой | готово |
| Производительность ≤ 5 минут на обычном ноутбуке | [`__main__.py · main`](backend/__main__.py#L29-L76) | [`F01_fresh_cli_without_model_key_under_five_minutes`](tests/test_acceptance.py#L585-L587) | Время в последней строке запуска | готово |
| Всё локально; сеть только для внешнего LLM API | Сервер слушает только 127.0.0.1: [`serve.py · make_server`](serve.py#L345-L351); запрос к модели: [`openai.py · request`](assistant/openai.py#L25-L45) | [`F07_foreign_host_origin_and_cross_site_rejected`](tests/test_server.py#L131-L138), [`F07_http_transport_fixed_url_header_timeout_and_no_redirect`](tests/test_assistant.py#L324-L339) | Интерфейс работает с отключённой сетью | готово |
| Масштабируемость до ~1 млн узлов — текстом | [`README · раздел 10`](README.md#L295) | — | Раздел 10 README | готово |

## Артефакты (раздел 10)

| Артефакт | Где | Состояние |
|---|---|---|
| Репозиторий: код конвейера и интерфейса | [`backend/`](backend/), [`assistant/`](assistant/), [`web/`](web/), [`serve.py`](serve.py), [`run.sh`](run.sh) | готово |
| README: одна команда, критерии и пороги, выходы, ограничения, масштабирование | [`раздел 7`](README.md#L195), [`раздел 4`](README.md#L84), [`раздел 9`](README.md#L272), [`раздел 10`](README.md#L286) | готово |
| Выгрузки: `nodes_roles.csv`, `clusters.csv`, `top_nodes.csv` | Готовые файлы: [`results/`](results/); заново — в `out/` командой `./run.sh --no-serve` | готово |
| Схема решения: данные → метрики → роли → интерфейс | [`README · раздел 6`](README.md#L169), [`docs/architecture.md`](docs/architecture.md) | готово |
| Демо на 5 минут | [`docs/demo.md`](docs/demo.md) | готово |
| Сторонние ресурсы и лицензии | Шрифты PDF Noto Sans — [`SIL Open Font License 1.1`](reports/fonts/OFL.txt); перенесённый код интерфейса — [`web/README.md`](web/README.md#заимствованный-код) | готово |

## Надёжность и безопасность

| Требование | Где реализовано | Чем проверено | Как убедиться вручную | Состояние |
|---|---|---|---|---|
| Неудачный запуск не портит прежние выгрузки | [`exports.py · _atomic_write`](backend/exports.py#L38-L41), [`exports.py · write_attempt`](backend/exports.py#L91-L101), [`__main__.py · _failed`](backend/__main__.py#L22-L26) | [`failed_run_keeps_prior_outputs_and_marks_the_attempt`](tests/test_roles_repair.py#L239-L250) | `cat out/last_attempt.json` | готово |
| Локальный сервер отдаёт только интерфейс и четыре результата | [`serve.py · make_handler`](serve.py#L112-L342), [`serve.py · _read_regular`](serve.py#L95-L109) | [`F07_paths_and_private_artifacts_rejected`](tests/test_server.py#L93-L110), [`F07_symlink_files_directories_and_output_rejected`](tests/test_server.py#L112-L125) | Запрос `/out/../run.sh` → 404 | готово |
| Ответ ассистента не выдумывает счета и цепочки | [`queries.py · validate_args`](assistant/queries.py#L321-L343), [`render.py · render`](assistant/render.py#L50-L124); [`SafeAnswer.tsx · SafeAnswer`](web/src/features/assistant/SafeAnswer.tsx#L25-L52) | [`F07_fabricated_or_nonchronological_witness_rejected`](tests/test_assistant.py#L217-L230), [`F07_inputs_unchanged_and_all_citations_resolve`](tests/test_assistant.py#L361-L372) | Каждая ссылка в ответе открывает существующий счёт | готово |
| Повторяемость при перестановке строк входа | [`clusters.py · assign_clusters`](backend/clusters.py#L19-L33) | [`core_determinism_rerun_and_row_shuffle`](tests/test_core.py#L378-L390), [`TEMP_row_order_does_not_change_any_byte`](tests/test_temporal.py#L463-L470), [`INS_DETERMINISM_row_permutation`](tests/test_insights.py#L367-L377) | Два запуска → одинаковые файлы (`cmp`) | готово |
