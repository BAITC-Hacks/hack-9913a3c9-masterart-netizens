"""Факты для PDF-справки: проверка запроса и выборка значений из analysis.json без пересчёта.

Справка только переносит то, что уже записано в файле анализа: роль, основание, опоры,
приоритет, потоки, датированные пути, ограничения. Здесь ничего не вычисляется заново,
кроме группировки уже наблюдаемых переводов по контрагентам. Идентификаторы счетов
остаются строками от начала до конца: число с плавающей точкой исказило бы 18 цифр.
"""

from __future__ import annotations

import re
from decimal import Decimal

MODES = ("structural", "strict", "same_day")
MAX_ACCOUNTS = 25
TOP_COUNTERPARTIES = 8
MAX_SOURCE_ROWS = 24
GID_PATTERN = re.compile(r"[0-9]{1,40}")

MODE_LABEL = {
    "structural": "Без учёта дат",
    "strict": "Позже по датам",
    "same_day": "Тот же день возможен",
}
MODE_HINT = {
    "structural": "путь по наблюдаемым переводам без учёта дат",
    "strict": "каждый следующий перевод строго позже предыдущего",
    "same_day": "переводы одного дня допускаются: порядок внутри дня неизвестен",
}
REACH_CAVEAT = (
    "Путь показывает, что цепочка переводов возможна по датам и направлениям. "
    "Он не доказывает, что двигались те же деньги."
)
MONTHS = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)
NBSP = " "


class ReportRequestError(ValueError):
    """Запрос на справку не прошёл проверку; текст ошибки можно показать пользователю.

    `status` — подсказка для HTTP-слоя: 413 при превышении числа счетов, 404 для неизвестного
    счёта, 400 для остальных ошибок запроса.
    """

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def report_filename(gids) -> str:
    """Имя файла только из латиницы, цифр и дефиса: spravka-<gid>.pdf или spravka-<N>-schetov.pdf."""
    if len(gids) == 1:
        return f"spravka-{gids[0]}.pdf"
    return f"spravka-{len(gids)}-schetov.pdf"


# --- Форматирование -----------------------------------------------------------------------


