"""Наблюдаемые метрики каждого счёта: степени, суммы, связи с исходными клиентами."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from . import policy
from .io import Dataset


@dataclass(frozen=True)
class NodeMetrics:
    gid: int
    depth: int
    is_seed: bool
    in_degree: int
    out_degree: int
    in_tiyn: int
    out_tiyn: int
    in_tx: int
    out_tx: int
    seed_in_count: int
    seed_out_count: int
    seed_links: int
    outgoing_censored: bool
    last_in_date: dt.date | None
    margin_days: int | None  # дней от последнего поступления до конца периода
    # Поля ниже вычисляются по транзакциям; None — значение не передано (например, в тестовом
    # счёте), тогда правила используют прежние грубые метрики.
    counterparty_count: int | None = None  # разные контрагенты: плательщики ∪ получатели
    forward_tiyn: int | None = None  # исходящие другим счетам не раньше поступления от иного плательщика
    value_margin_days: int | None = None  # дней от поступления 90% суммы до конца периода

    @property
    def pass_through(self) -> float | None:
        """Доля переданного дальше; только когда обе стороны баланса наблюдаются."""
        if self.is_seed or self.outgoing_censored or self.in_tiyn <= 0:
            return None
        return self.out_tiyn / self.in_tiyn

    @property
    def forward_share(self) -> float | None:
        """Доля полученного, ушедшая дальше с согласованием по датам и контрагентам."""
        if self.is_seed or self.outgoing_censored or self.in_tiyn <= 0:
            return None
        forwarded = self.out_tiyn if self.forward_tiyn is None else self.forward_tiyn
        return forwarded / self.in_tiyn

    @property
    def window_days(self) -> int | None:
        """Окно наблюдения после поступления основной суммы; иначе — после последнего поступления."""
        return self.margin_days if self.value_margin_days is None else self.value_margin_days

    @property
    def turnover_tiyn(self) -> int:
        return self.in_tiyn + self.out_tiyn

    @property
    def counterparties(self) -> int:
        """Число разных контрагентов: счёт, который и платит, и получает, считается один раз."""
        if self.counterparty_count is None:
            return self.in_degree + self.out_degree
        return self.counterparty_count


def _forward_tiyn(inflows: list, outflows: list) -> int:
    """Сумма исходящих, у которых есть более раннее или того же дня поступление от другого счёта.

    Перевод получателю r считается возможной передачей дальше, только если счёт до этого (или
    в тот же день — порядок внутри дня неизвестен) получил деньги от плательщика p ≠ r. Встречные
    переводы с одним контрагентом и отправка раньше первого поступления так не засчитываются.
    """
    if not inflows or not outflows:
        return 0
    first_day, first_payer = min((t["date"], t["src"]) for t in inflows)
    other = [t["date"] for t in inflows if t["src"] != first_payer]
    first_other_day = min(other) if other else None
    total = 0
    for t in outflows:
        earliest = first_day if t["dst"] != first_payer else first_other_day
        if earliest is not None and earliest <= t["date"]:
            total += t["tiyn"]
    return total


def _value_margin_days(inflows: list, end: dt.date | None) -> int | None:
    """Дни от даты, к которой поступила заданная доля суммы, до конца периода."""
    if not inflows or end is None:
        return None
    share = policy.threshold("terminal", "window_value_share")
    total = sum(t["tiyn"] for t in inflows)
    running = 0
    for t in sorted(inflows, key=lambda x: (x["date"], x["src"], x["tiyn"])):
        running += t["tiyn"]
        if running >= share * total:
            return (end - t["date"]).days
    return (end - max(t["date"] for t in inflows)).days


def compute_metrics(data: Dataset) -> dict:
    """Возвращает {gid: NodeMetrics} для всех узлов, включая изолированные."""
    seeds = {n["gid"] for n in data.nodes if n["is_seed"]}
    payers = {n["gid"]: set() for n in data.nodes}
    recipients = {n["gid"]: set() for n in data.nodes}
    in_tiyn = dict.fromkeys(payers, 0)
    out_tiyn = dict.fromkeys(payers, 0)
    in_tx = dict.fromkeys(payers, 0)
    out_tx = dict.fromkeys(payers, 0)
    for e in data.edges:
        recipients[e["src"]].add(e["dst"])
        payers[e["dst"]].add(e["src"])
        out_tiyn[e["src"]] += e["tiyn"]
        in_tiyn[e["dst"]] += e["tiyn"]
        out_tx[e["src"]] += e["n_tx"]
        in_tx[e["dst"]] += e["n_tx"]
    last_in: dict = {}
    inflows: dict = {g: [] for g in payers}
    outflows: dict = {g: [] for g in payers}
    for t in data.transactions:
        if t["dst"] not in last_in or t["date"] > last_in[t["dst"]]:
            last_in[t["dst"]] = t["date"]
        inflows[t["dst"]].append(t)
        outflows[t["src"]].append(t)
    end = data.period_end
    result = {}
    for n in data.nodes:
        gid = n["gid"]
        seed_in = payers[gid] & seeds
        seed_out = recipients[gid] & seeds
        last = last_in.get(gid)
        result[gid] = NodeMetrics(
            gid=gid,
            depth=n["depth"],
            is_seed=n["is_seed"],
            in_degree=len(payers[gid]),
            out_degree=len(recipients[gid]),
            in_tiyn=in_tiyn[gid],
            out_tiyn=out_tiyn[gid],
            in_tx=in_tx[gid],
            out_tx=out_tx[gid],
            seed_in_count=len(seed_in),
            seed_out_count=len(seed_out),
            seed_links=len((seed_in | seed_out) - {gid}),
            outgoing_censored=n["depth"] >= policy.TRACE_HORIZON_DEPTH,
            last_in_date=last,
            margin_days=(end - last).days if last is not None and end is not None else None,
            counterparty_count=len((payers[gid] | recipients[gid]) - {gid}),
            forward_tiyn=_forward_tiyn(inflows[gid], outflows[gid]),
            value_margin_days=_value_margin_days(inflows[gid], end),
        )
    return result
