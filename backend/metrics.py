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

    @property
    def pass_through(self) -> float | None:
        """Доля переданного дальше; только когда обе стороны баланса наблюдаются."""
        if self.is_seed or self.outgoing_censored or self.in_tiyn <= 0:
            return None
        return self.out_tiyn / self.in_tiyn

    @property
    def turnover_tiyn(self) -> int:
        return self.in_tiyn + self.out_tiyn

    @property
    def counterparties(self) -> int:
        return self.in_degree + self.out_degree


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
    for t in data.transactions:
        if t["dst"] not in last_in or t["date"] > last_in[t["dst"]]:
            last_in[t["dst"]] = t["date"]
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
        )
    return result
