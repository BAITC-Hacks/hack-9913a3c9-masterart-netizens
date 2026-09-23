"""Ответ строится из результатов операций; свободный текст модели не публикуется."""

from __future__ import annotations

import html
from decimal import Decimal

from .queries import LIMITATION, MODES, ROLES


def text(value: object) -> str:
    value = html.escape(str(value), quote=True)
    for char in ("\\", "`", "*", "_", "[", "]", "|", "#"):
        value = value.replace(char, "\\" + char)
    return value.replace("\r", " ").replace("\n", " ")


def number(value: object) -> str:
    result = format(Decimal(str(value)), ",f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result.replace(",", "\u202f").replace(".", ",")


def sentence(value: object) -> str:
    value = str(value)
    return text(value[:1].upper() + value[1:])


def priority_rows(facts: dict) -> list[tuple[str, str]]:
    labels = {"role_signal": "Признаки роли", "flow": "Наблюдаемый оборот",
              "seed_links": "Связи с исходными клиентами", "chronology": "Цепочки по датам",
              "breadth": "Разные контрагенты"}
    weights = facts.get("priority_weights", {})
    if not isinstance(weights, dict) or set(weights) != set(labels):
        return []
    if any(type(v) not in (int, float) or not 0 <= v <= 1 for v in weights.values()):
        return []
    if abs(sum(Decimal(str(v)) for v in weights.values()) - 1) > Decimal("0.000001"):
        return []
    return [(label, number(Decimal(str(weights[key])) * 100) + "%") for key, label in labels.items()]


def priority_explanation(facts: dict) -> str:
    rows = priority_rows(facts)
    if rows:
        return "Вес признаков в приоритете:\n\n" + "\n".join(f"- {label} — {weight}" for label, weight in rows)
    return "Основание очереди: " + text(str(facts["priority_description"]).removeprefix("priority_score — "))


def link(gid: str) -> str:
    return f"[{gid}](?gid={gid})"


def row(node: dict) -> str:
    return (f"{link(node['gid'])} — {ROLES[node['role']]}; приоритет {number(node['priority_score'])}. "
            f"{text(node['evidence'])}")


def observation(value: dict) -> list[str]:
    lines = []
    if value.get("outgoing_censored"):
        lines.append("Исходящие переводы ограничены границей сбора: их отсутствие не подтверждает конечного получателя.")
    lines.extend(text(w) for w in value.get("warnings", []))
    return lines


HELP = ("Доступны проверяемые запросы: «объясни выбранный счёт», «входящие связи», «топ 10», "
        "«сравни два счёта», «кластеры», «достижимы хотя бы от 2 выбранных счетов», «путь по датам», «каких данных не хватает». "
        "Укажите точный gid или выберите счёт на карте. Для достижимости доступны режимы «без дат», "
        "«строго по дням» и «внутри одного дня». Помощник выполняет только чтение графа.")
UNSUPPORTED = ("По этим данным нельзя установить личность клиента, виновность или происхождение конкретных денег. "
               "Произвольные SQL-запросы, код, изменение данных и внешнее обогащение не поддерживаются. " + HELP)


def render(result: dict) -> str:
    kind, facts = result["kind"], result["facts"]
    lines: list[str] = []
    if kind == "help":
        return HELP if facts["topic"] == "help" else UNSUPPORTED
    if kind == "navigation":
        destinations = {"account": "Счёт", "map": "Карта счёта", "cluster": "Кластер", "queue": "Очередь проверки", "saved": "Сохранённые счета"}
        target = destinations[facts["view"]]
        if facts["view"] in ("account", "map"):
            target += " " + link(facts["gid"])
        elif facts["view"] == "cluster":
            target += " " + str(facts["cluster_id"])
        return "Переход: " + target + "."
    if kind == "node":
        lines.append(row(facts))
        lines.append(f"Поддержка роли по эвристике: {number(facts['role_score'])}; это не вероятность. Кластер: {facts['cluster_id']}.")
        lines.append(priority_explanation(facts))
        metrics = facts["metrics"]
        lines.append(f"Плательщиков: {number(metrics['in_degree'])}; получателей: {number(metrics['out_degree'])}. "
                     f"Наблюдаемые входящие: {number(metrics['in_kzt'])} ₸ ({number(metrics['in_tx'])} операций); "
                     f"исходящие: {number(metrics['out_kzt'])} ₸ ({number(metrics['out_tx'])} операций).")
        lines.append(f"Прямых связей с исходными клиентами: входящих {number(metrics['seed_in_count'])}, "
                     f"исходящих {number(metrics['seed_out_count'])}.")
        alternatives = facts["role_alternatives"]
        if alternatives:
            # Конвейер уже упорядочил альтернативы по смыслу правил; периферия не перебивает сигналы.
            alt = alternatives[0]
            lines.append(f"Альтернатива по правилу: {ROLES[alt['role']]} ({number(alt['score'])}). {sentence(alt['reason'])}")
        lines.extend(observation(facts["observation"]))
        lines.append("Следующий запрос данных: " + text(facts["next_request"]))
    elif kind == "comparison":
        if len(facts["leaders"]) == 1:
            lines.append("Из сравниваемых счетов раньше в вычисленной очереди проверки: " + link(facts["leaders"][0]) + ".")
        else:
            lines.append("Одинаковый максимальный приоритет у счетов: " + ", ".join(link(g) for g in facts["leaders"]) + ". Данные не задают предпочтение между ними.")
        for node in facts["rows"]:
            metrics = node["metrics"]
            lines.append(row(node))
            lines.append(f"- Наблюдаемые входящие: {number(metrics['in_kzt'])} ₸ от {metrics['in_degree']} плательщиков; "
                         f"исходящие: {number(metrics['out_kzt'])} ₸ к {metrics['out_degree']} получателям.")
            lines.extend(observation(node["observation"]))
            lines.append("- Следующий запрос: " + text(node["next_request"]))
        lines.append(priority_explanation(facts))
        lines.append("Более высокий приоритет означает порядок проверки, а не большую вероятность виновности.")
    elif kind == "insights":
        lines.append(facts["title"] + ".")
        if facts["scope_gid"]:
            lines.append("Счёт " + link(facts["scope_gid"]) + ": смотрим сохранённые примеры и отметки этого раздела.")
        lines.append(text(facts["method"]))
        for flag in facts["account_flags"]:
            lines.append(text(flag["text"]))
        for example in facts["examples"]:
            lines.append("- " + text(example.get("text") or example.get("request") or "Пример доступен в основании ответа."))
        if facts["section"] == "resilience":
            strategies = {"priority": "по приоритету", "flow": "по обороту", "random": "случайно"}
            for scenario in facts["scenarios"]:
                strategy = strategies.get(scenario["strategy"], "по рассчитанному сценарию")
                averaging = f" (среднее по {scenario['runs']} наборам)" if scenario["strategy"] == "random" else ""
                lines.append(f"- Удаление {scenario['n_removed']} счетов {strategy}{averaging}: "
                             f"компонент — {scenario['components']}, крупнейшая — {scenario['largest_component_nodes']} счетов; "
                             f"достижимых остальных счетов от исходных — {scenario['reachable_non_seed']}.")
            lines.append(f"Показано сценариев: {len(facts['scenarios'])} из {facts['total_scenarios']}.")
        else:
            lines.append(f"Показано сохранённых примеров: {len(facts['examples'])} из {facts['matching_examples']} подходящих; "
                         f"в разделе сохранено {facts['saved_examples']} примеров по всей выборке.")
            if not facts["examples"]:
                lines.append("Подходящего сохранённого примера нет. Это не доказывает отсутствие паттерна: список примеров ограничен.")
        lines.extend(text(item) for item in facts["limitations"])
    elif kind == "neighbors":
        direction = {"in": "входящие", "out": "исходящие", "both": "входящие и исходящие"}[facts["direction"]]
        lines.append(f"Счёт {link(facts['gid'])}: {direction} связи. Показано {facts['shown']} из {facts['total_edges']} наблюдаемых рёбер, по убыванию суммы.")
        for edge in facts["edges"]:
            lines.append(f"- {link(edge['src'])} → {link(edge['dst'])}: {number(edge['sum_kzt'])} ₸, операций {edge['n_tx']}.")
        if not facts["edges"]:
            lines.append("Таких рёбер в наблюдаемой выборке нет.")
        lines.extend(observation(facts["observation"]))
    elif kind == "rank":
        lines.append(f"Приоритет проверки: показано {len(facts['rows'])} из {facts['total']} счетов, соответствующих фильтру.")
        if facts.get("top_excludes_seeds"):
            lines.append("В очереди только счета вне списка известных исходных клиентов; сами исходные клиенты доступны через поиск.")
        lines.append(priority_explanation(facts))
        lines.extend(f"{i}. {row(n)}" for i, n in enumerate(facts["rows"], 1))
        if not facts["rows"]:
            lines.append("Счетов с таким наблюдаемым сочетанием признаков не найдено.")
    elif kind == "clusters":
        lines.append(f"Всего кластеров в снимке: {facts['total_clusters']}; показано {len(facts['clusters'])}.")
        for c in facts["clusters"]:
            lines.append(f"Кластер {c['cluster_id']}: счетов {c['n_nodes']}, исходных клиентов {c['n_seed']}, "
                         f"внутренний оборот {number(c['sum_kzt_internal'])} ₸. {text(c['hypothesis'])}")
            lines.append("Ключевые счета: " + (", ".join(link(g) for g in c["top_gids"][:30]) or "не указаны"))
        if facts["members"]:
            lines.append(f"Участники по приоритету (показано {len(facts['members'])}):")
            lines.extend("- " + row(n) for n in facts["members"])
    elif kind == "convergence":
        lines.append(f"Режим: {MODES[facts['mode']]}. Порог: хотя бы {facts['min_sources']} из {facts['source_count']} источников. "
                     f"Найдено счетов: {facts['total_candidates']}; показано {len(facts['rows'])}. Собственная достижимость источника исключена.")
        for n in facts["rows"]:
            lines.append(f"- {link(n['gid'])}: {n['match_count']} из {facts['source_count']}; источники: "
                         + ", ".join(link(g) for g in n["matched_sources"]) + ".")
        if not facts["rows"]:
            lines.append("В наблюдаемом графе нет счетов, удовлетворяющих этому порогу и режиму.")
        if facts["mode"] == "same_day":
            lines.append("Внутридневной порядок неизвестен; этот режим показывает только возможную последовательность.")
    elif kind == "temporal":
        t = facts["temporal"]
        lines.append(f"Счёт {link(facts['gid'])}. Число других исходных клиентов, от которых есть путь: "
                     f"без дат — {t['static_seed_count']}; строго по дням — {t['strict_seed_count']}; "
                     f"с возможным порядком внутри дня — {t['same_day_seed_count']}.")
        lines.append("Проверенный пример, режим «" + MODES[facts["mode"]] + "»:")
        witness = facts["witness"]
        if witness:
            for hop in witness["hops"]:
                lines.append(f"- {text(hop['date'])}: {link(hop['src'])} → {link(hop['dst'])}, {number(hop['sum_kzt'])} ₸.")
        else:
            lines.append("В этом режиме пример пути отсутствует.")
    elif kind == "gaps":
        if "gid" in facts:
            lines.append("Границы наблюдения для " + link(facts["gid"]) + ".")
            lines.extend(observation(facts["observation"]))
            lines.append("Следующий запрос данных: " + text(facts["next_request"]))
        lines.extend("- " + text(s) for s in facts["limitations"])
    lines.append(LIMITATION)
    # Пустая строка перед пунктом нужна для корректного Markdown в просмотрщике.
    return "\n\n".join(lines)
