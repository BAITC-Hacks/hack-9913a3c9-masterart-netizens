"""Независимые проверки F01–F06. FINANCE_DATA_DIR включает свежий прогон исходных parquet.

WORKBENCH_VERIFY_BOOTSTRAP=1 дополнительно проверяет ./run.sh в отдельном каталоге.
Без данных проверяются только явно искусственные примеры и ошибки запуска.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import copy
import csv
from datetime import date
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
ROLES = {"consolidator", "transit", "distributor", "terminal", "coordinator", "peripheral"}
CSV_COLUMNS = {
    "nodes_roles.csv": ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"],
    "clusters.csv": ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"],
    "top_nodes.csv": ["rank", "gid", "role", "priority_score", "why"],
}
ARTIFACTS = (*CSV_COLUMNS, "analysis.json")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def keys(value, names):
    require(isinstance(value, dict), "Ожидается объект")
    require(set(names) <= value.keys(), "Отсутствуют обязательные поля: " + ", ".join(sorted(set(names) - value.keys())))


def exact_gid(value):
    require(isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value) is not None, "gid должен быть точной десятичной строкой")
    require(-(2**63) <= int(value) < 2**63 and str(int(value)) == value, "gid выходит за int64 или записан неканонически")
    return value


def integer(value, minimum=0):
    require(type(value) is int and value >= minimum, "Ожидается целое число в допустимых границах")
    return value


def number(value):
    require(type(value) in (int, float, Decimal), "Ожидается число, не строка и не логическое значение")
    result = Decimal(str(value))
    require(result.is_finite(), "Число должно быть конечным")
    return result


def money(value, positive=False):
    amount = number(value)
    require(amount > 0 if positive else amount >= 0, "Недопустимая сумма KZT")
    require(amount == amount.quantize(Decimal("0.01")), "Сумма KZT содержит доли меньше тиына")
    return amount


def score(value):
    require(0 <= number(value) <= 1, "Скор должен быть от 0 до 1")


def russian(value, maximum=None):
    require(isinstance(value, str) and value.strip() and re.search("[А-Яа-яЁё]", value) is not None, "Текст должен быть непустым и русским")
    require(maximum is None or len(value) <= maximum, "Объяснение превышает допустимую длину")


def iso_date(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is not None, "Неверный формат даты")
    require(date.fromisoformat(value).isoformat() == value, "Некорректная дата")
    return value


def transaction_key(row):
    keys(row, ("src", "dst", "date", "sum_kzt"))
    return exact_gid(row["src"]), exact_gid(row["dst"]), iso_date(row["date"]), money(row["sum_kzt"], True)


def validate_witness(witness, gid, seed_ids, transactions, strict):
    if not seed_ids:
        require(witness is None, "Для недостижимого узла путь должен быть null")
        return
    keys(witness, ("seed_gid", "hops"))
    require(exact_gid(witness["seed_gid"]) in seed_ids, "Путь начинается с неподтверждённого исходного клиента")
    require(isinstance(witness["hops"], list) and witness["hops"], "Путь должен содержать переводы")
    current, previous = witness["seed_gid"], None
    for hop in witness["hops"]:
        key = transaction_key(hop)
        require(key in transactions, "Путь содержит перевод, которого нет в источнике")
        require(hop["src"] == current, "Разрыв пути")
        require(previous is None or (hop["date"] > previous if strict else hop["date"] >= previous), "Даты пути нарушают выбранный режим")
        current, previous = hop["dst"], hop["date"]
    require(current == gid, "Путь заканчивается у другого счёта")


def reference_reach(nodes, transactions):
    """Малый эталон по определению: обход связей и отдельные снимки каждого дня."""
    result = {n["gid"]: {mode: set() for mode in ("static", "strict", "same_day")} for n in nodes}
    adjacent, by_day = defaultdict(set), defaultdict(list)
    for tx in transactions:
        adjacent[tx["src"]].add(tx["dst"])
        by_day[tx["date"]].append((tx["src"], tx["dst"]))
    for seed in (n["gid"] for n in nodes if n["is_seed"]):
        reached, queue = {seed}, [seed]
        while queue:
            fresh = adjacent[queue.pop()] - reached
            reached |= fresh
            queue.extend(fresh)
        for gid in reached - {seed}:
            result[gid]["static"].add(seed)
        strict, same_day = {seed}, {seed}
        for day in sorted(by_day):
            strict |= {dst for src, dst in by_day[day] if src in strict}
            while True:
                fresh = {dst for src, dst in by_day[day] if src in same_day} - same_day
                if not fresh:
                    break
                same_day |= fresh
        for mode, reach in (("strict", strict), ("same_day", same_day)):
            for gid in reach - {seed}:
                result[gid][mode].add(seed)
    return result


def validate_analysis(document, source=None):
    keys(document, ("schema_version", "summary", "policy", "nodes", "edges", "transactions", "clusters", "top_nodes", "temporal_summary"))
    require(document["schema_version"] == "finance-workbench/v1", "Неизвестная версия схемы")
    for name in ("nodes", "edges", "transactions", "clusters", "top_nodes"):
        require(isinstance(document[name], list), "Ожидается массив: " + name)
    nodes, edges, transactions = document["nodes"], document["edges"], document["transactions"]
    ids = [exact_gid(n["gid"]) for n in nodes]
    require(len(ids) == len(set(ids)), "Повторяющийся gid")
    by_gid = dict(zip(ids, nodes))
    seeds = {n["gid"] for n in nodes if n["is_seed"]}
    incoming, outgoing = defaultdict(list), defaultdict(list)
    edge_totals, tx_totals, tx_counts = {}, defaultdict(Decimal), Counter()
    tx_keys = [transaction_key(tx) for tx in transactions]
    require(len(tx_keys) == len(set(tx_keys)), "Повторяющаяся исходная транзакция")
    for src, dst, day, amount in tx_keys:
        require(src in by_gid and dst in by_gid, "Перевод с неизвестным концом")
        tx_totals[src, dst] += amount
        tx_counts[src, dst] += 1
    for edge in edges:
        keys(edge, ("src", "dst", "sum_kzt", "n_tx", "depth"))
        src, dst = exact_gid(edge["src"]), exact_gid(edge["dst"])
        require(src in by_gid and dst in by_gid, "Ребро с неизвестным концом")
        require((src, dst) not in edge_totals, "Повторяющееся ребро")
        edge_totals[src, dst] = money(edge["sum_kzt"], True)
        require(integer(edge["n_tx"], 1) == tx_counts[src, dst], "Число переводов не совпало с ребром")
        integer(edge["depth"])
        incoming[dst].append(edge)
        outgoing[src].append(edge)
    require(edge_totals == dict(tx_totals), "Суммы переводов не совпали с рёбрами")
    reference = reference_reach(nodes, transactions)
    available_transactions = set(tx_keys)

    for node in nodes:
        keys(node, ("gid", "depth", "is_seed", "role", "role_score", "cluster_id", "priority_score", "evidence", "metrics", "observation", "role_alternatives", "next_request", "temporal"))
        gid = node["gid"]
        integer(node["depth"])
        require(type(node["is_seed"]) is bool, "is_seed должен быть логическим")
        require(node["role"] in ROLES, "Неизвестная роль")
        integer(node["cluster_id"])
        score(node["role_score"])
        score(node["priority_score"])
        russian(node["evidence"], 200)
        russian(node["next_request"])
        metrics = node["metrics"]
        keys(metrics, ("in_degree", "out_degree", "in_kzt", "out_kzt", "in_tx", "out_tx", "seed_in_count", "seed_out_count", "pass_through"))
        for prefix, incident, endpoint in (("in", incoming[gid], "src"), ("out", outgoing[gid], "dst")):
            require(integer(metrics[prefix + "_degree"]) == len(incident), "Неверное число соседей")
            require(integer(metrics[prefix + "_tx"]) == sum(e["n_tx"] for e in incident), "Неверное число транзакций узла")
            require(money(metrics[prefix + "_kzt"]) == sum((money(e["sum_kzt"]) for e in incident), Decimal(0)), "Неверный оборот узла")
            require(integer(metrics["seed_" + prefix + "_count"]) == sum(e[endpoint] in seeds for e in incident), "Неверное число исходных соседей")
        if metrics["pass_through"] is not None:
            require(money(metrics["in_kzt"]) > 0, "Отношение при нулевом входящем потоке должно быть null")
            require(abs(number(metrics["pass_through"]) - money(metrics["out_kzt"]) / money(metrics["in_kzt"])) < Decimal("0.00001"), "Неверное отношение потоков")
        observation = node["observation"]
        keys(observation, ("outgoing_censored", "warnings"))
        require(type(observation["outgoing_censored"]) is bool, "Неверная отметка границы наблюдения")
        require(isinstance(observation["warnings"], list), "Предупреждения должны быть массивом")
        for warning in observation["warnings"]:
            russian(warning)
        if node["depth"] == 4:
            require(observation["outgoing_censored"] and observation["warnings"], "Граница наблюдения не раскрыта")
            require(node["role"] not in {"terminal", "transit", "distributor"}, "Ненаблюдаемая исходящая сторона использована для роли")
        alternatives = node["role_alternatives"]
        require(isinstance(alternatives, list) and alternatives, "Нужна альтернативная гипотеза")
        require(len({a["role"] for a in alternatives}) == len(alternatives), "Повтор альтернативной роли")
        for alternative in alternatives:
            keys(alternative, ("role", "score", "reason"))
            require(alternative["role"] in ROLES and alternative["role"] != node["role"], "Некорректная альтернативная роль")
            score(alternative["score"])
            russian(alternative["reason"])
        temporal = node["temporal"]
        expected_temporal = {"static_seed_count", "strict_seed_count", "same_day_seed_count", "strict_seed_ids", "same_day_seed_ids", "strict_witness", "same_day_witness"}
        require(isinstance(temporal, dict) and temporal.keys() == expected_temporal, "Неверный контракт временных полей")
        counts = [integer(temporal[p + "_seed_count"]) for p in ("strict", "same_day", "static")]
        require(counts == sorted(counts) and counts[-1] <= len(seeds - {gid}), "Нарушены границы временной достижимости")
        for mode in ("strict", "same_day"):
            reached = temporal[mode + "_seed_ids"]
            require(isinstance(reached, list), "Исходные клиенты должны быть массивом")
            reached_set = {exact_gid(value) for value in reached}
            require(len(reached_set) == len(reached) == temporal[mode + "_seed_count"], "Неверное число исходных клиентов")
            require(reached_set <= seeds - {gid}, "Неизвестный исходный клиент или самодостижимость")
            validate_witness(temporal[mode + "_witness"], gid, reached_set, available_transactions, mode == "strict")
            require(reached_set == reference[gid][mode], "Достижимость расходится с независимым обходом")
        require(temporal["static_seed_count"] == len(reference[gid]["static"]), "Неверная статическая достижимость")
        require(set(temporal["strict_seed_ids"]) <= set(temporal["same_day_seed_ids"]), "Строгий путь отсутствует в режиме одного дня")

    summary = document["summary"]
    keys(summary, ("n_nodes", "n_edges", "n_transactions", "n_seed", "total_kzt", "period_start", "period_end", "n_boundary", "n_isolates", "n_weak_components", "input_sha256"))
    undirected = {gid: set() for gid in ids}
    for src, dst in edge_totals:
        undirected[src].add(dst)
        undirected[dst].add(src)
    unseen, components = set(ids), 0
    while unseen:
        components += 1
        queue = [unseen.pop()]
        while queue:
            fresh = undirected[queue.pop()] & unseen
            unseen -= fresh
            queue.extend(fresh)
    expected_counts = {"n_nodes": len(nodes), "n_edges": len(edges), "n_transactions": len(transactions), "n_seed": len(seeds), "n_boundary": sum(n["depth"] == 4 for n in nodes), "n_isolates": sum(not undirected[gid] for gid in ids), "n_weak_components": components}
    for key, expected in expected_counts.items():
        require(integer(summary[key]) == expected, "Неверный итог: " + key)
    require(money(summary["total_kzt"]) == sum(edge_totals.values(), Decimal(0)), "Итоговая сумма не сохранилась")
    days = sorted(tx["date"] for tx in transactions)
    require(summary["period_start"] == (days[0] if days else None) and summary["period_end"] == (days[-1] if days else None), "Неверный период")
    digests = summary["input_sha256"]
    require(isinstance(digests, (str, dict)) and digests, "Нет отпечатка источника")
    for digest in ([digests] if isinstance(digests, str) else digests.values()):
        require(isinstance(digest, str) and re.fullmatch("[0-9a-f]{64}", digest) is not None, "Неверный SHA-256")
    policy = document["policy"]
    keys(policy, ("version", "rules", "priority_description", "score_description", "limitations"))
    require(isinstance(policy["version"], str) and policy["version"], "Нет версии политики")
    require(isinstance(policy["rules"], list), "Правила должны быть массивом")
    require({rule["role"] for rule in policy["rules"]} == ROLES, "Правила не покрывают шесть ролей")
    for rule in policy["rules"]:
        keys(rule, ("role", "description", "thresholds"))
        russian(rule["description"])
        require(isinstance(rule["thresholds"], dict), "Нет формальных порогов")
    russian(policy["priority_description"])
    russian(policy["score_description"])
    require(isinstance(policy["limitations"], list) and policy["limitations"], "Не раскрыты ограничения")
    for limitation in policy["limitations"]:
        russian(limitation)
    require(isinstance(document["temporal_summary"], dict) and document["temporal_summary"], "Нет временной сводки")

    members = defaultdict(list)
    for node in nodes:
        members[node["cluster_id"]].append(node)
    clusters = document["clusters"]
    require(len(clusters) == len({c["cluster_id"] for c in clusters}), "Повтор кластера")
    require({c["cluster_id"] for c in clusters} == members.keys(), "Кластеры не покрывают все узлы")
    for cluster in clusters:
        keys(cluster, CSV_COLUMNS["clusters.csv"])
        cid = integer(cluster["cluster_id"])
        require(integer(cluster["n_nodes"], 1) == len(members[cid]), "Неверный размер кластера")
        require(integer(cluster["n_seed"]) == sum(n["is_seed"] for n in members[cid]), "Неверное число исходных клиентов кластера")
        expected = sum((amount for (src, dst), amount in edge_totals.items() if by_gid[src]["cluster_id"] == by_gid[dst]["cluster_id"] == cid), Decimal(0))
        require(money(cluster["sum_kzt_internal"]) == expected, "Неверный внутренний оборот кластера")
        tops = cluster["top_gids"]
        require(isinstance(tops, list) and tops and len(tops) == len(set(tops)), "Неверные ключевые узлы кластера")
        require({exact_gid(gid) for gid in tops} <= {n["gid"] for n in members[cid]}, "Ключевой узел находится в другом кластере")
        russian(cluster["hypothesis"])
    top = document["top_nodes"]
    require(len(top) >= min(20, len(nodes)), "В рейтинге меньше 20 доступных узлов")
    require(len(top) == len({n["gid"] for n in top}), "Повтор узла в рейтинге")
    previous = Decimal(1)
    for rank, row in enumerate(top, 1):
        keys(row, CSV_COLUMNS["top_nodes.csv"])
        gid = exact_gid(row["gid"])
        require(gid in by_gid, "Рейтинг содержит неизвестный gid")
        require(integer(row["rank"], 1) == rank, "Ранги не последовательны")
        score(row["priority_score"])
        require(number(row["priority_score"]) <= previous, "Рейтинг не отсортирован")
        previous = number(row["priority_score"])
        require(row["role"] == by_gid[gid]["role"] and row["priority_score"] == by_gid[gid]["priority_score"], "Рейтинг расходится с узлами")
        russian(row["why"])
    if source is not None:
        require({n["gid"]: (n["depth"], n["is_seed"]) for n in nodes} == {n["gid"]: (n["depth"], n["is_seed"]) for n in source["nodes"]}, "Потеряны или изменены исходные узлы")
        require(Counter(tx_keys) == Counter(transaction_key(tx) for tx in source["transactions"]), "Транзакции отличаются от источника")
        require(Counter((e["src"], e["dst"], money(e["sum_kzt"]), e["n_tx"], e["depth"]) for e in edges) == Counter((e["src"], e["dst"], money(e["sum_kzt"]), e["n_tx"], e["depth"]) for e in source["edges"]), "Рёбра отличаются от источника")


def load_json(path):
    def reject_constant(value):
        raise AssertionError("JSON содержит нечисловую константу")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Повтор ключа в JSON")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal, parse_constant=reject_constant, object_pairs_hook=unique_object)


def validate_outputs(directory, source=None):
    document = load_json(directory / "analysis.json")
    validate_analysis(document, source)
    for filename, columns in CSV_COLUMNS.items():
        with (directory / filename).open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            require(reader.fieldnames == columns, "Неверная схема CSV: " + filename)
            rows = list(reader)
        expected = document[{"nodes_roles.csv": "nodes", "clusters.csv": "clusters", "top_nodes.csv": "top_nodes"}[filename]]
        require(len(rows) == len(expected), "Число строк CSV расходится с JSON")
        lookup_key = "cluster_id" if filename == "clusters.csv" else "gid"
        require(len({row[lookup_key] for row in rows}) == len(rows), "Повтор строки CSV")
        lookup = {str(row[lookup_key]): row for row in expected}
        for index, row in enumerate(rows):
            require(set(row) == set(columns) and all(value is not None and value.strip() for value in row.values()), "Пустое или лишнее поле CSV")
            require(row[lookup_key] in lookup, "Неизвестный идентификатор CSV")
            original = lookup[row[lookup_key]]
            for key in columns:
                value = row[key]
                if key == "top_gids":
                    parsed = json.loads(value) if value.startswith("[") else re.split(r"[;,|\s]+", value)
                    require(parsed == original[key], "Ключевые узлы CSV расходятся с JSON")
                    for gid in parsed:
                        exact_gid(gid)
                elif key in {"rank", "cluster_id", "n_nodes", "n_seed"}:
                    require(re.fullmatch(r"0|[1-9][0-9]*", value) is not None and int(value) == original[key], "Неверное целое поле CSV")
                elif key in {"role_score", "priority_score", "sum_kzt_internal"}:
                    require(Decimal(value).is_finite() and Decimal(value) == number(original[key]), "Числовое поле CSV расходится с JSON")
                else:
                    if key == "gid":
                        exact_gid(value)
                    require(value == original[key], "Текст CSV расходится с JSON")
            if filename == "top_nodes.csv":
                require(int(row["rank"]) == index + 1, "CSV рейтинга не отсортирован")
    return document


def source_snapshot(directory):
    import pyarrow.parquet as parquet

    result = {}
    for name in ("nodes", "edges", "transactions"):
        rows = parquet.read_table(directory / (name + ".parquet")).to_pylist()
        for row in rows:
            for key in ("gid", "src", "dst"):
                if key in row:
                    require(type(row[key]) is int, "Исходный идентификатор должен быть int64")
                    row[key] = exact_gid(str(row[key]))
            if "date" in row:
                row["date"] = iso_date(str(row["date"])[:10])
        result[name] = rows
    return result


def copy_product(destination):
    for name in ("run.sh", "serve.py", "requirements.txt"):
        shutil.copy2(ROOT / name, destination / name)
    for name in ("backend", "web"):
        require((ROOT / name).is_dir(), "Интеграция ещё не готова: нет " + name)
        shutil.copytree(ROOT / name, destination / name, ignore=shutil.ignore_patterns("node_modules", "dist", "__pycache__", ".env", ".env.*"))


def no_key_environment():
    return {key: value for key, value in os.environ.items() if not key.startswith(("OPENAI_", "ANTHROPIC_")) and not key.endswith("API_KEY") and key not in {"PYTHONPATH", "PYTHONHOME"}}


def fixture():
    # Эти искусственные счета проверяют округление JavaScript и направленный цикл.
    gids = [str(9007199254740993 + index) for index in range(20)]
    s, a, b = gids[:3]
    transactions = [
        {"src": s, "dst": a, "date": "2026-07-01", "sum_kzt": 100.25},
        {"src": a, "dst": b, "date": "2026-07-02", "sum_kzt": 70.10},
        {"src": b, "dst": a, "date": "2026-07-03", "sum_kzt": 5},
    ]
    edges = [{"src": tx["src"], "dst": tx["dst"], "sum_kzt": tx["sum_kzt"], "n_tx": 1, "depth": i + 1} for i, tx in enumerate(transactions)]
    nodes = []
    for i, gid in enumerate(gids):
        ins, outs = [e for e in edges if e["dst"] == gid], [e for e in edges if e["src"] == gid]
        inbound = sum((money(e["sum_kzt"]) for e in ins), Decimal(0))
        outbound = sum((money(e["sum_kzt"]) for e in outs), Decimal(0))
        reached = gid in {a, b}
        witness = {"seed_gid": s, "hops": transactions[:1 if gid == a else 2]} if reached else None
        nodes.append({
            "gid": gid, "depth": 0 if i in {0, 19} else min(i, 3), "is_seed": i in {0, 19},
            "role": "peripheral", "role_score": 0.1, "cluster_id": 0 if i < 3 else i - 2,
            "priority_score": (20 - i) / 20, "evidence": "Искусственный пример для проверки контракта.",
            "metrics": {"in_degree": len(ins), "out_degree": len(outs), "in_kzt": float(inbound), "out_kzt": float(outbound), "in_tx": len(ins), "out_tx": len(outs), "seed_in_count": sum(e["src"] == s for e in ins), "seed_out_count": 0, "pass_through": float(outbound / inbound) if inbound else None},
            "observation": {"outgoing_censored": False, "warnings": []},
            "role_alternatives": [{"role": "transit", "score": 0, "reason": "Наблюдений для этой гипотезы недостаточно."}],
            "next_request": "Запросить полную историю переводов.",
            "temporal": {"static_seed_count": int(reached), "strict_seed_count": int(reached), "same_day_seed_count": int(reached), "strict_seed_ids": [s] if reached else [], "same_day_seed_ids": [s] if reached else [], "strict_witness": copy.deepcopy(witness), "same_day_witness": copy.deepcopy(witness)},
        })
    clusters = []
    for cid in range(18):
        group = [n for n in nodes if n["cluster_id"] == cid]
        clusters.append({"cluster_id": cid, "n_nodes": len(group), "n_seed": sum(n["is_seed"] for n in group), "sum_kzt_internal": 175.35 if cid == 0 else 0, "top_gids": [n["gid"] for n in group], "hypothesis": "Искусственная группа для проверки полноты."})
    return {
        "schema_version": "finance-workbench/v1", "summary": {"n_nodes": 20, "n_edges": 3, "n_transactions": 3, "n_seed": 2, "total_kzt": 175.35, "period_start": "2026-07-01", "period_end": "2026-07-03", "n_boundary": 0, "n_isolates": 17, "n_weak_components": 18, "input_sha256": "0" * 64},
        "policy": {"version": "fixture-v1", "rules": [{"role": role, "description": "Искусственное правило для проверки схемы.", "thresholds": {"test": 1}} for role in sorted(ROLES)], "priority_description": "Искусственный приоритет для проверки порядка.", "score_description": "Эвристическая поддержка, не вероятность виновности.", "limitations": ["Искусственные данные, не результаты анализа."]},
        "nodes": nodes, "edges": edges, "transactions": transactions, "clusters": clusters,
        "top_nodes": [{"rank": rank, "gid": n["gid"], "role": n["role"], "priority_score": n["priority_score"], "why": n["evidence"]} for rank, n in enumerate(nodes, 1)],
        "temporal_summary": {"semantics": "Достижимость не доказывает движение одних и тех же средств."},
    }


def write_fixture(directory, document):
    (directory / "analysis.json").write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    for filename, columns in CSV_COLUMNS.items():
        source = {"nodes_roles.csv": "nodes", "clusters.csv": "clusters", "top_nodes.csv": "top_nodes"}[filename]
        with (directory / filename).open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            for row in document[source]:
                row = dict(row)
                if "top_gids" in row:
                    row["top_gids"] = json.dumps(row["top_gids"])
                writer.writerow(row)


class ContractTests(unittest.TestCase):
    def test_F02_explicit_valid_fixture_and_csv(self):
        with tempfile.TemporaryDirectory(prefix="workbench-valid-") as temporary:
            folder = Path(temporary)
            document = fixture()
            write_fixture(folder, document)
            validate_outputs(folder, document)

    def test_F02_hostile_schema_identifiers_scores_and_evidence(self):
        mutations = [
            lambda d: d.pop("policy"),
            lambda d: d["nodes"][0].update(gid=9007199254740993),
            lambda d: d["nodes"][0].update(gid="9007199254740992"),
            lambda d: d["nodes"][0].update(gid="9.007199254740993e15"),
            lambda d: d["nodes"].append(copy.deepcopy(d["nodes"][0])),
            lambda d: d["nodes"][0].update(role_score=1.01),
            lambda d: d["nodes"][0].update(priority_score=float("nan")),
            lambda d: d["nodes"][0].update(evidence=""),
            lambda d: d["nodes"][0].update(evidence="я" * 201),
            lambda d: d["nodes"][0].update(role="fraud"),
            lambda d: d["nodes"][0].update(role_alternatives=[]),
            lambda d: d["policy"]["rules"].pop(),
        ]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                document = fixture()
                mutation(document)
                with self.assertRaises((AssertionError, KeyError, ValueError)):
                    validate_analysis(document)

    def test_F03_conservation_endpoints_duplicates_and_dates(self):
        mutations = [
            lambda d: d["edges"][0].update(sum_kzt=100.26),
            lambda d: d["edges"][0].update(n_tx=2),
            lambda d: d["transactions"][0].update(dst="9223372036854775806"),
            lambda d: d["transactions"][0].update(date="2026-02-30"),
            lambda d: d["transactions"][0].update(sum_kzt=-1),
            lambda d: d["transactions"][0].update(sum_kzt=None),
            lambda d: d["transactions"].append(copy.deepcopy(d["transactions"][0])),
            lambda d: d["summary"].update(total_kzt=175.36),
            lambda d: d["nodes"][1]["metrics"].update(in_kzt=100),
        ]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                document = fixture()
                mutation(document)
                with self.assertRaises((AssertionError, KeyError, ValueError)):
                    validate_analysis(document)

    def test_F04_cluster_coverage_and_internal_amounts(self):
        for mutation in (
            lambda d: d["clusters"].pop(),
            lambda d: d["clusters"][0].update(n_nodes=2),
            lambda d: d["clusters"][0].update(sum_kzt_internal=170.35),
            lambda d: d["clusters"][0].update(top_gids=[d["nodes"][-1]["gid"]]),
        ):
            document = fixture()
            mutation(document)
            with self.assertRaises(AssertionError):
                validate_analysis(document)

    def test_F05_ranking_requires_twenty_sorted_consistent_nodes(self):
        for mutation in (
            lambda d: d["top_nodes"].pop(),
            lambda d: d["top_nodes"].reverse(),
            lambda d: d["top_nodes"][0].update(priority_score=0),
        ):
            document = fixture()
            mutation(document)
            with self.assertRaises(AssertionError):
                validate_analysis(document)

    def test_F06_witnesses_and_boundary_claims(self):
        for mutation in (
            lambda d: d["nodes"][2]["temporal"]["strict_witness"]["hops"][1].update(date="2026-07-01"),
            lambda d: d["nodes"][2]["temporal"]["strict_witness"]["hops"][0].update(sum_kzt=1),
            lambda d: d["nodes"][1]["temporal"].update(strict_witness=None),
            lambda d: d["nodes"][0].update(depth=4, role="terminal"),
        ):
            document = fixture()
            mutation(document)
            with self.assertRaises(AssertionError):
                validate_analysis(document)

    def test_F06_reference_distinguishes_reversed_and_same_day_paths(self):
        document = fixture()
        target = document["nodes"][2]["gid"]
        seed = document["nodes"][0]["gid"]
        document["transactions"][1]["date"] = "2026-06-30"
        reference = reference_reach(document["nodes"], document["transactions"])
        self.assertEqual(reference[target]["static"], {seed})
        self.assertEqual(reference[target]["strict"], set())
        self.assertEqual(reference[target]["same_day"], set())
        document["transactions"][1]["date"] = "2026-07-01"
        reference = reference_reach(document["nodes"], list(reversed(document["transactions"])))
        self.assertEqual(reference[target]["strict"], set())
        self.assertEqual(reference[target]["same_day"], {seed})

    def test_F02_csv_rounded_gid_and_corruption_rejected(self):
        with tempfile.TemporaryDirectory(prefix="workbench-csv-") as temporary:
            folder = Path(temporary)
            write_fixture(folder, fixture())
            path = folder / "nodes_roles.csv"
            path.write_text(path.read_text().replace("9007199254740993", "9007199254740992"), encoding="utf-8")
            with self.assertRaises(AssertionError):
                validate_outputs(folder)

    def test_F01_runner_cli_in_independent_directory(self):
        with tempfile.TemporaryDirectory(prefix="workbench-cli-") as temporary:
            folder = Path(temporary)
            shutil.copy2(ROOT / "run.sh", folder / "run.sh")
            for args, success, message in [(["--help"], True, "Python"), (["--data"], False, "нужно значение"), (["--port", "0"], False, "Порт"), (["--port", "70000"], False, "Порт"), (["--unknown"], False, "Неизвестный"), (["--data", "missing data", "--no-serve"], False, "Нет каталога")]:
                result = subprocess.run(["bash", str(folder / "run.sh"), *args], cwd=folder, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode == 0, success)
                self.assertIn(message, result.stdout + result.stderr)

    def test_F01_source_has_no_private_runtime_dependency(self):
        self.assertTrue(os.access(ROOT / "run.sh", os.X_OK))
        requirements = (ROOT / "requirements.txt").read_text()
        self.assertIn("pyarrow==25.0.0", requirements)
        self.assertIn("networkx==3.6.1", requirements)
        for name in ("run.sh", "serve.py", "requirements.txt"):
            text = (ROOT / name).read_text()
            for forbidden in ("/Users/", "fleet-host", "mcp__", "command-center/"):
                self.assertNotIn(forbidden, text)


@unittest.skipUnless(os.environ.get("FINANCE_DATA_DIR"), "Официальный прогон не включён: задайте FINANCE_DATA_DIR")
class OfficialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require(sys.version_info >= (3, 12), "Официальный прогон требует Python >=3.12")
        cls.temporary = tempfile.TemporaryDirectory(prefix="workbench-replay-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.data = Path(os.environ["FINANCE_DATA_DIR"]).resolve()
        copy_product(cls.root)
        cls.source = source_snapshot(cls.data)
        cls.outputs = []
        cls.durations = []
        for index in range(2):
            output = cls.root / ("out-" + str(index))
            start = time.perf_counter()
            result = subprocess.run([sys.executable, "-B", "-m", "backend", "--data", str(cls.data), "--out", str(output)], cwd=cls.root, env=no_key_environment(), capture_output=True, text=True, timeout=300)
            require(result.returncode == 0, "Свежий запуск backend завершился ошибкой: " + result.stderr[-2000:])
            cls.durations.append(time.perf_counter() - start)
            cls.outputs.append(output)

    def test_F01_fresh_cli_without_model_key_under_five_minutes(self):
        self.assertTrue(all(duration < 300 for duration in self.durations))
        print("\nАнализ без ключа, секунды:", ", ".join(f"{value:.3f}" for value in self.durations))

    def test_F02_F03_F04_F05_official_output_contract_and_source_totals(self):
        document = validate_outputs(self.outputs[0], self.source)
        self.assertEqual((len(document["nodes"]), len(document["edges"]), len(document["transactions"])), (2248, 3119, 4840))
        self.assertEqual(document["summary"]["n_seed"], 81)
        self.assertEqual(document["summary"]["n_isolates"], 19)
        self.assertEqual(document["summary"]["n_boundary"], 444)
        digest_map = document["summary"]["input_sha256"]
        if isinstance(digest_map, dict):
            for filename in ("nodes.parquet", "edges.parquet", "transactions.parquet"):
                self.assertEqual(digest_map[filename], hashlib.sha256((self.data / filename).read_bytes()).hexdigest())

    def test_F01_deterministic_rerun_bytes(self):
        for name in ARTIFACTS:
            with self.subTest(name=name):
                self.assertEqual((self.outputs[0] / name).read_bytes(), (self.outputs[1] / name).read_bytes())

    def test_F01_react_typescript_local_build_sources(self):
        package = load_json(self.root / "web" / "package.json")
        dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
        for name in ("react", "react-dom", "vite", "typescript"):
            self.assertIn(name, dependencies)
        self.assertTrue((self.root / "web" / "package-lock.json").is_file())
        self.assertIn("build", package["scripts"])
        self.assertTrue(list((self.root / "web").rglob("*.tsx")))
        configs = "\n".join(path.read_text() for path in (self.root / "web").glob("tsconfig*.json"))
        self.assertRegex(configs, r'"strict"\s*:\s*true')

    def test_F04_clusters_stable_under_input_row_reversal(self):
        import pyarrow as arrow
        import pyarrow.parquet as parquet

        shuffled = self.root / "reversed-data"
        shuffled.mkdir()
        for name in ("nodes", "edges", "transactions"):
            table = parquet.read_table(self.data / (name + ".parquet"))
            parquet.write_table(table.take(arrow.array(list(reversed(range(len(table)))))), shuffled / (name + ".parquet"))
        output = self.root / "reversed-out"
        result = subprocess.run([sys.executable, "-B", "-m", "backend", "--data", str(shuffled), "--out", str(output)], cwd=self.root, env=no_key_environment(), capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        baseline = load_json(self.outputs[0] / "analysis.json")
        actual = validate_outputs(output, self.source)
        self.assertEqual({n["gid"]: n["cluster_id"] for n in baseline["nodes"]}, {n["gid"]: n["cluster_id"] for n in actual["nodes"]})

    def test_F03_backend_rejects_explicit_invalid_inputs(self):
        import pyarrow as arrow
        import pyarrow.parquet as parquet

        schemas = {
            "nodes": arrow.schema([("gid", arrow.int64()), ("depth", arrow.int64()), ("is_seed", arrow.bool_())]),
            "edges": arrow.schema([("src", arrow.int64()), ("dst", arrow.int64()), ("sum_kzt", arrow.float64()), ("n_tx", arrow.int64()), ("depth", arrow.int64())]),
            "transactions": arrow.schema([("src", arrow.int64()), ("dst", arrow.int64()), ("date", arrow.date32()), ("sum_kzt", arrow.float64())]),
        }
        artificial = fixture()
        artificial["nodes"] = artificial["nodes"][:3] + artificial["nodes"][-1:]
        for index, amount in enumerate((10_000, 7_000, 5_000)):
            artificial["transactions"][index]["sum_kzt"] = amount
            artificial["edges"][index]["sum_kzt"] = amount

        def run_input(number, mutation=None):
            source = copy.deepcopy(artificial)
            if mutation:
                mutation(source)
            data = self.root / ("invalid-data-" + str(number))
            data.mkdir()
            for name, schema in schemas.items():
                rows = [{key: row[key] for key in schema.names} for row in source[name]]
                for row in rows:
                    for key in ("gid", "src", "dst"):
                        if key in row:
                            row[key] = int(row[key])
                    if "date" in row and row["date"] is not None:
                        row["date"] = date.fromisoformat(row["date"])
                parquet.write_table(arrow.Table.from_pylist(rows, schema=schema), data / (name + ".parquet"))
            output = self.root / ("invalid-out-" + str(number))
            return subprocess.run([sys.executable, "-B", "-m", "backend", "--data", str(data), "--out", str(output)], cwd=self.root, env=no_key_environment(), capture_output=True, text=True, timeout=30)

        valid = run_input(0)
        self.assertEqual(valid.returncode, 0, "Положительный контроль не принят: " + valid.stderr[-2000:])
        mutations = [
            lambda d: d["nodes"].append(copy.deepcopy(d["nodes"][0])),
            lambda d: d["edges"][0].update(sum_kzt=10_001),
            lambda d: d["edges"][0].update(n_tx=2),
            lambda d: d["transactions"][0].update(dst="9223372036854775806"),
            lambda d: d["transactions"][0].update(sum_kzt=-1),
            lambda d: d["transactions"][0].update(sum_kzt=None),
            lambda d: d["transactions"][0].update(date=None),
            lambda d: d["transactions"].append(copy.deepcopy(d["transactions"][0])),
        ]
        for index, mutation in enumerate(mutations, 1):
            with self.subTest(case=index):
                result = run_input(index, mutation)
                self.assertNotEqual(result.returncode, 0, "Повреждённый вход принят")
                self.assertRegex(result.stdout + result.stderr, "[А-Яа-яЁё]")

    def test_F06_official_reach_counts_are_queries_not_labels(self):
        document = load_json(self.outputs[0] / "analysis.json")
        actual = tuple(sum(n["temporal"][mode + "_seed_count"] >= 5 for n in document["nodes"]) for mode in ("static", "strict", "same_day"))
        self.assertEqual(actual, (1596, 30, 34))

    @unittest.skipUnless(os.environ.get("WORKBENCH_VERIFY_BOOTSTRAP") == "1", "Полная установка включается WORKBENCH_VERIFY_BOOTSTRAP=1")
    def test_F01_bootstrap_no_serve_from_source_copy(self):
        environment = no_key_environment()
        environment.pop("WORKBENCH_VENV", None)
        environment["WORKBENCH_PYTHON"] = sys.executable
        result = subprocess.run([str(self.root / "run.sh"), "--data", str(self.data), "--no-serve"], cwd=self.root, env=environment, capture_output=True, text=True, timeout=900)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        validate_outputs(self.root / "out", self.source)
        self.assertTrue((self.root / "web" / "dist" / "index.html").is_file())
        receipt = load_json(self.root / "out" / "runtime-receipt.json")
        self.assertGreaterEqual(receipt["setup_seconds"], 0)
        self.assertGreaterEqual(receipt["build_seconds"], 0)
        self.assertLess(receipt["pipeline_seconds"], 300)
        print("\nИзолированный запуск:", result.stdout[-2000:])
        saved = {name: (self.root / "out" / name).read_bytes() for name in ARTIFACTS}
        environment.update({"npm_config_offline": "true", "PIP_NO_INDEX": "1"})
        replay = subprocess.run([str(self.root / "run.sh"), "--data", str(self.data), "--no-serve"], cwd=self.root, env=environment, capture_output=True, text=True, timeout=300)
        self.assertEqual(replay.returncode, 0, replay.stderr[-2000:])
        for name, expected in saved.items():
            self.assertEqual((self.root / "out" / name).read_bytes(), expected)


if __name__ == "__main__":
    unittest.main()
