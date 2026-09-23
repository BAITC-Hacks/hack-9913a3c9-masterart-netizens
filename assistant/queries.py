"""Ограниченные операции чтения: без SQL, исполнения кода и внешнего обогащения."""

from __future__ import annotations

import copy
import re
from collections import defaultdict, deque
from datetime import date
from decimal import Decimal, InvalidOperation
from itertools import groupby
from typing import Any

ROLES = {
    "consolidator": "кандидат в консолидаторы",
    "transit": "кандидат в транзитные счета",
    "distributor": "кандидат в распределители",
    "terminal": "кандидат в конечные получатели",
    "coordinator": "кандидат в координаторы",
    "peripheral": "периферийный счёт",
}
MODES = {"static": "без учёта дат", "strict": "только более поздний день",
         "same_day": "возможный порядок внутри дня"}
LIMITATION = "Достижимость не доказывает движение одних и тех же денег; роль — гипотеза, а не вывод о виновности."
MAX_RESULTS = 30
MAX_SOURCES = 100


class QueryError(ValueError):
    """Сообщение, безопасное для отображения пользователю."""


def gid_value(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|-?[1-9][0-9]{0,18})", value):
        raise QueryError("Идентификатор счёта должен быть точной десятичной строкой int64 без округления.")
    if not -9223372036854775808 <= int(value) <= 9223372036854775807:
        raise QueryError("Идентификатор счёта выходит за диапазон int64.")
    return value


