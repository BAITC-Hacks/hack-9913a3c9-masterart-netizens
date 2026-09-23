"""Дополнительные наблюдения по графу переводов для необязательных пунктов задания.

Модуль читает готовый analysis.json и ничего в нём не меняет: роли, приоритеты, кластеры
и CSV-выгрузки ядра остаются прежними. Каждое наблюдение возвращается с параметрами,
счётчиками, ограниченным числом примеров из исходных транзакций и ограничениями.

Разделы:
- быстрый транзит за 0–2 дня, схождение плательщиков в один день, всплески активности;
- повторяющиеся маршруты A→B→C и короткие направленные циклы (возвраты);
- серии переводов одной пары (возможное дробление) и необычный профиль для своей глубины;
- структурные сценарии удаления счетов с наибольшим приоритетом;
- запросы данных, без которых наблюдения нельзя проверить.

Наблюдение — отбор для проверки, а не вывод: даты не доказывают движение тех же денег,
а переводы меньше 5 000 ₸ в выгрузке отсутствуют.

Подключение (делает интегратор, после build_analysis и до записи выгрузок):
    from backend.insights import compute_insights
    analysis["insights"] = compute_insights(analysis)
Контракт analysis.json допускает дополнительные ключи; CSV-файлы не меняются. Функция принимает
и словарь из build_analysis, и тот же словарь после чтения из JSON.

Схема результата (finance-insights/v1):
    sections[]: key, title, case_item, method, parameters{имя: value, unit, rationale}, counts,
                examples[] (не более MAX_EXAMPLES, с исходными транзакциями {src, dst, date, sum_kzt}),
                limitations[]; у bursts — daily[], у depth_profile — cohorts[],
                у resilience — baseline, scenarios[], summary_text.
    by_gid{gid: [{section, text}]} — короткие строки для карточки счёта;
    case_items[], review_load, analyst_effort_hypothesis, limitations[].
"""

from __future__ import annotations

import datetime as dt
import random
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from decimal import Decimal
from fractions import Fraction
from typing import NamedTuple

from . import insight_policy as ip
from . import policy
from .fmt import kzt_ru, kzt_value, percent_ru, plural_ru

_MONTHS_RU = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)

CASE_ITEMS = [
    {"key": "temporal", "title": "Временные паттерны", "sections": ["pass_through", "convergence", "bursts"]},
    {"key": "routes", "title": "Повторяющиеся маршруты и возвраты", "sections": ["routes", "cycles"]},
    {"key": "anomalies", "title": "Аномалии", "sections": ["splitting", "depth_profile"]},
    {"key": "resilience", "title": "Устойчивость сети", "sections": ["resilience"]},
    {"key": "completeness", "title": "Полнота данных", "sections": ["data_requests"]},
]


class Tx(NamedTuple):
    """Исходная транзакция; порядок кортежа — дата, отправитель, получатель, сумма."""

    date: dt.date
    src_key: int
    dst_key: int
    tiyn: int
    src: str
    dst: str


class _Section(NamedTuple):
    public: dict
    flags: dict  # gid → одна короткая строка для карточки счёта
    needs: dict  # ключ запроса данных → множество gid


# --- разбор входа -----------------------------------------------------------------------------


def _gid(value) -> str:
    """gid как точная десятичная строка; float и нецифровые значения отвергаются."""
    if isinstance(value, (bool, float)):
        raise ValueError(f"Идентификатор {value!r} должен быть целым числом в десятичной записи")
    text = str(value)
    if not text.isdigit() or str(int(text)) != text:
        raise ValueError(f"Идентификатор {value!r} должен быть целым числом в десятичной записи")
    return text