def exact_decimal(value) -> Decimal:
    """Сумма из JSON как точное десятичное число: repr числа с плавающей точкой — кратчайшая точная запись."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ReportRequestError(f"Сумма должна быть числом, получено: {value!r}")
    return Decimal(repr(value)) if isinstance(value, float) else Decimal(value)


def kzt(value) -> str:
    """«29 510 727,39 ₸»: все разряды и копейки, неразрывные пробелы, чтобы сумма не делилась."""
    amount = exact_decimal(value)
    sign = "−" if amount < 0 else ""
    amount = abs(amount)
    whole = int(amount)
    frac = amount - whole
    grouped = f"{whole:,}".replace(",", NBSP)
    if frac:
        cents = f"{frac.quantize(Decimal('0.01')):f}"[2:]
        grouped = f"{grouped},{cents}"
    return f"{sign}{grouped}{NBSP}₸"


def integer(value: int) -> str:
    return f"{int(value):,}".replace(",", NBSP)


def score(value) -> str:
    """Опора и приоритет с двумя знаками; значение ниже 0,5 не округляется до порога."""
    if value is None:
        return "—"
    shown = f"{float(value):.2f}"
    if float(value) < 0.5 and shown == "0.50":
        shown = "0.49"
    return shown.replace(".", ",")


def share(value) -> str:
    """Доля в процентах с одним знаком: 0,0047 → «0,5%»; ненулевая доля не показывается нулём."""
    if value is None:
        return "—"
    percent = float(value) * 100
    if 0 < percent < 0.05:
        return "< 0,1%"
    return f"{percent:.1f}".replace(".", ",").replace(",0", "") + "%"


def date_ru(iso: str | None, with_year: bool = True) -> str:
    """«2026-07-16» → «16 июля 2026»; строка разбирается без часовых поясов."""
    if not iso:
        return "—"
    try:
        year, month, day = (int(part) for part in iso.split("-"))
        name = MONTHS[month - 1]
    except (ValueError, IndexError):
        return iso
    return f"{day} {name} {year}" if with_year else f"{day} {name}"


def plural(n: int, one: str, few: str, many: str) -> str:
    mod10, mod100 = n % 10, n % 100
    if mod10 == 1 and mod100 != 11:
        return one
    if 2 <= mod10 <= 4 and not 12 <= mod100 <= 14:
        return few
    return many


def count(n: int, one: str, few: str, many: str) -> str:
    return f"{integer(n)}{NBSP}{plural(n, one, few, many)}"


def capital(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


# --- Проверка запроса ---------------------------------------------------------------------


def validate_request(analysis: dict, gids, mode: str) -> list:
    """Проверяет выбор счетов и режим; возвращает узлы в порядке запроса или бросает ReportRequestError."""
    if not isinstance(analysis, dict) or not isinstance(analysis.get("nodes"), list):
        raise ReportRequestError("Файл анализа без списка счетов: справку собрать не из чего")
    if mode not in MODES:
        raise ReportRequestError(f"Неизвестный режим «{mode}»: допустимы {', '.join(MODES)}")
    if isinstance(gids, (str, bytes)) or not isinstance(gids, (list, tuple)):
        raise ReportRequestError("Счета передаются списком строк-идентификаторов")
    if not gids:
        raise ReportRequestError("Не выбран ни один счёт")
    if len(gids) > MAX_ACCOUNTS:
        raise ReportRequestError(f"Выбрано {len(gids)} счетов; в одной справке не больше {MAX_ACCOUNTS}", status=413)
    seen = set()
    for gid in gids:
        if not isinstance(gid, str) or not GID_PATTERN.fullmatch(gid):
            raise ReportRequestError(f"Идентификатор {gid!r} должен быть строкой из цифр, без пробелов и знаков")
        if gid in seen:
            raise ReportRequestError(f"Счёт {gid} выбран дважды")
        seen.add(gid)
    by_gid = {node["gid"]: node for node in analysis["nodes"]}
    missing = [gid for gid in gids if gid not in by_gid]
    if missing:
        raise ReportRequestError(f"Счёт {missing[0]} не найден в файле анализа" + (f" (всего не найдено: {len(missing)})" if len(missing) > 1 else ""), status=404)
    return [by_gid[gid] for gid in gids]


# --- Выборка фактов -----------------------------------------------------------------------


class AnalysisIndex:
    """Индексы по файлу анализа, собранные один раз на справку: узлы, кластеры, очередь, переводы."""

    def __init__(self, analysis: dict):
        self.analysis = analysis
        self.nodes = {node["gid"]: node for node in analysis["nodes"]}
        self.clusters = {row["cluster_id"]: row for row in analysis.get("clusters", [])}
        self.rank = {row["gid"]: row["rank"] for row in analysis.get("top_nodes", [])}
        self.top_size = len(analysis.get("top_nodes", []))
        self.labels = {rule["role"]: rule.get("label", rule["role"]) for rule in analysis.get("policy", {}).get("rules", [])}
        self.rules = {rule["role"]: rule for rule in analysis.get("policy", {}).get("rules", [])}
        self.tx_by_gid: dict = {}
        for tx in analysis.get("transactions", []):
            self.tx_by_gid.setdefault(tx["src"], []).append(tx)
            if tx["dst"] != tx["src"]:
                self.tx_by_gid.setdefault(tx["dst"], []).append(tx)

    def label(self, role: str) -> str:
        return self.labels.get(role, role)


def strongest_alternative(node: dict):
    """Ближайшая содержательная альтернатива в порядке конвейера, как в тексте основания.

    «Периферийный» у непериферийной роли — это «1 минус сильнейший признак», а не другая
    гипотеза о роли, поэтому альтернативой он не считается. Нулевая опора — тоже не альтернатива.
    """
    for alt in node.get("role_alternatives", []):
        if alt.get("score", 0) > 0 and alt.get("role") != "peripheral":
            return alt
    return None


def counterparties(index: AnalysisIndex, gid: str) -> dict:
    """Контрагенты по наблюдаемым переводам: сумма, число переводов и даты, крупнейшие сверху."""
    sides = {"in": {}, "out": {}}
    for tx in index.tx_by_gid.get(gid, []):
        pairs = []
        if tx["dst"] == gid:
            pairs.append(("in", tx["src"]))
        if tx["src"] == gid:
            pairs.append(("out", tx["dst"]))
        for side, other in pairs:
            row = sides[side].setdefault(other, {"gid": other, "sum": Decimal(0), "n_tx": 0, "first": tx["date"], "last": tx["date"]})
            row["sum"] += exact_decimal(tx["sum_kzt"])
            row["n_tx"] += 1
            row["first"] = min(row["first"], tx["date"])
            row["last"] = max(row["last"], tx["date"])
    ordered = {}
    for side, rows in sides.items():
        ordered[side] = sorted(rows.values(), key=lambda r: (-r["sum"], r["gid"]))
        for row in ordered[side]:
            other = index.nodes.get(row["gid"])
            row["role"] = index.label(other["role"]) if other else "вне списка счетов"
    return ordered


def source_rows(index: AnalysisIndex, gid: str) -> tuple:
    """Переводы счёта для сверки с источником: по дате; при избытке — самые крупные, тоже по дате."""
    rows = list(index.tx_by_gid.get(gid, []))
    total = len(rows)
    if total > MAX_SOURCE_ROWS:
        rows = sorted(rows, key=lambda tx: (-exact_decimal(tx["sum_kzt"]), tx["date"], tx["src"], tx["dst"]))[:MAX_SOURCE_ROWS]
    rows.sort(key=lambda tx: (tx["date"], tx["src"], tx["dst"]))
    return rows, total


def witness_for(node: dict, mode: str):
    """Датированный путь выбранного режима. Для режима без дат — пример «позже по датам», если он есть."""
    temporal = node.get("temporal", {})
    if mode == "same_day":
        return "same_day", temporal.get("same_day_witness")
    if temporal.get("strict_witness"):
        return "strict", temporal.get("strict_witness")
    if mode == "structural" and temporal.get("same_day_witness"):
        return "same_day", temporal.get("same_day_witness")
    return "strict", None


def observation_limits(node: dict) -> list:
    """Границы наблюдения счёта словами файла анализа; отсутствие исходящих на границе — не ноль."""
    limits = []
    observation = node.get("observation", {})
    if observation.get("outgoing_censored"):
        limits.append("Исходящие переводы не наблюдаются из-за границы сбора данных. Это не доказывает, что деньги остались на счёте.")
    limits.extend(observation.get("warnings", []))
    return limits


def provenance(analysis: dict) -> dict:
    summary = analysis.get("summary", {})
    return {
        "schema": analysis.get("schema_version", "—"),
        "policy": analysis.get("policy", {}).get("version", "—"),
        "sha256": summary.get("input_sha256", "—"),
        "period": f"{date_ru(summary.get('period_start'))} — {date_ru(summary.get('period_end'))}",
    }
