"""Параметры дополнительных наблюдений (backend/insights.py): значения, единицы и обоснования.

Один модуль владеет всеми порогами наблюдений, чтобы выдача, тесты и документация
показывали одни и те же значения. Пороги — рабочие настройки отбора примеров
для проверки аналитиком, а не установленные признаки нарушений.
"""

from __future__ import annotations

from . import policy

VERSION = "finance-insights-policy/1"
SCHEMA_VERSION = "finance-insights/v1"

# Коридор «передано дальше» совпадает с правилом транзита ядра: одна мера для роли и для пар переводов.
PASS_THROUGH_RATIO = (
    policy.THRESHOLDS["transit"]["pass_through_low"]["value"],
    policy.THRESHOLDS["transit"]["pass_through_high"]["value"],
)
PASS_THROUGH_MAX_LAG_DAYS = 2
CONVERGENCE_MIN_PAYERS = 3
BURST_WINDOW_DAYS = 2
BURST_MIN_TX = 5
BURST_MIN_RATE_RATIO = 5.0
ROUTE_MAX_LAG_DAYS = 2
ROUTE_MIN_REPEATS = 2
CYCLE_MAX_LENGTH = 4
CYCLE_ENUMERATION_CAP = 50000
SPLIT_WINDOW_DAYS = 2
SPLIT_MIN_PARTS = 3
ANOMALY_TAIL_SHARE = 0.01
ANOMALY_MIN_RATIO = 3.0
ANOMALY_MIN_COHORT = 20
REMOVAL_TOP_N = (1, 3, 5, 10, 20)
REMOVAL_RANDOM_RUNS = 50
REMOVAL_RANDOM_SEED = 20260923
MAX_EXAMPLES = 10
MAX_RECORDS = 8
MAX_FLAGS_PER_GID = 4


def _param(value, unit: str, rationale: str) -> dict:
    return {"value": list(value) if isinstance(value, tuple) else value, "unit": unit, "rationale": rationale}


PARAMETERS = {
    "pass_through": {
        "max_lag_days": _param(
            PASS_THROUGH_MAX_LAG_DAYS,
            "календарных дня между входящим и исходящим переводом",
            "Задание называет транзит за 1–2 дня. Лаг 0 — тот же день: порядок операций внутри дня в данных не записан.",
        ),
        "amount_ratio": _param(
            PASS_THROUGH_RATIO,
            "отношение суммы исходящего перевода к входящему",
            "Тот же коридор 80–120%, что у правила транзита в backend/policy.py.",
        ),
    },
    "convergence": {
        "min_payers": _param(
            CONVERGENCE_MIN_PAYERS,
            "разных плательщиков в один календарный день",
            "Один-два плательщика в день — обычный поток; три и более в один день — схождение, которое стоит проверить.",
        ),
    },
    "bursts": {
        "window_days": _param(BURST_WINDOW_DAYS, "календарных дня подряд", "Окно не зависит от границы суток."),
        "min_tx": _param(BURST_MIN_TX, "переводов в окне", "Меньшее число не отличимо от обычной активности."),
        "min_rate_ratio": _param(
            BURST_MIN_RATE_RATIO,
            "раз выше собственного среднего темпа счёта за период",
            "Сравнение со своим темпом отделяет всплеск от постоянно активного счёта.",
        ),
    },
    "routes": {
        "max_lag_days": _param(
            ROUTE_MAX_LAG_DAYS,
            "календарных дня между переводами A→B и B→C",
            "То же окно, что и для быстрого транзита.",
        ),
        "min_repeats": _param(
            ROUTE_MIN_REPEATS,
            "разных дней, в которые маршрут повторился",
            "Однократная цепочка ещё не устойчивый маршрут.",
        ),
    },
    "cycles": {
        "max_length": _param(
            CYCLE_MAX_LENGTH,
            "счетов в цикле",
            "Короткие циклы проверяются вручную; длинные при глубине выборки 4 почти не наблюдаются.",
        ),
        "enumeration_cap": _param(
            CYCLE_ENUMERATION_CAP,
            "циклов",
            "Предел защищает время расчёта на плотных графах; достижение предела отмечается в счётчиках.",
        ),
    },
    "splitting": {
        "window_days": _param(SPLIT_WINDOW_DAYS, "календарных дня подряд", "Короткое окно для серии переводов одной пары."),
        "min_parts": _param(
            SPLIT_MIN_PARTS,
            "переводов одной пары отправитель→получатель в окне",
            "Два перевода — обычное явление; с трёх начинается серия.",
        ),
    },
    "depth_profile": {
        "tail_share": _param(
            ANOMALY_TAIL_SHARE,
            "доля счетов той же глубины со значением не ниже, чем у счёта (не менее одного счёта)",
            "Показатель выше, чем у 99% счетов своей глубины. Правило по рангам не ломается, когда "
            "у большинства счетов одинаковое значение, например один плательщик.",
        ),
        "min_ratio_to_median": _param(
            ANOMALY_MIN_RATIO,
            "раз больше медианы своей глубины",
            "Отсекает статистически заметные, но малые по величине отличия.",
        ),
        "min_cohort": _param(ANOMALY_MIN_COHORT, "счетов на одной глубине", "Меньшая группа не даёт устойчивой медианы."),
    },
    "resilience": {
        "top_n": _param(REMOVAL_TOP_N, "удаляемых счетов", "Сценарии для 1, 3, 5, 10 и 20 счетов."),
        "random_runs": _param(
            REMOVAL_RANDOM_RUNS,
            "случайных наборов того же размера",
            "Опорный сценарий: насколько удаление по приоритету отличается от случайного.",
        ),
        "random_seed": _param(REMOVAL_RANDOM_SEED, "зерно генератора", "Фиксировано для повторяемости."),
    },
}

GLOBAL_LIMITATIONS_RU = [
    "Наблюдения описывают структуру и даты переводов в выгрузке. Они не доказывают, что дальше "
    "переведены те же деньги, и не устанавливают происхождение средств или виновность владельцев.",
    "Переводы меньше 5 000 ₸ в выгрузку не попали: их наличие или отсутствие не оценивается.",
    "Даты не задают порядок операций внутри дня; совпадение дат отмечено как возможная, а не "
    "наблюдаемая последовательность.",
    "У счетов глубины 4 исходящие переводы не собирались: отсутствие продолжения у них не является наблюдением.",
    "Пороги — рабочие настройки для отбора примеров; точность обнаружения не измерялась, эталонных ролей нет.",
]


def parameters_payload() -> dict:
    return {section: {name: dict(spec) for name, spec in specs.items()} for section, specs in PARAMETERS.items()}
