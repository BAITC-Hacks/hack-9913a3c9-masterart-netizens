"""Временная достижимость счетов от исходных клиентов.

Модуль отвечает на три разных вопроса к одному и тому же графу переводов:

* ``static`` — есть ли направленная цепочка наблюдаемых переводов от исходного клиента
  к счёту; даты не учитываются;
* ``strict`` — есть ли цепочка, в которой каждый следующий перевод совершён строго в более
  поздний день, чем предыдущий;
* ``same_day`` — есть ли цепочка с неубывающими датами. Порядок операций внутри дня в данных
  не зафиксирован, поэтому переводы одного дня образуют лишь возможную последовательность.

Результат — ответы на запросы к графу. Это не метка подозрительности, не оценка точности и не
доказательство того, что по цепочке прошли одни и те же деньги: суммы соседних переводов не
сопоставляются, модели очерёдности списания (FIFO и подобные) не применяются.

Для каждого достижимого счёта сохраняется один свидетель на режим — цепочка исходных
транзакций, которую аналитик может проверить по датам и суммам.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from bisect import bisect_left, bisect_right
from decimal import Decimal
from typing import NamedTuple

__all__ = ["compute_temporal"]

VERSION = "temporal/v1"

MODES = (
    {
        "key": "static",
        "label": "Структурная связь",
        "rule": "Существует направленная цепочка наблюдаемых переводов от исходного клиента "
        "к счёту; даты переводов не учитываются.",
    },
    {
        "key": "strict",
        "label": "Строго по датам",
        "rule": "Каждый следующий перевод цепочки совершён строго в более поздний день, "
        "чем предыдущий.",
    },
    {
        "key": "same_day",
        "label": "Возможно в тот же день",
        "rule": "Даты переводов в цепочке не убывают. Порядок операций внутри дня в данных "
        "не зафиксирован, поэтому переводы одного дня допускаются как возможная, "
        "но не наблюдаемая последовательность.",
    },
)

SEED_COUNT_RULE = (
    "Счётчик режима — число разных исходных клиентов, от которых счёт достижим по правилу "
    "режима. Исходный клиент не учитывается в собственном счётчике, даже если цепочка "
    "возвращается к нему."
)

WITNESS_RULE = (
    "Свидетель — одна цепочка исходных транзакций, подтверждающая достижимость в режиме: "
    "с наименьшим числом переводов, затем с самой ранней датой последнего перевода, затем "
    "от исходного клиента с меньшим идентификатором. Равноценные переводы упорядочены по дате, "
    "отправителю, получателю и сумме."
)

LIMITATIONS = (
    "Достижимость показывает, что цепочка переводов с такими датами существует, но не доказывает "
    "движение одних и тех же денег: суммы соседних переводов не сопоставляются.",
    "Даты известны с точностью до дня; порядок операций внутри одного дня неизвестен.",
    "Входящие переводы извне выборки, переводы дальше четвёртого перехода и суммы меньше "
    "5 000 тенге не наблюдаются, поэтому отсутствие цепочки не доказывает отсутствия связи.",
    "Число исходных клиентов, от которых достижим счёт, — результат запроса к графу, а не метка "
    "подозрительности и не оценка точности.",
)

_GID_PATTERN = re.compile(r"0|-?[1-9][0-9]{0,18}")
_DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_INT64_MIN, _INT64_MAX = -(2**63), 2**63 - 1
# Порядковый номер «дня до периода»: у любой реальной даты date.toordinal() не меньше 1.
_BEFORE_ANY_DAY = 0


class _Transfer(NamedTuple):
    """Одна исходная транзакция. Порядок полей задаёт канонический порядок сравнения."""

    day: int
    src_key: int
    dst_key: int
    amount: int | float
    src: str
    dst: str
    date: str


def compute_temporal(nodes, edges, transactions):
    """Считает достижимость каждого счёта от исходных клиентов в трёх режимах.

    Входы — проверенные списки словарей: узлы ``{gid, is_seed}``, рёбра ``{src, dst}`` и
    транзакции ``{src, dst, date, sum_kzt}``; идентификаторы — точные десятичные строки.
    Возвращает ``{"by_gid": {gid: temporal}, "summary": {...}}``. Результат не зависит от
    порядка строк во входных списках, а сами входные данные не изменяются.
    """
    node_ids, seeds = _read_nodes(nodes)
    known = set(node_ids)
    transfers = _read_transactions(transactions, known)
    successors = _read_edges(edges, known)
    # Структурный режим опирается на все наблюдаемые переходы; на согласованных данных
    # пары транзакций совпадают с рёбрами, и объединение ничего не меняет.
    for transfer in transfers:
        successors.setdefault(transfer.src, set()).add(transfer.dst)

    static_count = dict.fromkeys(node_ids, 0)
    for seed in seeds:
        for gid in _static_descendants(seed, successors):
            static_count[gid] += 1

    links = _index_links(transfers)
    strict_ids, strict_witness = _dated_reach(node_ids, seeds, links, strict=True)
    same_day_ids, same_day_witness = _dated_reach(node_ids, seeds, links, strict=False)

    by_gid = {}
    for gid in node_ids:
        by_gid[gid] = {
            "static_seed_count": static_count[gid],
            "strict_seed_count": len(strict_ids[gid]),
            "same_day_seed_count": len(same_day_ids[gid]),
            "strict_seed_ids": strict_ids[gid],
            "same_day_seed_ids": same_day_ids[gid],
            "strict_witness": strict_witness.get(gid),
            "same_day_witness": same_day_witness.get(gid),
        }

    counts = {
        "static": list(static_count.values()),
        "strict": [len(ids) for ids in strict_ids.values()],
        "same_day": [len(ids) for ids in same_day_ids.values()],
    }
    dates = sorted({transfer.date for transfer in transfers})
    summary = {
        "version": VERSION,
        "n_nodes": len(node_ids),
        "n_seeds": len(seeds),
        "n_transactions": len(transfers),
        "n_days": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "reachable_from_at_least_1_seed": {
            mode: sum(value >= 1 for value in values) for mode, values in counts.items()
        },
        "reachable_from_at_least_5_seeds": {
            mode: sum(value >= 5 for value in values) for mode, values in counts.items()
        },
        "max_seed_count": {mode: max(values, default=0) for mode, values in counts.items()},
        "modes": [dict(mode) for mode in MODES],
        "seed_count_rule": SEED_COUNT_RULE,
        "witness_rule": WITNESS_RULE,
        "limitations": list(LIMITATIONS),
    }
    return {"by_gid": by_gid, "summary": summary}


def _static_descendants(seed, successors):
    """Все счета, достижимые из исходного клиента по направленным переходам, кроме него самого."""
    seen = {seed}
    stack = [seed]
    while stack:
        for following in successors.get(stack.pop(), ()):
            if following not in seen:
                seen.add(following)
                stack.append(following)
    seen.discard(seed)
    return seen


def _index_links(transfers):
    """Группирует транзакции по паре «отправитель → получатель» в каноническом порядке."""
    grouped = {}
    for transfer in sorted(transfers):
        grouped.setdefault(transfer.src, {}).setdefault(transfer.dst, []).append(transfer)
    return {
        src: [
            (dst, [transfer.day for transfer in rows], rows)
            for dst, rows in sorted(by_dst.items(), key=lambda item: int(item[0]))
        ]
        for src, by_dst in grouped.items()
    }


def _dated_reach(node_ids, seeds, links, strict):
    """Для режима с датами возвращает исходных клиентов каждого счёта и по одному свидетелю."""
    reached_by = {gid: [] for gid in node_ids}
    best = {}
    for seed in seeds:
        first, parents = _shortest_journeys(seed, links, strict)
        for gid, (hops, day) in first.items():
            reached_by[gid].append(seed)
            rank = (hops, day, int(seed))
            if gid not in best or rank < best[gid][0]:
                best[gid] = (rank, seed, parents)
    witnesses = {
        gid: _witness(seed, gid, rank[0], parents) for gid, (rank, seed, parents) in best.items()
    }
    return reached_by, witnesses


def _shortest_journeys(seed, links, strict):
    """Находит для каждого счёта, достижимого из ``seed``, кратчайшую допустимую цепочку.

    Поиск идёт слоями по числу переводов. В слое для счёта хранится самая ранняя дата прихода
    среди цепочек этой длины, но только если она раньше, чем у всех более коротких цепочек:
    более длинная цепочка с не более ранним приходом не открывает новых продолжений. Поэтому
    первый слой, в котором появился счёт, даёт наименьшее число переводов, а дата в нём —
    самый ранний приход среди таких цепочек. Каждый слой строго улучшает дату хотя бы одного
    счёта, так что поиск конечен и на графах с циклами.

    Возвращает ``first`` (счёт → (число переводов, день прихода)) и ``parents``
    ((счёт, слой) → (предыдущий счёт, транзакция)) для восстановления цепочки.
    """
    earliest = {seed: _BEFORE_ANY_DAY}
    frontier = {seed: _BEFORE_ANY_DAY}
    parents = {}
    first = {}
    layer = 0
    while frontier:
        layer += 1
        chosen = {}
        for node, arrived in frontier.items():
            for dst, days, rows in links.get(node, ()):
                # Строгий режим требует более позднего дня, режим одного дня — не более раннего.
                index = bisect_right(days, arrived) if strict else bisect_left(days, arrived)
                if index == len(days):
                    continue
                transfer = rows[index]
                if transfer.day >= earliest.get(dst, math.inf):
                    continue
                current = chosen.get(dst)
                if current is None or transfer < current[1]:
                    chosen[dst] = (node, transfer)
        frontier = {}
        for dst, (node, transfer) in chosen.items():
            earliest[dst] = transfer.day
            frontier[dst] = transfer.day
            parents[(dst, layer)] = (node, transfer)
            first.setdefault(dst, (layer, transfer.day))
    return first, parents


def _witness(seed, target, hops, parents):
    """Восстанавливает цепочку исходных транзакций от ``seed`` до ``target``."""
    chain = []
    node = target
    for layer in range(hops, 0, -1):
        node, transfer = parents[(node, layer)]
        chain.append(transfer)
    if node != seed:
        raise RuntimeError(f"Цепочка для счёта {target} не начинается с исходного клиента {seed}")
    chain.reverse()
    return {
        "seed_gid": seed,
        "hops": [
            {"src": t.src, "dst": t.dst, "date": t.date, "sum_kzt": t.amount} for t in chain
        ],
    }


def _read_nodes(nodes):
    ids = []
    seeds = []
    seen = set()
    for number, row in enumerate(nodes, start=1):
        where = f"Узел {number}"
        gid = _gid(_field(row, "gid", where), where)
        if gid in seen:
            raise ValueError(f"{where}: счёт {gid} встречается в списке узлов повторно")
        seen.add(gid)
        ids.append(gid)
        if _flag(_field(row, "is_seed", where), where):
            seeds.append(gid)
    ids.sort(key=int)
    seeds.sort(key=int)
    return ids, seeds


def _read_edges(edges, known):
    successors = {}
    for number, row in enumerate(edges, start=1):
        where = f"Ребро {number}"
        src = _endpoint(row, "src", where, known)
        dst = _endpoint(row, "dst", where, known)
        successors.setdefault(src, set()).add(dst)
    return successors


def _read_transactions(transactions, known):
    transfers = []
    for number, row in enumerate(transactions, start=1):
        where = f"Транзакция {number}"
        src = _endpoint(row, "src", where, known)
        dst = _endpoint(row, "dst", where, known)
        day = _day(_field(row, "date", where), where)
        amount = _amount(_field(row, "sum_kzt", where), where)
        transfers.append(
            _Transfer(day.toordinal(), int(src), int(dst), amount, src, dst, day.isoformat())
        )
    return transfers


def _field(row, key, where):
    try:
        return row[key]
    except (KeyError, TypeError):
        raise ValueError(f"{where}: нет поля «{key}»") from None


def _endpoint(row, key, where, known):
    gid = _gid(_field(row, key, where), f"{where}, поле «{key}»")
    if gid not in known:
        raise ValueError(f"{where}: счёт {gid} в поле «{key}» отсутствует в списке узлов")
    return gid


def _gid(value, where):
    # Идентификаторы больше 2**53 теряют точность во float, поэтому float не принимается вовсе.
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"{where}: идентификатор должен быть десятичной строкой, получено {value!r}")
    text = value if isinstance(value, str) else str(int(value))
    if not _GID_PATTERN.fullmatch(text) or not _INT64_MIN <= int(text) <= _INT64_MAX:
        raise ValueError(f"{where}: {text!r} не является точной десятичной записью int64")
    return text


def _flag(value, where):
    if value is True or value is False:
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    raise ValueError(f"{where}: признак исходного клиента должен быть логическим, получено {value!r}")


def _day(value, where):
    parsed = value
    if isinstance(value, dt.datetime):
        parsed = value.date()
    elif isinstance(value, str) and _DATE_PATTERN.fullmatch(value):
        try:
            parsed = dt.date.fromisoformat(value)
        except ValueError:
            parsed = None
    if isinstance(parsed, dt.date) and not isinstance(parsed, dt.datetime):
        return parsed
    raise ValueError(f"{where}: дата должна иметь вид ГГГГ-ММ-ДД, получено {value!r}")


def _amount(value, where):
    # Сумма переносится в свидетеля без пересчёта; Decimal приводится к числу JSON.
    if isinstance(value, Decimal) and value.is_finite():
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    raise ValueError(f"{where}: сумма должна быть конечным числом, получено {value!r}")