def amount(value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise QueryError("В данных найдена некорректная сумма или метрика.")
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise QueryError("В данных найдена некорректная сумма или метрика.") from None
    if not result.is_finite() or result < 0:
        raise QueryError("В данных найдена отрицательная или неконечная метрика.")
    return result


def integer(value: Any, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise QueryError("Целочисленный параметр вне допустимого диапазона.")
    return value


def citation(pointer: str, label: str, gid: str | None = None) -> dict:
    result = {"source": "/out/analysis.json", "pointer": pointer, "label": label}
    if gid is not None:
        result["gid"] = gid
    return result


class GraphQueries:
    """Снимок фактов из analysis.json; вызовы не изменяют исходный объект."""

    def __init__(self, analysis: dict):
        if not isinstance(analysis, dict) or analysis.get("schema_version") != "finance-workbench/v1":
            raise QueryError("Нет совместимого analysis.json. Сначала выполните локальный анализ.")
        self.analysis = analysis
        self.nodes: dict[str, dict] = {}
        self.node_positions: dict[str, int] = {}
        self.incoming: dict[str, list] = defaultdict(list)
        self.outgoing: dict[str, list] = defaultdict(list)
        self.cluster_positions: dict[int, int] = {}
        self.clusters: dict[int, dict] = {}
        self.transactions: list[dict] = []
        try:
            for name, cap in (("nodes", 50000), ("edges", 200000), ("transactions", 300000), ("clusters", 50000)):
                if not isinstance(analysis[name], list) or len(analysis[name]) > cap:
                    raise QueryError("Размер или формат снимка не поддерживается помощником.")
            for pos, node in enumerate(analysis["nodes"]):
                gid = gid_value(node["gid"])
                if gid in self.nodes or node["role"] not in ROLES:
                    raise QueryError("В снимке повторяется счёт или указана неизвестная роль.")
                if not 0 <= amount(node["priority_score"]) <= 1 or not 0 <= amount(node["role_score"]) <= 1:
                    raise QueryError("Оценки в снимке должны быть в диапазоне от 0 до 1.")
                integer(node["cluster_id"], 0, 2147483647)
                if type(node["is_seed"]) is not bool:
                    raise QueryError("Некорректная отметка исходного клиента.")
                self.nodes[gid] = node
                self.node_positions[gid] = pos
            for pos, edge in enumerate(analysis["edges"]):
                self.require_gid(edge["src"])
                self.require_gid(edge["dst"])
                if amount(edge["sum_kzt"]) <= 0:
                    raise QueryError("В снимке найдена неположительная сумма перевода.")
                integer(edge["n_tx"], 1, 2147483647)
                self.incoming[edge["dst"]].append((pos, edge))
                self.outgoing[edge["src"]].append((pos, edge))
            for tx in analysis["transactions"]:
                self.require_gid(tx["src"])
                self.require_gid(tx["dst"])
                if not isinstance(tx["date"], str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", tx["date"]):
                    raise QueryError("Дата перевода должна иметь формат ГГГГ-ММ-ДД.")
                date.fromisoformat(tx["date"])
                if amount(tx["sum_kzt"]) <= 0:
                    raise QueryError("В снимке найдена неположительная сумма перевода.")
                self.transactions.append(tx)
            self.transactions.sort(key=lambda t: (t["date"], int(t["src"]), int(t["dst"]), amount(t["sum_kzt"])))
            for pos, cluster in enumerate(analysis["clusters"]):
                cid = integer(cluster["cluster_id"], 0, 2147483647)
                if cid in self.clusters:
                    raise QueryError("В снимке повторяется номер кластера.")
                for gid in cluster["top_gids"]:
                    self.require_gid(gid)
                    if self.nodes[gid]["cluster_id"] != cid:
                        raise QueryError("Ключевой счёт относится к другому кластеру.")
                self.clusters[cid] = cluster
                self.cluster_positions[cid] = pos
            if any(n["cluster_id"] not in self.clusters for n in self.nodes.values()):
                raise QueryError("Не для каждого счёта найден кластер.")
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            if isinstance(exc, QueryError):
                raise
            raise QueryError("Снимок analysis.json повреждён или неполон; выполните анализ заново.") from None

    def require_gid(self, value: Any) -> str:
        gid = gid_value(value)
        if gid not in self.nodes:
            raise QueryError("Счёт с таким точным идентификатором отсутствует в выборке.")
        return gid

    def node_citation(self, gid: str) -> dict:
        return citation(f"/nodes/{self.node_positions[gid]}", "Карточка счёта", gid)

    def brief(self, gid: str) -> dict:
        node = self.nodes[gid]
        return {k: copy.deepcopy(node[k]) for k in (
            "gid", "role", "role_score", "priority_score", "cluster_id", "evidence")}

    def _result(self, kind: str, facts: dict, gids: list[str], citations: list[dict], warnings: list[str] | None = None) -> dict:
        return {"kind": kind, "facts": facts, "nodes": list(dict.fromkeys(gids)),
                "citations": citations, "warnings": warnings or []}

    def node(self, gid: str) -> dict:
        gid = self.require_gid(gid)
        node = self.nodes[gid]
        facts = {k: copy.deepcopy(node[k]) for k in (
            "gid", "depth", "is_seed", "role", "role_score", "cluster_id", "priority_score",
            "evidence", "metrics", "observation", "role_alternatives", "next_request")}
        facts["priority_description"] = self.analysis["policy"]["priority_description"]
        return self._result("node", facts, [gid], [self.node_citation(gid), citation("/policy", "Правила и ограничения")])

    def neighbors(self, gid: str, direction: str, limit: int) -> dict:
        gid = self.require_gid(gid)
        edges = {}
        for rows in ([self.incoming[gid]] if direction == "in" else [self.outgoing[gid]] if direction == "out"
                     else [self.incoming[gid], self.outgoing[gid]]):
            edges.update(rows)
        ordered = sorted(edges.items(), key=lambda p: (-amount(p[1]["sum_kzt"]), int(p[1]["src"]), int(p[1]["dst"])))
        chosen = ordered[:limit]
        facts = {"gid": gid, "direction": direction, "total_edges": len(ordered), "shown": len(chosen),
                 "edges": [copy.deepcopy(e) for _, e in chosen], "observation": copy.deepcopy(self.nodes[gid]["observation"])}
        gids = [gid] + [v for _, e in chosen for v in (e["src"], e["dst"])]
        citations = [self.node_citation(gid)] + [citation(f"/edges/{pos}", "Наблюдаемое ребро") for pos, _ in chosen]
        return self._result("neighbors", facts, gids, citations)

    def rank(self, limit: int, role: str | None) -> dict:
        ordered = sorted((n for n in self.nodes.values() if role is None or n["role"] == role),
                         key=lambda n: (-amount(n["priority_score"]), int(n["gid"])))
        gids = [n["gid"] for n in ordered[:limit]]
        return self._result("rank", {"rows": [self.brief(gid) for gid in gids], "total": len(ordered), "role": role,
                                     "priority_description": self.analysis["policy"]["priority_description"]}, gids,
                            [citation("/policy/priority_description", "Правило приоритета")] + [self.node_citation(g) for g in gids])

    def cluster_query(self, cluster_id: int | None, limit: int) -> dict:
        if cluster_id is not None and cluster_id not in self.clusters:
            raise QueryError("Кластер с таким номером отсутствует в выборке.")
        rows = ([self.clusters[cluster_id]] if cluster_id is not None else
                sorted(self.clusters.values(), key=lambda c: (-c["n_nodes"], c["cluster_id"]))[:limit])
        rows = [copy.deepcopy(c) for c in rows]
        gids = [gid for c in rows for gid in c["top_gids"][:MAX_RESULTS]]
        members = []
        if cluster_id is not None:
            candidates = sorted((n for n in self.nodes.values() if n["cluster_id"] == cluster_id),
                                key=lambda n: (-amount(n["priority_score"]), int(n["gid"])))
            members = [self.brief(n["gid"]) for n in candidates[:limit]]
            gids += [n["gid"] for n in members]
        citations = [citation(f"/clusters/{self.cluster_positions[c['cluster_id']]}", "Метрики кластера") for c in rows]
        citations.extend(self.node_citation(n["gid"]) for n in members)
        return self._result("clusters", {"clusters": rows, "members": members, "total_clusters": len(self.clusters)}, gids, citations)

    def convergence(self, sources: list[str], min_sources: int, mode: str, limit: int) -> dict:
        sources = sorted(sources or [gid for gid, n in self.nodes.items() if n["is_seed"]], key=int)
        if not sources or len(sources) > MAX_SOURCES or min_sources > len(sources):
            raise QueryError("Порог должен быть не больше числа источников; поддерживается от 1 до 100 источников.")
        matched: dict[str, list[str]] = defaultdict(list)
        for source in sources:
            reached = {source}
            if mode == "static":
                queue = deque([source])
                while queue:
                    current = queue.popleft()
                    for _, edge in self.outgoing[current]:
                        if edge["dst"] not in reached:
                            reached.add(edge["dst"])
                            queue.append(edge["dst"])
            else:
                for _, daily in groupby(self.transactions, key=lambda t: t["date"]):
                    rows = list(daily)
                    if mode == "strict":
                        # Сначала читаем доступность на начало дня, затем применяем весь пакет.
                        reached.update({t["dst"] for t in rows if t["src"] in reached})
                    else:
                        adjacency: dict[str, list[str]] = defaultdict(list)
                        for tx in rows:
                            adjacency[tx["src"]].append(tx["dst"])
                        queue = deque(sorted(reached.intersection(adjacency), key=int))
                        visited = set(queue)
                        while queue:
                            for dst in adjacency[queue.popleft()]:
                                reached.add(dst)
                                if dst not in visited:
                                    visited.add(dst)
                                    queue.append(dst)
            for gid in reached - {source}:
                matched[gid].append(source)
        candidates = sorted((g for g in matched if len(matched[g]) >= min_sources),
                            key=lambda g: (-len(matched[g]), -amount(self.nodes[g]["priority_score"]), int(g)))
        gids = candidates[:limit]
        rows = [{**self.brief(g), "match_count": len(matched[g]), "matched_sources": matched[g]} for g in gids]
        facts = {"sources": sources, "source_count": len(sources), "min_sources": min_sources, "mode": mode,
                 "total_candidates": len(candidates), "rows": rows, "self_reach_excluded": True}
        citations = [citation("/edges" if mode == "static" else "/transactions", "Основание расчёта достижимости")]
        citations += [self.node_citation(g) for g in gids]
        return self._result("convergence", facts, gids, citations, [LIMITATION])

    def temporal(self, gid: str, mode: str) -> dict:
        gid = self.require_gid(gid)
        temporal = copy.deepcopy(self.nodes[gid]["temporal"])
        witness = temporal[mode + "_witness"]
        citations = [citation(f"/nodes/{self.node_positions[gid]}/temporal", "Достижимость от исходных клиентов", gid)]
        gids = [gid]
        if witness:
            seed = self.require_gid(witness["seed_gid"])
            if not self.nodes[seed]["is_seed"] or seed == gid or not witness["hops"]:
                raise QueryError("Некорректный пример временного пути в снимке.")
            lookup = {(t["src"], t["dst"], t["date"], amount(t["sum_kzt"])): pos
                      for pos, t in enumerate(self.analysis["transactions"])}
            current, previous_date = seed, None
            for hop in witness["hops"]:
                key = (hop["src"], hop["dst"], hop["date"], amount(hop["sum_kzt"]))
                if key not in lookup or hop["src"] != current or (
                    previous_date is not None and (hop["date"] <= previous_date if mode == "strict" else hop["date"] < previous_date)
                ):
                    raise QueryError("Пример временного пути не подтверждён исходными транзакциями.")
                citations.append(citation(f"/transactions/{lookup[key]}", "Транзакция временного пути"))
                gids.extend([hop["src"], hop["dst"]])
                current, previous_date = hop["dst"], hop["date"]
            if current != gid:
                raise QueryError("Пример временного пути ведёт к другому счёту.")
        return self._result("temporal", {"gid": gid, "mode": mode, "temporal": temporal, "witness": witness}, gids,
                            citations, [LIMITATION])

    def gaps(self, gid: str | None) -> dict:
        facts = {"limitations": copy.deepcopy(self.analysis["policy"]["limitations"])}
        citations = [citation("/policy/limitations", "Ограничения выборки")]
        gids = []
        if gid is not None:
            gid = self.require_gid(gid)
            facts.update({"gid": gid, "observation": copy.deepcopy(self.nodes[gid]["observation"]),
                          "next_request": self.nodes[gid]["next_request"]})
            gids.append(gid)
            citations.append(self.node_citation(gid))
        return self._result("gaps", facts, gids, citations)

    def execute(self, name: str, args: dict) -> dict:
        validate_args(name, args, self)
        methods = {"get_node": self.node, "get_neighbors": self.neighbors, "rank_nodes": self.rank,
                   "get_clusters": self.cluster_query, "find_convergence": self.convergence,
                   "get_temporal": self.temporal, "get_gaps": self.gaps}
        if name == "help":
            return self._result("help", {"topic": args["topic"]}, [], [])
        try:
            return methods[name](**args)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            if isinstance(exc, QueryError):
                raise
            raise QueryError("Для этой операции в analysis.json недостаточно проверенных данных.") from None


def _schema(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


GID_SCHEMA = {"type": "string", "pattern": r"^(0|-?[1-9][0-9]{0,18})$"}
LIMIT_SCHEMA = {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS}
TOOL_SCHEMAS = {
    "get_node": ("Карточка точного счёта: роль-гипотеза, альтернатива, метрики и следующий запрос.", _schema({"gid": GID_SCHEMA})),
    "get_neighbors": ("Наблюдаемые входящие/исходящие рёбра одного счёта; лимит не меняет общее число.",
                      _schema({"gid": GID_SCHEMA, "direction": {"type": "string", "enum": ["in", "out", "both"]}, "limit": LIMIT_SCHEMA})),
    "rank_nodes": ("Счета по вычисленному приоритету проверки; роль — необязательный фильтр, не обвинение.",
                   _schema({"limit": LIMIT_SCHEMA, "role": {"type": ["string", "null"], "enum": list(ROLES) + [None]}})),
    "get_clusters": ("Метрики кластеров или один кластер по номеру; null — обзор.",
                     _schema({"cluster_id": {"type": ["integer", "null"], "minimum": 0, "maximum": 2147483647}, "limit": LIMIT_SCHEMA})),
    "find_convergence": ("Счета, достижимые хотя бы от k из выбранных источников; [] — все исходные клиенты. Собственный источник не учитывается. Это не атрибуция денег.",
                         _schema({"sources": {"type": "array", "items": GID_SCHEMA, "maxItems": MAX_SOURCES},
                                  "min_sources": {"type": "integer", "minimum": 1, "maximum": MAX_SOURCES},
                                  "mode": {"type": "string", "enum": list(MODES)}, "limit": LIMIT_SCHEMA})),
    "get_temporal": ("Счётчики исходных клиентов и один проверенный пример пути с датами, если он есть.",
                     _schema({"gid": GID_SCHEMA, "mode": {"type": "string", "enum": ["strict", "same_day"]}})),
    "get_gaps": ("Границы наблюдения и следующий запрос данных; null — общие ограничения.",
                 _schema({"gid": {"type": ["string", "null"], "pattern": GID_SCHEMA["pattern"]}})),
    "help": ("Справка или честный отказ от неподдерживаемого запроса; без дополнительных фактов.",
             _schema({"topic": {"type": "string", "enum": ["help", "unsupported", "limitations"]}})),
}


def validate_args(name: str, args: dict, graph: GraphQueries) -> None:
    if name not in TOOL_SCHEMAS or not isinstance(args, dict):
        raise QueryError("Запрошена неизвестная операция помощника.")
    properties = TOOL_SCHEMAS[name][1]["properties"]
    if set(args) != set(properties):
        raise QueryError("Параметры операции неполны или содержат лишние поля.")
    for key, value in args.items():
        schema = properties[key]
        if value is None and "null" in schema.get("type", []):
            continue
        if key == "gid":
            graph.require_gid(value)
        elif key == "sources":
            if not isinstance(value, list) or len(value) > MAX_SOURCES:
                raise QueryError("Список источников должен содержать не больше 100 точных идентификаторов.")
            for gid in value:
                graph.require_gid(gid)
            if len(set(value)) != len(value):
                raise QueryError("Источник повторяется; каждый счёт должен учитываться один раз.")
        elif key in ("limit", "min_sources", "cluster_id"):
            integer(value, schema["minimum"], schema["maximum"])
        elif value not in schema["enum"] or not isinstance(value, str):
            raise QueryError("Значение параметра не входит в разрешённый список.")