def _tiyn(value) -> int:
    """Сумма в тенге из JSON → целые тиыны без потерь (0,01 ₸ = 1 тиын)."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError(f"Сумма {value!r} не является числом")
    amount = Decimal(str(value)) * 100
    if amount != amount.to_integral_value():
        raise ValueError(f"Сумма {value!r} задана точнее одного тиына")
    return int(amount)


def _rec(t: Tx) -> dict:
    """Строка транзакции в той же форме, что и в analysis.json."""
    return {"src": t.src, "dst": t.dst, "date": t.date.isoformat(), "sum_kzt": kzt_value(t.tiyn)}


def _day_ru(d: dt.date) -> str:
    return f"{d.day} {_MONTHS_RU[d.month - 1]}"


def _window_ru(a: dt.date, b: dt.date) -> str:
    if a == b:
        return _day_ru(a)
    if a.month == b.month:
        return f"{a.day}–{b.day} {_MONTHS_RU[a.month - 1]}"
    return f"{_day_ru(a)} – {_day_ru(b)}"


def _num_ru(x: float, digits: int = 1) -> str:
    return f"{x:.{digits}f}".replace(".", ",")


def _times_ru(x: float) -> str:
    """«в 3,5 раза», «в 12 раз»."""
    if x >= 10:
        n = int(round(x))
        return f"в {n} {plural_ru(n, 'раз', 'раза', 'раз')}"
    return f"в {_num_ru(x)} раза"


def _tx_ru(n: int) -> str:
    return f"{n} {plural_ru(n, 'перевод', 'перевода', 'переводов')}"


def _of_outgoing_ru(n: int) -> str:
    """«из 1 исходящего перевода», «из 67 исходящих переводов»."""
    return f"из {n} {plural_ru(n, 'исходящего перевода', 'исходящих переводов', 'исходящих переводов')}"


def _median(values: list):
    s = sorted(values)
    if not s:
        return None
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


class _Graph:
    """Проиндексированные строки analysis.json; все порядки заданы явно по целому значению gid."""

    def __init__(self, analysis: dict):
        nodes = analysis.get("nodes") or []
        self.nodes = {}
        for n in nodes:
            gid = _gid(n["gid"])
            if gid in self.nodes:
                raise ValueError(f"Счёт {gid} повторяется в nodes")
            self.nodes[gid] = n
        self.gids = sorted(self.nodes, key=int)

        txs = []
        for t in analysis.get("transactions") or []:
            src, dst = _gid(t["src"]), _gid(t["dst"])
            for g in (src, dst):
                if g not in self.nodes:
                    raise ValueError(f"Транзакция ссылается на счёт {g}, которого нет в nodes")
            txs.append(Tx(dt.date.fromisoformat(t["date"]), int(src), int(dst), _tiyn(t["sum_kzt"]), src, dst))
        self.tx = sorted(txs)

        self.pair_tx = defaultdict(list)
        self.in_tx = defaultdict(list)
        self.out_tx = defaultdict(list)
        for t in self.tx:
            self.pair_tx[(t.src, t.dst)].append(t)
            self.in_tx[t.dst].append(t)
            self.out_tx[t.src].append(t)

        self.edges = {}
        for e in analysis.get("edges") or []:
            src, dst = _gid(e["src"]), _gid(e["dst"])
            for g in (src, dst):
                if g not in self.nodes:
                    raise ValueError(f"Ребро ссылается на счёт {g}, которого нет в nodes")
            self.edges[(src, dst)] = (_tiyn(e["sum_kzt"]), int(e["n_tx"]))
        out_nbrs, in_nbrs = defaultdict(list), defaultdict(list)
        for src, dst in self.edges:
            out_nbrs[src].append(dst)
            in_nbrs[dst].append(src)
        self.out_nbrs = {g: sorted(v, key=int) for g, v in out_nbrs.items()}
        self.in_nbrs = {g: sorted(v, key=int) for g, v in in_nbrs.items()}

        summary = analysis.get("summary") or {}
        start, end = summary.get("period_start"), summary.get("period_end")
        self.start = dt.date.fromisoformat(start) if start else (self.tx[0].date if self.tx else None)
        self.end = dt.date.fromisoformat(end) if end else (self.tx[-1].date if self.tx else None)

    def depth(self, gid: str) -> int:
        return int(self.nodes[gid]["depth"])

    def is_seed(self, gid: str) -> bool:
        return bool(self.nodes[gid]["is_seed"])

    def censored(self, gid: str) -> bool:
        """Исходящие переводы счёта на границе выборки не собирались."""
        return self.depth(gid) >= policy.TRACE_HORIZON_DEPTH

    def edge_rec(self, src: str, dst: str) -> dict:
        tiyn, n_tx = self.edges[(src, dst)]
        return {"src": src, "dst": dst, "sum_kzt": kzt_value(tiyn), "n_tx": n_tx}


def _section(key: str, title: str, case_item: str, method: str, counts: dict, examples: list,
             limitations: list, parameters: dict | None = None, **extra) -> dict:
    body = {
        "key": key,
        "title": title,
        "case_item": case_item,
        "method": method,
        "parameters": parameters if parameters is not None else ip.parameters_payload().get(key, {}),
        "counts": counts,
        "examples": examples,
        "limitations": limitations,
    }
    body.update(extra)
    return body


# --- временные паттерны -------------------------------------------------------------------


def _pass_through(g: _Graph) -> _Section:
    lo, hi = (Fraction(str(x)) for x in ip.PASS_THROUGH_RATIO)
    max_lag = ip.PASS_THROUGH_MAX_LAG_DAYS
    found = []
    for gid in g.gids:
        ins, outs = g.in_tx.get(gid), g.out_tx.get(gid)
        if not ins or not outs:
            continue
        in_dates = [i.date for i in ins]
        pairs = []
        for o in outs:
            best = None
            # Только входящие за max_lag дней до исходящего: окно ищется двоичным поиском по датам.
            first = bisect_left(in_dates, o.date - dt.timedelta(days=max_lag))
            last = bisect_right(in_dates, o.date)
            for i in ins[first:last]:
                lag = (o.date - i.date).days
                if lo * i.tiyn <= o.tiyn <= hi * i.tiyn:
                    key = (lag, abs(o.tiyn - i.tiyn), i)
                    if best is None or key < best:
                        best = key
            if best is not None:
                pairs.append((o, best[2], best[0]))
        if pairs:
            found.append((gid, outs, pairs))

    rows = []
    flags, same_day = {}, set()
    by_lag = Counter()
    for gid, outs, pairs in found:
        out_total = sum(t.tiyn for t in outs)
        matched = sum(o.tiyn for o, _, _ in pairs)
        lags = Counter(lag for _, _, lag in pairs)
        by_lag.update(lags)
        if lags.get(0):
            same_day.add(gid)
        share = matched / out_total
        shown = sorted(pairs, key=lambda p: (-p[0].tiyn, p[2], p[0], p[1]))[:3]
        text = (
            f"{len(pairs)} {_of_outgoing_ru(len(outs))} — через 0–{max_lag} дня после входящего "
            f"сопоставимой суммы; это {percent_ru(share)} исходящей суммы."
        )
        rows.append(
            {
                "gid": gid,
                "depth": g.depth(gid),
                "is_seed": g.is_seed(gid),
                "out_tx_total": len(outs),
                "out_tx_matched": len(pairs),
                "out_kzt_total": kzt_value(out_total),
                "out_kzt_matched": kzt_value(matched),
                "matched_share": round(share, 4),
                "lag_days": {str(k): lags.get(k, 0) for k in range(max_lag + 1)},
                "pairs": [{"in": _rec(i), "out": _rec(o), "lag_days": lag} for o, i, lag in shown],
                "text": text,
                "_sort": (-matched, int(gid)),
            }
        )
        flags[gid] = f"Быстрый транзит: {len(pairs)} {_of_outgoing_ru(len(outs))} через 0–{max_lag} дня после входящего"
    rows.sort(key=lambda r: r.pop("_sort"))
    counts = {
        "accounts": len(rows),
        "accounts_majority_share": sum(1 for r in rows if r["matched_share"] >= 0.5),
        "outgoing_matched": sum(r["out_tx_matched"] for r in rows),
        "by_lag_days": {str(k): by_lag.get(k, 0) for k in range(max_lag + 1)},
    }
    method = (
        "Для каждого исходящего перевода счёта ищется входящий перевод того же счёта не раньше чем "
        f"за {max_lag} дня до него, с суммой исходящего от 80% до 120% входящего. Считаются исходящие "
        "переводы, для которых такой входящий нашёлся; один входящий может подходить нескольким исходящим."
    )
    limitations = [
        "Совпадение сроков и сумм не доказывает, что дальше переведены те же деньги.",
        "Лаг 0 — перевод в тот же день: порядок операций внутри дня неизвестен, исходящий мог быть раньше входящего.",
        "Входящие переводы из-за пределов выборки не видны, поэтому часть транзита может остаться незамеченной.",
    ]
    public = _section(
        "pass_through", f"Быстрый транзит за 0–{max_lag} дня", "Временные паттерны", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations,
    )
    return _Section(public, flags, {"intraday_time": same_day})


def _convergence(g: _Graph) -> _Section:
    groups = defaultdict(list)
    for t in g.tx:
        groups[(t.dst, t.date)].append(t)
    lag = ip.PASS_THROUGH_MAX_LAG_DAYS
    rows, flags, censored = [], defaultdict(list), set()
    for (dst, day), txs in groups.items():
        payers = sorted({t.src for t in txs}, key=int)
        if len(payers) < ip.CONVERGENCE_MIN_PAYERS:
            continue
        total = sum(t.tiyn for t in txs)
        if g.censored(dst):
            censored.add(dst)
            onward_n, onward_kzt = None, None
            tail = "исходящие переводы счёта на границе выборки не собирались."
        else:
            onward = [t for t in g.out_tx.get(dst, []) if 0 <= (t.date - day).days <= lag]
            onward_n, onward_kzt = len(onward), kzt_value(sum(t.tiyn for t in onward))
            tail = (
                f"за 0–{lag} дня после этого отправлено {kzt_ru(sum(t.tiyn for t in onward))}."
                if onward else f"за 0–{lag} дня после этого исходящих переводов нет."
            )
        n = len(payers)
        rows.append(
            {
                "gid": dst,
                "date": day.isoformat(),
                "depth": g.depth(dst),
                "n_payers": n,
                "n_tx": len(txs),
                "sum_kzt": kzt_value(total),
                "payers": payers[: ip.MAX_RECORDS],
                "onward_n_tx": onward_n,
                "onward_kzt": onward_kzt,
                "transactions": [_rec(t) for t in sorted(txs, key=lambda t: (-t.tiyn, t))[: ip.MAX_RECORDS]],
                "text": f"{n} {plural_ru(n, 'плательщик', 'плательщика', 'плательщиков')} "
                        f"{_day_ru(day)}: {kzt_ru(total)}; {tail}",
                "_sort": (-n, -total, day, int(dst)),
            }
        )
        flags[dst].append((day, n))
    rows.sort(key=lambda r: r.pop("_sort"))
    flag_text = {}
    for gid, events in flags.items():
        events.sort()
        top = max(n for _, n in events)
        flag_text[gid] = (
            f"Схождение: до {top} {plural_ru(top, 'плательщика', 'плательщиков', 'плательщиков')} в один день ({len(events)} "
            f"{plural_ru(len(events), 'день', 'дня', 'дней')})"
        )
    counts = {
        "events": len(rows),
        "accounts": len(flags),
        "max_payers": max((r["n_payers"] for r in rows), default=0),
        "events_at_boundary": sum(1 for r in rows if r["onward_n_tx"] is None),
    }
    method = (
        f"Для каждого счёта и календарного дня считается число разных плательщиков. Схождение — не менее "
        f"{ip.CONVERGENCE_MIN_PAYERS} плательщиков в один день; рядом показано, сколько счёт отправил за "
        f"0–{lag} дня после этого."
    )
    limitations = [
        "Одновременные поступления от разных плательщиков бывают и у обычных получателей: это повод для проверки, а не вывод.",
        "Отправка после схождения не означает, что переведены именно поступившие деньги.",
    ]
    public = _section(
        "convergence", "Схождение плательщиков в один день", "Временные паттерны", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations,
    )
    return _Section(public, flag_text, {"beyond_depth4": censored})


def _max_window(txs: list, window_days: int) -> tuple:
    """Окно из window_days дней подряд с наибольшим числом переводов; при равенстве — самое раннее."""
    best, j = (0, 0, -1), 0
    for i, t in enumerate(txs):
        while (t.date - txs[j].date).days > window_days - 1:
            j += 1
        if i - j + 1 > best[0]:
            best = (i - j + 1, j, i)
    return best


def _bursts(g: _Graph) -> _Section:
    w = ip.BURST_WINDOW_DAYS
    rows, flags, censored = [], {}, set()
    for gid in g.gids:
        own = g.in_tx.get(gid, []) + g.out_tx.get(gid, [])
        if not own or g.end is None:
            continue
        first = min(t.date for t in own)
        basis_days = max((g.end - first).days + 1, w)
        for direction, txs in (("out", g.out_tx.get(gid, [])), ("in", g.in_tx.get(gid, []))):
            n = len(txs)
            if n < ip.BURST_MIN_TX:
                continue
            k, j, i = _max_window(txs, w)
            ratio = (k / w) / (n / basis_days)
            if k < ip.BURST_MIN_TX or ratio < ip.BURST_MIN_RATE_RATIO:
                continue
            window = txs[j : i + 1]
            parties = {t.dst if direction == "out" else t.src for t in window}
            total = sum(t.tiyn for t in window)
            what = "исходящих" if direction == "out" else "входящих"
            who = (
                f"{len(parties)} {plural_ru(len(parties), 'получателю', 'получателям', 'получателям')}"
                if direction == "out"
                else f"от {len(parties)} {plural_ru(len(parties), 'плательщика', 'плательщиков', 'плательщиков')}"
            )
            text = (
                f"Всплеск {what}: {_tx_ru(k)} {who} за {_window_ru(window[0].date, window[-1].date)}, "
                f"{kzt_ru(total)} — {_times_ru(ratio)} чаще собственного среднего темпа ({n} за {basis_days} дн.)."
            )
            rows.append(
                {
                    "gid": gid,
                    "depth": g.depth(gid),
                    "direction": direction,
                    "window_start": window[0].date.isoformat(),
                    "window_end": window[-1].date.isoformat(),
                    "n_tx": k,
                    "n_counterparties": len(parties),
                    "sum_kzt": kzt_value(total),
                    "period_tx": n,
                    "basis_days": basis_days,
                    "rate_ratio": round(ratio, 2),
                    "transactions": [_rec(t) for t in sorted(window, key=lambda t: (-t.tiyn, t))[: ip.MAX_RECORDS]],
                    "text": text,
                    "_sort": (-k, -ratio, int(gid), direction),
                }
            )
            label = "исходящих" if direction == "out" else "входящих"
            flags[gid] = (flags[gid] + "; " if gid in flags else "Всплеск: ") + f"{k} {label} за {w} дня"
            if direction == "in" and g.censored(gid):
                censored.add(gid)
    rows.sort(key=lambda r: r.pop("_sort"))

    daily = []
    if g.start and g.end:
        per_day = defaultdict(lambda: [0, 0])
        for t in g.tx:
            per_day[t.date][0] += 1
            per_day[t.date][1] += t.tiyn
        day = g.start
        while day <= g.end:
            n, s = per_day.get(day, (0, 0))
            daily.append({"date": day.isoformat(), "n_tx": n, "sum_kzt": kzt_value(s)})
            day += dt.timedelta(days=1)

    counts = {
        "accounts": len(flags),
        "out_bursts": sum(1 for r in rows if r["direction"] == "out"),
        "in_bursts": sum(1 for r in rows if r["direction"] == "in"),
    }
    method = (
        f"Для каждого счёта и направления ищется окно из {w} дней подряд с наибольшим числом переводов. "
        f"Всплеск — не менее {ip.BURST_MIN_TX} переводов в окне при темпе, в {_num_ru(ip.BURST_MIN_RATE_RATIO)} "
        "раза и более превышающем средний темп счёта с первого наблюдаемого перевода до конца периода."
    )
    limitations = [
        "Всплеск описывает только частоту переводов; причина (зарплата, закупка, вывод средств) из данных не следует.",
        "Для входящих учитываются только плательщики из выборки.",
    ]
    public = _section(
        "bursts", "Всплески активности", "Временные паттерны", method, counts, rows[: ip.MAX_EXAMPLES],
        limitations, daily=daily,
    )
    return _Section(public, flags, {"beyond_depth4": censored})


# --- маршруты и циклы -----------------------------------------------------------------------


def _match_days(first: list, then: list, max_lag: int) -> list:
    """Жадное сопоставление дней первого и второго перевода (0 ≤ лаг ≤ max_lag), каждый день — один раз.

    Для интервалов одинаковой длины выбор самого раннего подходящего дня даёт наибольшее число пар.
    """
    pairs, j = [], 0
    for d1 in first:
        while j < len(then) and then[j] < d1:
            j += 1
        if j < len(then) and (then[j] - d1).days <= max_lag:
            pairs.append((d1, then[j]))
            j += 1
    return pairs


def _routes(g: _Graph) -> _Section:
    max_lag = ip.ROUTE_MAX_LAG_DAYS
    days = {pair: sorted({t.date for t in txs}) for pair, txs in g.pair_tx.items()}
    rows, structural = [], 0
    member = defaultdict(lambda: [0, 0])  # gid → [маршрутов всего, из них в середине]
    for b in g.gids:
        for a in g.in_nbrs.get(b, []):
            for c in g.out_nbrs.get(b, []):
                if c == a:
                    continue  # возврат A→B→A учитывается в циклах
                if g.edges[(a, b)][1] >= 2 and g.edges[(b, c)][1] >= 2:
                    structural += 1
                matches = _match_days(days.get((a, b), []), days.get((b, c), []), max_lag)
                if len(matches) < ip.ROUTE_MIN_REPEATS:
                    continue
                occurrences = []
                for d1, d2 in matches[:3]:
                    first = next(t for t in g.pair_tx[(a, b)] if t.date == d1)
                    then = next(t for t in g.pair_tx[(b, c)] if t.date == d2)
                    occurrences.append({"first": _rec(first), "then": _rec(then), "lag_days": (d2 - d1).days})
                m = len(matches)
                low = min(g.edges[(a, b)][0], g.edges[(b, c)][0])
                rows.append(
                    {
                        "route": [a, b, c],
                        "repeats": m,
                        "edges": [g.edge_rec(a, b), g.edge_rec(b, c)],
                        "occurrences": occurrences,
                        "text": f"Маршрут повторился {m} {plural_ru(m, 'раз', 'раза', 'раз')}: после перевода "
                                f"A→B перевод B→C следовал не позже чем через {max_lag} дня.",
                        "_sort": (-m, -low, int(a), int(b), int(c)),
                    }
                )
                for gid in (a, b, c):
                    member[gid][0] += 1
                member[b][1] += 1
    rows.sort(key=lambda r: r.pop("_sort"))
    flags = {
        gid: f"Повторяющиеся маршруты A→B→C: {n}" + (f", в середине — {mid}" if mid else "")
        for gid, (n, mid) in member.items()
    }
    counts = {
        "routes_dated": len(rows),
        "routes_structural_repeated": structural,
        "middle_accounts": sum(1 for _, mid in member.values() if mid),
        "max_repeats": max((r["repeats"] for r in rows), default=0),
    }
    method = (
        "Для каждой пары соседних рёбер A→B→C (A ≠ C) дни переводов A→B сопоставляются с днями переводов "
        f"B→C в пределах 0–{max_lag} дней, каждый день используется один раз. Маршрут устойчивый, если так "
        f"сопоставлено не менее {ip.ROUTE_MIN_REPEATS} разных дней. Отдельно считаются маршруты, где оба "
        "ребра повторялись, без учёта дат."
    )
    limitations = [
        "Повтор маршрута показывает регулярную связь счетов, а не передачу тех же денег по цепочке.",
        "Лаг 0 допускает, что перевод B→C в тот же день был раньше перевода A→B.",
    ]
    public = _section(
        "routes", "Повторяющиеся маршруты A→B→C", "Повторяющиеся маршруты и возвраты", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations,
    )
    return _Section(public, flags, {})


def _enumerate_cycles(g: _Graph) -> list:
    """Простые направленные циклы длиной 2..CYCLE_MAX_LENGTH.

    Каждый цикл записывается один раз, начиная с наименьшего gid; направление сохраняется.
    """
    order = {gid: i for i, gid in enumerate(g.gids)}
    cycles = []
    cap = ip.CYCLE_ENUMERATION_CAP

    def walk(start, v, path):
        for w in g.out_nbrs.get(v, []):
            if len(cycles) >= cap:
                return
            if w == start and len(path) >= 2:
                cycles.append(list(path))
            elif order[w] > order[start] and w not in path and len(path) < ip.CYCLE_MAX_LENGTH:
                path.append(w)
                walk(start, w, path)
                path.pop()

    for s in g.gids:
        if len(cycles) >= cap:
            break
        walk(s, s, [s])
    return cycles


def _dated_walk(g: _Graph, pairs: list, strict: bool):
    """Самая ранняя цепочка исходных транзакций по рёбрам pairs с неубывающими (строго возрастающими) датами."""
    hops, prev = [], None
    for pair in pairs:
        nxt = None
        for t in g.pair_tx.get(pair, []):
            if prev is None or (t.date > prev if strict else t.date >= prev):
                nxt = t
                break
        if nxt is None:
            return None
        hops.append(nxt)
        prev = nxt.date
    return hops


def _cycle_witness(g: _Graph, cycle: list, strict: bool):
    k = len(cycle)
    best = None
    for r in range(k):
        rotated = cycle[r:] + cycle[:r]
        pairs = [(rotated[i], rotated[(i + 1) % k]) for i in range(k)]
        hops = _dated_walk(g, pairs, strict)
        if hops is not None:
            key = (hops[-1].date, hops[0].date, r)
            if best is None or key < best[0]:
                best = (key, hops)
    return None if best is None else best[1]


def _cycles(g: _Graph) -> _Section:
    rank = {"strict": 0, "same_day": 1, "none": 2}
    rows, flags_n, flags_dated, same_day_members = [], Counter(), Counter(), set()
    found = _enumerate_cycles(g)
    for cycle in found:
        k = len(cycle)
        pairs = [(cycle[i], cycle[(i + 1) % k]) for i in range(k)]
        witness = _cycle_witness(g, cycle, strict=True)
        dated = "strict"
        if witness is None:
            witness = _cycle_witness(g, cycle, strict=False)
            dated = "same_day" if witness is not None else "none"
        low = min(g.edges[p][0] for p in pairs)
        if dated == "strict":
            text = (
                f"Цикл из {k} счетов: есть цепочка переводов со строго возрастающими датами, вернувшаяся к "
                f"первому счёту ({_window_ru(witness[0].date, witness[-1].date)})."
            )
        elif dated == "same_day":
            text = f"Цикл из {k} счетов: замкнуть его по датам можно, только если переводы одного дня шли в нужном порядке."
            same_day_members.update(cycle)
        else:
            text = f"Структурный цикл из {k} счетов: переводы по кругу есть, но их даты не образуют возврата."
        rows.append(
            {
                "cycle": cycle,
                "length": k,
                "edges": [g.edge_rec(*p) for p in pairs],
                "bottleneck_kzt": kzt_value(low),
                "dated_return": dated,
                "witness": None if witness is None else [_rec(t) for t in witness],
                "text": text,
                "_sort": (rank[dated], -low, k, [int(x) for x in cycle]),
            }
        )
        for gid in cycle:
            flags_n[gid] += 1
            if dated == "strict":
                flags_dated[gid] += 1
    rows.sort(key=lambda r: r.pop("_sort"))
    flags = {
        gid: f"Циклы (возвраты): {n}, из них с возвратом по возрастающим датам — {flags_dated.get(gid, 0)}"
        for gid, n in flags_n.items()
    }
    by_length = Counter(r["length"] for r in rows)
    counts = {
        "cycles": len(rows),
        "by_length": {str(k): by_length.get(k, 0) for k in range(2, ip.CYCLE_MAX_LENGTH + 1)},
        "dated_strict": sum(1 for r in rows if r["dated_return"] == "strict"),
        "dated_same_day_only": sum(1 for r in rows if r["dated_return"] == "same_day"),
        "structural_only": sum(1 for r in rows if r["dated_return"] == "none"),
        "accounts": len(flags_n),
        "truncated": len(found) >= ip.CYCLE_ENUMERATION_CAP,
    }
    method = (
        f"Перечисляются все простые направленные циклы длиной от 2 до {ip.CYCLE_MAX_LENGTH} счетов; цикл "
        "записывается один раз, начиная с наименьшего gid. Затем проверяется, можно ли обойти цикл по исходным "
        "транзакциям со строго возрастающими датами или хотя бы с неубывающими (переводы одного дня). "
        "Цепочка-свидетель — самая ранняя такая последовательность."
    )
    limitations = [
        "Цикл — структурный факт: переводы по кругу существуют. Он не доказывает возврат тех же денег.",
        "Цикл без подходящих дат остаётся структурным; с переводами одного дня — только возможным.",
        f"Перечисление останавливается на {ip.CYCLE_ENUMERATION_CAP} циклах; при truncated = true счётчики — нижняя граница.",
    ]
    public = _section(
        "cycles", "Короткие циклы и возвраты", "Повторяющиеся маршруты и возвраты", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations,
    )
    return _Section(public, flags, {"intraday_time": same_day_members})


# --- аномалии -----------------------------------------------------------------------------


def _splitting(g: _Graph) -> _Section:
    w = ip.SPLIT_WINDOW_DAYS
    rows, members = [], defaultdict(int)
    for (src, dst), txs in g.pair_tx.items():
        if len(txs) < ip.SPLIT_MIN_PARTS:
            continue
        k, j, i = _max_window(txs, w)
        if k < ip.SPLIT_MIN_PARTS:
            continue
        part = txs[j : i + 1]
        total = sum(t.tiyn for t in part)
        identical = max(Counter(t.tiyn for t in part).values())
        pair_total = sum(t.tiyn for t in txs)
        rows.append(
            {
                "src": src,
                "dst": dst,
                "window_start": part[0].date.isoformat(),
                "window_end": part[-1].date.isoformat(),
                "n_parts": k,
                "sum_kzt": kzt_value(total),
                "min_kzt": kzt_value(min(t.tiyn for t in part)),
                "max_kzt": kzt_value(max(t.tiyn for t in part)),
                "identical_parts": identical if identical > 1 else 0,
                "pair_sum_kzt": kzt_value(pair_total),
                "pair_n_tx": len(txs),
                "transactions": [_rec(t) for t in part[: ip.MAX_RECORDS]],
                "text": f"{_tx_ru(k)} одной пары за {_window_ru(part[0].date, part[-1].date)}: {kzt_ru(total)}, "
                        f"от {kzt_ru(min(t.tiyn for t in part))} до {kzt_ru(max(t.tiyn for t in part))}"
                        + (f"; одинаковых сумм — {identical}" if identical > 1 else "")
                        + ". Возможны дробление или регулярные платежи.",
                "_sort": (-k, -total, int(src), int(dst)),
            }
        )
        members[src] += 1
        members[dst] += 1
    rows.sort(key=lambda r: r.pop("_sort"))
    flags = {
        gid: f"Серии из {ip.SPLIT_MIN_PARTS} и более переводов одной пары за {w} дня: {n}" for gid, n in members.items()
    }
    counts = {
        "pairs": len(rows),
        "with_identical_amounts": sum(1 for r in rows if r["identical_parts"]),
        "parts": sum(r["n_parts"] for r in rows),
        "accounts": len(members),
    }
    method = (
        f"Для каждой пары отправитель→получатель ищется окно из {w} дней подряд с наибольшим числом переводов. "
        f"Серия — не менее {ip.SPLIT_MIN_PARTS} переводов в окне; отдельно считается число одинаковых сумм."
    )
    limitations = [
        "Переводы меньше 5 000 ₸ в выгрузке отсутствуют: дробление на более мелкие суммы не видно и не оценивается.",
        "Серия переводов одной пары бывает и у законных регулярных платежей.",
    ]
    public = _section(
        "splitting", "Серии переводов одной пары (возможное дробление)", "Аномалии", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations,
    )
    return _Section(public, flags, {"below_floor": set(members)})


_FEATURES = (
    # имя, подпись, направление, сумма ли (в тиынах) — иначе счётчик
    ("in_kzt", "получено", "in", True),
    ("out_kzt", "отправлено", "out", True),
    ("in_degree", "разных плательщиков", "in", False),
    ("out_degree", "разных получателей", "out", False),
    ("in_tx", "входящих переводов", "in", False),
    ("out_tx", "исходящих переводов", "out", False),
)
_MIN_AMOUNT_TIYN = 5000 * 100  # минимальная сумма перевода, попавшего в выгрузку


def _profile_values(g: _Graph) -> dict:
    """Показатели профиля из рёбер: суммы в тиынах, число контрагентов и переводов."""
    values = {gid: dict.fromkeys((f[0] for f in _FEATURES), 0) for gid in g.gids}
    for (src, dst), (tiyn, n_tx) in g.edges.items():
        values[src]["out_kzt"] += tiyn
        values[src]["out_degree"] += 1
        values[src]["out_tx"] += n_tx
        values[dst]["in_kzt"] += tiyn
        values[dst]["in_degree"] += 1
        values[dst]["in_tx"] += n_tx
    return values


def _feature_value(x, is_amount: bool):
    return kzt_value(int(round(x))) if is_amount else x


def _feature_ru(x, is_amount: bool) -> str:
    return kzt_ru(int(round(x))) if is_amount else _num_ru(x, 0) if float(x).is_integer() else _num_ru(x)


def _depth_profile(g: _Graph) -> _Section:
    values = _profile_values(g)
    cohorts = defaultdict(list)
    for gid in g.gids:
        cohorts[g.depth(gid)].append(gid)
    flagged, cohort_rows = {}, []
    for depth in sorted(cohorts):
        members = cohorts[depth]
        size = len(members)
        row = {"depth": depth, "size": size, "medians": {}, "analysed": size >= ip.ANOMALY_MIN_COHORT}
        cohort_rows.append(row)
        if not row["analysed"]:
            continue
        max_tail = max(1, int(ip.ANOMALY_TAIL_SHARE * size))
        for name, label, direction, is_amount in _FEATURES:
            if direction == "out" and depth >= policy.TRACE_HORIZON_DEPTH:
                continue  # исходящие на границе выборки не собирались
            raw = sorted(values[gid][name] for gid in members)
            med = _median(raw)
            row["medians"][name] = _feature_value(med, is_amount)
            floor = max(med, _MIN_AMOUNT_TIYN if is_amount else 1)
            for gid in members:
                x = values[gid][name]
                if x < ip.ANOMALY_MIN_RATIO * floor:
                    continue
                below = bisect_left(raw, x)
                if size - below > max_tail:
                    continue
                flagged.setdefault(gid, []).append(
                    {
                        "name": name,
                        "label": label,
                        "value": _feature_value(x, is_amount),
                        "cohort_median": _feature_value(med, is_amount),
                        "ratio_to_median": round(x / med, 1) if med else None,
                        "accounts_at_or_above": size - below,
                        "below_share": round(below / size, 4),
                        "_rank": (size - below, -x / floor),
                        "_ru": (_feature_ru(x, is_amount), _feature_ru(med, is_amount)),
                    }
                )
    rows, flags = [], {}
    for gid, feats in flagged.items():
        feats.sort(key=lambda f: (f["_rank"], f["name"]))
        top = feats[0]
        depth = g.depth(gid)
        below_pct = f"{int(top['below_share'] * 100)}%"
        value_ru, median_ru = top["_ru"]
        text = (
            f"Необычно для глубины {depth}: {top['label']} — {value_ru}; это больше, чем у {below_pct} счетов "
            f"той же глубины, при медиане {median_ru}."
        )
        if len(feats) > 1:
            text += f" Ещё показателей выше порога: {len(feats) - 1}."
        sort_key = (top["_rank"], int(gid))
        for f in feats:
            f.pop("_rank")
            f.pop("_ru")
        rows.append(
            {
                "gid": gid,
                "depth": depth,
                "cohort_size": len(cohorts[depth]),
                "features": feats,
                "text": text,
                "_sort": sort_key,
            }
        )
        flags[gid] = f"Профиль необычен для глубины {depth}: {top['label']} больше, чем у {below_pct} счетов той же глубины"
    rows.sort(key=lambda r: r.pop("_sort"))
    counts = {
        "accounts": len(rows),
        "by_depth": {str(d): sum(1 for r in rows if r["depth"] == d) for d in sorted(cohorts)},
    }
    method = (
        "Счета сравниваются только со счетами той же глубины по суммам, числу контрагентов и числу переводов. "
        f"Показатель необычен, если не ниже него значения не более чем у {percent_ru(ip.ANOMALY_TAIL_SHARE)} счетов "
        f"этой глубины (не менее одного счёта) и он не менее чем {_times_ru(ip.ANOMALY_MIN_RATIO)} больше медианы; "
        "для сумм медиана берётся не меньше 5 000 ₸, для счётчиков — не меньше 1."
    )
    limitations = [
        "Необычный профиль — отличие от своей глубины, а не признак нарушения; верхний 1% есть в любой группе.",
        "Исходящие показатели счетов глубины 4 не сравниваются: они не собирались.",
        "Входящие переводы из-за пределов выборки не учтены.",
    ]
    public = _section(
        "depth_profile", "Необычный профиль для своей глубины", "Аномалии", method, counts,
        rows[: ip.MAX_EXAMPLES], limitations, cohorts=cohort_rows,
    )
    return _Section(public, flags, {})


# --- устойчивость сети ----------------------------------------------------------------------


class _Topology:
    """Компактное представление графа для многократного пересчёта сценариев удаления."""

    def __init__(self, g: _Graph):
        self.gids = g.gids
        self.n = len(g.gids)
        index = {gid: i for i, gid in enumerate(g.gids)}
        self.edges = [(index[s], index[d], tiyn) for (s, d), (tiyn, _) in sorted(g.edges.items(), key=lambda kv: (int(kv[0][0]), int(kv[0][1])))]
        self.out = [[] for _ in range(self.n)]
        for s, d, _ in self.edges:
            self.out[s].append(d)
        self.seed = [g.is_seed(gid) for gid in g.gids]
        self.total = sum(t for _, _, t in self.edges)
        base = self._reach(set())
        self.base_reachable = [i for i in range(self.n) if base[i] and not self.seed[i]]

    def _reach(self, removed: set) -> list:
        """Счета, достижимые по направленным рёбрам от оставшихся исходных клиентов."""
        seen = [False] * self.n
        stack = [i for i in range(self.n) if self.seed[i] and i not in removed]
        for i in stack:
            seen[i] = True
        while stack:
            v = stack.pop()
            for w in self.out[v]:
                if not seen[w] and w not in removed:
                    seen[w] = True
                    stack.append(w)
        return seen

    def measure(self, removed: set) -> dict:
        parent = list(range(self.n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        removed_tiyn = 0
        for s, d, t in self.edges:
            if s in removed or d in removed:
                removed_tiyn += t
                continue
            a, b = find(s), find(d)
            if a != b:
                parent[max(a, b)] = min(a, b)
        sizes = Counter(find(i) for i in range(self.n) if i not in removed)
        seen = self._reach(removed)
        reachable = sum(1 for i in range(self.n) if seen[i] and not self.seed[i])
        # Знаменатель — оставшиеся счета, которые были достижимы до удаления: удалённые не считаются потерей.
        still_there = sum(1 for i in self.base_reachable if i not in removed)
        remaining = self.n - len(removed)
        return {
            "components": len(sizes),
            "largest_component_nodes": max(sizes.values(), default=0),
            "largest_component_share": round(max(sizes.values(), default=0) / remaining, 4) if remaining else 0.0,
            "reachable_non_seed": reachable,
            "reachable_share": round(reachable / still_there, 4) if still_there else 0.0,
            "edge_tiyn_removed": removed_tiyn,
        }


def _removal_row(topo: _Topology, base: dict, strategy: str, n: int, metrics: dict, removed_gids=None) -> dict:
    removed_tiyn = metrics["edge_tiyn_removed"]
    row = {
        "strategy": strategy,
        "n_removed": n,
        "components": metrics["components"],
        "largest_component_nodes": metrics["largest_component_nodes"],
        "largest_component_share": metrics["largest_component_share"],
        "reachable_non_seed": metrics["reachable_non_seed"],
        "reachable_share": metrics["reachable_share"],
        "edge_kzt_removed": kzt_value(int(round(removed_tiyn))) if isinstance(removed_tiyn, float) else kzt_value(removed_tiyn),
        "edge_kzt_remaining": kzt_value(int(round(topo.total - removed_tiyn))) if isinstance(removed_tiyn, float) else kzt_value(topo.total - removed_tiyn),
        "edge_kzt_removed_share": round(removed_tiyn / topo.total, 4) if topo.total else 0.0,
    }
    if removed_gids is not None:
        row["removed_gids"] = removed_gids
    return row


def _resilience(g: _Graph) -> _Section:
    topo = _Topology(g)
    index = {gid: i for i, gid in enumerate(g.gids)}
    base = topo.measure(set())
    sizes = [n for n in ip.REMOVAL_TOP_N if n <= topo.n]
    flow = {gid: 0 for gid in g.gids}
    for (s, d), (tiyn, _) in g.edges.items():
        flow[s] += tiyn
        flow[d] += tiyn
    orders = {
        "priority": sorted(g.gids, key=lambda x: (-float(g.nodes[x].get("priority_score", 0.0)), int(x))),
        "flow": sorted(g.gids, key=lambda x: (-flow[x], int(x))),
    }
    scenarios = []
    for strategy, order in orders.items():
        for n in sizes:
            chosen = order[:n]
            metrics = topo.measure({index[x] for x in chosen})
            scenarios.append(_removal_row(topo, base, strategy, n, metrics, removed_gids=chosen))
    if sizes:
        rng = random.Random(ip.REMOVAL_RANDOM_SEED)
        sums = {n: Counter() for n in sizes}
        for _ in range(ip.REMOVAL_RANDOM_RUNS):
            draw = rng.sample(range(topo.n), max(sizes))
            for n in sizes:
                m = topo.measure(set(draw[:n]))
                for key in ("components", "largest_component_nodes", "reachable_non_seed", "edge_tiyn_removed"):
                    sums[n][key] += m[key]
                sums[n]["largest_component_share"] += m["largest_component_share"]
                sums[n]["reachable_share"] += m["reachable_share"]
        runs = ip.REMOVAL_RANDOM_RUNS
        for n in sizes:
            mean = {k: v / runs for k, v in sums[n].items()}
            mean["largest_component_share"] = round(mean["largest_component_share"], 4)
            mean["reachable_share"] = round(mean["reachable_share"], 4)
            row = _removal_row(topo, base, "random", n, mean)
            for key in ("components", "largest_component_nodes", "reachable_non_seed"):
                row[key] = round(mean[key], 1)
            row["runs"] = runs
            scenarios.append(row)
    baseline = _removal_row(topo, base, "none", 0, base)
    summary_text = ""
    if sizes:
        n = sizes[-1]
        pick = {r["strategy"]: r for r in scenarios if r["n_removed"] == n}
        lost = lambda r: 1 - r["reachable_share"]  # noqa: E731
        summary_text = (
            f"На графе выборки: без {n} счетов с наибольшим приоритетом от исходных клиентов недостижимы {percent_ru(lost(pick['priority']))} "
            f"остальных счетов; без {n} счетов с наибольшим оборотом — {percent_ru(lost(pick['flow']))}; без {n} "
            f"случайных — в среднем {percent_ru(lost(pick['random']))}. Крупнейшая связная часть: "
            f"{percent_ru(pick['priority']['largest_component_share'])} оставшихся счетов после удаления по приоритету."
        )
    counts = {
        "nodes": topo.n,
        "edges": len(topo.edges),
        "baseline_components": base["components"],
        "baseline_reachable_non_seed": base["reachable_non_seed"],
    }
    method = (
        "Из графа удаляются счета вместе со всеми их рёбрами: по убыванию приоритета проверки, по убыванию "
        f"оборота и случайные наборы того же размера ({ip.REMOVAL_RANDOM_RUNS} наборов, фиксированное зерно). "
        "После удаления считаются слабосвязные компоненты, размер крупнейшей из них, число счетов, достижимых "
        "по направленным переводам от оставшихся исходных клиентов, и сумма рёбер, проходивших через удалённые счета."
    )
    limitations = [
        "Это расчёт на графе выборки, а не прогноз эффекта блокировки: реальные переводы пошли бы по другим каналам.",
        "Достижимость считается от исходных клиентов выборки; граф собран от них, поэтому базовая достижимость полная.",
        "Сумма рёбер через удалённые счета — наблюдаемый оборот, а не объём предотвращённых переводов.",
    ]
    public = _section(
        "resilience", "Сценарии удаления счетов", "Устойчивость сети", method, counts, [], limitations,
        baseline=baseline, scenarios=scenarios, summary_text=summary_text,
    )
    return _Section(public, {}, {})


# --- запросы данных и сводка --------------------------------------------------------------

_REQUESTS = (
    (
        "intraday_time",
        "Время операций внутри дня",
        "Без времени порядок переводов одного дня не установить: транзит с лагом 0 и циклы, замыкаемые только "
        "внутри дня, остаются возможными, а не наблюдаемыми.",
    ),
    (
        "below_floor",
        "Переводы меньше 5 000 ₸ для отмеченных пар",
        "Серии переводов одной пары видны только выше порога выгрузки; более мелкие части не наблюдаются.",
    ),
    (
        "beyond_depth4",
        "Исходящие переводы счетов глубины 4",
        "Счёт получил схождение или всплеск поступлений, но его дальнейшие переводы не собирались.",
    ),
)


def _data_requests(sections: list) -> dict:
    needs = defaultdict(set)
    for s in sections:
        for key, gids in s.needs.items():
            needs[key] |= set(gids)
    rows = []
    for key, request, reason in _REQUESTS:
        gids = sorted(needs.get(key, set()), key=int)
        rows.append(
            {
                "key": key,
                "request": request,
                "reason": reason,
                "n_accounts": len(gids),
                "example_gids": gids[: ip.MAX_EXAMPLES],
            }
        )
    counts = {"requests": sum(1 for r in rows if r["n_accounts"]), "accounts": len(set().union(*needs.values())) if needs else 0}
    method = "Для каждого наблюдения отмечается, каких данных не хватает для его проверки; счета группируются по запросу."
    return _section(
        "data_requests", "Какие данные запросить", "Полнота данных", method, counts, rows,
        ["Запросы касаются только наблюдений этого модуля; общий список пробелов данных ведёт ядро (next_request)."],
        parameters={},
    )


def _cited(sections: list) -> set:
    """Все исходные транзакции, на которые ссылаются примеры."""
    keys = set()

    def visit(obj):
        if isinstance(obj, dict):
            if set(obj) == {"src", "dst", "date", "sum_kzt"}:
                keys.add((obj["src"], obj["dst"], obj["date"], obj["sum_kzt"]))
                return
            for v in obj.values():
                visit(v)
        elif isinstance(obj, list):
            for v in obj:
                visit(v)

    for s in sections:
        visit(s["examples"])
    return keys


def compute_insights(analysis: dict) -> dict:
    """Дополнительные наблюдения по готовому analysis.json; результат детерминирован и без отметок времени."""
    g = _Graph(analysis)
    parts = [
        _pass_through(g),
        _convergence(g),
        _bursts(g),
        _routes(g),
        _cycles(g),
        _splitting(g),
        _depth_profile(g),
        _resilience(g),
    ]
    sections = [p.public for p in parts] + [_data_requests(parts)]

    by_gid = defaultdict(list)
    for p in parts:
        for gid, text in p.flags.items():
            by_gid[gid].append({"section": p.public["key"], "text": text})
    by_gid = {gid: by_gid[gid][: ip.MAX_FLAGS_PER_GID] for gid in sorted(by_gid, key=int)}

    cited = _cited(sections)
    n_tx = len(g.tx)
    examples = sum(len(s["examples"]) for s in sections if s["key"] != "data_requests")
    return {
        "schema_version": ip.SCHEMA_VERSION,
        "policy_version": ip.VERSION,
        "input_sha256": (analysis.get("summary") or {}).get("input_sha256"),
        "case_items": CASE_ITEMS,
        "sections": sections,
        "by_gid": by_gid,
        "review_load": {
            "source_transactions": n_tx,
            "source_edges": len(g.edges),
            "examples": examples,
            "cited_transactions": len(cited),
            "note": "Число исходных строк, приведённых в примерах. Время работы аналитика не измерялось.",
        },
        "analyst_effort_hypothesis": {
            "status": "гипотеза, не проверена",
            "baseline": f"Без этих наблюдений аналитик ищет шаблоны вручную среди {n_tx} транзакций и {len(g.edges)} рёбер.",
            "hypothesis": "Примеры с исходными строками сокращают время поиска временных шаблонов, циклов и серий переводов.",
            "falsifier": "Хронометраж: аналитики ищут одни и те же шаблоны с наблюдениями и без них. Гипотеза неверна, "
                         "если время не сокращается или вручную находятся примеры, которых нет в наблюдениях.",
        },
        "limitations": list(ip.GLOBAL_LIMITATIONS_RU),
    }
